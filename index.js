const { Transform } = require('readable-stream')
// TODO: full path to node source to avoid webpack issues with ebml@3.0.0 'browser' tag
//       https://github.com/node-ebml/node-ebml/pull/113
const ebml = require('ebml/lib/ebml')
const ebmlBlock = require('ebml-block')
const readElement = require('./lib/read-element')

// track elements we care about
const TRACK_ELEMENTS = ['TrackNumber', 'TrackType', 'Language', 'CodecID', 'CodecPrivate']
const SUBTITLE_TYPES = ['S_TEXT/UTF8', 'S_TEXT/SSA', 'S_TEXT/ASS']
const ASS_KEYS = ['readOrder', 'layer', 'style', 'name', 'marginL', 'marginR', 'marginV', 'effect', 'text']

class SubtitleParserBase extends Transform {
  constructor () {
    super()

    let currentTrack = null
    let currentSubtitleBlock = null
    let currentClusterTimecode = null

    this.subtitleTracks = new Map()
    this.timecodeScale = 1

    this._parseEbmlSubtitles = (chunk) => { //_onMetaData
      if (this.seekstuff) this.seekstuff(chunk)

      // Segment Information
      if (chunk[1].name === 'TimecodeScale') {
        this.timecodeScale = readElement(chunk[1]) / 1000000
      }

      // Tracks
      if (chunk[0] === 'start' && chunk[1].name === 'TrackEntry') {
        currentTrack = {}
      }

      if (currentTrack && chunk[0] === 'tag') {
        // save info about track currently being scanned
        if (TRACK_ELEMENTS.includes(chunk[1].name)) {
          currentTrack[chunk[1].name] = readElement(chunk[1])
        }
      }

      if (chunk[0] === 'end' && chunk[1].name === 'TrackEntry') {
        if (currentTrack.TrackType === 0x11) { // Subtitle Track
          if (SUBTITLE_TYPES.includes(currentTrack.CodecID)) {
            const track = {
              number: currentTrack.TrackNumber,
              language: currentTrack.Language,
              type: currentTrack.CodecID.substring(7).toLowerCase()
            }

            if (currentTrack.CodecPrivate) {
              // only SSA/ASS
              track.header = currentTrack.CodecPrivate.toString('utf8')
            }

            this.subtitleTracks.set(currentTrack.TrackNumber, track)
          }
        }
        currentTrack = null
      }

      if (chunk[0] === 'end' && chunk[1].name === 'Tracks') {
        // if (this.subtitleTracks.size <= 0) return this.end()

        this.emit('tracks', Array.from(this.subtitleTracks.values()))
      }

      // Assumption: This is a Cluster `Timecode`
      if (chunk[1].name === 'Timecode') {
        currentClusterTimecode = readElement(chunk[1])
      }

      if (chunk[1].name === 'Block') {
        const block = ebmlBlock(chunk[1].data)

        if (this.subtitleTracks.has(block.trackNumber)) {
          const type = this.subtitleTracks.get(block.trackNumber).type

          const subtitle = {
            text: block.frames[0].toString('utf8'),
            time: (block.timecode + currentClusterTimecode) * this.timecodeScale
          }

          if (type === 'ass' || type === 'ssa') {
            // extract SSA/ASS keys
            const values = subtitle.text.split(',')
            // ignore read-order, and skip layer if ssa
            let i = type === 'ssa' ? 2 : 1
            for (; i < 9; i++) {
              subtitle[ASS_KEYS[i]] = values[i]
            }
            // re-append extra text that might have been split
            for (i = 9; i < values.length; i++) {
              subtitle.text += ',' + values[i]
            }
          }

          currentSubtitleBlock = [subtitle, block.trackNumber]
        }
      }

      // Assumption: `BlockDuration` exists and always comes after `Block`
      if (currentSubtitleBlock && chunk[1].name === 'BlockDuration') {
        currentSubtitleBlock[0].duration = readElement(chunk[1]) * this.timecodeScale

        this.emit('subtitle', ...currentSubtitleBlock)

        currentSubtitleBlock = null
      }
    }
  }

}

class SubtitleParser extends SubtitleParserBase {
  constructor () {
    super()
    this.decoder = new ebml.Decoder()
    this.decoder.on('data', this._parseEbmlSubtitles.bind(this))
  }

  _write (chunk, _, callback) {
    this.decoder.write(chunk)
    callback(null, chunk)
  }
}


class SeekableSubtitleParser extends SubtitleParserBase {
  constructor () {
    super()

    this.segmentStart = null
    this.seekPositions = new Set()

    this.decoder = new ebml.Decoder()
    this.decoder.on('data', this._interceptSeeksAndParse)
  }

  // returns new parser stream at offset
  seekTo (offset) {
    if (offset == null) throw new Error('Must supply offset to seek to')
    
    this.once('drain', () => this.end())

    const newParser = new SeekableSubtitleParser()

    // copy previous metadata
    newParser.subtitleTracks = this.subtitleTracks
    newParser.timecodeScale = this.timecodeScale
    newParser.segmentStart = this.segmentStart
    newParser.seekPositions = this.seekPositions

    if (offset === 0) {
      // begin parsing from beginning of video
      return newParser
    }

    if (this.decoder) {
      // use the position of the previous decoder as a valid seek point
      // this can help if offset is changed before parsing seeks and cues
      const decoderPosition = this.decoder.total - this.decoder.cursor
      newParser.seekPositions.add(decoderPosition)
    }

    if (newParser.seekPositions.length === 0) {
      console.warn('No cues was parsed. Subtitle parsing disabled.')
      newParser.decoder = null
      return newParser
    }

    // find a cue that's close to the file offset
    // const seeksSorted = Uint32Array.from(newParser.seekPositions)
    // seeksSorted.sort()
    const seeksSorted = Array.from(newParser.seekPositions)
    seeksSorted.sort((a, b) => a - b)

    const closestSeek = seeksSorted.find(i => i >= offset)

    if (closestSeek != null) {
      // prepare to skip file stream until we hit a cue position
      newParser.skip = closestSeek - offset
      // set internal decoder position to output consistent file offsets
      newParser.decoder.total = closestSeek
    } else {
      console.warn(`No cues for offset ${offset}. Subtitle parsing disabled.`)
      this.decoder = null
    }

    return newParser
  }

  _interceptSeeksAndParse = (chunk) => {
    if (chunk[0] === 'start' && chunk[1].name === 'Segment') {
      // beginning of segment (next tag)
      const segStart = this.decoder.total

      if (this.segmentStart != null && this.segmentStart !== segStart) {
        // we don't really support multiple segments...
        this.seekPositions = new Set()
        console.warn('New segment found, this could be a problem!')
      }

      this.segmentStart = segStart
    }

    if (chunk[1].name === 'SeekPosition' || chunk[1].name === 'CueClusterPosition') {
      // save all seek and cue positions
      this.seekPositions.add(this.segmentStart + chunk[1].value)
    }

    if (chunk[0] === 'end' && chunk[1].name === 'Cues') {
      this.emit('cues')
    }

    this._parseEbmlSubtitles(chunk)
  }

  _transform (chunk, _, callback) {
    // passthrough stream, data is intercepted but not transformed
    if (!this.decoder) {
      return callback(null, chunk)
    }

    if (this.skip) {
      if (this.skip > 20000000) {
        // TODO: remove after further testing
        console.warn(this.id, 'Subtitle parsing stalled.')
      }
      // skip bytes to reach cue position
      if (this.skip < chunk.length) {
        // slice chunk
        const sc = chunk.slice(this.skip)
        this.skip = 0
        this.decoder.write(sc)
      } else {
        // skip entire chunk
        this.skip -= chunk.length
      }
    } else {
      this.decoder.write(chunk)
    }

    callback(null, chunk)
  }
}

module.exports = { SubtitleParser, SeekableSubtitleParser }

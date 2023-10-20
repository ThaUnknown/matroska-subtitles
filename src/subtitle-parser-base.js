const { PassThrough } = require('stream')
const { EbmlStreamDecoder, EbmlTagId, EbmlElementType, Tools } = require('ebml-stream')
const { inflateSync } = require('zlib')

const SSA_TYPES = new Set(['ssa', 'ass'])
const SSA_KEYS = ['readOrder', 'layer', 'style', 'name', 'marginL', 'marginR', 'marginV', 'effect', 'text']

function getChild (chunk, tag) {
  return chunk?.Children.find(({ id }) => id === tag)
}
function getData (chunk, tag) {
  return getChild(chunk, tag)?.data
}

function readChildren (parent = {}, start = 0) {
  const Children = []

  if (!parent) throw new Error('Parent object is required')
  if (!parent.Children) parent.Children = []

  for (const Child of parent.Children) {
    const childOutput = {}
    const childName = EbmlTagId[Child.id] || Child.id
    if (Child.Children && Child.Children.length > 0) {
      const subChildren = readChildren(Child)
      childOutput[childName] = subChildren.Children.reduce((acc, cur) => ({ ...acc, ...cur }), {})
    } else {
      if (Child.type === EbmlElementType.String || Child.type === EbmlElementType.UTF8 || Child.type == null) {
        childOutput[childName] = Child.data.toString()
      } else {
        childOutput[childName] = Child.data
      }
    }
    Children.push(childOutput)
  }

  delete parent._children
  if (start) parent.absoluteStart = start
  return { ...parent, Children }
}

class SubtitleParserBase extends PassThrough {
  constructor () {
    super()

    this.subtitleTracks = new Map()
    this.timecodeScale = 1

    this._currentClusterTimecode = null
    this.duration = null
    this.chapters = null
    this.seekHead = {}

    this.decoder = new EbmlStreamDecoder({
      bufferTagIds: [
        EbmlTagId.SeekHead,
        EbmlTagId.TimecodeScale,
        EbmlTagId.Tracks,
        EbmlTagId.BlockGroup,
        EbmlTagId.Attachments,
        EbmlTagId.Chapters,
        EbmlTagId.Duration
      ]
    })

    const tagMap = {
      [EbmlTagId.SeekHead]: (seekHeadTags) => {
        const seekHead = readChildren(seekHeadTags)

        const transformedHead = {}

        for (const child of seekHead.Children) {
          if (!child.Seek) continue // CRC32 elements will appear, currently we don't check them
          const tagName = EbmlTagId[Tools.readUnsigned(child.Seek.SeekID)]
          transformedHead[tagName] = child.Seek.SeekPosition
        }

        if (!transformedHead.Attachments) this.emit('attachments', [])

        this.seekHead = transformedHead
      },
      // Segment Information
      [EbmlTagId.TimecodeScale]: ({ data }) => {
        this.timecodeScale = data / 1000000
      },
      // Assumption: This is a Cluster `Timecode`
      [EbmlTagId.Timecode]: ({ data }) => {
        this._currentClusterTimecode = data
      },
      // Parse attached files, mainly to allow extracting subtitle font files.
      [EbmlTagId.Attachments]: ({ Children }) => {
        this.emit('attachments', Children.map(chunk => ({
          filename: getData(chunk, EbmlTagId.FileName),
          mimetype: getData(chunk, EbmlTagId.FileMimeType),
          data: getData(chunk, EbmlTagId.FileData)
        })))
      },
      // Duration for chapters which don't specify an end position
      [EbmlTagId.Duration]: ({ data }) => {
        if (this.chapters) {
          this.chapters[this.chapters.length - 1].end = data
          this.emit('chapters', this.chapters)
        } else {
          this.duration = data
        }
      },
      [EbmlTagId.Tracks]: this.handleTracks.bind(this),
      [EbmlTagId.BlockGroup]: this.handleBlockGroup.bind(this),
      [EbmlTagId.Chapters]: this.handleChapters.bind(this)
    }
    this.decoder.on('data', chunk => {
      tagMap[chunk.id]?.(chunk)
    })
  }

  handleTracks (chunk) {
    for (const entry of chunk.Children.filter(c => c.id === EbmlTagId.TrackEntry)) {
      // Skip non subtitle tracks
      if (getData(entry, EbmlTagId.TrackType) !== 0x11) continue

      const codecID = getData(entry, EbmlTagId.CodecID) || ''
      if (codecID.startsWith('S_TEXT')) {
        const track = {
          number: getData(entry, EbmlTagId.TrackNumber),
          language: getData(entry, EbmlTagId.Language),
          type: codecID.substring(7).toLowerCase()
        }

        const name = getData(entry, EbmlTagId.Name)
        if (name) track.name = name

        const header = getData(entry, EbmlTagId.CodecPrivate)
        if (header) track.header = header.toString()

        // TODO: Assume zlib deflate compression
        const compressed = entry.Children.find(c =>
          c.id === EbmlTagId.ContentEncodings &&
          c.Children.find(cc =>
            cc.id === EbmlTagId.ContentEncoding &&
            getChild(cc, EbmlTagId.ContentCompression)
          )
        )

        if (compressed) track._compressed = true

        this.subtitleTracks.set(track.number, track)
      }
    }

    this.emit('tracks', [...this.subtitleTracks.values()])
  }

  handleBlockGroup (chunk) {
    const block = getChild(chunk, EbmlTagId.Block)

    if (block && this.subtitleTracks.has(block.track)) {
      const blockDuration = getData(chunk, EbmlTagId.BlockDuration)
      const track = this.subtitleTracks.get(block.track)

      const payload = track._compressed
        ? inflateSync(Buffer.from(block.payload))
        : block.payload

      const subtitle = {
        text: payload.toString('utf8'),
        time: (block.value + this._currentClusterTimecode) * this.timecodeScale,
        duration: blockDuration * this.timecodeScale
      }

      if (SSA_TYPES.has(track.type)) {
        // extract SSA/ASS keys
        const values = subtitle.text.split(',')

        // ignore read-order, and skip layer if ssa
        for (let i = track.type === 'ssa' ? 2 : 1; i < 8; i++) {
          subtitle[SSA_KEYS[i]] = values[i]
        }

        subtitle.text = values.slice(8).join(',')
      }

      this.emit('subtitle', subtitle, block.track)
    }
  }

  handleChapters ({ Children }) {
    const editions = Children.filter(c => c.id === EbmlTagId.EditionEntry)
    // https://www.matroska.org/technical/chapters.html#default-edition
    // finds first default edition, or first entry
    const defaultEdition = editions.find(c => {
      return c.Children.some(cc => {
        return cc.id === EbmlTagId.EditionFlagDefault && Boolean(cc.data)
      })
    }) || editions[0]

    // exclude hidden atoms
    const atoms = defaultEdition.Children.filter(c => c.id === EbmlTagId.ChapterAtom && !getData(c, EbmlTagId.ChapterFlagHidden))
    const chapters = []
    for (let i = atoms.length - 1; i >= 0; --i) {
      const start = getData(atoms[i], EbmlTagId.ChapterTimeStart) / this.timecodeScale / 1000000
      const end = (getData(atoms[i], EbmlTagId.ChapterTimeEnd) / this.timecodeScale / 1000000)
      const disp = getChild(atoms[i], EbmlTagId.ChapterDisplay)

      chapters[i] = {
        start,
        end,
        text: getData(disp, EbmlTagId.ChapString),
        language: getData(disp, EbmlTagId.ChapLanguage)
      }
    }

    chapters.sort((a, b) => a.start - b.start)
    for (let i = chapters.length - 1; i >= 0; --i) {
      chapters[i].end ||= chapters[i + 1]?.start || this.duration
    }

    if (this.duration) {
      this.emit('chapters', chapters)
    } else {
      this.chapters = chapters
    }
  }
}
module.exports = SubtitleParserBase

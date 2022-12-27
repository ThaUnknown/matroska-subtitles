var ebmlStream = require('ebml-stream');
var readableStream = require('readable-stream');
var zlib = require('zlib');

const SSA_TYPES = new Set(['ssa', 'ass']);
const SSA_KEYS = ['readOrder', 'layer', 'style', 'name', 'marginL', 'marginR', 'marginV', 'effect', 'text'];
function getChild(chunk, tag) {
  return chunk == null ? void 0 : chunk.Children.find(({
    id
  }) => id === tag);
}
function getData(chunk, tag) {
  var _getChild;
  return (_getChild = getChild(chunk, tag)) == null ? void 0 : _getChild.data;
}
class SubtitleParserBase extends readableStream.PassThrough {
  constructor() {
    super();
    this.subtitleTracks = new Map();
    this.timecodeScale = 1;
    this._currentClusterTimecode = null;
    this.decoder = new ebmlStream.EbmlStreamDecoder({
      bufferTagIds: [ebmlStream.EbmlTagId.TimecodeScale, ebmlStream.EbmlTagId.Tracks, ebmlStream.EbmlTagId.BlockGroup, ebmlStream.EbmlTagId.AttachedFile, ebmlStream.EbmlTagId.Chapters, ebmlStream.EbmlTagId.Duration]
    });
    const tagMap = {
      // Segment Information
      [ebmlStream.EbmlTagId.TimecodeScale]: ({
        data
      }) => {
        this.timecodeScale = data / 1000000;
      },
      // Assumption: This is a Cluster `Timecode`
      [ebmlStream.EbmlTagId.Timecode]: ({
        data
      }) => {
        this._currentClusterTimecode = data;
      },
      // Parse attached files, mainly to allow extracting subtitle font files.
      [ebmlStream.EbmlTagId.AttachedFile]: chunk => {
        this.emit('file', {
          filename: getData(chunk, ebmlStream.EbmlTagId.FileName),
          mimetype: getData(chunk, ebmlStream.EbmlTagId.FileMimeType),
          data: getData(chunk, ebmlStream.EbmlTagId.FileData)
        });
      },
      // Duration for chapters which don't specify an end position
      [ebmlStream.EbmlTagId.Duration]: ({
        data
      }) => {
        this.duration = data;
      },
      [ebmlStream.EbmlTagId.Tracks]: this.handleTracks.bind(this),
      [ebmlStream.EbmlTagId.BlockGroup]: this.handleBlockGroup.bind(this),
      [ebmlStream.EbmlTagId.Chapters]: this.handleChapters.bind(this)
    };
    this.decoder.on('data', chunk => {
      var _tagMap$chunk$id;
      (_tagMap$chunk$id = tagMap[chunk.id]) == null ? void 0 : _tagMap$chunk$id.call(tagMap, chunk);
    });
  }
  handleTracks(chunk) {
    for (const entry of chunk.Children.filter(c => c.id === ebmlStream.EbmlTagId.TrackEntry)) {
      // Skip non subtitle tracks
      if (getData(entry, ebmlStream.EbmlTagId.TrackType) !== 0x11) continue;
      const codecID = getData(entry, ebmlStream.EbmlTagId.CodecID) || '';
      if (codecID.startsWith('S_TEXT')) {
        const track = {
          number: getData(entry, ebmlStream.EbmlTagId.TrackNumber),
          language: getData(entry, ebmlStream.EbmlTagId.Language),
          type: codecID.substring(7).toLowerCase()
        };
        const name = getData(entry, ebmlStream.EbmlTagId.Name);
        if (name) track.name = name;
        const header = getData(entry, ebmlStream.EbmlTagId.CodecPrivate);
        if (header) track.header = header.toString();

        // TODO: Assume zlib deflate compression
        const compressed = entry.Children.find(c => c.id === ebmlStream.EbmlTagId.ContentEncodings && c.Children.find(cc => cc.id === ebmlStream.EbmlTagId.ContentEncoding && getChild(cc, ebmlStream.EbmlTagId.ContentCompression)));
        if (compressed) track._compressed = true;
        this.subtitleTracks.set(track.number, track);
      }
    }
    this.emit('tracks', [...this.subtitleTracks.values()]);
  }
  handleBlockGroup(chunk) {
    const block = getChild(chunk, ebmlStream.EbmlTagId.Block);
    if (block && this.subtitleTracks.has(block.track)) {
      const blockDuration = getData(chunk, ebmlStream.EbmlTagId.BlockDuration);
      const track = this.subtitleTracks.get(block.track);
      const payload = track._compressed ? zlib.inflateSync(Buffer.from(block.payload)) : block.payload;
      const subtitle = {
        text: payload.toString('utf8'),
        time: (block.value + this._currentClusterTimecode) * this.timecodeScale,
        duration: blockDuration * this.timecodeScale
      };
      if (SSA_TYPES.has(track.type)) {
        // extract SSA/ASS keys
        const values = subtitle.text.split(',');

        // ignore read-order, and skip layer if ssa
        for (let i = track.type === 'ssa' ? 2 : 1; i < 8; i++) {
          subtitle[SSA_KEYS[i]] = values[i];
        }
        subtitle.text = values.slice(8).join(',');
      }
      this.emit('subtitle', subtitle, block.track);
    }
  }
  handleChapters({
    Children
  }) {
    const editions = Children.filter(c => c.id === ebmlStream.EbmlTagId.EditionEntry);
    // https://www.matroska.org/technical/chapters.html#default-edition
    // finds first default edition, or first entry
    const defaultEdition = editions.find(c => {
      return c.Children.some(cc => {
        return cc.id === ebmlStream.EbmlTagId.EditionFlagDefault && Boolean(cc.data);
      });
    }) || editions[0];

    // exclude hidden atoms
    const atoms = defaultEdition.Children.filter(c => c.id === ebmlStream.EbmlTagId.ChapterAtom && !getData(c, ebmlStream.EbmlTagId.ChapterFlagHidden));
    const chapters = [];
    for (let i = atoms.length - 1; i >= 0; --i) {
      var _chapters;
      const start = getData(atoms[i], ebmlStream.EbmlTagId.ChapterTimeStart) / this.timecodeScale / 1000000;
      const end = getData(atoms[i], ebmlStream.EbmlTagId.ChapterTimeEnd) / this.timecodeScale / 1000000 || ((_chapters = chapters[i + 1]) == null ? void 0 : _chapters.start) || this.duration;
      const disp = getChild(atoms[i], ebmlStream.EbmlTagId.ChapterDisplay);
      chapters[i] = {
        start,
        end,
        text: getData(disp, ebmlStream.EbmlTagId.ChapString),
        language: getData(disp, ebmlStream.EbmlTagId.ChapLanguage)
      };
    }
    this.emit('chapters', chapters);
  }
}

class SubtitleParser extends SubtitleParserBase {
  constructor() {
    super();
    this.decoder.on('data', chunk => {
      if (chunk.id === ebmlStream.EbmlTagId.Tracks) {
        // stop decoding if no subtitle tracks are present
        if (this.subtitleTracks.size === 0) this.end();
      }
    });
  }
  _write(chunk, _, callback) {
    this.decoder.write(chunk);
    callback(null, chunk);
  }
}

class SubtitleStream extends SubtitleParserBase {
  constructor(prevInstance) {
    super();
    if (prevInstance instanceof SubtitleParserBase) {
      prevInstance.once('drain', () => prevInstance.end());

      // copy previous metadata
      this.subtitleTracks = prevInstance.subtitleTracks;
      this.timecodeScale = prevInstance.timecodeScale;

      // may not be at ebml tag offset
      this.unstable = true;
    }
    this.on('data', this._ondata.bind(this));
  }

  // passthrough stream: data is intercepted but not transformed
  _ondata(chunk) {
    if (this.unstable) {
      // the ebml decoder expects to see a tag, so we won't use it until we find a cluster
      for (let i = 0; i < chunk.length - 12; i++) {
        // cluster id 0x1F43B675
        // https://matroska.org/technical/elements.html#LevelCluster
        if (chunk[i] === 0x1f && chunk[i + 1] === 0x43 && chunk[i + 2] === 0xb6 && chunk[i + 3] === 0x75) {
          // length of cluster size tag
          const len = 8 - Math.floor(Math.log2(chunk[i + 4]));
          // first tag in cluster is a valid EbmlTag
          if (ebmlStream.EbmlTagId[chunk[i + 4 + len]]) {
            // okay this is probably a cluster
            this.unstable = false;
            this.decoderWrite(chunk.slice(i));
            return;
          }
        }
      }
    } else {
      this.decoderWrite(chunk);
    }
  }
  decoderWrite(chunk) {
    // passthrough stream should allow chained streams to continue on error
    try {
      this.decoder.write(chunk);
    } catch (err) {
      console.warn('[matroska-subtitles] EBML stream decoding error', err);
    }
  }
}

exports.SubtitleParser = SubtitleParser;
exports.SubtitleStream = SubtitleStream;
//# sourceMappingURL=matroska-subtitles.js.map

const { readdir } = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const { resolve } = require('node:path')
const { SubtitleParser } = require('../src/index.js')

readdir('./tests/matroska-test-files').then(files => {
  for (const fileName of files) {
    const stream = createReadStream(resolve('./tests/matroska-test-files', fileName))
    const parser = new SubtitleParser()
    parser.on('file', console.log)
    parser.on('no-files', () => console.log('uwu'))
    stream.pipe(parser)
  }
})

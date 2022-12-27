const { inflate } = require('pako')

const inflateSync = (buffer) => inflate(buffer, { to: 'string' })
module.exports = { inflateSync }

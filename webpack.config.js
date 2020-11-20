const path = require('path')
const webpack = require('webpack')

module.exports = {
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'matroska-subtitles.min.js',
    library: 'MatroskaSubtitles'
  },
  devtool: 'source-map',
  resolve: {
    alias: {
      stream: 'stream-browserify'
    }
  },
  plugins: [
    new webpack.ProvidePlugin({
      process: 'process-fast',
      Buffer: ['buffer', 'Buffer']
    })]
}

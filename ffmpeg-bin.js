// Resolve the ffmpeg binary to use.
//
// In the container we install a full system ffmpeg via apt (Debian's build has
// the `drawtext` filter + libass + fontconfig — johnvansickle's `ffmpeg-static`
// build ships WITHOUT drawtext, so cards can't render on it). The Dockerfile
// sets FFMPEG_PATH=/usr/bin/ffmpeg. On Windows/dev with no FFMPEG_PATH we fall
// back to the bundled ffmpeg-static binary (whose Windows build DOES include
// drawtext), so local behaviour is unchanged.
const fs = require('fs');

function resolveFfmpegPath() {
  const envPath = (process.env.FFMPEG_PATH || '').trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    return require('ffmpeg-static');
  } catch {
    // Last resort: trust PATH.
    return envPath || 'ffmpeg';
  }
}

module.exports = { resolveFfmpegPath };

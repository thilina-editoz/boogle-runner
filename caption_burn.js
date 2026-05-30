// ─────────────────────────────────────────────────────────
//  BOOGLE by Content Psycho — Caption Burner
//  10 caption style presets — pick your look
//
//  Usage:
//  node caption_burn.js "output/Avatar_video_2.mp4"
//  node caption_burn.js "output/Avatar_video_2.mp4" 3
//
//  If no style number given, an interactive menu appears.
//  Text is auto-loaded from spoken.txt in the video folder.
// ─────────────────────────────────────────────────────────

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

ffmpeg.setFfmpegPath(ffmpegPath);

// ─── ARGUMENTS ───────────────────────────────────────────
const inputVideo = process.argv[2];
const styleArg   = process.argv[3];

if (!inputVideo) {
  console.error('\n  ❌  No video file specified');
  console.error('  Usage: node caption_burn.js "output/Avatar_video_2.mp4"');
  console.error('  Usage: node caption_burn.js "output/Avatar_video_2.mp4" 3\n');
  process.exit(1);
}

if (!fs.existsSync(inputVideo)) {
  console.error(`\n  ❌  Video file not found: ${inputVideo}`);
  console.error('  Check the file path is correct\n');
  process.exit(1);
}

// ─── AUTO-LOAD TEXT ──────────────────────────────────────
// Looks for spoken.txt in the same folder as the video
// Falls back to placeholder text if not found
function loadSpokenText() {
  const videoDir = path.dirname(inputVideo);
  const spokenPath = path.join(videoDir, 'spoken.txt');

  if (fs.existsSync(spokenPath)) {
    console.log(`  →  Found spoken.txt — using that for captions`);
    return fs.readFileSync(spokenPath, 'utf8').trim();
  }

  console.log('  →  No spoken.txt found — using placeholder caption text');
  return 'Boogle is building something great. Content that actually reaches people. Stop guessing what works. Start creating with purpose. This is what the algorithm actually wants from you.';
}

// ─── 10 CAPTION STYLES ───────────────────────────────────
// Colors use FFmpeg ASS format: &HAABBGGRR (alpha, blue, green, red)
// AA: 00=opaque, 80=50% transparent, FF=invisible
//
const STYLES = {
  1: {
    name: 'Simple White',
    desc: 'Clean white text, subtle outline — works everywhere',
    wordsPerLine: 4,
    style: 'FontName=Arial,FontSize=16,Bold=1,' +
           'PrimaryColour=&H00FFFFFF,' +   // white text
           'OutlineColour=&H00000000,' +   // black outline
           'Outline=2,Shadow=1,' +
           'Alignment=2,MarginV=60',       // bottom center
  },

  2: {
    name: 'Bold Impact',
    desc: 'Large bold text, thick outline — TikTok / Reels style',
    wordsPerLine: 3,
    style: 'FontName=Impact,FontSize=22,Bold=1,' +
           'PrimaryColour=&H00FFFFFF,' +
           'OutlineColour=&H00000000,' +
           'Outline=4,Shadow=0,' +
           'Alignment=2,MarginV=80',
  },

  3: {
    name: 'White Box',
    desc: 'Black text on white background — super clean and readable',
    wordsPerLine: 4,
    style: 'FontName=Arial,FontSize=15,Bold=1,' +
           'PrimaryColour=&H00000000,' +   // black text
           'BackColour=&H00FFFFFF,' +       // white box background
           'BorderStyle=3,' +              // opaque box mode
           'Outline=0,Shadow=0,' +
           'Alignment=2,MarginV=60',
  },

  4: {
    name: 'Yellow Classic',
    desc: 'Yellow bold text, black outline — YouTube / podcast style',
    wordsPerLine: 4,
    style: 'FontName=Arial,FontSize=17,Bold=1,' +
           'PrimaryColour=&H0000FFFF,' +   // yellow (BGR format)
           'OutlineColour=&H00000000,' +
           'Outline=2,Shadow=1,' +
           'Alignment=2,MarginV=60',
  },

  5: {
    name: 'Word by Word',
    desc: 'One word at a time, large, centered on screen',
    wordsPerLine: 1,
    style: 'FontName=Arial,FontSize=26,Bold=1,' +
           'PrimaryColour=&H00FFFFFF,' +
           'OutlineColour=&H00000000,' +
           'Outline=3,Shadow=0,' +
           'Alignment=5,MarginV=0',       // middle center
  },

  6: {
    name: 'Minimal',
    desc: 'Small, subtle, no outline — for clean aesthetic content',
    wordsPerLine: 5,
    style: 'FontName=Arial,FontSize=13,Bold=0,' +
           'PrimaryColour=&H00FFFFFF,' +
           'OutlineColour=&H00000000,' +
           'Outline=0,Shadow=2,' +
           'Alignment=2,MarginV=50',
  },

  7: {
    name: 'Dark Subtitle',
    desc: 'White text on dark semi-transparent box — Netflix style',
    wordsPerLine: 4,
    style: 'FontName=Arial,FontSize=15,Bold=0,' +
           'PrimaryColour=&H00FFFFFF,' +
           'BackColour=&H80000000,' +      // 50% transparent black box
           'BorderStyle=3,' +
           'Outline=0,Shadow=0,' +
           'Alignment=2,MarginV=60',
  },

  8: {
    name: 'Bold Red',
    desc: 'Red text, white outline — dramatic and attention-grabbing',
    wordsPerLine: 3,
    style: 'FontName=Arial,FontSize=19,Bold=1,' +
           'PrimaryColour=&H000000FF,' +   // red (BGR)
           'OutlineColour=&H00FFFFFF,' +   // white outline
           'Outline=2,Shadow=1,' +
           'Alignment=2,MarginV=70',
  },

  9: {
    name: 'Top Banner',
    desc: 'White text at the top of the screen',
    wordsPerLine: 4,
    style: 'FontName=Arial,FontSize=16,Bold=1,' +
           'PrimaryColour=&H00FFFFFF,' +
           'OutlineColour=&H00000000,' +
           'Outline=2,Shadow=1,' +
           'Alignment=8,MarginV=60',       // top center
  },

  10: {
    name: 'Neon Pop',
    desc: 'Bright cyan text, dark outline — modern creator look',
    wordsPerLine: 3,
    style: 'FontName=Arial,FontSize=18,Bold=1,' +
           'PrimaryColour=&H00FFFF00,' +   // cyan (BGR)
           'OutlineColour=&H00000000,' +
           'Outline=2,Shadow=1,' +
           'Alignment=2,MarginV=70',
  },
};

// ─────────────────────────────────────────────────────────
//  SHOW STYLE MENU AND GET CHOICE
// ─────────────────────────────────────────────────────────
function showMenu() {
  console.log('  Pick a caption style:\n');
  for (const [num, style] of Object.entries(STYLES)) {
    const numPad = String(num).padStart(3, ' ');
    console.log(`  ${numPad}. ${style.name.padEnd(18)} — ${style.desc}`);
  }
  console.log('');
}

function askForStyle() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('  Enter style number (1-10): ', (answer) => {
      rl.close();
      const num = parseInt(answer.trim());
      if (STYLES[num]) {
        resolve(num);
      } else {
        console.log('  Invalid choice — defaulting to Style 1 (Simple White)\n');
        resolve(1);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────
//  GENERATE SRT FROM TEXT
// ─────────────────────────────────────────────────────────
function generateSRT(text, wordsPerLine) {
  const WORDS_PER_MINUTE = 130;
  const MS_PER_WORD = (60 / WORDS_PER_MINUTE) * 1000;

  const cleaned = text
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/).filter(w => w.length > 0);
  const lines = [];
  let index = 1;
  let currentMs = 500;

  for (let i = 0; i < words.length; i += wordsPerLine) {
    const chunk = words.slice(i, i + wordsPerLine);
    const durationMs = chunk.length * MS_PER_WORD;
    const startMs = currentMs;
    const endMs = currentMs + durationMs;

    lines.push(`${index}`);
    lines.push(`${msToSRT(startMs)} --> ${msToSRT(endMs)}`);
    lines.push(chunk.join(' '));
    lines.push('');

    index++;
    currentMs = endMs + 80;
  }

  return lines.join('\n');
}

function msToSRT(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const ms2 = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms2).padStart(3, '0')}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

// ─────────────────────────────────────────────────────────
//  BURN CAPTIONS INTO VIDEO
// ─────────────────────────────────────────────────────────
function burnCaptions(inputVideo, srtPath, outputVideo, styleString) {
  return new Promise((resolve, reject) => {

    // Windows-safe path escaping for FFmpeg subtitles filter
    const safeSrtPath = srtPath
      .replace(/\\/g, '/')
      .replace(/:/g, '\\:');

    const subtitleFilter = `subtitles='${safeSrtPath}':force_style='${styleString}'`;

    ffmpeg(inputVideo)
      .videoFilters(subtitleFilter)
      .output(outputVideo)
      .on('start', () => {
        log('step', 'FFmpeg rendering...');
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          process.stdout.write(`  →  Rendering: ${Math.round(progress.percent)}%...\r`);
        }
      })
      .on('end', () => {
        console.log('');
        resolve();
      })
      .on('error', (err) => {
        console.log('');
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .run();
  });
}

// ─────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────
function log(type, msg) {
  const icons = { step: '→', done: '✅', error: '❌' };
  console.log(`  ${icons[type] || '·'}  ${msg}`);
}
function divider() { console.log('\n  ' + '─'.repeat(52) + '\n'); }

// ─────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────
async function run() {
  console.log('\n');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   BOOGLE  —  Caption Burner                     ║');
  console.log('  ║   by Content Psycho  —  10 Styles               ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  divider();

  // Pick style
  let styleNum;
  if (styleArg && STYLES[parseInt(styleArg)]) {
    styleNum = parseInt(styleArg);
    console.log(`  Style    : ${styleNum}. ${STYLES[styleNum].name}`);
    divider();
  } else {
    showMenu();
    styleNum = await askForStyle();
    console.log(`\n  Selected : ${styleNum}. ${STYLES[styleNum].name}`);
    divider();
  }

  const selectedStyle = STYLES[styleNum];

  // Load text
  const spokenText = loadSpokenText();

  // Build output paths
  const inputDir  = path.dirname(inputVideo);
  const inputName = path.basename(inputVideo, path.extname(inputVideo));
  const srtPath   = path.join(inputDir, `${inputName}_style${styleNum}.srt`);
  const outputVideo = path.join(inputDir, `${inputName}_style${styleNum}_${selectedStyle.name.replace(/\s+/g, '_')}.mp4`);

  console.log(`  Input    : ${path.basename(inputVideo)}`);
  console.log(`  Output   : ${path.basename(outputVideo)}`);
  divider();

  try {
    // Generate SRT with style's words-per-line setting
    log('step', `Generating captions (${selectedStyle.wordsPerLine} word${selectedStyle.wordsPerLine > 1 ? 's' : ''} per line)...`);
    const srt = generateSRT(spokenText, selectedStyle.wordsPerLine);
    fs.writeFileSync(srtPath, srt);
    log('done', `SRT saved → ${path.basename(srtPath)}`);

    // Burn captions
    await burnCaptions(inputVideo, srtPath, outputVideo, selectedStyle.style);
    log('done', `Video saved → ${path.basename(outputVideo)}`);

    divider();
    console.log(`  ✅  Done — Style ${styleNum}: ${selectedStyle.name}`);
    console.log(`\n  🎬  Watch → ${outputVideo}`);
    divider();
    console.log('  → Like the style? Use this number going forward:');
    console.log(`     node caption_burn.js "your_video.mp4" ${styleNum}`);
    console.log('  → Want to try another? Run the command again and pick a different number');
    console.log('  → Note: timing is estimated. AssemblyAI makes it frame-perfect on Monday.\n');

  } catch (err) {
    divider();
    log('error', err.message);
    if (err.message.toLowerCase().includes('no such filter')) {
      console.error('\n     → FFmpeg subtitle filter issue. Try running: npm install\n');
    }
    if (err.message.toLowerCase().includes('invalid data')) {
      console.error('\n     → The video file may be corrupted or in an unsupported format\n');
    }
    console.error('     → Paste the full error in the chat for an immediate fix.\n');
    process.exit(1);
  }
}

run();
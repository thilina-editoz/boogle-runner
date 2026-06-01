// ─────────────────────────────────────────────────────────
//  BOOGLE by Content Psycho — Unified Pipeline (Stage 5)
//  One command. Full output.
//
//  Usage:
//  node generate.js "your topic here"
//  node generate.js "your topic here" 3   ← style 3 captions
//
//  Caption styles (1-10):
//  1 Simple White  2 Bold Impact  3 White Box   4 Yellow Classic
//  5 Word by Word  6 Minimal      7 Dark Sub     8 Bold Red
//  9 Top Banner   10 Neon Pop
// ─────────────────────────────────────────────────────────

require('dotenv').config();
const Anthropic  = require('@anthropic-ai/sdk');
const ffmpeg     = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const { postContent } = require('./post');
const { uploadToR2 } = require('./r2-upload');
const { loadBrandConfig, withFallbacks } = require('./worker/brand-config');
const { isExecutorEnabled, loadEdl, isValidEdl, composeFromEdl } = require('./edit-brain/executor');

ffmpeg.setFfmpegPath(ffmpegPath);

// ─── Optional --brand <uuid> ──────────────────────────────
// When passed, voice/avatar/caption/audience config for that brand
// is loaded from Supabase and overrides the .env defaults. Without
// --brand, generate.js behaves exactly as before (env-driven).
function readFlag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`\n  ❌  ${name} requires a value\n`);
    process.exit(1);
  }
  return v;
}

const BRAND_ID         = readFlag('--brand');
const CONTENT_PIECE_ID = readFlag('--content-piece') || process.env.BOOGLE_CONTENT_PIECE_ID || null;

// Edit Brain EDL (Stage 12.3). Passed by the worker as `--edl <tmpfile>`
// (or BOOGLE_EDL_JSON). Only consumed when EDIT_BRAIN_EXECUTOR is on AND
// the EDL is schema-valid — otherwise the legacy single-shot path runs.
const EDL = loadEdl();

// Positional args (topic, caption style) excluding the named flags
const POSITIONAL = (() => {
  const skip = new Set(['--brand', '--content-piece', '--edl']);
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (skip.has(process.argv[i])) { i++; continue; }
    out.push(process.argv[i]);
  }
  return out;
})();

// ─────────────────────────────────────────────────────────
//  CAPTION STYLES
// ─────────────────────────────────────────────────────────
const CAPTION_STYLES = {
  1:  { name: 'Simple White',    wordsPerLine: 4, style: 'FontName=Arial,FontSize=16,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=60' },
  2:  { name: 'Bold Impact',     wordsPerLine: 3, style: 'FontName=Impact,FontSize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=4,Shadow=0,Alignment=2,MarginV=80' },
  3:  { name: 'White Box',       wordsPerLine: 4, style: 'FontName=Arial,FontSize=15,Bold=1,PrimaryColour=&H00000000,BackColour=&H00FFFFFF,BorderStyle=3,Outline=0,Shadow=0,Alignment=2,MarginV=60' },
  4:  { name: 'Yellow Classic',  wordsPerLine: 4, style: 'FontName=Arial,FontSize=17,Bold=1,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=60' },
  5:  { name: 'Word by Word',    wordsPerLine: 1, style: 'FontName=Arial,FontSize=26,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,Shadow=0,Alignment=5,MarginV=0' },
  6:  { name: 'Minimal',         wordsPerLine: 5, style: 'FontName=Arial,FontSize=13,Bold=0,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=0,Shadow=2,Alignment=2,MarginV=50' },
  7:  { name: 'Dark Subtitle',   wordsPerLine: 4, style: 'FontName=Arial,FontSize=15,Bold=0,PrimaryColour=&H00FFFFFF,BackColour=&H80000000,BorderStyle=3,Outline=0,Shadow=0,Alignment=2,MarginV=60' },
  8:  { name: 'Bold Red',        wordsPerLine: 3, style: 'FontName=Arial,FontSize=19,Bold=1,PrimaryColour=&H000000FF,OutlineColour=&H00FFFFFF,Outline=2,Shadow=1,Alignment=2,MarginV=70' },
  9:  { name: 'Top Banner',      wordsPerLine: 4, style: 'FontName=Arial,FontSize=16,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=8,MarginV=60' },
  10: { name: 'Neon Pop',        wordsPerLine: 3, style: 'FontName=Arial,FontSize=18,Bold=1,PrimaryColour=&H00FFFF00,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=70' },
};

// ─────────────────────────────────────────────────────────
//  VALIDATE REQUIRED ENV
// ─────────────────────────────────────────────────────────
// HEYGEN_AVATAR_ID can come from voice_avatar_config when --brand is set,
// so it's only required up-front when no brand override is available.
const REQUIRED = {
  ANTHROPIC_API_KEY: 'Claude (scripts)',
  HEYGEN_API_KEY:    'HeyGen (avatar)',
  HEYGEN_VOICE_ID:   'HeyGen (voice ID)',
  ...(BRAND_ID ? {} : { HEYGEN_AVATAR_ID: 'HeyGen (avatar ID)' }),
};

let missingKeys = false;
for (const [key, label] of Object.entries(REQUIRED)) {
  if (!process.env[key] || process.env[key].includes('your_') || process.env[key] === '') {
    console.error(`  ❌  Missing ${key} (${label}) in .env`);
    missingKeys = true;
  }
}
if (missingKeys) {
  console.error('\n  → Open .env and fill in the missing keys\n');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── ARGS + TREND AUTO-PICK ──────────────────────────────
function getTopic() {
  if (POSITIONAL[0]) return { topic: POSITIONAL[0], fromTrends: false };
  const trendsPath = path.join('trends', 'today.json');
  if (fs.existsSync(trendsPath)) {
    try {
      const trends = JSON.parse(fs.readFileSync(trendsPath, 'utf8'));
      const top    = trends.topics?.[0];
      if (top?.topic) {
        console.log("\n  📈  Auto-picked from today's trends:");
        console.log('      "' + top.topic + '"');
        console.log('      Hook: "' + top.hook + '"\n');
        return { topic: top.topic, hook: top.hook, fromTrends: true };
      }
    } catch {}
  }
  return { topic: 'Why most creators fail in the first 90 days', fromTrends: false };
}
const { topic, hook: trendHook, fromTrends } = getTopic();

// ─── BRAND CONFIG (env defaults; overridden by --brand at run() time) ──
// `let` not `const` so loadBrandConfig() can override these without a
// second mutable layer. Mirrors the scrape.js pattern.
let config = {
  niche:             process.env.NICHE                || 'content creation and personal branding',
  primaryAudience:   process.env.PRIMARY_AUDIENCE     || 'aspiring creators aged 22-35',
  country:           process.env.TARGET_COUNTRY       || 'US',
  language:          process.env.TARGET_LANGUAGE      || 'English',
  gender:            process.env.AUDIENCE_GENDER      || 'all',
  ageRange:          process.env.AUDIENCE_AGE_RANGE   || '22-35',
  painPoints:        process.env.AUDIENCE_PAIN_POINTS || 'not getting views, no strategy, no time',
  aspirations:       process.env.AUDIENCE_ASPIRATIONS || 'build an audience, monetise their knowledge',
  tone:              process.env.TONE                 || 'direct, experienced, no fluff',
  bannedTopics:      process.env.BANNED_TOPICS        || 'none',
  referenceCreators: process.env.REFERENCE_CREATORS   || 'Gary Vee, Alex Hormozi',
  // HeyGen / ElevenLabs IDs — brand override replaces these when available.
  avatarId:          process.env.HEYGEN_AVATAR_ID     || null,
  voiceId:           process.env.ELEVENLABS_VOICE_ID  || null,
  voiceModel:        process.env.ELEVENLABS_MODEL     || 'eleven_turbo_v2_5',
  captionStyle:      parseInt(process.env.CAPTION_STYLE) || null,
};

// Caption style: explicit CLI arg wins, then brand DB (resolved in run()),
// then env, then default 1. We resolve the final value after the merge.
const cliStyleNum = parseInt(POSITIONAL[1]);
let styleNum      = Number.isFinite(cliStyleNum) ? cliStyleNum : (config.captionStyle || 1);
let captionStyle  = CAPTION_STYLES[styleNum] || CAPTION_STYLES[1];

// ─────────────────────────────────────────────────────────
//  STEP 1 — SCRIPT (Claude)
// ─────────────────────────────────────────────────────────
async function generateScript(topic) {
  log('step', 'Step 1/6 — Generating script with Claude...');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `You are a viral short-form content scriptwriter specialising in the following niche.

NICHE: ${config.niche}
TARGET COUNTRY: ${config.country}
TARGET LANGUAGE: ${config.language}
PRIMARY AUDIENCE: ${config.primaryAudience}
AUDIENCE GENDER: ${config.gender}
AUDIENCE AGE RANGE: ${config.ageRange}
AUDIENCE PAIN POINTS: ${config.painPoints}
AUDIENCE ASPIRATIONS: ${config.aspirations}
TONE: ${config.tone}
BANNED TOPICS: ${config.bannedTopics}
REFERENCE CREATORS (voice/style only): ${config.referenceCreators}

TOPIC: ${topic}

FORMAT: Vertical short-form video (TikTok / Instagram Reels / YouTube Shorts)
TARGET LENGTH: 30-40 seconds when spoken at a natural pace

Write using this exact structure:

─── SPOKEN SCRIPT ───
[3-4 short punchy beats. Each beat 1-2 sentences. Write for speech not reading. No filler words.]

─── HOOK (0-3 seconds) ───
[The opening line pulled out separately]

─── B-ROLL NOTES ───
[3-4 specific shot suggestions]

─── POST CAPTION ───
[Platform caption. Hook first. 3 sentences max.]

─── HASHTAGS ───
[6-8 hashtags. Mix broad and niche. Native to ${config.country}.]

─── HOOK ALTERNATIVE ───
[One alternative opening line]

Rules: 3-4 beats max. Conversational. Never sound like AI. Tone: ${config.tone}.`
    }]
  });

  return response.content[0].text;
}

// ─────────────────────────────────────────────────────────
//  STEP 2 — EXTRACT SPOKEN TEXT
// ─────────────────────────────────────────────────────────
function extractSpokenText(script) {
  const match = script.match(/─── SPOKEN SCRIPT ───\n([\s\S]*?)─── HOOK/);
  if (match && match[1]) {
    return match[1].replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '').trim();
  }
  return script
    .replace(/─── .* ───/g, '')
    .replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '')
    .replace(/#\w+/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ─────────────────────────────────────────────────────────
//  STEP 3 — VOICE (ElevenLabs or stub)
// ─────────────────────────────────────────────────────────
async function generateVoice(spokenText, folder) {
  const hasElevenLabs = process.env.ELEVENLABS_API_KEY &&
                        config.voiceId &&
                        !process.env.ELEVENLABS_API_KEY.includes('your_');

  if (hasElevenLabs) {
    log('step', 'Step 3/6 — Generating voice clone with ElevenLabs...');

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
          },
          body: JSON.stringify({
            text: spokenText,
            model_id: config.voiceModel || 'eleven_turbo_v2_5',
            voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true },
          }),
        }
      );

      // Handle payment / plan errors gracefully — fall back to stub
      if (response.status === 402 || response.status === 401) {
        const errData = await response.text();
        console.log('');
        log('step', `ElevenLabs needs paid plan — skipping voice, continuing pipeline`);
        console.log(`         → Upgrade at elevenlabs.io to activate voice clone`);
        return { status: 'stub', file: null, note: 'ElevenLabs plan required — upgrade to activate' };
      }

      if (!response.ok) {
        const err = await response.text();
        log('step', `ElevenLabs error (${response.status}) — skipping voice, continuing pipeline`);
        return { status: 'stub', file: null, note: `ElevenLabs error: ${response.status}` };
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const audioPath = path.join(folder, 'audio.mp3');
      fs.writeFileSync(audioPath, audioBuffer);
      log('done', `Voice saved → audio.mp3 (${(audioBuffer.length / 1024).toFixed(0)} KB)`);
      return { status: 'real', file: audioPath };

    } catch (voiceErr) {
      log('step', `Voice generation skipped: ${voiceErr.message}`);
      return { status: 'stub', file: null, note: voiceErr.message };
    }

  } else {
    log('step', 'Step 3/6 — Voice (stub — add ElevenLabs keys to .env to activate)');
    await sleep(200);
    return { status: 'stub', file: null, note: 'Add ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID to activate' };
  }
}

// ─────────────────────────────────────────────────────────
//  STEP 4 — AVATAR VIDEO (HeyGen)
// ─────────────────────────────────────────────────────────
async function generateAvatarVideo(spokenText) {
  log('step', 'Step 4/6 — Submitting to HeyGen...');

  const submitRes = await fetch('https://api.heygen.com/v2/video/generate', {
    method: 'POST',
    headers: {
      'X-Api-Key': process.env.HEYGEN_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      video_inputs: [{
        character: {
          type: 'avatar',
          avatar_id: config.avatarId,
          avatar_style: 'normal',
        },
        voice: {
          type: 'text',
          input_text: spokenText,
          voice_id: process.env.HEYGEN_VOICE_ID,
          speed: 1.0,
        },
        background: { type: 'color', value: '#000000' },
      }],
      dimension: { width: 1080, height: 1920 },
      caption: false,
      test: false,
    }),
  });

  if (!submitRes.ok) {
    const err = await submitRes.text();
    throw new Error(`HeyGen submit failed (${submitRes.status}): ${err}`);
  }

  const submitData = await submitRes.json();
  const videoId = submitData.data?.video_id;
  if (!videoId) throw new Error(`HeyGen did not return a video_id: ${JSON.stringify(submitData)}`);

  log('done', `Job submitted → ID: ${videoId}`);
  log('step', 'Waiting for HeyGen to render (2-8 minutes)...');

  // Poll until complete
  let attempts = 0;
  while (attempts < 90) {
    await sleep(10000);
    attempts++;

    const statusRes = await fetch(
      `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
      { headers: { 'X-Api-Key': process.env.HEYGEN_API_KEY } }
    );

    if (!statusRes.ok) throw new Error(`HeyGen status check failed (${statusRes.status})`);

    const statusData = await statusRes.json();
    const status = statusData.data?.status;
    process.stdout.write(`  →  Status: ${status} (${attempts * 10}s)...\r`);

    if (status === 'completed') {
      console.log('');
      const videoUrl = statusData.data?.video_url;
      if (!videoUrl) throw new Error('HeyGen completed but no video_url returned');
      log('done', 'Render complete');
      return { videoId, videoUrl };
    }

    if (status === 'failed') {
      console.log('');
      throw new Error(`HeyGen render failed: ${statusData.data?.error || 'unknown error'}`);
    }
  }

  throw new Error('HeyGen timed out — check heygen.com/videos for your video');
}

// ─────────────────────────────────────────────────────────
//  STEP 4b — DOWNLOAD VIDEO
// ─────────────────────────────────────────────────────────
async function downloadVideo(videoUrl, folder) {
  log('step', 'Downloading video from HeyGen...');
  const videoPath = path.join(folder, 'avatar_video.mp4');

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(videoPath);

    const handleResponse = (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        https.get(response.headers.location, handleResponse).on('error', reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        const sizeMB = (fs.statSync(videoPath).size / (1024 * 1024)).toFixed(1);
        log('done', `Video downloaded → avatar_video.mp4 (${sizeMB} MB)`);
        resolve(videoPath);
      });
    };

    https.get(videoUrl, handleResponse)
      .on('error', (err) => { fs.unlink(videoPath, () => {}); reject(err); });

    file.on('error', (err) => { fs.unlink(videoPath, () => {}); reject(err); });
  });
}

// ─────────────────────────────────────────────────────────
//  STEP 5 — CAPTIONS (AssemblyAI or estimated SRT)
// ─────────────────────────────────────────────────────────
async function generateCaptions(audioFile, spokenText, folder) {
  const hasAssemblyAI = process.env.ASSEMBLYAI_API_KEY &&
                        !process.env.ASSEMBLYAI_API_KEY.includes('your_') &&
                        audioFile;

  if (hasAssemblyAI) {
    log('step', 'Step 5/6 — Generating frame-perfect captions with AssemblyAI...');

    const audioData = fs.readFileSync(audioFile);
    const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY, 'content-type': 'application/octet-stream' },
      body: audioData,
    });
    if (!uploadRes.ok) throw new Error(`AssemblyAI upload failed: ${uploadRes.status}`);
    const { upload_url } = await uploadRes.json();

    const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: upload_url, punctuate: true, format_text: true }),
    });
    if (!transcriptRes.ok) throw new Error(`AssemblyAI transcript request failed: ${transcriptRes.status}`);
    const { id: transcriptId } = await transcriptRes.json();

    let transcript;
    let attempts = 0;
    log('step', 'Processing captions...');
    while (true) {
      await sleep(3000);
      attempts++;
      const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
      });
      transcript = await pollRes.json();
      if (transcript.status === 'completed') break;
      if (transcript.status === 'error') throw new Error(`AssemblyAI error: ${transcript.error}`);
      if (attempts > 40) throw new Error('AssemblyAI timed out');
      process.stdout.write(`  →  ${attempts * 3}s...\r`);
    }
    console.log('');

    const srt = buildSRT(transcript.words, captionStyle.wordsPerLine);
    const srtPath = path.join(folder, 'captions.srt');
    fs.writeFileSync(srtPath, srt);
    log('done', 'Frame-perfect captions saved → captions.srt');
    return { status: 'real', file: srtPath };

  } else {
    log('step', 'Step 5/6 — Generating estimated captions from script...');
    const srt = buildEstimatedSRT(spokenText, captionStyle.wordsPerLine);
    const srtPath = path.join(folder, 'captions.srt');
    fs.writeFileSync(srtPath, srt);
    log('done', 'Estimated captions saved → captions.srt');
    return { status: 'estimated', file: srtPath, note: 'Add ASSEMBLYAI_API_KEY for frame-perfect sync' };
  }
}

// ─────────────────────────────────────────────────────────
//  STEP 6 — BURN CAPTIONS INTO VIDEO
// ─────────────────────────────────────────────────────────
async function burnCaptions(videoPath, srtPath, folder) {
  log('step', `Step 6/6 — Burning captions (Style ${styleNum}: ${captionStyle.name})...`);

  const outputPath = path.join(folder, 'final_video.mp4');
  const safeSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const filter = `subtitles='${safeSrtPath}':force_style='${captionStyle.style}'`;

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .videoFilters(filter)
      .output(outputPath)
      .on('progress', (p) => {
        if (p.percent) process.stdout.write(`  →  Burning: ${Math.round(p.percent)}%...\r`);
      })
      .on('end', () => {
        console.log('');
        log('done', 'Captions burned → final_video.mp4');
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.log('');
        reject(new Error(`Caption burn failed: ${err.message}`));
      })
      .run();
  });
}

// ─────────────────────────────────────────────────────────
//  SRT BUILDERS
// ─────────────────────────────────────────────────────────
function buildSRT(words, wordsPerLine) {
  if (!words || !words.length) return '';
  const lines = [];
  let index = 1;
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + wordsPerLine);
    lines.push(`${index}\n${msToSRT(chunk[0].start)} --> ${msToSRT(chunk[chunk.length - 1].end)}\n${chunk.map(w => w.text).join(' ')}\n`);
    index++;
    i += wordsPerLine;
  }
  return lines.join('\n');
}

function buildEstimatedSRT(text, wordsPerLine) {
  const MS_PER_WORD = (60 / 130) * 1000;
  const cleaned = text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '').replace(/\n+/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(w => w.length > 0);
  const lines = [];
  let index = 1;
  let currentMs = 500;
  for (let i = 0; i < words.length; i += wordsPerLine) {
    const chunk = words.slice(i, i + wordsPerLine);
    const durationMs = chunk.length * MS_PER_WORD;
    lines.push(`${index}\n${msToSRT(currentMs)} --> ${msToSRT(currentMs + durationMs)}\n${chunk.join(' ')}\n`);
    index++;
    currentMs += durationMs + 80;
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
//  UTILITIES
// ─────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
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
  console.log('  ║   BOOGLE  —  Unified Content Pipeline           ║');
  console.log('  ║   by Content Psycho  —  Stage 5                 ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  divider();

  // ── Brand override (when --brand <uuid> passed) ──────────
  if (BRAND_ID) {
    try {
      log('step', `Loading brand config from Supabase (${BRAND_ID})...`);
      const brandCfg = await loadBrandConfig(BRAND_ID);
      config = withFallbacks(brandCfg, config);
      // CLI caption-style arg still wins over the brand setting.
      if (!Number.isFinite(cliStyleNum) && brandCfg.captionStyle) {
        styleNum     = brandCfg.captionStyle;
        captionStyle = CAPTION_STYLES[styleNum] || CAPTION_STYLES[1];
      }
      log('done', `Brand config loaded: ${brandCfg.brand_name ?? BRAND_ID}`);
    } catch (e) {
      log('error', `loadBrandConfig failed: ${e.message}`);
      console.error('         → Falling back to .env values\n');
    }
  }

  // ── Post-merge validation: avatar_id must exist somewhere ──
  if (!config.avatarId) {
    console.error('  ❌  No avatar_id available — set HEYGEN_AVATAR_ID in .env or save one in voice_avatar_config for this brand\n');
    process.exit(1);
  }

  console.log(`  Topic    : ${topic}`);
  console.log(`  Audience : ${config.primaryAudience}`);
  console.log(`  Country  : ${config.country}  |  Language: ${config.language}`);
  console.log(`  Avatar   : ${config.avatarId}${BRAND_ID ? '  (from brand)' : ''}`);
  console.log(`  Captions : Style ${styleNum} — ${captionStyle.name}`);

  // Show which APIs are active
  const voiceActive    = process.env.ELEVENLABS_API_KEY && config.voiceId && !process.env.ELEVENLABS_API_KEY.includes('your_');
  const captionsActive = process.env.ASSEMBLYAI_API_KEY && !process.env.ASSEMBLYAI_API_KEY.includes('your_');
  console.log(`  Voice    : ${voiceActive ? '✅ ElevenLabs' : '⏳ Stub (add key Monday)'}`);
  console.log(`  Captions : ${captionsActive ? '✅ AssemblyAI (frame-perfect)' : '⏳ Estimated timing'}`);
  divider();

  // Create output folder
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const folder = path.join('output', `${timestamp}_${slug}`);
  fs.mkdirSync(folder, { recursive: true });

  const pipelineState = {
    tool: 'Boogle by Content Psycho',
    stage: 5,
    topic,
    captionStyle: { num: styleNum, name: captionStyle.name },
    generatedAt: new Date().toISOString(),
    audienceConfig: config,
    steps: {}
  };

  try {
    // ── Step 1: Script ──────────────────────────────────
    const script = await generateScript(topic);
    fs.writeFileSync(path.join(folder, 'script.txt'), script);
    pipelineState.steps.script = { status: 'done', file: 'script.txt' };
    log('done', 'Script saved → script.txt');

    const spokenText = extractSpokenText(script);
    fs.writeFileSync(path.join(folder, 'spoken.txt'), spokenText);
    pipelineState.steps.spoken = { status: 'done', file: 'spoken.txt' };

    divider();
    console.log('  SCRIPT PREVIEW:\n');
    script.split('\n').slice(0, 20).forEach(line => console.log('  ' + line));
    if (script.split('\n').length > 20) console.log('  ... (see script.txt for full script)');
    divider();

    // ── Step 3: Voice ───────────────────────────────────
    const audio = await generateVoice(spokenText, folder);
    pipelineState.steps.voice = audio;

    // ── Step 4: Avatar video ────────────────────────────
    let videoPath = null;
    try {
      const { videoId, videoUrl } = await generateAvatarVideo(spokenText);
      videoPath = await downloadVideo(videoUrl, folder);
      pipelineState.steps.avatar = { status: 'done', videoId, file: 'avatar_video.mp4' };
    } catch (heygenErr) {
      console.log('');
      log('error', `HeyGen skipped: ${heygenErr.message}`);
      console.log('         → Top up HeyGen credits and re-run to generate the video');
      pipelineState.steps.avatar = { status: 'skipped', reason: heygenErr.message };
    }

    // ── Step 5: Captions ────────────────────────────────
    const captions = await generateCaptions(audio.file, spokenText, folder);
    pipelineState.steps.captions = captions;

    // ── Step 6: Burn captions ───────────────────────────
    if (videoPath && captions.file) {
      let rendered = false;

      // ── Edit Brain executor (Stage 12.3) — flag-gated, best-effort ──
      // When EDIT_BRAIN_EXECUTOR is on and the dashboard supplied a valid
      // EDL, render through the executor (safe-zone caption placement +
      // music bed). ANY failure falls through to the legacy single-shot
      // burn below, so a bad EDL can never regress a working render.
      if (isExecutorEnabled() && isValidEdl(EDL)) {
        try {
          await composeFromEdl({ edl: EDL, videoPath, srtPath: captions.file, folder, captionStyle });
          pipelineState.steps.finalVideo = { status: 'done', file: 'final_video.mp4', via: 'edit-brain' };
          pipelineState.editBrain = { used: true, platform: EDL.platform, segments: EDL.segments.length };
          log('done', 'Edit Brain executor render → final_video.mp4');
          rendered = true;
        } catch (edlErr) {
          log('error', `Edit Brain executor failed: ${edlErr.message} — falling back to legacy burn`);
          pipelineState.editBrain = { used: false, reason: edlErr.message };
        }
      } else if (EDL && !isValidEdl(EDL)) {
        pipelineState.editBrain = { used: false, reason: 'EDL present but invalid' };
      }

      if (!rendered) {
        try {
          const finalPath = await burnCaptions(videoPath, captions.file, folder);
          pipelineState.steps.finalVideo = { status: 'done', file: 'final_video.mp4' };
        } catch (burnErr) {
          log('error', `Caption burn failed: ${burnErr.message}`);
          pipelineState.steps.finalVideo = { status: 'failed', reason: burnErr.message };
          console.log('         → Video saved without captions as avatar_video.mp4');
        }
      }
    } else {
      pipelineState.steps.finalVideo = {
        status: 'skipped',
        reason: videoPath ? 'No captions file' : 'No video (HeyGen skipped)'
      };
    }

    // ── Step 7: Upload to R2 + post via dashboard ──────────
    const finalVideoPath = pipelineState.steps.finalVideo?.status === 'done'
      ? path.join(folder, 'final_video.mp4')
      : videoPath
        ? path.join(folder, 'avatar_video.mp4')
        : null;

    const postApproval    = process.env.POST_APPROVAL !== 'false';
    const dashboardReady  = process.env.BOOGLE_DASHBOARD_URL &&
                            process.env.BOOGLE_INTERNAL_TOKEN &&
                            process.env.BOOGLE_USER_ID;
    // runId namespaces the R2 object key — derived from the output folder name.
    const runId = path.basename(folder);

    if (!finalVideoPath) {
      pipelineState.steps.posting = { status: 'skipped', reason: 'No video file generated yet' };

    } else if (!dashboardReady) {
      log('step', 'Posting skipped — add BOOGLE_DASHBOARD_URL, BOOGLE_INTERNAL_TOKEN, BOOGLE_USER_ID to .env');
      pipelineState.steps.posting = { status: 'skipped', reason: 'Dashboard env not configured' };

    } else {
      // Upload first so the R2 URL exists even if posting is gated by approval.
      let r2Url = null;
      try {
        log('step', 'Uploading video to R2 via dashboard...');
        const up = await uploadToR2({ localPath: finalVideoPath, runId });
        r2Url = up.publicUrl;
        pipelineState.steps.r2 = { status: 'done', key: up.key, url: up.publicUrl, bytes: up.bytes };
        log('done', `Video on R2 → ${up.publicUrl}`);
      } catch (r2Err) {
        log('error', `R2 upload failed: ${r2Err.message}`);
        pipelineState.steps.r2 = { status: 'failed', reason: r2Err.message };
      }

      if (!r2Url) {
        pipelineState.steps.posting = { status: 'skipped', reason: 'R2 upload failed' };

      } else if (postApproval) {
        log('step', 'Post approval is ON — video uploaded to R2, awaiting your approval to publish');
        console.log('         → Set POST_APPROVAL=false in .env to auto-publish');
        pipelineState.steps.posting = {
          status: 'pending_approval',
          file:   path.basename(finalVideoPath),
          r2Url,
        };

      } else {
        const captionMatch = script.match(/─── POST CAPTION ───\n([\s\S]*?)─── HASHTAGS/);
        const hashtagMatch = script.match(/─── HASHTAGS ───\n([\s\S]*?)─── HOOK ALTERNATIVE/);
        const caption      = captionMatch ? captionMatch[1].trim() : topic;
        const hashtags     = hashtagMatch ? hashtagMatch[1].trim() : '';

        log('step', 'Step 7/7 — Publishing via dashboard...');
        const postResult = await postContent({
          r2Url,
          caption,
          hashtags,
          folder,
          brandId:        BRAND_ID,
          contentPieceId: CONTENT_PIECE_ID,
        });

        pipelineState.steps.posting = postResult;
        if (postResult.status === 'success') {
          log('done', `Posted to ${postResult.succeeded} platform(s) successfully`);
        } else if (postResult.status === 'partial') {
          log('done', `Posted to ${postResult.succeeded} platform(s) — ${postResult.failed} failed`);
        }
      }
    }

    // ── Save pipeline summary ───────────────────────────
    fs.writeFileSync(
      path.join(folder, 'pipeline.json'),
      JSON.stringify(pipelineState, null, 2)
    );

    // ── Final summary ───────────────────────────────────
    divider();
    log('done', 'Pipeline complete');
    console.log(`\n  📁  ${folder}\n`);
    console.log(`  📄  script.txt          full script + caption + hashtags`);
    console.log(`  🗣️   spoken.txt          voice-ready text`);
    if (pipelineState.steps.voice?.status === 'real')
    console.log(`  🎙️   audio.mp3           voice clone audio`);
    if (pipelineState.steps.avatar?.status === 'done')
    console.log(`  🎬  avatar_video.mp4    raw avatar video`);
    if (pipelineState.steps.finalVideo?.status === 'done')
    console.log(`  ✨  final_video.mp4     captioned final video ← this is your post`);
    console.log(`  📋  pipeline.json       full run summary`);
    divider();

    // Activation reminders
    const pending = [];
    if (!voiceActive)    pending.push('ElevenLabs (voice clone) → add ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID');
    if (!captionsActive) pending.push('AssemblyAI (frame-perfect captions) → add ASSEMBLYAI_API_KEY');
    if (pipelineState.steps.avatar?.status === 'skipped') pending.push('HeyGen credits → top up at heygen.com');

    if (pending.length > 0) {
      console.log('  ⚡  Activate when ready:\n');
      pending.forEach(p => console.log(`     • ${p}`));
      console.log('');
    }

  } catch (err) {
    divider();
    log('error', err.message);
    fs.writeFileSync(path.join(folder, 'pipeline.json'), JSON.stringify({ ...pipelineState, error: err.message }, null, 2));
    if (err.message.includes('401'))        console.error('\n     → An API key is wrong — check .env\n');
    if (err.message.includes('ElevenLabs')) console.error('\n     → Check ELEVENLABS_API_KEY in .env\n');
    if (err.message.includes('HeyGen'))     console.error('\n     → Check HEYGEN_API_KEY and HEYGEN_AVATAR_ID in .env\n');
    console.error('     → Paste this full error in the chat for an immediate fix.\n');
    process.exit(1);
  }
}

run();
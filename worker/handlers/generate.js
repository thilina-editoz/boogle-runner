// ─────────────────────────────────────────────────────────
//  Generate handler — spawns the existing generate.js CLI.
//
//  Supports graceful pause: before each step boundary we'd normally
//  check the DB for a pause request. V1 keeps it simple — the handler
//  runs end-to-end; pause kicks in for the NEXT piece (handlePause
//  flags the piece in content_pieces).
//
//  Topic resolution:
//   - job.payload.topic     → explicit topic string
//   - job.target_id         → content_pieces.id, look up the title
//   - else                  → error (need something to generate)
// ─────────────────────────────────────────────────────────

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { updatePieceStatus, writePieceOutput, writePieceMedia } = require('../api');

// Content types that DON'T use the avatar-video path. These run through
// generate-image.js (image generation) instead of generate.js (HeyGen).
// reel/story (+ anything unknown) stay on the video path. Mirrors the
// dashboard's lib/edit-brain/content-mode.ts.
const NON_VIDEO_TYPES = new Set(['carousel', 'image', 'text']);

// Pull the last [[MARKER]]{json} object a generate script prints on stdout.
// generate.js emits PIECE_OUTPUT (video_url / caption / captions_srt);
// generate-image.js emits PIECE_OUTPUT (caption / thumbnail_url) and
// PIECE_MEDIA (the carousel/image slides). Returns null when absent.
function parseMarker(stdout, marker) {
  const re = new RegExp(`\\[\\[${marker}\\]\\](\\{.*\\})`, 'g');
  const matches = String(stdout || '').match(re);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1].replace(new RegExp(`^\\[\\[${marker}\\]\\]`), '');
  try {
    const o = JSON.parse(last);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

function parsePieceOutput(stdout) {
  return parseMarker(stdout, 'PIECE_OUTPUT');
}

// Write the EDL (when the dashboard Director produced one) to a temp file
// and return its path so we can hand generate.js `--edl <path>`. Inline
// JSON on argv would be fragile at EDL sizes; a temp file is robust and
// the executor reads it the same way. Returns null when there's no EDL.
function writeEdlTemp(job) {
  const edl = job && job.payload && job.payload.edl;
  if (!edl || typeof edl !== 'object') return null;
  try {
    const file = path.join(os.tmpdir(), `boogle-edl-${job.id}.json`);
    fs.writeFileSync(file, JSON.stringify(edl));
    return file;
  } catch (err) {
    console.error(`    [generate] could not stage EDL temp file: ${err.message}`);
    return null;
  }
}

// Same idea for the non-video asset plan (carousel/image/text). Inline JSON
// on argv would be fragile, so we stage it to a temp file and hand
// generate-image.js `--asset-plan <path>`. Returns null when there's none.
function writeAssetPlanTemp(job) {
  const plan = job && job.payload && job.payload.asset_plan;
  if (!plan || typeof plan !== 'object') return null;
  try {
    const file = path.join(os.tmpdir(), `boogle-plan-${job.id}.json`);
    fs.writeFileSync(file, JSON.stringify(plan));
    return file;
  } catch (err) {
    console.error(`    [generate] could not stage asset-plan temp file: ${err.message}`);
    return null;
  }
}

const PIPELINE_ROOT   = path.resolve(__dirname, '..', '..');
const GENERATE_SCRIPT = path.join(PIPELINE_ROOT, 'generate.js');
const IMAGE_SCRIPT    = path.join(PIPELINE_ROOT, 'generate-image.js');

async function resolveTopic(job) {
  if (job.payload && typeof job.payload.topic === 'string' && job.payload.topic.trim()) {
    return job.payload.topic.trim();
  }
  // Phase 1b: the runner no longer has direct DB access to look up a
  // piece title. The dashboard's approval cascade always includes
  // payload.topic when enqueuing a generate job, so this is the only
  // supported path now.
  throw new Error('generate job needs payload.topic (set by the dashboard approval cascade)');
}

function runScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...args], {
      cwd: PIPELINE_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      process.stdout.write(`    [generate] ${s}`);
    });
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(`    [generate:err] ${s}`);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`generate.js exited with code ${code}\n${stderr.slice(-500)}`));
    });
  });
}

async function handleGenerate(job) {
  const topic = await resolveTopic(job);
  // Content Types (C3): branch by the piece type the dashboard stamped on
  // the job. carousel/image/text → generate-image.js (image generation);
  // reel/story + anything unknown → generate.js (the avatar-video path).
  const contentType = String(job.payload?.content_type || 'reel').toLowerCase();
  const isNonVideo = NON_VIDEO_TYPES.has(contentType);

  // caption_style in payload wins; otherwise generate.js resolves brand
  // setting → env → default. Pass empty string positionally if absent so
  // --brand still lands at the right argv index.
  const explicitStyle = job.payload?.caption_style;
  const args = [topic];
  if (explicitStyle != null) args.push(String(explicitStyle));
  if (job.brand_id)  args.push('--brand', job.brand_id);
  if (job.target_id) args.push('--content-piece', job.target_id);

  let stdout;
  if (isNonVideo) {
    // Non-video path: hand generate-image.js the asset plan + content type.
    const planPath = writeAssetPlanTemp(job);
    args.push('--content-type', contentType);
    if (planPath) args.push('--asset-plan', planPath);
    try {
      ({ stdout } = await runScript(IMAGE_SCRIPT, args));
    } finally {
      if (planPath) { try { fs.unlinkSync(planPath); } catch { /* best-effort cleanup */ } }
    }
  } else {
    // Edit Brain (Stage 12.3): hand generate.js the EDL when present. It's
    // only acted on if EDIT_BRAIN_EXECUTOR is on AND the EDL is valid;
    // otherwise generate.js ignores it and renders the legacy way.
    const edlPath = writeEdlTemp(job);
    if (edlPath) args.push('--edl', edlPath);
    try {
      ({ stdout } = await runScript(GENERATE_SCRIPT, args));
    } finally {
      if (edlPath) { try { fs.unlinkSync(edlPath); } catch { /* best-effort cleanup */ } }
    }
  }

  // Generate succeeded — flip the piece to 'review' so it shows up in
  // the dashboard's review queue, then fire piece_ready over Telegram.
  // Both steps are best-effort: a flaky status update or notify must
  // not mark the whole job failed.
  if (job.target_id) {
    // Write the finished media back FIRST so the piece is previewable the
    // moment it shows up in the review queue. Best-effort — never fails the job.
    // Non-video pieces also emit PIECE_MEDIA (the ordered carousel/image
    // slides) → content_media via a separate broker.
    if (isNonVideo) {
      const mediaOut = parseMarker(stdout, 'PIECE_MEDIA');
      const media = mediaOut && Array.isArray(mediaOut.media) ? mediaOut.media : null;
      if (media && media.length) {
        try {
          await writePieceMedia(job.target_id, media);
        } catch (err) {
          console.error(`    [generate] piece media write-back failed: ${err.message}`);
        }
      }
    }

    const output = parsePieceOutput(stdout);
    if (output) {
      try {
        await writePieceOutput(job.target_id, output);
      } catch (err) {
        console.error(`    [generate] piece output write-back failed: ${err.message}`);
      }
    }

    try {
      await updatePieceStatus(job.target_id, 'review');
    } catch (err) {
      console.error(`    [generate] piece status → review failed: ${err.message}`);
    }

    try {
      const { notifyEvent, resolveOwnerUserId } = require('../../notify');
      const userId = await resolveOwnerUserId(job.brand_id);
      if (userId) {
        await notifyEvent({
          userId,
          event: {
            type: 'piece_ready',
            piece: { id: job.target_id, title: topic },
          },
        });
      }
    } catch (err) {
      console.error(`    [generate] piece_ready notify failed: ${err.message}`);
    }
  }

  return {
    ok: true,
    topic,
    brand_id: job.brand_id,
    caption_style: explicitStyle ?? null,
    log_tail: stdout.split('\n').slice(-10).join('\n'),
  };
}

module.exports = { handleGenerate };

// ─────────────────────────────────────────────────────────
//  EDIT BRAIN — the EXECUTOR (Stage 12.3, runner side)
//
//  The dumb renderer for the Edit Decision List the dashboard Director
//  produces (lib/edit-brain/edl-schema.ts, stored on content_pieces.edl
//  and passed in the generate job payload). The Director has the taste;
//  the Executor just renders what it's told.
//
//  FLAG-GATED + non-breaking. Everything here is dormant unless
//  EDIT_BRAIN_EXECUTOR is truthy AND a schema-valid EDL is present. With
//  the flag off (the default), generate.js renders exactly as it did
//  before — single avatar shot + the legacy caption burn.
//
//  What's ACTIVE today:
//   • Safe-zone-aware caption placement — the EDL's caption position +
//     the platform safe zone drive libass alignment/margin, instead of
//     the caption style's fixed MarginV. This is renderable now from the
//     avatar video + the SRT we already build.
//   • Music bed with fades + ducking — wired and correct, but only fires
//     when a music track resolves. Resolution lands with the asset
//     libraries in Stage 12.4, so it's a graceful no-op until then.
//
//  Scaffolded for 12.4 (intentionally NOT yet wired into ffmpeg, so we
//  don't ship dead, untestable filter graphs):
//   • Multi-shot b-roll cutaways and SFX one-shots — these need resolved
//     `assets` rows, which don't exist until 12.4. resolveAssets() is the
//     single seam where that retrieval will plug in.
//
//  Always best-effort: composeFromEdl throws on any ffmpeg/parse error and
//  the caller falls back to the legacy single-shot burn. The EDL must
//  never be able to break a working render.
// ─────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const { Readable } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const {
  safeZoneFor,
  placementFor,
  DEFAULT_CAPTION_POSITION,
  DEFAULT_DUCK_DB,
  DEFAULT_FADE_IN_S,
  DEFAULT_FADE_OUT_S,
} = require('./rulebook');

// ── Flag ──────────────────────────────────────────────────
function isExecutorEnabled() {
  const v = String(process.env.EDIT_BRAIN_EXECUTOR || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

// ── EDL loading + validation ──────────────────────────────
// The handler hands the EDL to generate.js either as a temp-file path
// (`--edl <path>`) or inline JSON in BOOGLE_EDL_JSON. File wins.
function loadEdl(argv = process.argv) {
  try {
    const i = argv.indexOf('--edl');
    if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const raw = fs.readFileSync(argv[i + 1], 'utf8');
      return JSON.parse(raw);
    }
    if (process.env.BOOGLE_EDL_PATH && fs.existsSync(process.env.BOOGLE_EDL_PATH)) {
      return JSON.parse(fs.readFileSync(process.env.BOOGLE_EDL_PATH, 'utf8'));
    }
    if (process.env.BOOGLE_EDL_JSON) {
      return JSON.parse(process.env.BOOGLE_EDL_JSON);
    }
  } catch (err) {
    console.error(`  [edit-brain] could not load EDL: ${err.message}`);
  }
  return null;
}

// Mirror of lib/edit-brain/edl-schema.ts::isValidEdl — the runner trusts
// nothing it can't minimally verify. Falls back to legacy when false.
function isValidEdl(v) {
  return !!v
    && typeof v === 'object'
    && v.version === 1
    && typeof v.platform === 'string'
    && Array.isArray(v.segments)
    && v.segments.length > 0;
}

// ── Caption placement from the EDL ────────────────────────
// v1 uses ONE safe-zone-aware placement for the whole piece: the first
// segment caption that declares a position wins, else the rulebook
// default. Per-segment ASS positioning is a 12.4+ refinement (needs the
// SRT rewritten as ASS with per-line \an overrides).
function captionPlacement(edl) {
  const platform = edl.platform;
  let position = DEFAULT_CAPTION_POSITION;
  for (const seg of edl.segments) {
    if (seg && seg.caption && seg.caption.position) {
      position = seg.caption.position;
      break;
    }
  }
  return { ...placementFor(position, platform), position, platform };
}

// Override individual keys in a libass force_style string
// ("Key=Val,Key2=Val2,…") without disturbing the rest of the style.
function applyStyleOverrides(styleStr, overrides) {
  const parts = String(styleStr || '').split(',').map((s) => s.trim()).filter(Boolean);
  const map = new Map();
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    map.set(p.slice(0, eq).trim(), p.slice(eq + 1).trim());
  }
  for (const [k, val] of Object.entries(overrides)) {
    if (val == null) continue;
    map.set(k, String(val));
  }
  return Array.from(map.entries()).map(([k, val]) => `${k}=${val}`).join(',');
}

function ffSubtitlesPath(srtPath) {
  // ffmpeg subtitles filter needs forward slashes and an escaped drive colon.
  return srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// ── Asset resolution (Stage 12.4) ─────────────────────────
// The Director stamps real asset ids onto the EDL (dashboard-side, by
// tag/fingerprint match against the `assets` table). Here we turn the
// MUSIC asset id into a local file: ask the dashboard broker for a
// signed R2 URL, download it, hand the path to composeFromEdl which mixes
// the ducked bed. Brand scoping + R2 creds stay server-side.
//
// Fully best-effort: no music asset, no runner token, a broker/download
// failure — all degrade to "avatar + safe-zone captions" with a log line,
// never an exception. B-roll/SFX resolution is intentionally deferred
// until the Executor grows a multi-shot compositor (a later phase) — the
// broker already returns those rows, there's just nothing to render them
// into yet.
async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    Readable.fromWeb(res.body).pipe(out).on('finish', resolve).on('error', reject);
  });
  return dest;
}

async function resolveAssets(edl, folder) {
  const out = { music: null, sfx: [], brollBySegment: {} };
  try {
    const musicId = edl && edl.music && edl.music.asset_id;
    if (!musicId) return out;

    const { resolveAssets: brokerResolve } = require('../worker/api');
    const assets = await brokerResolve([musicId]);
    const m = (assets || []).find((a) => a.id === musicId && a.type === 'music')
          || (assets || []).find((a) => a.type === 'music');
    if (!m || !m.url) return out;

    const ext  = path.extname(m.r2_key || '') || '.mp3';
    const dest = path.join(folder, 'assets', `music${ext}`);
    await downloadTo(m.url, dest);
    out.music = { path: dest, duration_s: m.duration_s != null ? Number(m.duration_s) : null, title: m.title || null };
    console.log(`  [edit-brain] resolved music asset → assets/music${ext}${m.duration_s ? ` (${m.duration_s}s)` : ''}`);
  } catch (err) {
    console.error(`  [edit-brain] asset resolution skipped: ${err.message}`);
  }
  return out;
}

function dbToLinear(db) {
  const n = Number(db);
  return Number.isFinite(n) ? Math.pow(10, n / 20) : 1;
}

// ── Render ────────────────────────────────────────────────
// Compose the final video from the EDL. Returns the output path.
// Throws on any failure — the caller (generate.js) catches and falls
// back to the legacy burnCaptions path.
async function composeFromEdl({ edl, videoPath, srtPath, folder, captionStyle }) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error('composeFromEdl: avatar video missing');
  }
  if (!srtPath || !fs.existsSync(srtPath)) {
    throw new Error('composeFromEdl: captions SRT missing');
  }

  const placed   = captionPlacement(edl);
  const styleStr = applyStyleOverrides(captionStyle.style, {
    Alignment: placed.alignment,
    MarginV:   placed.marginV,
  });
  const subFilter = `subtitles='${ffSubtitlesPath(srtPath)}':force_style='${styleStr}'`;

  const { music } = await resolveAssets(edl, folder);
  const outputPath = path.join(folder, 'final_video.mp4');

  console.log(
    `  [edit-brain] executor render — platform=${placed.platform} ` +
    `captions=${placed.position}(an${placed.alignment},mv${placed.marginV}) ` +
    `music=${music ? 'yes' : 'none'} segments=${edl.segments.length}`
  );

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg(videoPath);

    if (music && music.path && fs.existsSync(music.path)) {
      // Avatar video + a ducked, faded music bed under the voiceover.
      // Constant duck (music attenuated to duck_db under the VO) — robust
      // without needing the music track's duration up front. Sidechain
      // ducking is a later refinement.
      const duck    = Number(edl.music && edl.music.duck_db != null ? edl.music.duck_db : DEFAULT_DUCK_DB);
      const fadeIn  = Number(edl.music && edl.music.fade_in_s != null ? edl.music.fade_in_s : DEFAULT_FADE_IN_S);
      const fadeOut = Number(edl.music && edl.music.fade_out_s != null ? edl.music.fade_out_s : DEFAULT_FADE_OUT_S);
      const dur     = Number(music.duration_s) > 0 ? Number(music.duration_s) : null;

      const musicChain = [
        `volume=${dbToLinear(duck).toFixed(4)}`,
        `afade=t=in:st=0:d=${fadeIn}`,
        dur ? `afade=t=out:st=${Math.max(0, dur - fadeOut).toFixed(2)}:d=${fadeOut}` : null,
      ].filter(Boolean).join(',');

      cmd.input(music.path);
      cmd.complexFilter([
        `[0:v]${subFilter}[v]`,
        `[1:a]${musicChain}[mus]`,
        // duration=first → end with the voiceover, not the music bed.
        `[0:a][mus]amix=inputs=2:duration=first:dropout_transition=0[a]`,
      ]);
      cmd.outputOptions(['-map', '[v]', '-map', '[a]', '-shortest']);
    } else {
      // No resolvable music → avatar video + safe-zone captions only.
      cmd.videoFilters(subFilter);
    }

    cmd
      .output(outputPath)
      .on('progress', (p) => {
        if (p.percent) process.stdout.write(`  →  [edit-brain] rendering: ${Math.round(p.percent)}%...\r`);
      })
      .on('end', () => { console.log(''); resolve(); })
      .on('error', (err) => { console.log(''); reject(new Error(`edit-brain render failed: ${err.message}`)); })
      .run();
  });

  return outputPath;
}

module.exports = {
  isExecutorEnabled,
  loadEdl,
  isValidEdl,
  composeFromEdl,
  // exported for unit reasoning / future reuse
  captionPlacement,
  applyStyleOverrides,
  resolveAssets,
};

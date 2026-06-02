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
//  What's ACTIVE:
//   • Safe-zone-aware caption placement — the EDL's caption position +
//     the platform safe zone drive libass alignment/margin, instead of
//     the caption style's fixed MarginV.
//   • Music bed with fades + ducking — fires when the Director matched a
//     music asset (resolveAssets downloads it from R2 via the broker).
//   • Multi-shot b-roll cutaways — each EDL segment with layer='broll' and
//     a matched asset is composited over the avatar during its [t_in,t_out]
//     window (buildCompositeGraph). Avatar shows through any gap.
//  Each layer is independent: with no matched assets the render degrades
//  cleanly to "avatar + safe-zone captions".
//
//  Still deferred: timed SFX one-shots and full-screen `card` segments —
//  the broker returns the rows; the mixer/renderer for them is a later
//  refinement. resolveAssets() is the seam where SFX retrieval plugs in.
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
// Fully best-effort: no assets, no runner token, a broker/download
// failure — all degrade gracefully (avatar + safe-zone captions) with a
// log line, never an exception. Resolves BOTH the music bed and the
// per-segment b-roll clips the Director matched; the compositor below
// cuts the b-roll over the avatar during each segment's window. SFX
// one-shots are still deferred (the broker returns them; the mixer for
// timed one-shots is a later refinement).
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

// Cap on simultaneous b-roll cutaways — keeps the ffmpeg filter graph
// (one scale+overlay pair per clip) sane on a small runner box.
const MAX_BROLL_CLIPS = 12;

async function resolveAssets(edl, folder) {
  const out = { music: null, sfx: [], broll: [] };
  try {
    const musicId = edl && edl.music && edl.music.asset_id;

    // Segments the Director matched to a real b-roll asset, in timeline order.
    const brollSegs = (edl.segments || [])
      .map((s, i) => ({ i, s }))
      .filter(({ s }) => s && s.layer === 'broll' && s.asset_id && Number(s.t_out) > Number(s.t_in))
      .slice(0, MAX_BROLL_CLIPS);

    const ids = [];
    if (musicId) ids.push(musicId);
    for (const { s } of brollSegs) ids.push(s.asset_id);
    if (ids.length === 0) return out;

    const { resolveAssets: brokerResolve } = require('../worker/api');
    const assets = await brokerResolve(Array.from(new Set(ids)));
    const byId = new Map((assets || []).map((a) => [a.id, a]));

    // Music bed.
    if (musicId) {
      const m = byId.get(musicId) || (assets || []).find((a) => a.type === 'music');
      if (m && m.url) {
        const ext  = path.extname(m.r2_key || '') || '.mp3';
        const dest = path.join(folder, 'assets', `music${ext}`);
        await downloadTo(m.url, dest);
        out.music = { path: dest, duration_s: m.duration_s != null ? Number(m.duration_s) : null, title: m.title || null };
        console.log(`  [edit-brain] resolved music asset → assets/music${ext}${m.duration_s ? ` (${m.duration_s}s)` : ''}`);
      }
    }

    // B-roll cutaways — one downloaded clip per matched segment.
    let n = 0;
    for (const { i, s } of brollSegs) {
      const a = byId.get(s.asset_id);
      if (!a || !a.url || a.type !== 'broll') continue;
      const ext  = path.extname(a.r2_key || '') || '.mp4';
      const dest = path.join(folder, 'assets', `broll_${i}${ext}`);
      try {
        await downloadTo(a.url, dest);
        out.broll.push({ segIndex: i, t_in: Number(s.t_in), t_out: Number(s.t_out), path: dest });
        n++;
      } catch (e) {
        console.error(`  [edit-brain] b-roll seg ${i} download failed: ${e.message}`);
      }
    }
    if (n) console.log(`  [edit-brain] resolved ${n} b-roll clip(s)`);
  } catch (err) {
    console.error(`  [edit-brain] asset resolution skipped: ${err.message}`);
  }
  return out;
}

function dbToLinear(db) {
  const n = Number(db);
  return Number.isFinite(n) ? Math.pow(10, n / 20) : 1;
}

// Build the ffmpeg filter graph + output map for the b-roll/music
// composite. Pure (no ffmpeg, no fs) so the graph can be unit-tested.
// Input order assumed by the labels: [0]=avatar, [1..B]=broll, [B+1]=music.
//   broll: [{ t_in, t_out, path }] (path unused here — caller adds inputs)
//   music: { duration_s } | null   edlMusic: edl.music | null
function buildCompositeGraph({ subFilter, broll, music, edlMusic }) {
  const parts = [];

  // VIDEO — cut each b-roll over the avatar during its [t_in,t_out] window,
  // scaled to fill the vertical frame and started from its head at t_in.
  // eof_action=pass → a clip shorter than its window lets the avatar show.
  let last = '0:v';
  broll.forEach((b, k) => {
    const inIdx = 1 + k;
    parts.push(
      `[${inIdx}:v]scale=1080:1920:force_original_aspect_ratio=increase,` +
      `crop=1080:1920,setpts=PTS-STARTPTS+${b.t_in}/TB[bv${k}]`
    );
    parts.push(
      `[${last}][bv${k}]overlay=enable='between(t,${b.t_in},${b.t_out})':eof_action=pass[ov${k}]`
    );
    last = `ov${k}`;
  });
  parts.push(`[${last}]${subFilter}[v]`);

  // AUDIO — voiceover always; duck a faded music bed under it when present.
  let audioMap = '0:a';
  if (music) {
    const duck    = Number(edlMusic && edlMusic.duck_db   != null ? edlMusic.duck_db   : DEFAULT_DUCK_DB);
    const fadeIn  = Number(edlMusic && edlMusic.fade_in_s != null ? edlMusic.fade_in_s : DEFAULT_FADE_IN_S);
    const fadeOut = Number(edlMusic && edlMusic.fade_out_s != null ? edlMusic.fade_out_s : DEFAULT_FADE_OUT_S);
    const dur     = Number(music.duration_s) > 0 ? Number(music.duration_s) : null;
    const musicInIdx = 1 + broll.length;
    const musicChain = [
      `volume=${dbToLinear(duck).toFixed(4)}`,
      `afade=t=in:st=0:d=${fadeIn}`,
      dur ? `afade=t=out:st=${Math.max(0, dur - fadeOut).toFixed(2)}:d=${fadeOut}` : null,
    ].filter(Boolean).join(',');
    parts.push(`[${musicInIdx}:a]${musicChain}[mus]`);
    // duration=first → end with the voiceover, not the music bed.
    parts.push(`[0:a][mus]amix=inputs=2:duration=first:dropout_transition=0[a]`);
    audioMap = '[a]';
  }

  const mapOpts = ['-map', '[v]', '-map', audioMap];
  if (music) mapOpts.push('-shortest');
  return { parts, mapOpts };
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

  const { music, broll } = await resolveAssets(edl, folder);
  const outputPath = path.join(folder, 'final_video.mp4');
  const hasBroll = broll.length > 0;
  const hasMusic = !!(music && music.path && fs.existsSync(music.path));

  console.log(
    `  [edit-brain] executor render — platform=${placed.platform} ` +
    `captions=${placed.position}(an${placed.alignment},mv${placed.marginV}) ` +
    `music=${hasMusic ? 'yes' : 'none'} broll=${broll.length} segments=${edl.segments.length}`
  );

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg(videoPath);

    if (!hasBroll && !hasMusic) {
      // Simplest path — avatar video + safe-zone captions only.
      cmd.videoFilters(subFilter);
    } else {
      // Inputs in a FIXED order so the filter labels line up:
      //   [0] = avatar (the base), [1..B] = b-roll clips, [B+1] = music.
      broll.forEach((b) => cmd.input(b.path));
      if (hasMusic) cmd.input(music.path);

      const { parts, mapOpts } = buildCompositeGraph({
        subFilter,
        broll,
        music: hasMusic ? music : null,
        edlMusic: edl.music || null,
      });
      cmd.complexFilter(parts);
      cmd.outputOptions(mapOpts);
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
  buildCompositeGraph,
  // exported for unit reasoning / future reuse
  captionPlacement,
  applyStyleOverrides,
  resolveAssets,
};

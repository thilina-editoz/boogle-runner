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
//   • SFX one-shots — each segment's Director-resolved sfx asset id is mixed
//     in as a delayed one-shot (adelay) at the segment onset, amix'd over
//     the VO (normalize=0 keeps the voiceover at full level).
//  Each layer is independent: with no matched assets the render degrades
//  cleanly to "avatar + safe-zone captions".
//
//   • Full-screen `card` segments (text beats) — Stage 12 TASK 2a — a dark
//     scrim + centered headline (+ optional sub) drawn during each card
//     segment window via drawtext, using a bundled DejaVu Sans font (the
//     node:20-slim image has none). Adds no inputs (pure filtergraph).
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

// ── Bundled fonts (Stage 12 TASK 2a) ─────────────────────
// node:20-slim ships no fonts, so card text drawn via drawtext MUST point at
// a bundled fontfile by absolute path (drawtext bypasses fontconfig this way).
// DejaVu Sans (Bitstream Vera license — redistributable; see fonts/LICENSE.txt).
const FONT_DIR = path.join(__dirname, 'fonts');
const FONTS = {
  bold:    path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
  regular: path.join(FONT_DIR, 'DejaVuSans.ttf'),
};

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

// Escape a filesystem path for use inside an ffmpeg filtergraph option
// (forward slashes + escaped drive colon). On Linux there's no colon so it's
// a near no-op; on Windows it turns C:\… into C\:/… as ffmpeg expects.
function ffEscapePath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}

function ffSubtitlesPath(srtPath) {
  // ffmpeg subtitles filter needs forward slashes and an escaped drive colon.
  return ffEscapePath(srtPath);
}

// ── Card segments (Stage 12 TASK 2a) ──────────────────────
// Full-screen text beats: a dark scrim + centered headline (+ optional sub)
// shown during the card segment's [t_in,t_out] window. Text is written to
// files and referenced via drawtext textfile= so arbitrary headline content
// (apostrophes, colons, %) never has to be escaped into the filtergraph.

// Greedy word-wrap to keep headlines/subs inside the frame.
function wrapText(text, maxChars) {
  const words = String(text == null ? '' : text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

// Extract card segments → write their text files → return render metadata.
// Does the fs work so buildCardFilterChain can stay pure/unit-testable.
function buildCardData(edl, folder) {
  const cards = [];
  const segs = (edl.segments || []).filter(
    (s) => s && s.layer === 'card' && s.card && (s.card.headline || s.card.sub)
      && Number(s.t_out) > Number(s.t_in)
  );
  if (segs.length === 0) return cards;
  const dir = path.join(folder, 'cards');
  fs.mkdirSync(dir, { recursive: true });
  segs.forEach((s, i) => {
    const hFile = path.join(dir, `card_${i}_h.txt`);
    fs.writeFileSync(hFile, wrapText(s.card.headline || '', 18), 'utf8');
    let sFile = null;
    if (s.card.sub) {
      sFile = path.join(dir, `card_${i}_s.txt`);
      fs.writeFileSync(sFile, wrapText(s.card.sub, 28), 'utf8');
    }
    cards.push({
      t_in: Number(s.t_in), t_out: Number(s.t_out),
      headlineFile: hFile, subFile: sFile, headlineSize: 78, subSize: 44,
    });
  });
  return cards;
}

// Pure: build the comma-joined drawbox+drawtext chain for all card segments.
// Returns '' when there are no cards (caller then skips the card stage).
function buildCardFilterChain(cards, fonts) {
  if (!Array.isArray(cards) || cards.length === 0) return '';
  const f = fonts || FONTS;
  const ops = [];
  for (const c of cards) {
    const en = `between(t,${c.t_in},${c.t_out})`;
    ops.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black@0.82:t=fill:enable='${en}'`);
    ops.push(
      `drawtext=fontfile='${ffEscapePath(f.bold)}':textfile='${ffEscapePath(c.headlineFile)}':` +
      `fontcolor=white:fontsize=${c.headlineSize}:line_spacing=18:expansion=none:` +
      `x=(w-text_w)/2:y=(h-text_h)/2-${c.subFile ? 70 : 0}:enable='${en}'`
    );
    if (c.subFile) {
      ops.push(
        `drawtext=fontfile='${ffEscapePath(f.regular)}':textfile='${ffEscapePath(c.subFile)}':` +
        `fontcolor=0xDDDDDD:fontsize=${c.subSize}:line_spacing=12:expansion=none:` +
        `x=(w-text_w)/2:y=(h/2)+90:enable='${en}'`
      );
    }
  }
  return ops.join(',');
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
// Cap on sfx one-shots (one adelay+amix branch each).
const MAX_SFX = 24;

// A resolved sfx/asset id looks like a uuid; raw rulebook tags ("impact",
// "whoosh") never will, so they harmlessly fail to resolve at the broker.
function looksLikeAssetId(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s);
}

async function resolveAssets(edl, folder) {
  const out = { music: null, sfx: [], broll: [] };
  try {
    const musicId = edl && edl.music && edl.music.asset_id;

    // Segments the Director matched to a real b-roll asset, in timeline order.
    const brollSegs = (edl.segments || [])
      .map((s, i) => ({ i, s }))
      .filter(({ s }) => s && s.layer === 'broll' && s.asset_id && Number(s.t_out) > Number(s.t_in))
      .slice(0, MAX_BROLL_CLIPS);

    // SFX: segments carry sfx[] of Director-resolved asset ids (and/or raw
    // tags that didn't resolve). Each id fires a one-shot at the segment's
    // onset (t_in). Tags are dropped — they won't match an asset.
    const sfxRefs = [];
    for (const s of (edl.segments || [])) {
      if (s && Array.isArray(s.sfx)) {
        for (const entry of s.sfx) {
          if (looksLikeAssetId(entry)) sfxRefs.push({ id: entry, atS: Number(s.t_in) || 0 });
        }
      }
    }
    const sfxCapped = sfxRefs.slice(0, MAX_SFX);

    const ids = [];
    if (musicId) ids.push(musicId);
    for (const { s } of brollSegs) ids.push(s.asset_id);
    for (const r of sfxCapped) ids.push(r.id);
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

    // SFX one-shots — download each unique sfx asset once, then place a
    // one-shot at every segment that references it (fired at t_in).
    const sfxPathById = new Map();
    let sfxN = 0;
    for (const r of sfxCapped) {
      const a = byId.get(r.id);
      if (!a || !a.url || a.type !== 'sfx') continue;
      let p = sfxPathById.get(r.id);
      if (!p) {
        const ext = path.extname(a.r2_key || '') || '.mp3';
        const dest = path.join(folder, 'assets', `sfx_${sfxPathById.size}${ext}`);
        try {
          await downloadTo(a.url, dest);
          p = dest;
          sfxPathById.set(r.id, dest);
        } catch (e) {
          console.error(`  [edit-brain] sfx download failed: ${e.message}`);
          continue;
        }
      }
      out.sfx.push({ atS: r.atS, path: p });
      sfxN++;
    }
    if (sfxN) console.log(`  [edit-brain] resolved ${sfxN} sfx one-shot(s)`);
  } catch (err) {
    console.error(`  [edit-brain] asset resolution skipped: ${err.message}`);
  }
  return out;
}

function dbToLinear(db) {
  const n = Number(db);
  return Number.isFinite(n) ? Math.pow(10, n / 20) : 1;
}

// Build the ffmpeg filter graph + output map for the b-roll/music/sfx
// composite. Pure (no ffmpeg, no fs) so the graph can be unit-tested.
// Input order assumed by the labels (caller MUST add inputs in this order):
//   [0]=avatar, [1..B]=broll, then music (if any), then one input per sfx.
//   broll: [{ t_in, t_out }]   music: { duration_s } | null
//   sfx:   [{ atS }]           edlMusic: edl.music | null
function buildCompositeGraph({ subFilter, broll, music, edlMusic, sfx, cards, fonts }) {
  const parts = [];
  const sfxList = Array.isArray(sfx) ? sfx : [];

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

  // CARDS — full-screen text beats over the current video during their windows,
  // burned BEFORE captions so captions still sit on top.
  const cardChain = buildCardFilterChain(cards || [], fonts || FONTS);
  if (cardChain) {
    parts.push(`[${last}]${cardChain}[cards]`);
    last = 'cards';
  }

  parts.push(`[${last}]${subFilter}[v]`);

  // AUDIO — voiceover is always input [0]; layer a ducked/faded music bed
  // and timed sfx one-shots over it, then amix (normalize=0 so the VO stays
  // at full level instead of being attenuated by the input count).
  let idx = 1 + broll.length;
  const mix = ['0:a'];

  if (music) {
    const duck    = Number(edlMusic && edlMusic.duck_db   != null ? edlMusic.duck_db   : DEFAULT_DUCK_DB);
    const fadeIn  = Number(edlMusic && edlMusic.fade_in_s != null ? edlMusic.fade_in_s : DEFAULT_FADE_IN_S);
    const fadeOut = Number(edlMusic && edlMusic.fade_out_s != null ? edlMusic.fade_out_s : DEFAULT_FADE_OUT_S);
    const dur     = Number(music.duration_s) > 0 ? Number(music.duration_s) : null;
    const musicChain = [
      `volume=${dbToLinear(duck).toFixed(4)}`,
      `afade=t=in:st=0:d=${fadeIn}`,
      dur ? `afade=t=out:st=${Math.max(0, dur - fadeOut).toFixed(2)}:d=${fadeOut}` : null,
    ].filter(Boolean).join(',');
    parts.push(`[${idx}:a]${musicChain}[mus]`);
    mix.push('mus');
    idx++;
  }

  sfxList.forEach((s, k) => {
    const atMs = Math.max(0, Math.round((Number(s.atS) || 0) * 1000));
    // adelay shifts the one-shot to its fire time (stereo → both channels).
    parts.push(`[${idx}:a]adelay=${atMs}|${atMs}[sfx${k}]`);
    mix.push(`sfx${k}`);
    idx++;
  });

  let audioMap = '0:a';
  if (mix.length > 1) {
    // duration=first → end with the voiceover, not a trailing bed/sfx.
    parts.push(
      `${mix.map((l) => `[${l}]`).join('')}` +
      `amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[a]`
    );
    audioMap = '[a]';
  }

  const mapOpts = ['-map', '[v]', '-map', audioMap];
  if (mix.length > 1) mapOpts.push('-shortest');
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
    // node:20-slim ships no Arial/Impact — force the bundled DejaVu face so
    // libass resolves it via fontsdir below instead of falling back to notdef.
    FontName:  'DejaVu Sans',
  });
  const subFilter =
    `subtitles='${ffSubtitlesPath(srtPath)}':fontsdir='${ffEscapePath(FONT_DIR)}':` +
    `force_style='${styleStr}'`;

  const { music, broll, sfx } = await resolveAssets(edl, folder);
  const cards = buildCardData(edl, folder);
  const outputPath = path.join(folder, 'final_video.mp4');
  const hasBroll = broll.length > 0;
  const hasMusic = !!(music && music.path && fs.existsSync(music.path));
  const sfxClips = (sfx || []).filter((s) => s && s.path && fs.existsSync(s.path));
  const hasSfx = sfxClips.length > 0;
  const hasCards = cards.length > 0;

  console.log(
    `  [edit-brain] executor render — platform=${placed.platform} ` +
    `captions=${placed.position}(an${placed.alignment},mv${placed.marginV}) ` +
    `music=${hasMusic ? 'yes' : 'none'} broll=${broll.length} sfx=${sfxClips.length} ` +
    `cards=${cards.length} segments=${edl.segments.length}`
  );

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg(videoPath);

    if (!hasBroll && !hasMusic && !hasSfx && !hasCards) {
      // Simplest path — avatar video + safe-zone captions only.
      cmd.videoFilters(subFilter);
    } else {
      // Inputs in a FIXED order so the filter labels line up:
      //   [0]=avatar, [1..B]=b-roll, then music (if any), then each sfx.
      // Cards add NO inputs — they're drawbox/drawtext on the video chain.
      broll.forEach((b) => cmd.input(b.path));
      if (hasMusic) cmd.input(music.path);
      sfxClips.forEach((s) => cmd.input(s.path));

      const { parts, mapOpts } = buildCompositeGraph({
        subFilter,
        broll,
        music: hasMusic ? music : null,
        edlMusic: edl.music || null,
        sfx: sfxClips,
        cards,
        fonts: FONTS,
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
  buildCardFilterChain,
  buildCardData,
  wrapText,
  FONTS,
};

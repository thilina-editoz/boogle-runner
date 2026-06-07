// ─────────────────────────────────────────────────────────
//  EDIT BRAIN — SHOT-LEVEL MINER (Stage 12 TASK 2b, runner side)
//
//  Real avg-shot-length / shot-count for top scraped posts via ffmpeg
//  scene detection, folded into editing_patterns.pattern_data so the
//  Director can bias pacing toward what actually wins for the brand.
//
//  COST-GATED: only runs when EDIT_BRAIN_SHOT_MINING is truthy. It needs
//  the scraped videos downloaded (Apify shouldDownloadVideos:true → extra
//  Apify + bandwidth per scrape), so it's OFF by default — a customer opts
//  in. Even when on, only the top-N ranked posts are analysed (bounded
//  bandwidth), and EVERYTHING here is best-effort: any failure yields null
//  and the metadata-only pattern is recorded as before.
// ─────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const ffmpegPath = require('../ffmpeg-bin').resolveFfmpegPath();

function isShotMiningEnabled() {
  const v = String(process.env.EDIT_BRAIN_SHOT_MINING || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

// How many top-ranked posts to analyse per scrape (bounds bandwidth/time).
function shotMiningTopN() {
  const n = parseInt(process.env.EDIT_BRAIN_SHOT_MINING_TOPN, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

// Scene-cut sensitivity (0–1). ~0.3 is a good general default for short-form.
const SCENE_THRESHOLD = (() => {
  const t = parseFloat(process.env.EDIT_BRAIN_SCENE_THRESHOLD);
  return Number.isFinite(t) && t > 0 && t < 1 ? t : 0.3;
})();

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

// Count scene cuts via ffmpeg: select frames whose scene score exceeds the
// threshold + showinfo → one "pts_time:" line per selected (cut) frame.
function countScenes(filePath) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      ['-hide_banner', '-i', filePath,
       '-vf', `select='gt(scene\\,${SCENE_THRESHOLD})',showinfo`,
       '-an', '-f', 'null', '-'],
      { maxBuffer: 1 << 26 },
      (err, stdout, stderr) => {
        // showinfo prints to stderr; count one line per selected frame.
        const cuts = ((stderr || '').match(/pts_time:/g) || []).length;
        resolve(cuts);
      }
    );
  });
}

/**
 * Analyse one post's video → { avg_shot_len_s, shot_count } or null.
 * durationS (from scrape metadata) drives avg shot length; shot_count is
 * cuts + 1. Never throws.
 */
async function analyzeShots(videoUrl, durationS) {
  if (!videoUrl) return null;
  const dest = path.join(os.tmpdir(), `boogle-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  try {
    await downloadTo(videoUrl, dest);
    const cuts = await countScenes(dest);
    const shot_count = cuts + 1;
    const dur = Number(durationS);
    const avg_shot_len_s = Number.isFinite(dur) && dur > 0
      ? Math.round((dur / shot_count) * 100) / 100
      : null;
    return { avg_shot_len_s, shot_count };
  } catch {
    return null;
  } finally {
    fs.promises.unlink(dest).catch(() => {});
  }
}

/**
 * Analyse the top-N posts (already engagement-sorted) that carry a
 * downloadable video URL. Returns a Map keyed by post.url →
 * { avg_shot_len_s, shot_count }. Best-effort + sequential (keeps
 * bandwidth/CPU on a small runner box sane). Empty Map when disabled.
 */
async function mineTopPosts(posts, log) {
  const out = new Map();
  if (!isShotMiningEnabled()) return out;
  const top = (posts || []).filter((p) => p.url && p.videoDownloadUrl).slice(0, shotMiningTopN());
  if (top.length === 0) return out;
  if (log) log('step', `Shot-level mining ${top.length} top post(s) (scene detect)...`);
  let ok = 0;
  for (const p of top) {
    const r = await analyzeShots(p.videoDownloadUrl, p.durationS);
    if (r) { out.set(p.url, r); ok++; }
  }
  if (log) log('done', `Shot-level mined ${ok}/${top.length} post(s)`);
  return out;
}

module.exports = {
  isShotMiningEnabled,
  shotMiningTopN,
  analyzeShots,
  countScenes,
  mineTopPosts,
};

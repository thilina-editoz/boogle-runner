// ─────────────────────────────────────────────────────────
//  api.js — the runner's ONLY channel to dashboard data.
//
//  Replaces the old direct-Supabase access (worker/db.js,
//  worker/claim.js, brand-config reads, idea/post inserts). The
//  runner NO LONGER holds the Supabase service-role key — every
//  read/write is brokered by the dashboard's /api/internal/* routes,
//  authenticated by a per-customer runner token and scoped to that
//  customer's brand server-side.
//
//  Env required (in .env):
//    BOOGLE_DASHBOARD_URL   — base URL, no trailing slash
//    BOOGLE_RUNNER_TOKEN    — per-customer token (issued in the
//                             dashboard's Settings → Your Runner)
//
//  Every call throws on transport / non-2xx so handlers can mark the
//  job failed. See PLAN-RUNNER.md.
// ─────────────────────────────────────────────────────────

require('dotenv').config();

function base() {
  const b = (process.env.BOOGLE_DASHBOARD_URL || '').replace(/\/$/, '');
  if (!b) throw new Error('BOOGLE_DASHBOARD_URL is not set');
  return b;
}

function token() {
  const t = process.env.BOOGLE_RUNNER_TOKEN;
  if (!t) throw new Error('BOOGLE_RUNNER_TOKEN is not set');
  return t;
}

async function call(method, pathname, body) {
  const res = await fetch(`${base()}${pathname}`, {
    method,
    headers: {
      'x-runner-token': token(),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }

  if (!res.ok || payload.ok === false) {
    const reason = payload.error || `HTTP ${res.status}`;
    throw new Error(`${method} ${pathname} failed: ${reason}`);
  }
  return payload;
}

// ── Jobs ──────────────────────────────────────────────────
async function getNextJob() {
  const { job } = await call('GET', '/api/internal/jobs/next');
  return job ?? null;
}

async function completeJob(id, result) {
  await call('POST', `/api/internal/jobs/${id}/done`, { result: result ?? {} });
}

async function failJob(id, errMessage) {
  await call('POST', `/api/internal/jobs/${id}/fail`, {
    error: String(errMessage).slice(0, 2000),
  });
}

// ── Brand config ──────────────────────────────────────────
async function getBrandConfig() {
  const { config } = await call('GET', '/api/internal/brand-config');
  return config;
}

// ── Content ideas ─────────────────────────────────────────
async function insertIdeas(rows) {
  const { ideas } = await call('POST', '/api/internal/ideas', { rows });
  return ideas ?? [];
}

// ── Content pieces ────────────────────────────────────────
async function updatePieceStatus(id, status) {
  await call('POST', `/api/internal/pieces/${id}/status`, { status });
}

// ── Posts ─────────────────────────────────────────────────
async function insertPosts(rows) {
  const { written } = await call('POST', '/api/internal/posts', { rows });
  return written ?? 0;
}

// ── Assets (Edit Brain — resolve EDL asset ids → signed URLs) ──
// Given the asset ids the Director stamped onto the EDL, the dashboard
// returns short-lived signed R2 GET URLs (brand-scoped server-side). The
// runner never sees R2 credentials. Returns [] on no ids.
async function resolveAssets(assetIds) {
  if (!Array.isArray(assetIds) || assetIds.length === 0) return [];
  const { assets } = await call('POST', '/api/internal/assets/resolve', { asset_ids: assetIds });
  return assets ?? [];
}

// ── Trending sounds (Edit Brain trend radar) ──────────────
// Fire-and-forget: NEVER throws. A flaky trend report must not fail a
// scrape. Returns the broker payload or a {ok:false} marker.
async function recordTrendingSounds(sounds) {
  if (!Array.isArray(sounds) || sounds.length === 0) return { ok: false, reason: 'no sounds' };
  try {
    return await call('POST', '/api/internal/trending-sounds', { sounds });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  getNextJob,
  completeJob,
  failJob,
  getBrandConfig,
  insertIdeas,
  updatePieceStatus,
  insertPosts,
  resolveAssets,
  recordTrendingSounds,
};

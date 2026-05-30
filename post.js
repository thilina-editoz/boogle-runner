// ─────────────────────────────────────────────────────────
//  BOOGLE by Content Psycho — Posting Module
//
//  Calls the dashboard's internal publish route. The dashboard
//  resolves the user's posting_provider + API key and dispatches
//  to the right adapter (Upload-Post at launch). The pipeline
//  no longer talks to any social provider directly.
//
//  Architecture:
//    generate.js
//      → uploadToR2(final_video.mp4) → publicUrl
//      → postContent({ r2Url, caption, hashtags, folder })
//          → POST {DASHBOARD}/api/internal/publish
//              → adapter.publish() (UploadPostAdapter, etc.)
// ─────────────────────────────────────────────────────────

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { writePostRows } = require('./posts-writer');

const POLL_INTERVAL_MS  = 30_000;
const POLL_TIMEOUT_MS   = 3 * 60_000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Platforms accepted by the dashboard's Platform union.
// Note: dashboard uses "x", not "twitter".
const VALID_PLATFORMS = new Set([
  'tiktok',
  'instagram',
  'youtube',
  'linkedin',
  'x',
  'facebook',
  'threads',
  'pinterest',
  'bluesky',
  'reddit',
]);

// ─────────────────────────────────────────────────────────
//  ENV VALIDATION
// ─────────────────────────────────────────────────────────
function validateEnv() {
  const missing = [];
  if (!process.env.BOOGLE_DASHBOARD_URL)  missing.push('BOOGLE_DASHBOARD_URL');
  if (!process.env.BOOGLE_INTERNAL_TOKEN) missing.push('BOOGLE_INTERNAL_TOKEN');
  if (!process.env.BOOGLE_USER_ID)        missing.push('BOOGLE_USER_ID');
  if (missing.length > 0) {
    throw new Error(`Missing pipeline env: ${missing.join(', ')}`);
  }
}

// ─────────────────────────────────────────────────────────
//  PLATFORM LIST FROM ENV
//  POSTING_PLATFORMS=tiktok,instagram,youtube
// ─────────────────────────────────────────────────────────
function parsePlatforms() {
  const raw = (process.env.POSTING_PLATFORMS || '').trim();
  if (!raw) return [];

  const out = [];
  for (const p of raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
    if (!VALID_PLATFORMS.has(p)) {
      throw new Error(
        `POSTING_PLATFORMS contains unsupported value "${p}". ` +
        `Valid: ${Array.from(VALID_PLATFORMS).join(', ')}`
      );
    }
    out.push(p);
  }
  return out;
}

// ─────────────────────────────────────────────────────────
//  SCHEDULE TIME — POST_TIME (HH:MM) → ISO
// ─────────────────────────────────────────────────────────
function getScheduleTime() {
  const postTime = process.env.POST_TIME;
  if (!postTime) return null;

  const [hours, minutes] = postTime.split(':').map(Number);
  const now = new Date();
  const schedule = new Date(now);
  schedule.setHours(hours, minutes, 0, 0);
  if (schedule <= now) schedule.setDate(schedule.getDate() + 1);
  return schedule.toISOString();
}

// ─────────────────────────────────────────────────────────
//  MAIN — called from generate.js
// ─────────────────────────────────────────────────────────
async function pollPublishStatus({ requestId, platforms, base }) {
  const start = Date.now();
  let latest = null;

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    let res;
    try {
      res = await fetch(`${base}/api/internal/publish-status`, {
        method: 'POST',
        headers: {
          'x-internal-token': process.env.BOOGLE_INTERNAL_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_id:    process.env.BOOGLE_USER_ID,
          request_id: requestId,
          platforms,
        }),
      });
    } catch (e) {
      log('step', `Status poll network error — will retry (${e.message})`);
      continue;
    }

    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) {
      log('step', `Status poll returned ${res.status} — will retry`);
      continue;
    }

    latest = Array.isArray(payload.results) ? payload.results : [];
    const stillQueued = latest.some(r => r.status === 'queued');
    log('step', `Status: ${latest.map(r => `${r.platform}=${r.status}`).join(' ')}`);
    if (!stillQueued) return latest;
  }

  log('step', `Status polling timed out after ${POLL_TIMEOUT_MS / 1000}s — leaving rows as queued`);
  return latest;
}

async function postContent({ r2Url, caption, hashtags, folder, brandId, contentPieceId }) {
  validateEnv();

  if (!r2Url || typeof r2Url !== 'string') {
    throw new Error('postContent requires r2Url (string)');
  }

  const platforms = parsePlatforms();
  if (platforms.length === 0) {
    log('step', 'No POSTING_PLATFORMS set — skipping posting');
    console.log('         → Add POSTING_PLATFORMS=tiktok,instagram,... to .env');
    return { status: 'skipped', reason: 'No POSTING_PLATFORMS configured' };
  }

  const postImmediately = process.env.POST_IMMEDIATELY !== 'false';
  const scheduledFor    = postImmediately ? null : getScheduleTime();

  const text = [caption, hashtags].filter(Boolean).join('\n\n').trim();

  const body = {
    user_id: process.env.BOOGLE_USER_ID,
    post_input: {
      platforms,
      text,
      media_urls: [r2Url],
      ...(scheduledFor ? { scheduled_for: scheduledFor } : {}),
    },
  };

  log('step', `Publishing via dashboard → ${platforms.join(', ')}...`);
  if (scheduledFor) log('step', `Scheduled for: ${scheduledFor}`);

  const base = process.env.BOOGLE_DASHBOARD_URL.replace(/\/$/, '');

  let res;
  try {
    res = await fetch(`${base}/api/internal/publish`, {
      method: 'POST',
      headers: {
        'x-internal-token': process.env.BOOGLE_INTERNAL_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    throw new Error(`Dashboard unreachable: ${netErr.message}`);
  }

  const payload = await res.json().catch(() => ({}));

  if (!res.ok || !payload.ok) {
    const reason = payload?.error || `HTTP ${res.status}`;
    log('error', `Publish failed: ${reason}`);
    const failResult = {
      status: 'failed',
      succeeded: 0,
      failed: platforms.length,
      error: reason,
      results: [],
    };
    writeLog(folder, failResult);
    return failResult;
  }

  // results: PostResult[] — { platform, status, externalPostId?, postUrl?, error? }
  let results = Array.isArray(payload.results) ? payload.results : [];

  for (const r of results) {
    if (r.status === 'success' || r.status === 'queued') {
      log('done', `${r.platform} → ${r.status}${r.postUrl ? ` (${r.postUrl})` : ''}`);
    } else {
      log('error', `${r.platform} → ${r.status}${r.error ? ` (${r.error})` : ''}`);
    }
  }

  // Poll if anything came back queued. Upload-Post returns request_id
  // on the per-platform results; any non-empty externalPostId works.
  const requestId = results.find(r => r.status === 'queued' && r.externalPostId)?.externalPostId;
  if (requestId && results.some(r => r.status === 'queued')) {
    log('step', `Polling Upload-Post for final status (every ${POLL_INTERVAL_MS / 1000}s, up to ${POLL_TIMEOUT_MS / 1000}s)...`);
    const polled = await pollPublishStatus({ requestId, platforms, base });
    if (polled) results = polled;
  }

  // Persist to public.posts (one row per platform). No-op if either
  // brand_id or content_piece_id is missing — see posts-writer.js.
  const effectiveBrandId = brandId ?? process.env.BOOGLE_BRAND_ID ?? null;
  const effectivePieceId = contentPieceId ?? process.env.BOOGLE_CONTENT_PIECE_ID ?? null;
  try {
    const w = await writePostRows({
      brandId:        effectiveBrandId,
      contentPieceId: effectivePieceId,
      results,
      scheduledFor,
    });
    if (w.written > 0) log('done', `Wrote ${w.written} row(s) to posts`);
  } catch (e) {
    log('error', `posts table write failed: ${e.message}`);
  }

  // Fire Telegram notifications for each platform result. Uses
  // BOOGLE_USER_ID (already validated in validateEnv) so we don't need
  // a brand → owner lookup here. Title comes from content_pieces; if
  // we can't resolve it we fall back to the folder name so the message
  // is still readable.
  try {
    const { notifyEvent } = require('./notify');
    const userId = process.env.BOOGLE_USER_ID;
    // Phase 1b: no direct DB access from the runner. The piece title is
    // cosmetic in the notification — use the output folder name. (If we
    // want the real title later, fold it into the generate/post job
    // payload like the cascade already does for topic.)
    const title = folder ? path.basename(folder) : 'content piece';

    for (const r of results) {
      if (r.status === 'failed') {
        await notifyEvent({
          userId,
          event: {
            type: 'post_failed',
            post: { platform: r.platform, title, error: r.error || 'unknown error' },
          },
        });
      } else if (r.status === 'success') {
        await notifyEvent({
          userId,
          event: {
            type: 'post_published',
            post: { platform: r.platform, title, url: r.postUrl ?? null },
          },
        });
      }
      // 'queued' results are pending Upload-Post processing — pollPublishStatus
      // resolves them to success/failed before we get here.
    }
  } catch (e) {
    log('error', `notify failed (non-fatal): ${e.message}`);
  }

  const succeeded = results.filter(r => r.status === 'success' || r.status === 'queued').length;
  const failed    = results.filter(r => r.status === 'failed').length;
  const status =
    failed === 0 ? 'success' :
    succeeded > 0 ? 'partial' :
    'failed';

  const out = { status, succeeded, failed, results };
  writeLog(folder, out);
  return out;
}

function writeLog(folder, data) {
  try {
    fs.writeFileSync(
      path.join(folder, 'posting_results.json'),
      JSON.stringify({
        postedAt: new Date().toISOString(),
        service: 'dashboard',
        ...data,
      }, null, 2)
    );
  } catch {
    // non-fatal
  }
}

// ─────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────
function log(type, msg) {
  const icons = { step: '→', done: '✅', error: '❌' };
  console.log(`  ${icons[type] || '·'}  ${msg}`);
}

module.exports = { postContent };

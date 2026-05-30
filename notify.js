// ─────────────────────────────────────────────────────────
//  notify.js — pipeline → dashboard notification bridge.
//
//  POSTs to the dashboard's /api/internal/notify, which runs the
//  Telegram dispatcher (lib/telegram/notify.ts). The dashboard owns
//  per-user toggles, link lookup, message rendering, and delivery.
//  This module only needs:
//
//    • BOOGLE_DASHBOARD_URL    — base URL (no trailing slash)
//    • BOOGLE_INTERNAL_TOKEN   — shared secret for /api/internal/*
//
//  Failures are LOGGED, NEVER THROWN. A notification is fire-and-
//  forget: a flaky Telegram call must not crash the pipeline.
//
//  Usage:
//    const { notifyEvent, resolveOwnerUserId } = require('./notify');
//    const userId = await resolveOwnerUserId(brandId);
//    if (userId) await notifyEvent({ userId, event: { type: '...', ... } });
// ─────────────────────────────────────────────────────────

// brand_id → owner user_id.
//
// Phase 1b: the runner is single-tenant from its own perspective — it
// only ever runs ONE customer's pipeline, and that customer's user_id
// is in BOOGLE_USER_ID. So there's no DB lookup anymore (and no
// service-role key to do it with). The brandId arg is kept for call-
// site compatibility but ignored.
async function resolveOwnerUserId(_brandId) {
  return process.env.BOOGLE_USER_ID || null;
}

async function notifyEvent({ userId, event }) {
  if (!userId || !event) return { ok: false, reason: 'missing userId or event' };

  const base = (process.env.BOOGLE_DASHBOARD_URL || '').replace(/\/$/, '');
  const token = process.env.BOOGLE_INTERNAL_TOKEN;
  if (!base || !token) {
    console.error('  ·  notify: BOOGLE_DASHBOARD_URL or BOOGLE_INTERNAL_TOKEN missing — skipping');
    return { ok: false, reason: 'env missing' };
  }

  try {
    const res = await fetch(`${base}/api/internal/notify`, {
      method: 'POST',
      headers: {
        'x-internal-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: userId, event }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`  ·  notify: ${event.type} HTTP ${res.status} (${payload?.error || 'no body'})`);
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    // payload.ok === false is a benign "user toggled off / not linked" — quiet log.
    if (payload.ok === false) {
      console.log(`  ·  notify: ${event.type} skipped (${payload.reason})`);
    }
    return payload;
  } catch (err) {
    console.error(`  ·  notify: ${event.type} fetch failed (${err.message})`);
    return { ok: false, reason: err.message };
  }
}

module.exports = { notifyEvent, resolveOwnerUserId };

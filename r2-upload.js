// ─────────────────────────────────────────────────────────
//  BOOGLE — R2 Upload Helper
//
//  Two-step upload: ask the dashboard for a presigned PUT URL,
//  then PUT the local file. The pipeline never sees R2 keys —
//  they live in the dashboard's env.
//
//  Usage:
//    const { publicUrl } = await uploadToR2({
//      localPath: '/full/path/to/final_video.mp4',
//      runId:     '2026-05-21T08-12-44_some-slug',
//    });
// ─────────────────────────────────────────────────────────

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

function validateEnv() {
  const missing = [];
  if (!process.env.BOOGLE_DASHBOARD_URL)  missing.push('BOOGLE_DASHBOARD_URL');
  if (!process.env.BOOGLE_INTERNAL_TOKEN) missing.push('BOOGLE_INTERNAL_TOKEN');
  if (!process.env.BOOGLE_USER_ID)        missing.push('BOOGLE_USER_ID');
  if (missing.length > 0) {
    throw new Error(`Missing pipeline env: ${missing.join(', ')}`);
  }
}

async function uploadToR2({ localPath, runId, contentType = 'video/mp4' }) {
  validateEnv();

  if (!fs.existsSync(localPath)) {
    throw new Error(`File not found: ${localPath}`);
  }

  const base     = process.env.BOOGLE_DASHBOARD_URL.replace(/\/$/, '');
  const filename = path.basename(localPath);

  // Step 1 — mint presigned PUT URL
  const mintRes = await fetch(`${base}/api/internal/upload-url`, {
    method: 'POST',
    headers: {
      'x-internal-token': process.env.BOOGLE_INTERNAL_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id:      process.env.BOOGLE_USER_ID,
      filename,
      content_type: contentType,
      run_id:       runId,
    }),
  });

  if (!mintRes.ok) {
    const err = await mintRes.text();
    throw new Error(`Upload URL mint failed (${mintRes.status}): ${err}`);
  }

  const { uploadUrl, publicUrl, key } = await mintRes.json();
  if (!uploadUrl || !publicUrl) {
    throw new Error('Dashboard returned no uploadUrl / publicUrl');
  }

  // Step 2 — PUT the file. Read into memory; videos are ~5-20 MB so this
  // is fine. Switch to streaming via undici if files ever exceed ~100 MB.
  const body = fs.readFileSync(localPath);

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
  });

  if (!putRes.ok) {
    const err = await putRes.text().catch(() => '');
    throw new Error(`R2 PUT failed (${putRes.status}): ${err.slice(0, 200)}`);
  }

  return { key, publicUrl, bytes: body.length };
}

module.exports = { uploadToR2 };

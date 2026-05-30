// ─────────────────────────────────────────────────────────
//  Pause / Cancel handlers.
//
//  Graceful pause: flag the target content_piece. When generate.js
//  reaches the next step boundary, it sees the flag and exits cleanly.
//  (Step-boundary check will be added when we refactor generate.js to
//  write progress back to Supabase mid-run.)
//
//  V1: flip status → 'draft' (out of the pipeline) and stamp paused_at.
//  Cancel is the same flow but with a different status label in the
//  result — semantics may diverge later.
// ─────────────────────────────────────────────────────────

const { updatePieceStatus } = require('../api');

async function flagPiece(targetId, intent) {
  if (!targetId) {
    throw new Error(`${intent} job needs target_id (content_pieces.id)`);
  }
  // Phase 1b: brokered through the dashboard. Flip the piece back to
  // 'draft' (out of the pipeline). The broker stamps updated_at; the
  // old soft paused_at stamp is dropped for now.
  await updatePieceStatus(targetId, 'draft');
  return { id: targetId, status: 'draft' };
}

async function handlePause(job) {
  const r = await flagPiece(job.target_id, 'pause');
  return { ok: true, intent: 'pause', ...r };
}

async function handleCancel(job) {
  const r = await flagPiece(job.target_id, 'cancel');
  return { ok: true, intent: 'cancel', ...r };
}

module.exports = { handlePause, handleCancel };

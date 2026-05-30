// ─────────────────────────────────────────────────────────
//  Regenerate handler — re-runs generate for an existing piece.
//
//  Same as handleGenerate but requires target_id (the piece to redo).
//  The handler reuses the topic from the existing content_pieces row.
// ─────────────────────────────────────────────────────────

const { handleGenerate } = require('./generate');

async function handleRegenerate(job) {
  if (!job.target_id) {
    throw new Error('regenerate job needs target_id (content_pieces.id)');
  }
  // Delegate to generate — it'll resolve the topic from the piece title.
  const result = await handleGenerate(job);
  return { ...result, intent: 'regenerate' };
}

module.exports = { handleRegenerate };

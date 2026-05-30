// ─────────────────────────────────────────────────────────
//  posts-writer.js — write one row per PostResult to public.posts
//
//  Schema requires (brand_id, content_piece_id, platform, status)
//  to be non-null. If either id is missing the writer no-ops with a
//  console line so standalone runs of generate.js don't error out.
//
//  Status mapping (Upload-Post → posts.status CHECK):
//    success                → posted
//    queued (scheduled_for) → scheduled
//    queued (no schedule)   → posting
//    failed                 → failed
// ─────────────────────────────────────────────────────────

const { insertPosts } = require('./worker/api');

function mapStatus(result, scheduledFor) {
  switch (result.status) {
    case 'success': return 'posted';
    case 'failed':  return 'failed';
    case 'queued':  return scheduledFor ? 'scheduled' : 'posting';
    default:        return 'failed';
  }
}

async function writePostRows({ brandId, contentPieceId, results, scheduledFor }) {
  if (!brandId || !contentPieceId) {
    console.log(
      '  ·  Skipping posts table write — need both BOOGLE_BRAND_ID/--brand ' +
      'and --content-piece <uuid> (or BOOGLE_CONTENT_PIECE_ID env)'
    );
    return { written: 0, skipped: true };
  }
  if (!Array.isArray(results) || results.length === 0) {
    return { written: 0, skipped: false };
  }

  const now = new Date().toISOString();
  const rows = results.map((r) => {
    const status = mapStatus(r, scheduledFor);
    return {
      brand_id:           brandId,
      content_piece_id:   contentPieceId,
      platform:           r.platform,
      status,
      platform_post_id:   r.externalPostId ?? null,
      platform_post_url:  r.postUrl ?? null,
      scheduled_for:      scheduledFor ?? null,
      posted_at:          status === 'posted' ? now : null,
      error_message:      r.error ?? null,
    };
  });

  const written = await insertPosts(rows);
  return { written, skipped: false };
}

module.exports = { writePostRows };

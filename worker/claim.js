// ─────────────────────────────────────────────────────────
//  Job claim — now brokered through the dashboard.
//
//  Phase 1b: the runner no longer claims jobs by querying Supabase
//  directly. It asks the dashboard for the next pending job FOR ITS
//  OWN BRAND (the dashboard resolves the runner token → brand and
//  scopes the claim). This removes the service-role key from the
//  runner and makes the multi-tenant model safe.
//
//  The job-claim atomicity now lives server-side in
//  GET /api/internal/jobs/next. See PLAN-RUNNER.md.
// ─────────────────────────────────────────────────────────

const { getNextJob, completeJob, failJob } = require('./api');

// Names kept identical so worker/index.js needs no changes.
async function claimNextJob() {
  return getNextJob();
}

module.exports = { claimNextJob, completeJob, failJob };

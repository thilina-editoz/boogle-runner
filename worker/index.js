// ─────────────────────────────────────────────────────────
//  BOOGLE Pipeline Worker — Stage 8f
//  Polls public.pipeline_jobs every POLL_INTERVAL_MS seconds.
//  Claims one pending job, dispatches to a handler, writes back
//  status='completed' or status='failed'.
//
//  Run with:
//    node worker/index.js
//  Stop with Ctrl-C — current job finishes, then the loop exits.
//
//  Env required (in .env):
//    BOOGLE_DASHBOARD_URL=https://<your-boogle-dashboard>
//    BOOGLE_RUNNER_TOKEN=<token issued in Settings → Your Runner>
//    BOOGLE_USER_ID=<your user id>   (for notifications)
//
//  Plus the BYOK keys the underlying scripts need (ANTHROPIC_API_KEY,
//  HEYGEN_API_KEY, APIFY_API_KEY, etc.).
//
//  The runner NO LONGER holds the Supabase service-role key — all DB
//  access is brokered by the dashboard via worker/api.js. See
//  PLAN-RUNNER.md.
// ─────────────────────────────────────────────────────────

const { claimNextJob, completeJob, failJob } = require('./claim');
const { syncKeysIntoEnv }  = require('./keys');
const { handleScrape }     = require('./handlers/scrape');
const { handleGenerate }   = require('./handlers/generate');
const { handlePause, handleCancel } = require('./handlers/pause');
const { handleRegenerate } = require('./handlers/regenerate');

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 10_000;

const HANDLERS = {
  scrape:     handleScrape,
  generate:   handleGenerate,
  pause:      handlePause,
  cancel:     handleCancel,
  regenerate: handleRegenerate,
};

// ── Graceful shutdown ─────────────────────────────────────
let shuttingDown = false;
let activeJobId = null;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

process.on('SIGINT', () => {
  if (shuttingDown) {
    console.log(`\n  [${ts()}] Second SIGINT — exiting immediately.`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`\n  [${ts()}] SIGINT received. Finishing job ${activeJobId ?? '(none)'} then stopping…`);
});

process.on('SIGTERM', () => {
  shuttingDown = true;
  console.log(`\n  [${ts()}] SIGTERM received. Shutting down after current job.`);
});

// ── Main loop ─────────────────────────────────────────────
async function processOne() {
  const job = await claimNextJob();
  if (!job) return false;

  activeJobId = job.id;
  console.log(`\n  [${ts()}] ▶ ${job.type} job ${job.id} (brand=${job.brand_id}, target=${job.target_id ?? '—'})`);

  // Refresh BYOK keys from the dashboard so this job runs on the
  // customer's latest keys (entered once in Settings → Integrations).
  // Best-effort — falls back to .env if the fetch fails.
  await syncKeysIntoEnv().catch(() => {});

  const handler = HANDLERS[job.type];
  if (!handler) {
    await failJob(job.id, `No handler for job type: ${job.type}`);
    console.error(`  [${ts()}] ✗ unknown job type "${job.type}" — marked failed`);
    activeJobId = null;
    return true;
  }

  try {
    const started = Date.now();
    const result = await handler(job);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    await completeJob(job.id, result);
    console.log(`  [${ts()}] ✓ ${job.type} job ${job.id} done in ${elapsed}s`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failJob(job.id, message);
    console.error(`  [${ts()}] ✗ ${job.type} job ${job.id} failed: ${message}`);
  } finally {
    activeJobId = null;
  }
  return true;
}

async function run() {
  console.log(`  [${ts()}] Boogle worker started. Polling every ${POLL_INTERVAL_MS / 1000}s.`);

  // Pull BYOK keys from the dashboard up front so the first job has them
  // even if the customer only entered keys in the web UI.
  await syncKeysIntoEnv().catch(() => {});

  while (!shuttingDown) {
    try {
      const didWork = await processOne();
      // If we just did work, immediately check for more — there may be
      // a queue. Only sleep when there was nothing pending.
      if (!didWork) {
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (err) {
      // Loop-level errors (e.g. DB connection blip) — log and back off.
      console.error(`  [${ts()}] worker loop error: ${err instanceof Error ? err.message : err}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }
  console.log(`  [${ts()}] Worker stopped cleanly.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

run().catch((err) => {
  console.error(`  [${ts()}] fatal:`, err);
  process.exit(1);
});

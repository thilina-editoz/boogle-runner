// ─────────────────────────────────────────────────────────
//  Generate handler — spawns the existing generate.js CLI.
//
//  Supports graceful pause: before each step boundary we'd normally
//  check the DB for a pause request. V1 keeps it simple — the handler
//  runs end-to-end; pause kicks in for the NEXT piece (handlePause
//  flags the piece in content_pieces).
//
//  Topic resolution:
//   - job.payload.topic     → explicit topic string
//   - job.target_id         → content_pieces.id, look up the title
//   - else                  → error (need something to generate)
// ─────────────────────────────────────────────────────────

const path = require('path');
const { spawn } = require('child_process');
const { updatePieceStatus } = require('../api');

const PIPELINE_ROOT   = path.resolve(__dirname, '..', '..');
const GENERATE_SCRIPT = path.join(PIPELINE_ROOT, 'generate.js');

async function resolveTopic(job) {
  if (job.payload && typeof job.payload.topic === 'string' && job.payload.topic.trim()) {
    return job.payload.topic.trim();
  }
  // Phase 1b: the runner no longer has direct DB access to look up a
  // piece title. The dashboard's approval cascade always includes
  // payload.topic when enqueuing a generate job, so this is the only
  // supported path now.
  throw new Error('generate job needs payload.topic (set by the dashboard approval cascade)');
}

function runScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...args], {
      cwd: PIPELINE_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      process.stdout.write(`    [generate] ${s}`);
    });
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(`    [generate:err] ${s}`);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`generate.js exited with code ${code}\n${stderr.slice(-500)}`));
    });
  });
}

async function handleGenerate(job) {
  const topic = await resolveTopic(job);
  // caption_style in payload wins; otherwise generate.js resolves brand
  // setting → env → default. Pass empty string positionally if absent so
  // --brand still lands at the right argv index.
  const explicitStyle = job.payload?.caption_style;
  const args = [topic];
  if (explicitStyle != null) args.push(String(explicitStyle));
  if (job.brand_id)  args.push('--brand', job.brand_id);
  if (job.target_id) args.push('--content-piece', job.target_id);

  const { stdout } = await runScript(GENERATE_SCRIPT, args);

  // Generate succeeded — flip the piece to 'review' so it shows up in
  // the dashboard's review queue, then fire piece_ready over Telegram.
  // Both steps are best-effort: a flaky status update or notify must
  // not mark the whole job failed.
  if (job.target_id) {
    try {
      await updatePieceStatus(job.target_id, 'review');
    } catch (err) {
      console.error(`    [generate] piece status → review failed: ${err.message}`);
    }

    try {
      const { notifyEvent, resolveOwnerUserId } = require('../../notify');
      const userId = await resolveOwnerUserId(job.brand_id);
      if (userId) {
        await notifyEvent({
          userId,
          event: {
            type: 'piece_ready',
            piece: { id: job.target_id, title: topic },
          },
        });
      }
    } catch (err) {
      console.error(`    [generate] piece_ready notify failed: ${err.message}`);
    }
  }

  return {
    ok: true,
    topic,
    brand_id: job.brand_id,
    caption_style: explicitStyle ?? null,
    log_tail: stdout.split('\n').slice(-10).join('\n'),
  };
}

module.exports = { handleGenerate };

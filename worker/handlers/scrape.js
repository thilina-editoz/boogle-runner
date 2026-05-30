// ─────────────────────────────────────────────────────────
//  Scrape handler — spawns the existing scrape.js CLI.
//
//  Behaviour: spawn scrape.js with `--brand <uuid>`. The script scrapes
//  TikTok+Instagram (env-config driven), runs Claude to extract topics,
//  saves trends/<date>.json, AND inserts pending content_ideas rows for
//  the brand. The dashboard's Trends page reads those rows.
//
//  Next refactor: load the brand's niche/audience/competitors from
//  Supabase (brands + competitors tables) instead of relying on the
//  scrape-side .env. Until then, all brands share the same scrape
//  config — fine while we have a single brand.
// ─────────────────────────────────────────────────────────

const path = require('path');
const { spawn } = require('child_process');

const PIPELINE_ROOT = path.resolve(__dirname, '..', '..');
const SCRAPE_SCRIPT = path.join(PIPELINE_ROOT, 'scrape.js');

function runScript(scriptPath, args = []) {
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
      process.stdout.write(`    [scrape] ${s}`);
    });
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(`    [scrape:err] ${s}`);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`scrape.js exited with code ${code}\n${stderr.slice(-500)}`));
    });
  });
}

async function handleScrape(job) {
  // brand_id is on the job; pass it through so scrape.js can scope by brand
  // once it's been refactored to read from Supabase.
  const { stdout } = await runScript(SCRAPE_SCRIPT, ['--brand', job.brand_id]);

  // Pull a rough summary out of stdout if scrape.js prints one.
  // Schema-flexible: result is just stored as jsonb on the job row.
  return {
    ok: true,
    brand_id: job.brand_id,
    log_tail: stdout.split('\n').slice(-10).join('\n'),
  };
}

module.exports = { handleScrape };

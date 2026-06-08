// ─────────────────────────────────────────────────────────
//  keys.js — pull BYOK keys from the dashboard into the runner's
//  environment so customers enter each key ONCE (Settings →
//  Integrations) instead of also pasting them into the runner .env.
//
//  Source of truth = the dashboard: a key present there overrides the
//  matching env var, so the customer manages keys in one place. A
//  provider the dashboard has no key for is left untouched, so an
//  advanced user can still set a value purely in .env. Best-effort —
//  a fetch failure leaves the existing environment intact (the runner
//  keeps using whatever is in .env).
//
//  Spawned scripts (scrape.js / generate.js / generate-image.js) are
//  launched with `env: process.env`, so injecting here is enough — the
//  children inherit the synced keys.
// ─────────────────────────────────────────────────────────

const { fetchApiKeys } = require('./api');

// dashboard provider slug → runner environment variable. Only the keys
// the runner's own scripts consume. Posting keys (upload_post / blotato
// / ayrshare) are used dashboard-side at publish time, not here.
const PROVIDER_ENV = {
  anthropic:  'ANTHROPIC_API_KEY',
  gemini:     'GEMINI_API_KEY',
  heygen:     'HEYGEN_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  assemblyai: 'ASSEMBLYAI_API_KEY',
  apify:      'APIFY_API_KEY',
};

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Fetch the customer's keys from the dashboard and inject them into
// process.env. Returns the number of keys newly applied/changed.
async function syncKeysIntoEnv() {
  const keys = await fetchApiKeys();
  const providers = Object.keys(keys || {});
  if (providers.length === 0) return 0;

  let applied = 0;
  const names = [];
  for (const provider of providers) {
    const envVar = PROVIDER_ENV[provider];
    if (!envVar) continue;
    const value = String(keys[provider] || '').trim();
    if (!value) continue;
    if (process.env[envVar] !== value) {
      process.env[envVar] = value;
      applied++;
      names.push(provider);
    }
  }
  if (applied > 0) {
    console.log(`  [${ts()}] [keys] synced ${applied} key(s) from dashboard: ${names.join(', ')}`);
  }
  return applied;
}

module.exports = { syncKeysIntoEnv, PROVIDER_ENV };

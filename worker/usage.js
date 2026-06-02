// ─────────────────────────────────────────────────────────
//  worker/usage.js — report API spend to the dashboard.
//
//  After a billable API call, the pipeline calls recordUsage() which
//  POSTs to the dashboard's /api/internal/usage broker (x-runner-token
//  auth). The dashboard increments today's api_usage row; the Token
//  Usage page sums it month-to-date.
//
//  Fire-and-forget: NEVER throws. A flaky usage report must not break
//  content generation.
//
//  Cost notes:
//   • Anthropic — exact, computed from the SDK's response.usage tokens.
//   • Apify     — exact, read from the run's usageTotalUsd.
//   • HeyGen / ElevenLabs / AssemblyAI — to be instrumented next; their
//     cost is estimated from minutes / characters / audio-seconds.
// ─────────────────────────────────────────────────────────

// USD per 1,000,000 tokens. Keep in sync with the model scrape.js /
// generate.js actually call. Sonnet 4.x list pricing.
const ANTHROPIC_RATES = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  _default:            { input: 3.0, output: 15.0 },
};

function anthropicCostUsd(model, inputTokens = 0, outputTokens = 0) {
  const r = ANTHROPIC_RATES[model] || ANTHROPIC_RATES._default;
  return (Number(inputTokens) / 1e6) * r.input + (Number(outputTokens) / 1e6) * r.output;
}

async function recordUsage({ provider, spendUsd, requestCount = 1 }) {
  const base = (process.env.BOOGLE_DASHBOARD_URL || '').replace(/\/$/, '');
  const token = process.env.BOOGLE_RUNNER_TOKEN;
  if (!base || !token || !provider) return { ok: false, reason: 'env/provider missing' };
  if (!(Number(spendUsd) >= 0)) return { ok: false, reason: 'bad spend' };

  try {
    const res = await fetch(`${base}/api/internal/usage`, {
      method: 'POST',
      headers: { 'x-runner-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, spend_usd: Number(spendUsd), request_count: requestCount }),
    });
    if (!res.ok) {
      console.error(`  ·  usage: ${provider} HTTP ${res.status}`);
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error(`  ·  usage: ${provider} report failed (${err.message})`);
    return { ok: false, reason: err.message };
  }
}

module.exports = { recordUsage, anthropicCostUsd };

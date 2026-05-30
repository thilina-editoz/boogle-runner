// ─────────────────────────────────────────────────────────
//  Brand config loader for the scraper / generator.
//
//  Pulls the brand's niche, audience, tone, and competitor handles
//  out of Supabase so scrape.js doesn't have to rely on .env vars
//  that are shared across brands.
//
//  Tables read:
//    brand_bible          → niche (text), mission, signature_phrases
//    audience_config      → age range, location, psychographics, tone sliders
//    competitors          → handles per platform (account-targeted scrapes)
//    voice_avatar_config  → HeyGen avatar_id, ElevenLabs voice_id + model
//    caption_config       → caption style_id (1-10)
//
//  Anything missing falls back to scrape.js's existing .env defaults
//  via the `withFallbacks` helper. That way a brand with empty config
//  still gets a working scrape instead of a hard error.
// ─────────────────────────────────────────────────────────

const { getBrandConfig } = require('./api');

// Map audience_config tone sliders (0–10) to a short descriptor used in
// the Claude prompt. Cheap heuristic — refine later.
function tonePhrase(formal, energy, playful) {
  const parts = [];
  if (formal != null) {
    if (formal <= 3) parts.push('casual');
    else if (formal >= 7) parts.push('formal');
    else parts.push('balanced register');
  }
  if (energy != null) {
    if (energy >= 7) parts.push('high-energy');
    else if (energy <= 3) parts.push('calm');
  }
  if (playful != null) {
    if (playful >= 7) parts.push('playful');
    else if (playful <= 3) parts.push('serious');
  }
  return parts.join(', ') || 'direct, experienced, no fluff';
}

function audiencePhrase(audience) {
  if (!audience) return null;
  const parts = [];
  const ageMin = audience.age_min;
  const ageMax = audience.age_max;
  if (ageMin != null && ageMax != null) parts.push(`aged ${ageMin}-${ageMax}`);
  if (audience.gender && audience.gender !== 'any' && audience.gender !== 'all') {
    parts.push(audience.gender);
  }
  if (Array.isArray(audience.pain_points) && audience.pain_points.length > 0) {
    parts.push(`struggling with ${audience.pain_points.slice(0, 3).join(', ')}`);
  }
  if (audience.psychographics) {
    parts.push(audience.psychographics);
  }
  return parts.length > 0 ? parts.join(' — ') : null;
}

async function loadBrandConfig(brandId) {
  if (!brandId) throw new Error('loadBrandConfig: brandId required');

  // The dashboard resolves the runner token → brand and returns the
  // raw row sets. The prompt-shaping transforms below stay here in the
  // pipeline (where they belong). brandId is still passed for parity /
  // logging, but the dashboard scopes by token, not this argument.
  const { bible, audience, brand, competitors: competitorsRaw, voice, caption } =
    await getBrandConfig();
  const competitors = competitorsRaw ?? [];

  const tiktokAccounts    = competitors.filter(c => c.platform === 'tiktok')    .map(c => c.handle.replace(/^@/, ''));
  const instagramAccounts = competitors.filter(c => c.platform === 'instagram') .map(c => c.handle.replace(/^@/, ''));

  return {
    brand_id:         brandId,
    brand_name:       brand?.name ?? null,
    niche:            bible?.niche ?? null,
    primaryAudience:  audiencePhrase(audience),
    country:          audience?.location_label ?? null,
    language:         audience?.language ?? null,
    gender:           audience?.gender ?? null,
    ageRange:         (audience?.age_min != null && audience?.age_max != null) ? `${audience.age_min}-${audience.age_max}` : null,
    painPoints:       Array.isArray(audience?.pain_points)  ? audience.pain_points.join(', ')  : null,
    aspirations:      Array.isArray(audience?.aspirations)  ? audience.aspirations.join(', ')  : null,
    bannedTopics:     Array.isArray(bible?.banned_phrases)  ? bible.banned_phrases.join(', ')  : null,
    tone:             tonePhrase(audience?.tone_formal, audience?.tone_energy, audience?.tone_playful),
    tiktokAccounts,
    instagramAccounts,
    // voice / avatar / captions — null if no row yet, falls back to .env
    avatarId:         voice?.avatar_id ?? null,
    voiceId:          voice?.voice_id ?? null,
    voiceModel:       voice?.voice_model ?? null,
    captionStyle:     caption?.style_id ?? null,
    // Hashtags currently have no UI / table — caller falls back to .env
    // for those. Will move them to DB once we have a "monitored sources"
    // settings page.
  };
}

// Merge brand-loaded config over env defaults. Anything null/empty in
// the brand config falls back to the env value so a partial brand still
// produces a working scrape.
function withFallbacks(brandCfg, envCfg) {
  const out = { ...envCfg };
  for (const [k, v] of Object.entries(brandCfg)) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  // Merge accounts (don't overwrite): combine DB + env, dedupe.
  if (brandCfg.tiktokAccounts?.length || envCfg.tiktokAccounts?.length) {
    out.tiktokAccounts = Array.from(new Set([
      ...(brandCfg.tiktokAccounts ?? []),
      ...(envCfg.tiktokAccounts ?? []),
    ]));
  }
  if (brandCfg.instagramAccounts?.length || envCfg.instagramAccounts?.length) {
    out.instagramAccounts = Array.from(new Set([
      ...(brandCfg.instagramAccounts ?? []),
      ...(envCfg.instagramAccounts ?? []),
    ]));
  }
  return out;
}

module.exports = { loadBrandConfig, withFallbacks };

// ─────────────────────────────────────────────────────────
//  BOOGLE by Content Psycho — Daily Trend Scraper (Stage 7)
//  Finds what's trending in your niche on TikTok + Instagram
//  Saves top topic ideas to trends/today.json AND (when --brand is
//  passed) inserts them into Supabase `content_ideas` for that brand,
//  status='pending'.
//
//  Usage:
//  node scrape.js                       ← scrape, save JSON only
//  node scrape.js --print               ← also print full results
//  node scrape.js --brand <uuid>        ← also write content_ideas rows
//                                          (used by the pipeline worker)
// ─────────────────────────────────────────────────────────

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const { recordUsage, anthropicCostUsd } = require('./worker/usage');
const { isShotMiningEnabled, mineTopPosts } = require('./edit-brain/shot-mining');

const APIFY_BASE = 'https://api.apify.com/v2';
const PRINT_MODE = process.argv.includes('--print');

// ─── Optional --brand <uuid> ──────────────────────────────
// When passed, scraped topics are inserted into Supabase
// `content_ideas` rows for that brand. The dashboard's Trends page
// reads from that table; the JSON files stay as a local artifact.
const BRAND_ID = (() => {
  const i = process.argv.indexOf('--brand');
  if (i === -1) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error('\n  ❌  --brand requires a UUID\n');
    process.exit(1);
  }
  return v;
})();

// ─── VALIDATE ENV ────────────────────────────────────────
if (!process.env.APIFY_API_KEY || process.env.APIFY_API_KEY === '') {
  console.error('\n  ❌  Missing APIFY_API_KEY in .env');
  console.error('      Sign up free at apify.com → Settings → API & Integrations\n');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n  ❌  Missing ANTHROPIC_API_KEY in .env\n');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── CONFIG ──────────────────────────────────────────────
// Default config from .env. When --brand <uuid> is passed, brand-scoped
// values from Supabase override these at run() time (see loadBrandConfig).
// Reassigned (not const) so the runtime override is possible.
let config = {
  tiktokHashtags:     (process.env.MONITOR_TIKTOK_HASHTAGS    || 'contentcreation,personaldevelopment').split(',').map(s => s.trim()).filter(Boolean),
  tiktokAccounts:     (process.env.MONITOR_TIKTOK_ACCOUNTS     || '').split(',').map(s => s.trim()).filter(Boolean),
  instagramHashtags:  (process.env.MONITOR_INSTAGRAM_HASHTAGS  || 'contentcreator,personalgrowth').split(',').map(s => s.trim()).filter(Boolean),
  instagramAccounts:  (process.env.MONITOR_INSTAGRAM_ACCOUNTS  || '').split(',').map(s => s.trim()).filter(Boolean),
  postsLimit:         parseInt(process.env.SCRAPE_POSTS_LIMIT) || 25,
  trendsPerDay:       parseInt(process.env.TRENDS_PER_DAY)     || 5,
  niche:              process.env.NICHE                         || 'content creation and personal branding',
  primaryAudience:    process.env.PRIMARY_AUDIENCE             || 'aspiring creators aged 22-35',
  country:            process.env.TARGET_COUNTRY               || 'US',
  tone:               process.env.TONE                         || 'direct, experienced, no fluff',
};

// ─────────────────────────────────────────────────────────
//  APIFY HELPER — Run an actor and wait for results
// ─────────────────────────────────────────────────────────
async function runApifyActor(actorId, input) {
  const safeActorId = actorId.replace('/', '~');

  // Start the actor run
  const startRes = await fetch(
    `${APIFY_BASE}/acts/${safeActorId}/runs?token=${process.env.APIFY_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );

  if (!startRes.ok) {
    const err = await startRes.text();
    throw new Error(`Apify actor start failed (${startRes.status}): ${err}`);
  }

  const startData = await startRes.json();
  const runId     = startData.data.id;
  const datasetId = startData.data.defaultDatasetId;

  // Poll until finished
  log('step', `Actor running (ID: ${runId})...`);
  let attempts = 0;
  while (attempts < 60) {
    await sleep(5000);
    attempts++;

    const statusRes = await fetch(
      `${APIFY_BASE}/actor-runs/${runId}?token=${process.env.APIFY_API_KEY}`
    );
    const statusData = await statusRes.json();
    const status = statusData.data.status;

    process.stdout.write(`  →  Status: ${status} (${attempts * 5}s)...\r`);

    if (status === 'SUCCEEDED') {
      console.log('');
      // Report exact Apify spend for this run (fire-and-forget).
      const apifyCost = Number(statusData.data?.usageTotalUsd ?? 0);
      if (apifyCost > 0) await recordUsage({ provider: 'apify', spendUsd: apifyCost });
      break;
    }
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      console.log('');
      throw new Error(`Actor ${actorId} ${status}`);
    }
  }

  // Fetch dataset items
  const dataRes = await fetch(
    `${APIFY_BASE}/datasets/${datasetId}/items?token=${process.env.APIFY_API_KEY}&limit=${config.postsLimit}`
  );

  if (!dataRes.ok) throw new Error(`Failed to fetch dataset: ${dataRes.status}`);
  return await dataRes.json();
}

// ─────────────────────────────────────────────────────────
//  SCRAPE TIKTOK — hashtags + accounts
// ─────────────────────────────────────────────────────────
async function scrapeTikTok() {
  log('step', `Scraping TikTok (hashtags: ${config.tiktokHashtags.join(', ')})...`);

  const searches = [
    ...config.tiktokHashtags.map(h => `#${h}`),
    ...config.tiktokAccounts.map(a => `@${a}`),
  ];

  try {
    const items = await runApifyActor('clockworks/tiktok-scraper', {
      hashtags:      config.tiktokHashtags,
      profiles:      config.tiktokAccounts,
      resultsPerPage: Math.ceil(config.postsLimit / Math.max(searches.length, 1)),
      maxProfilesPerQuery: 1,
      // Only ask Apify to download videos when shot-level mining is on — it's
      // an extra Apify + bandwidth cost (Stage 12 TASK 2b), off by default.
      shouldDownloadVideos: isShotMiningEnabled(),
      shouldDownloadCovers: false,
    });

    // Normalize and filter
    return items
      .filter(item => item.text || item.desc)
      .map(item => ({
        platform:    'tiktok',
        description: (item.text || item.desc || '').slice(0, 300),
        views:       item.playCount       || item.stats?.playCount       || 0,
        likes:       item.diggCount       || item.stats?.diggCount       || 0,
        comments:    item.commentCount    || item.stats?.commentCount    || 0,
        shares:      item.shareCount      || item.stats?.shareCount      || 0,
        author:      item.authorMeta?.name || item.author?.nickname || 'unknown',
        url:         item.webVideoUrl     || item.url || '',
        // Runtime in seconds (Edit Brain miner) — clockworks exposes videoMeta.duration.
        durationS:   item.videoMeta?.duration ?? null,
        // Downloadable video URL for shot-level mining (Stage 12 TASK 2b) —
        // present when shouldDownloadVideos is on. null otherwise.
        videoDownloadUrl: item.mediaUrls?.[0] || item.videoMeta?.downloadAddr || null,
        // Trending-sound metadata (Edit Brain). Apify clockworks/tiktok-scraper
        // returns musicMeta; field names vary, so read defensively.
        musicId:     item.musicMeta?.musicId     || item.musicMeta?.id         || null,
        musicName:   item.musicMeta?.musicName   || item.musicMeta?.title      || null,
        musicAuthor: item.musicMeta?.musicAuthor || item.musicMeta?.authorName || null,
        musicUrl:    item.musicMeta?.playUrl     || item.musicMeta?.musicUrl   || null,
      }))
      .sort((a, b) => b.views - a.views)
      .slice(0, config.postsLimit);

  } catch (err) {
    log('error', `TikTok scrape failed: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────
//  SCRAPE INSTAGRAM — hashtags
// ─────────────────────────────────────────────────────────
async function scrapeInstagram() {
  if (config.instagramHashtags.length === 0) return [];
  log('step', `Scraping Instagram (hashtags: ${config.instagramHashtags.join(', ')})...`);

  try {
    const items = await runApifyActor('apify/instagram-scraper', {
      hashtags:    config.instagramHashtags,
      resultsType: 'posts',
      resultsLimit: config.postsLimit,
      addParentData: false,
    });

    return items
      .filter(item => item.caption || item.text)
      .map(item => ({
        platform:    'instagram',
        description: (item.caption || item.text || '').slice(0, 300),
        views:       item.videoViewCount  || item.likesCount * 10 || 0,
        likes:       item.likesCount      || 0,
        comments:    item.commentsCount   || 0,
        shares:      0,
        author:      item.ownerUsername   || 'unknown',
        url:         item.url             || item.shortCode ? `https://instagram.com/p/${item.shortCode}` : '',
        // Runtime in seconds (Edit Brain miner) — IG scraper exposes videoDuration on reels.
        durationS:   item.videoDuration ?? null,
        // Downloadable reel URL for shot-level mining (Stage 12 TASK 2b).
        videoDownloadUrl: item.videoUrl ?? null,
        // Trending-sound metadata (Edit Brain). apify/instagram-scraper exposes
        // musicInfo on reels; absent on photos — null is fine.
        musicId:     item.musicInfo?.audio_id    || null,
        musicName:   item.musicInfo?.song_name   || null,
        musicAuthor: item.musicInfo?.artist_name || null,
        musicUrl:    null,
      }))
      .sort((a, b) => b.likes - a.likes)
      .slice(0, config.postsLimit);

  } catch (err) {
    log('error', `Instagram scrape failed: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────
//  CALCULATE ENGAGEMENT SCORE
//  Rewards velocity (high engagement relative to platform avg)
//  not just raw numbers
// ─────────────────────────────────────────────────────────
function engagementScore(post) {
  const engagements = post.likes + (post.comments * 3) + (post.shares * 5);
  const views       = post.views || 1;
  const ratio       = engagements / views;
  return ratio * Math.log10(Math.max(post.views, 10));
}

// ─────────────────────────────────────────────────────────
//  CLAUDE TOPIC EXTRACTION
//  Analyzes scraped posts and generates actionable content ideas
// ─────────────────────────────────────────────────────────
async function extractTopics(posts) {
  log('step', `Analysing ${posts.length} posts with Claude...`);

  if (posts.length === 0) {
    log('error', 'No posts to analyse — check your hashtags and API key');
    return [];
  }

  // Format posts for Claude
  const postSummaries = posts
    .slice(0, 20)
    .map((p, i) => `${i + 1}. [${p.platform.toUpperCase()}] @${p.author}
   Caption: "${p.description}"
   Views: ${p.views.toLocaleString()} | Likes: ${p.likes.toLocaleString()} | Comments: ${p.comments.toLocaleString()}`)
    .join('\n\n');

  const prompt = `You are a content strategy expert analysing viral social media posts to generate topic ideas.

CREATOR NICHE: ${config.niche}
TARGET AUDIENCE: ${config.primaryAudience}
TARGET COUNTRY: ${config.country}
CONTENT TONE: ${config.tone}

Here are today's top-performing posts across TikTok and Instagram:

${postSummaries}

Analyse these posts and generate exactly ${config.trendsPerDay} content topic ideas for this creator.

For each idea consider:
- What core emotion or insight made the original post perform well
- How to adapt the angle for this creator's specific niche and audience
- The hook format that would work (curiosity, pain point, controversy, story, list)
- The best CONTENT TYPE to deliver it: "reel" (short vertical video — default, best for narrative/emotional hooks), "carousel" (multi-slide images for step-by-step / listicles), "image" (one strong visual or quote), "story" (casual ephemeral), or "text" (discussion/text post)

Respond ONLY with valid JSON — no text before or after. Use this exact format:
{
  "scrapedAt": "${new Date().toISOString()}",
  "niche": "${config.niche}",
  "topics": [
    {
      "rank": 1,
      "topic": "The specific content topic/angle",
      "hook": "The opening line for this video",
      "hookAlternative": "A second hook option",
      "whyItWillWork": "One sentence on why this resonates with the audience",
      "contentType": "reel | story | carousel | image | text",
      "format": "reel | carousel | quote_card",
      "emotion": "curiosity | inspiration | controversy | relatability | fear_of_missing_out",
      "sourceInsight": "What from the scraped posts inspired this"
    }
  ]
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });

  // Report exact Anthropic spend from the SDK's token counts (fire-and-forget).
  await recordUsage({
    provider: 'anthropic',
    spendUsd: anthropicCostUsd(
      'claude-sonnet-4-6',
      response.usage?.input_tokens,
      response.usage?.output_tokens
    ),
  });

  const raw = response.content[0].text.trim();

  try {
    const parsed = JSON.parse(raw);
    return parsed.topics || [];
  } catch {
    // Try extracting JSON from response if there's any surrounding text
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.topics || [];
      } catch {}
    }
    log('error', 'Claude returned invalid JSON — saving raw response');
    return [];
  }
}

// ─────────────────────────────────────────────────────────
//  SAVE AND DISPLAY TRENDS
// ─────────────────────────────────────────────────────────
function saveTrends(topics, allPosts) {
  const trendsDir = 'trends';
  if (!fs.existsSync(trendsDir)) fs.mkdirSync(trendsDir, { recursive: true });

  const today = new Date().toISOString().split('T')[0];

  const output = {
    date:        today,
    scrapedAt:   new Date().toISOString(),
    niche:       config.niche,
    postsScraped: allPosts.length,
    platforms:   [...new Set(allPosts.map(p => p.platform))],
    topics,
  };

  // Save today's trends
  fs.writeFileSync(path.join(trendsDir, 'today.json'), JSON.stringify(output, null, 2));

  // Archive with date stamp
  fs.writeFileSync(path.join(trendsDir, `${today}.json`), JSON.stringify(output, null, 2));

  return output;
}

// ─────────────────────────────────────────────────────────
//  SUPABASE WRITE — insert content_ideas rows for a brand
//  Called only when --brand <uuid> was passed.
// ─────────────────────────────────────────────────────────
// Normalize the model's contentType to the content_ideas CHECK set
// (13_1_content_types). Anything unexpected → 'reel' (the safe default).
const VALID_CONTENT_TYPES = new Set(['reel', 'story', 'carousel', 'image', 'text']);
function normContentType(v) {
  const t = String(v ?? '').trim().toLowerCase();
  return VALID_CONTENT_TYPES.has(t) ? t : 'reel';
}

async function insertContentIdeas(brandId, topics, allPosts) {
  const { insertIdeas } = require('./worker/api');

  // Per-topic source attribution: pick the top-engagement post for the
  // dominant platform mentioned in sourceInsight, fall back to the
  // single highest-engagement post overall. Cheap heuristic — good
  // enough for v1, the user can re-rank in the UI.
  const topPostByPlatform = new Map();
  for (const p of allPosts) {
    if (!topPostByPlatform.has(p.platform)) topPostByPlatform.set(p.platform, p);
  }
  const overallTop = allPosts[0] ?? null;

  const scrapedAt = new Date().toISOString();
  const rows = topics.map((t, i) => {
    const insight = (t.sourceInsight || '').toLowerCase();
    const matchedPlatform = ['tiktok', 'instagram'].find(p => insight.includes(p)) ?? null;
    const sourcePost = (matchedPlatform && topPostByPlatform.get(matchedPlatform)) || overallTop;

    return {
      brand_id:          brandId,
      rank:              t.rank ?? i + 1,
      topic:             String(t.topic ?? '').slice(0, 500),
      hook:              String(t.hook ?? '').slice(0, 500),
      hook_alternative:  t.hookAlternative ? String(t.hookAlternative).slice(0, 500) : null,
      why_it_will_work:  t.whyItWillWork ? String(t.whyItWillWork).slice(0, 1000) : null,
      emotion:           t.emotion ?? null,
      format:            t.format ?? null,
      content_type:      normContentType(t.contentType),
      platform:          sourcePost?.platform ?? matchedPlatform ?? null,
      source:            sourcePost?.platform ?? null,
      source_url:        sourcePost?.url ?? null,
      source_views:      sourcePost?.views != null
                           ? formatViewCount(sourcePost.views)
                           : null,
      status:            'pending',
      scraped_at:        scrapedAt,
    };
  });

  // brand_id on each row is ignored server-side — the dashboard scopes
  // the insert to the runner token's brand. We still set it for clarity.
  const data = await insertIdeas(rows);
  log('done', `Inserted ${data.length} content_ideas rows for brand ${brandId}`);

  // Fire one idea_ready notification per inserted idea. The dashboard
  // dispatcher handles the inline Approve/Reject buttons.
  // Fire-and-forget — never block the scraper on Telegram I/O.
  try {
    const { notifyEvent, resolveOwnerUserId } = require('./notify');
    const userId = await resolveOwnerUserId(brandId);
    if (userId) {
      await Promise.all(
        data.map((idea) =>
          notifyEvent({
            userId,
            event: {
              type: 'idea_ready',
              idea: {
                id: idea.id,
                title: idea.topic,
                format: idea.format || 'reel',
                platform: idea.platform,
                // Inspiration context so the Telegram message can link
                // to the original post (returned by /api/internal/ideas).
                source: idea.source ?? null,
                sourceUrl: idea.source_url ?? null,
                sourceViews: idea.source_views ?? null,
              },
            },
          })
        )
      );
    } else {
      log('step', `Skipping Telegram notify — no owner_id for brand ${brandId}`);
    }
  } catch (err) {
    log('error', `notify failed (non-fatal): ${err.message}`);
  }

  return data.length;
}

// Compact view-count formatter for source_views (text column on
// content_ideas). 12_345 → "12.3K", 1_234_567 → "1.2M".
function formatViewCount(n) {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function displayTopics(topics) {
  divider();
  console.log("  TODAY'S CONTENT IDEAS:\n");

  topics.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.topic}`);
    console.log(`     Hook    : "${t.hook}"`);
    console.log(`     Format  : ${t.format}  |  Emotion: ${t.emotion}`);
    console.log(`     Why     : ${t.whyItWillWork}`);
    console.log('');
  });

  divider();
  console.log('  → Run any topic through the pipeline:');
  console.log('     node generate.js              ← auto-picks top trend');
  console.log('     node generate.js "your topic" ← use custom topic');
  console.log('');
}

// ─────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(type, msg) {
  const icons = { step: '→', done: '✅', error: '❌' };
  console.log(`  ${icons[type] || '·'}  ${msg}`);
}
function divider() { console.log('\n  ' + '─'.repeat(52) + '\n'); }

// ─────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────
async function run() {
  console.log('\n');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   BOOGLE  —  Daily Trend Scraper                ║');
  console.log('  ║   by Content Psycho  —  Stage 7                 ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  divider();
  console.log(`  Niche      : ${config.niche}`);
  console.log(`  TikTok     : #${config.tiktokHashtags.join(', #')}`);
  if (config.tiktokAccounts.length > 0)
    console.log(`  Accounts   : @${config.tiktokAccounts.join(', @')}`);
  console.log(`  Instagram  : #${config.instagramHashtags.join(', #')}`);
  console.log(`  Ideas/day  : ${config.trendsPerDay}`);
  divider();

  try {
    // ── Brand-scoped config override ──────────────────────────
    // When --brand <uuid> was passed, pull niche/audience/competitors
    // from Supabase and merge over the env defaults.
    if (BRAND_ID) {
      try {
        const { loadBrandConfig, withFallbacks } = require('./worker/brand-config');
        const brandCfg = await loadBrandConfig(BRAND_ID);
        config = withFallbacks(brandCfg, config);
        log('done', `Loaded brand config: ${brandCfg.brand_name ?? BRAND_ID} (niche="${config.niche}")`);
        if (config.tiktokAccounts.length || config.instagramAccounts.length) {
          log('step', `Brand competitors → TikTok:${config.tiktokAccounts.length}, IG:${config.instagramAccounts.length}`);
        }
      } catch (err) {
        log('error', `Brand config load failed, using .env defaults: ${err.message}`);
      }
    }

    // Scrape both platforms in parallel
    const [tiktokPosts, instagramPosts] = await Promise.allSettled([
      scrapeTikTok(),
      scrapeInstagram(),
    ]);

    const allPosts = [
      ...(tiktokPosts.status    === 'fulfilled' ? tiktokPosts.value    : []),
      ...(instagramPosts.status === 'fulfilled' ? instagramPosts.value : []),
    ];

    log('done', `Scraped ${allPosts.length} posts total`);

    // Record trending sounds for the Edit Brain (fire-and-forget — never fatal).
    try {
      const { recordTrendingSounds } = require('./worker/api');
      const sounds = allPosts
        .filter(p => p.musicId)
        .map(p => ({
          platform:          p.platform,
          external_sound_id: String(p.musicId),
          title:             p.musicName   || null,
          author:            p.musicAuthor || null,
          play_url:          p.musicUrl    || null,
        }));
      if (sounds.length) {
        const r = await recordTrendingSounds(sounds);
        if (r && r.ok) log('done', `Recorded ${r.upserted ?? sounds.length} trending sound(s)`);
        else log('step', `Trending-sound capture skipped (${r?.reason || 'none'})`);
      }
    } catch (err) {
      log('error', `trending-sound capture failed (non-fatal): ${err.message}`);
    }

    // Sort by engagement score
    allPosts.sort((a, b) => engagementScore(b) - engagementScore(a));

    // Mine editing patterns for the Edit Brain learning loop (fire-and-forget).
    // Always captures metadata (runtime + engagement + sound). When
    // EDIT_BRAIN_SHOT_MINING is on (TASK 2b), ALSO downloads the top-N posts
    // and runs ffmpeg scene detection for real avg_shot_len_s + shot_count.
    // The Director reads these back to bias target_duration_s + pacing.
    // Dedupes on url.
    try {
      const { recordEditingPatterns } = require('./worker/api');
      // Shot-level enrichment (best-effort, no-op + empty Map when flag off).
      const shotsByUrl = await mineTopPosts(allPosts, log);
      const patterns = allPosts
        .filter(p => p.url)
        .slice(0, 10)
        .map(p => {
          const shots = shotsByUrl.get(p.url) || null;
          return {
          source_platform:     p.platform,
          source_post_url:     p.url,
          source_views:        p.views || 0,
          effectiveness_score: Math.round(engagementScore(p) * 100) / 100,
          pattern_data: {
            duration_s:    p.durationS != null ? Number(p.durationS) : null,
            music_id:      p.musicId ? String(p.musicId) : null,
            caption_len:   p.description ? p.description.length : null,
            hashtag_count: (p.description.match(/#/g) || []).length,
            // null unless shot-level mining ran for this post.
            avg_shot_len_s: shots ? shots.avg_shot_len_s : null,
            shot_count:     shots ? shots.shot_count : null,
          },
        };
        });
      if (patterns.length) {
        const r = await recordEditingPatterns(patterns);
        if (r && r.ok) log('done', `Recorded ${r.recorded ?? patterns.length} editing pattern(s)`);
        else log('step', `Editing-pattern capture skipped (${r?.reason || 'none'})`);
      }
    } catch (err) {
      log('error', `editing-pattern capture failed (non-fatal): ${err.message}`);
    }

    // Print top posts if requested
    if (PRINT_MODE) {
      divider();
      console.log('  TOP PERFORMING POSTS:\n');
      allPosts.slice(0, 10).forEach((p, i) => {
        console.log(`  ${i + 1}. [${p.platform.toUpperCase()}] @${p.author}`);
        console.log(`     "${p.description.slice(0, 100)}..."`);
        console.log(`     👁 ${p.views.toLocaleString()}  ❤️ ${p.likes.toLocaleString()}  💬 ${p.comments.toLocaleString()}`);
        console.log('');
      });
    }

    // Extract topics with Claude
    const topics = await extractTopics(allPosts);

    if (topics.length === 0) {
      log('error', 'No topics generated — check Claude API key and scraped data');
      process.exit(1);
    }

    // Save and display
    const saved = saveTrends(topics, allPosts);
    log('done', `Trends saved → trends/today.json`);
    log('done', `Archive saved → trends/${saved.date}.json`);

    // If invoked by the worker (--brand <uuid>), also write Supabase rows
    // so the dashboard Trends page can show today's ideas.
    if (BRAND_ID) {
      try {
        await insertContentIdeas(BRAND_ID, topics, allPosts);
      } catch (err) {
        // Don't kill the whole run — JSON is still saved.
        log('error', `content_ideas write failed: ${err.message}`);
        process.exitCode = 1;
      }
    } else {
      log('step', 'No --brand passed → skipping Supabase insert (local run)');
    }

    displayTopics(topics);

  } catch (err) {
    divider();
    log('error', err.message);
    if (err.message.includes('401') || err.message.includes('token')) {
      console.error('\n     → Check your APIFY_API_KEY in .env\n');
    }
    if (err.message.includes('Actor')) {
      console.error('\n     → Apify actor error — the scraper may need updating');
      console.error('       Check apify.com/actors for the latest actor IDs\n');
    }
    console.error('     → Paste this error in the chat for an immediate fix.\n');
    process.exit(1);
  }
}

run();

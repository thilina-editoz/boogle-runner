#!/usr/bin/env node
// ─────────────────────────────────────────────────────────
//  BOOGLE — Image / Text pipeline (Content Types, Stage C3)
//
//  The non-video sibling of generate.js. The video path (reel/story)
//  still runs through generate.js untouched; carousel / image / text
//  pieces run here instead. The worker handler chooses which script to
//  spawn from job.payload.content_type.
//
//  What it does, driven by a provider-agnostic ASSET PLAN (built by the
//  dashboard's asset-plan Director, lib/edit-brain/asset-plan.ts, and
//  staged to a temp file we read via --asset-plan):
//    • carousel → generate N image slides (Gemini "Nano Banana"
//                 gemini-2.5-flash-image), upload each to R2
//    • image    → generate 1 image, upload to R2
//    • text     → no media; just the post copy
//
//  Output (parsed by worker/handlers/generate.js from stdout):
//    [[PIECE_MEDIA]]{"media":[{kind,r2_key,position,meta}...]}  (image/carousel)
//    [[PIECE_OUTPUT]]{"caption":...,"thumbnail_url":...}        (all kinds)
//  The handler writes content_media + the piece caption/thumbnail, then
//  flips the piece to 'review'.
//
//  Env:
//    GEMINI_API_KEY        — BYOK Google Gemini (AI Studio) key
//    GEMINI_IMAGE_MODEL    — optional override (default gemini-2.5-flash-image)
//    + the R2 upload env from r2-upload.js
//      (BOOGLE_DASHBOARD_URL / BOOGLE_INTERNAL_TOKEN / BOOGLE_USER_ID)
//
//  Usage:
//    node generate-image.js "<topic>" [caption_style] \
//      --content-type <carousel|image|text> --asset-plan <tmpfile> \
//      --brand <id> --content-piece <id>
// ─────────────────────────────────────────────────────────

require('dotenv').config();
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { uploadToR2 } = require('./r2-upload');
const { postContent } = require('./post');

const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const GEMINI_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Aspect → a short prompt suffix. gemini-2.5-flash-image has no simple
// aspect parameter, so we steer it in the prompt. Provider-agnostic plan
// in, provider-specific nudge out.
const ASPECT_HINT = {
  '9:16': 'Vertical 9:16 aspect ratio, full-bleed composition.',
  '4:5':  'Vertical 4:5 portrait aspect ratio, full-bleed composition.',
  '1:1':  'Square 1:1 aspect ratio, full-bleed composition.',
};

function parseArgs(argv) {
  const out = { positional: [], contentType: null, assetPlanPath: null, brandId: null, pieceId: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--content-type') { out.contentType = rest[++i]; }
    else if (a === '--asset-plan') { out.assetPlanPath = rest[++i]; }
    else if (a === '--brand') { out.brandId = rest[++i]; }
    else if (a === '--content-piece') { out.pieceId = rest[++i]; }
    else { out.positional.push(a); }
  }
  out.topic = out.positional[0] || null;
  return out;
}

function loadAssetPlan(p) {
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`[image] could not read asset plan ${p}: ${err.message}`);
    return null;
  }
}

function slugify(s) {
  return String(s || 'post')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'post';
}

// Call Gemini once for a single prompt; return { buffer, mime } or throw.
async function generateImage(prompt, aspect) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');

  const fullPrompt = `${prompt}\n\n${ASPECT_HINT[aspect] || ASPECT_HINT['4:5']}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(GEMINI_ENDPOINT(GEMINI_MODEL), {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const img = parts.find((p) => p.inlineData && p.inlineData.data);
    if (!img) {
      throw new Error('Gemini returned no inline image data');
    }
    const mime = img.inlineData.mimeType || 'image/png';
    const buffer = Buffer.from(img.inlineData.data, 'base64');
    return { buffer, mime };
  } finally {
    clearTimeout(timer);
  }
}

function emit(marker, obj) {
  process.stdout.write(`[[${marker}]]${JSON.stringify(obj)}\n`);
}

// Publish the finished piece via the dashboard, mirroring generate.js's
// gate: when POST_APPROVAL is on (the default) we stop after generation and
// let the user approve in the dashboard; only POST_APPROVAL=false auto-posts.
// Best-effort — a posting failure must not fail the generation job (the
// media is already written back, so the piece is recoverable in review).
async function maybePost({ kind, mediaUrls, caption, hashtags, args }) {
  const postApproval = process.env.POST_APPROVAL !== 'false';
  if (postApproval) {
    console.log('[image] POST_APPROVAL on — awaiting dashboard approval to publish');
    return;
  }
  try {
    const result = await postContent({
      mediaType: kind === 'text' ? 'text' : 'photo',
      mediaUrls,
      caption,
      hashtags: Array.isArray(hashtags) ? hashtags.join(' ') : (hashtags || ''),
      folder: null,
      brandId: args.brandId || process.env.BOOGLE_BRAND_ID || null,
      contentPieceId: args.pieceId || process.env.BOOGLE_CONTENT_PIECE_ID || null,
    });
    console.log(`[image] posting: ${result.status}`);
  } catch (err) {
    console.error(`[image] posting failed (non-fatal): ${err.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const kind = (args.contentType || 'image').toLowerCase();
  const plan = loadAssetPlan(args.assetPlanPath);

  if (!plan) {
    // No plan means the dashboard Director failed/skipped. We can still
    // ship a text post from the topic, but image/carousel need prompts.
    if (kind === 'text') {
      emit('PIECE_OUTPUT', { caption: args.topic || '' });
      console.log('[image] text post: no plan, fell back to topic as caption');
      return;
    }
    throw new Error('no asset plan available for an image/carousel piece');
  }

  const caption = typeof plan.caption === 'string' && plan.caption.trim()
    ? plan.caption.trim()
    : (args.topic || '');
  const hashtags = Array.isArray(plan.hashtags) ? plan.hashtags.filter((h) => typeof h === 'string') : [];
  const fullCaption = hashtags.length ? `${caption}\n\n${hashtags.join(' ')}` : caption;

  // Text-only — no media, just the copy.
  if (kind === 'text') {
    emit('PIECE_OUTPUT', { caption: fullCaption });
    console.log('[image] text post ready (no media)');
    await maybePost({ kind: 'text', mediaUrls: [], caption, hashtags, args });
    return;
  }

  const aspect = plan.aspect || '4:5';
  const slides = Array.isArray(plan.slides) ? plan.slides : [];
  if (slides.length === 0) {
    throw new Error('asset plan has no slides to render');
  }

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${slugify(args.topic)}`;
  const media = [];
  let thumbnailUrl = null;

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i] || {};
    const prompt = typeof slide.image_prompt === 'string' ? slide.image_prompt.trim() : '';
    if (!prompt) { console.warn(`[image] slide ${i} has no prompt — skipping`); continue; }

    console.log(`[image] generating slide ${i + 1}/${slides.length} …`);
    const { buffer, mime } = await generateImage(prompt, aspect);

    const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
    const localPath = path.join(os.tmpdir(), `boogle-slide-${runId}-${i}.${ext}`);
    fs.writeFileSync(localPath, buffer);

    try {
      const { key, publicUrl } = await uploadToR2({ localPath, runId, contentType: mime });
      media.push({
        kind: 'image',
        r2_key: key,
        position: i,
        meta: { prompt, caption: slide.caption || null, public_url: publicUrl, aspect },
      });
      if (!thumbnailUrl) thumbnailUrl = publicUrl;
      console.log(`[image] slide ${i} uploaded → ${key}`);
    } finally {
      try { fs.unlinkSync(localPath); } catch { /* best-effort */ }
    }
  }

  if (media.length === 0) {
    throw new Error('no slides rendered');
  }

  emit('PIECE_MEDIA', { media });
  emit('PIECE_OUTPUT', { caption: fullCaption, ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}) });
  console.log(`[image] done — ${media.length} slide(s)`);

  const slideUrls = media.map((m) => m.meta.public_url).filter(Boolean);
  await maybePost({ kind: 'photo', mediaUrls: slideUrls, caption, hashtags, args });
}

main().catch((err) => {
  console.error(`[image] FAILED: ${err.message}`);
  process.exit(1);
});

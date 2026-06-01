// ─────────────────────────────────────────────────────────
//  EDIT BRAIN — runner-side rulebook mirror (Stage 12.3)
//
//  A small CommonJS mirror of the craft constants the dashboard
//  Director uses (lib/edit-brain/rulebook.ts). The Executor only
//  needs the bits that affect *rendering*: platform safe zones and
//  the caption-position → libass placement mapping. Keep the values
//  in sync with the dashboard copy.
// ─────────────────────────────────────────────────────────

// Pixel insets for a 1080×1920 vertical canvas — keep captions out of
// the native platform UI (action rails, CTAs, progress bars).
const SAFE_ZONES = {
  tiktok:    { top: 180, bottom: 320, left: 40, right: 130 },
  instagram: { top: 120, bottom: 250, left: 40, right: 120 },
  youtube:   { top: 90,  bottom: 230, left: 40, right: 110 },
};

// Platforms outside the three we have measured zones for render vertical
// too — fall back to the tiktok zone (the most conservative bottom inset).
function safeZoneFor(platform) {
  return SAFE_ZONES[platform] || SAFE_ZONES.tiktok;
}

// EdlCaption.position → libass numpad alignment + which inset drives the
// vertical margin. MarginV in ASS is measured from the aligned edge, so a
// bottom-aligned caption uses the bottom inset, a top-aligned one the top.
//   2 = bottom-center, 5 = middle-center, 8 = top-center
function placementFor(position, platform) {
  const z = safeZoneFor(platform);
  switch (position) {
    case 'top':
      return { alignment: 8, marginV: z.top };
    case 'mid':
      return { alignment: 5, marginV: 0 };
    case 'bottom':
    case 'lower':
    default:
      return { alignment: 2, marginV: z.bottom };
  }
}

const DEFAULT_CAPTION_POSITION = 'lower';
const TARGET_LUFS = -14;
const DEFAULT_DUCK_DB = -14;
const DEFAULT_FADE_IN_S = 0.5;
const DEFAULT_FADE_OUT_S = 1.0;

module.exports = {
  SAFE_ZONES,
  safeZoneFor,
  placementFor,
  DEFAULT_CAPTION_POSITION,
  TARGET_LUFS,
  DEFAULT_DUCK_DB,
  DEFAULT_FADE_IN_S,
  DEFAULT_FADE_OUT_S,
};

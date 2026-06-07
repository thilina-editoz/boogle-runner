// ─────────────────────────────────────────────────────────
//  Caption styles — turn AssemblyAI word timings into styled ASS.
//
//  The legacy path burns a plain SRT with one static libass force_style.
//  This builds rich ASS (Advanced SubStation Alpha) that libass renders
//  natively — enabling the modern "AI caption" looks:
//
//    word_by_word  — one word at a time, big and centered (most popular)
//    phrase        — 2-3 words per beat
//    highlighted   — a phrase stays up; the active word changes colour
//    karaoke       — the phrase fills word-by-word (\kf) as it's spoken
//    minimalist    — clean, smaller, lower-third typography
//
//  All per-style numbers (font size, alignment, margin, colours, words per
//  cue, uppercase) are overridable via opts so the dashboard can expose them
//  like a typical caption tool. Pure: returns the ASS string, writes nothing.
//
//  Requires word-level timings ({ text, start, end } in ms — what AssemblyAI
//  returns). Render with ffmpeg's `ass` filter (NOT subtitles+force_style),
//  which honours the embedded styles/animation.
// ─────────────────────────────────────────────────────────
'use strict';

const PLAY_W = 1080;
const PLAY_H = 1920;

const STYLE_IDS = ['word_by_word', 'phrase', 'highlighted', 'karaoke', 'minimalist', 'dynamic_motion', 'hook_only'];

// Motion effects for the dynamic_motion style — per-word ASS entrance
// animations (relative transforms, no absolute coords needed).
const MOTIONS = ['bounce', 'scale', 'rotate', 'blur', 'fade'];

// Per-style defaults (1080×1920 vertical). ASS Bold: -1 = bold, 0 = normal.
// alignment is numpad (2 = bottom-center, 5 = middle-center, 8 = top-center).
const DEFAULTS = {
  word_by_word: { fontSize: 96, bold: -1, alignment: 5, marginV: 0,   outline: 6, shadow: 0, uppercase: true,  wordsPerCue: 1 },
  phrase:       { fontSize: 74, bold: -1, alignment: 2, marginV: 260, outline: 5, shadow: 0, uppercase: true,  wordsPerCue: 3 },
  highlighted:  { fontSize: 70, bold: -1, alignment: 2, marginV: 260, outline: 5, shadow: 0, uppercase: true,  wordsPerCue: 5 },
  karaoke:      { fontSize: 72, bold: -1, alignment: 2, marginV: 260, outline: 5, shadow: 0, uppercase: true,  wordsPerCue: 5 },
  minimalist:   { fontSize: 52, bold: 0,  alignment: 2, marginV: 190, outline: 0, shadow: 1, uppercase: false, wordsPerCue: 4 },
  // One punchy word at a time with an entrance animation.
  dynamic_motion: { fontSize: 100, bold: -1, alignment: 5, marginV: 0, outline: 6, shadow: 0, uppercase: true, wordsPerCue: 1 },
  // Full line, only the important (non-filler) words highlighted.
  hook_only:    { fontSize: 74, bold: -1, alignment: 2, marginV: 260, outline: 5, shadow: 0, uppercase: true, wordsPerCue: 4 },
};

// Common English filler words — everything else in a line is a "hook" word for
// the hook_only style.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'to', 'of',
  'in', 'on', 'for', 'and', 'or', 'but', 'it', 'its', 'this', 'that', 'these',
  'those', 'you', 'your', 'i', 'we', 'they', 'he', 'she', 'my', 'me', 'our',
  'at', 'as', 'so', 'if', 'then', 'than', 'with', 'from', 'by', 'do', 'does',
  'did', 'not', 'no', 'yes', 'up', 'out', 'just', 'can', 'will', 'would',
  'should', 'could', 'have', 'has', 'had', 'get', 'got', 'about', 'into', 'too',
]);
function isHookWord(text) {
  const w = String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
  return w.length >= 3 && !STOPWORDS.has(w);
}

// Per-word entrance animation for dynamic_motion. Relative transforms so no
// absolute coordinates are needed (works at any alignment).
function motionTag(motion) {
  switch (motion) {
    case 'scale':  return '{\\fscx62\\fscy62\\t(0,130,\\fscx100\\fscy100)}';
    case 'rotate': return '{\\frz22\\alpha&HFF&\\t(0,150,\\frz0\\alpha&H00&)}';
    case 'blur':   return '{\\blur12\\alpha&HFF&\\t(0,170,\\blur0\\alpha&H00&)}';
    case 'fade':   return '{\\alpha&HFF&\\t(0,140,\\alpha&H00&)}';
    case 'bounce':
    default:       return '{\\fscx55\\fscy55\\t(0,90,\\fscx113\\fscy113)\\t(90,180,\\fscx100\\fscy100)}';
  }
}

// ── helpers ──────────────────────────────────────────────
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// ASS colour is &HAABBGGRR (AA=alpha, 00 = opaque). Accept that form, or a
// web hex (#RRGGBB / RRGGBB), else fall back.
function toAssColour(c, fallback) {
  if (c == null) return fallback;
  const s = String(c).trim();
  if (/^&H[0-9A-Fa-f]{6,8}$/.test(s)) return s.toUpperCase();
  const m = s.match(/^#?([0-9A-Fa-f]{6})$/);
  if (m) {
    const r = m[1].slice(0, 2), g = m[1].slice(2, 4), b = m[1].slice(4, 6);
    return `&H00${b}${g}${r}`.toUpperCase();
  }
  return fallback;
}

// ms → ASS time H:MM:SS.cc (centiseconds).
function asTime(ms) {
  let v = Number(ms);
  if (!Number.isFinite(v) || v < 0) v = 0;
  const cs = Math.round(v / 10);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

// Escape user word text for an ASS dialogue field (braces open override blocks).
function esc(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function normWords(words) {
  const out = [];
  for (const w of words || []) {
    const text = String((w && (w.text ?? w.word)) || '').trim();
    if (!text) continue;
    const start = Number(w.start);
    if (!Number.isFinite(start)) continue;
    let end = Number(w.end);
    if (!Number.isFinite(end) || end <= start) end = start + 200;
    out.push({ text, start, end });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function chunk(words, size) {
  const n = Math.max(1, Math.floor(size));
  const out = [];
  for (let i = 0; i < words.length; i += n) out.push(words.slice(i, i + n));
  return out;
}

// Map a human position (top/middle/bottom) + horizontal align (left/center/
// right) to an ASS numpad alignment (1-9). Falls back when not both given.
function computeAlignment(position, align, fallback) {
  const base = position === 'top' ? 7 : position === 'middle' ? 4 : position === 'bottom' ? 1 : null;
  const off = align === 'left' ? 0 : align === 'center' ? 1 : align === 'right' ? 2 : null;
  return base != null && off != null ? base + off : fallback;
}

function resolveOpts(opts = {}) {
  const style = STYLE_IDS.includes(opts.style) ? opts.style : 'word_by_word';
  const d = DEFAULTS[style];
  // Direct numpad alignment wins; otherwise derive from position + align.
  const alignment = opts.alignment != null
    ? num(opts.alignment, d.alignment)
    : computeAlignment(opts.position, opts.align, d.alignment);
  return {
    style,
    fontName: (opts.fontName && String(opts.fontName).trim()) || 'DejaVu Sans',
    fontSize: num(opts.fontSize, d.fontSize),
    bold: opts.bold == null ? d.bold : (opts.bold ? -1 : 0),
    alignment,
    marginV: num(opts.marginV, d.marginV),
    outline: num(opts.outline, d.outline),
    shadow: num(opts.shadow, d.shadow),
    uppercase: opts.uppercase == null ? d.uppercase : !!opts.uppercase,
    wordsPerCue: Math.max(1, num(opts.wordsPerCue, d.wordsPerCue)),
    motion: MOTIONS.includes(opts.motion) ? opts.motion : 'bounce',
    // Free vertical position (0-100% from top). null → use the style's
    // alignment/MarginV instead.
    vertical: opts.vertical == null || opts.vertical === '' ? null : num(opts.vertical, null),
    primary: toAssColour(opts.primaryColour, '&H00FFFFFF'),       // white
    highlight: toAssColour(opts.highlightColour, '&H0000FFFF'),   // yellow
    outlineColour: toAssColour(opts.outlineColour, '&H00000000'), // black
    back: toAssColour(opts.backColour, '&H80000000'),
    playResX: num(opts.playResX, PLAY_W),
    playResY: num(opts.playResY, PLAY_H),
  };
}

function disp(t, o) {
  return o.uppercase ? String(t).toUpperCase() : String(t);
}

// Free vertical positioning: when `vertical` (0-100, % of frame height from the
// top) is set, captions are absolutely placed with \pos — always horizontally
// centered, vertically wherever the user dragged. This overrides the Style's
// alignment/MarginV. \an5 anchors the text block at its centre.
function posTag(o) {
  if (o.vertical == null) return '';
  const x = Math.round(o.playResX / 2);
  const y = Math.round((Math.max(0, Math.min(100, o.vertical)) / 100) * o.playResY);
  return `{\\an5\\pos(${x},${y})}`;
}

function dialogue(o, startMs, endMs, text) {
  return `Dialogue: 0,${asTime(startMs)},${asTime(endMs)},Default,,0,0,0,,${posTag(o)}${text}`;
}

// ── event builders (one per style) ───────────────────────
const EVENT_BUILDERS = {
  word_by_word(words, o) {
    const ev = [];
    for (let i = 0; i < words.length; i++) {
      const start = words[i].start;
      const end = i + 1 < words.length ? words[i + 1].start : words[i].end;
      ev.push(dialogue(o, start, end, esc(disp(words[i].text, o))));
    }
    return ev;
  },

  phrase(words, o) {
    return chunkEvents(words, o);
  },

  minimalist(words, o) {
    return chunkEvents(words, o);
  },

  highlighted(words, o) {
    const ev = [];
    for (const ch of chunk(words, o.wordsPerCue)) {
      for (let i = 0; i < ch.length; i++) {
        const start = ch[i].start;
        const end = i + 1 < ch.length ? ch[i + 1].start : ch[i].end;
        const line = ch
          .map((wd, j) => {
            const t = esc(disp(wd.text, o));
            return j === i ? `{\\c${o.highlight}}${t}{\\c${o.primary}}` : t;
          })
          .join(' ');
        ev.push(dialogue(o, start, end, line));
      }
    }
    return ev;
  },

  karaoke(words, o) {
    const ev = [];
    for (const ch of chunk(words, o.wordsPerCue)) {
      const start = ch[0].start;
      const end = ch[ch.length - 1].end;
      let text = '';
      for (const wd of ch) {
        const durCs = Math.max(1, Math.round((wd.end - wd.start) / 10));
        text += `{\\kf${durCs}}${esc(disp(wd.text, o))} `;
      }
      ev.push(dialogue(o, start, end, text.trim()));
    }
    return ev;
  },

  dynamic_motion(words, o) {
    const tag = motionTag(o.motion);
    const ev = [];
    for (let i = 0; i < words.length; i++) {
      const start = words[i].start;
      const end = i + 1 < words.length ? words[i + 1].start : words[i].end;
      ev.push(dialogue(o, start, end, `${tag}${esc(disp(words[i].text, o))}`));
    }
    return ev;
  },

  hook_only(words, o) {
    const ev = [];
    for (const ch of chunk(words, o.wordsPerCue)) {
      for (let i = 0; i < ch.length; i++) {
        const start = ch[i].start;
        const end = i + 1 < ch.length ? ch[i + 1].start : ch[i].end;
        // Whole line visible; key words in the highlight colour, filler dimmed.
        const line = ch
          .map((wd) => {
            const t = esc(disp(wd.text, o));
            return isHookWord(wd.text)
              ? `{\\c${o.highlight}}${t}{\\c${o.primary}}`
              : t;
          })
          .join(' ');
        ev.push(dialogue(o, start, end, line));
      }
    }
    return ev;
  },
};

// phrase + minimalist share contiguous chunk rendering.
function chunkEvents(words, o) {
  const ev = [];
  const chunks = chunk(words, o.wordsPerCue);
  for (let c = 0; c < chunks.length; c++) {
    const ch = chunks[c];
    const start = ch[0].start;
    const end = c + 1 < chunks.length ? chunks[c + 1][0].start : ch[ch.length - 1].end;
    ev.push(dialogue(o, start, end, ch.map((wd) => esc(disp(wd.text, o))).join(' ')));
  }
  return ev;
}

function buildStyleLine(o) {
  // For karaoke, PrimaryColour is the "filled" colour and SecondaryColour the
  // "unfilled" base — \kf sweeps primary over secondary. Other styles use
  // primary as the text colour and apply highlight inline.
  const isKar = o.style === 'karaoke';
  const primary = isKar ? o.highlight : o.primary;
  const secondary = o.primary;
  return [
    'Style: Default',
    o.fontName,
    o.fontSize,
    primary,
    secondary,
    o.outlineColour,
    o.back,
    o.bold,
    0, 0, 0,        // Italic, Underline, StrikeOut
    100, 100,       // ScaleX, ScaleY
    0, 0,           // Spacing, Angle
    1,              // BorderStyle 1 = outline + drop shadow
    o.outline,
    o.shadow,
    o.alignment,
    60, 60,         // MarginL, MarginR
    o.marginV,
    1,              // Encoding
  ].join(',');
}

/**
 * Build an ASS file (string) from word timings + style opts.
 * Returns null if there are no usable words (caller falls back to SRT).
 */
function buildAss(words, opts) {
  const o = resolveOpts(opts);
  const w = normWords(words);
  if (w.length === 0) return null;

  const events = EVENT_BUILDERS[o.style](w, o);

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${o.playResX}`,
    `PlayResY: ${o.playResY}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    buildStyleLine(o),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

module.exports = { buildAss, STYLE_IDS, DEFAULTS };

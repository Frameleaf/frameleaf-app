// Titles and text: the engine-free half of the text goldens (studio/spec/text.md).
//  - the synthetic measurer, a test INPUT standing where a platform's text engine stands;
//  - the case lists;
//  - an independent reference written from the prose of text.md (tags X1 to X19). No engine code,
//    engine output or browser API enters it; text-goldens.test.mjs requires it to reproduce every
//    numeric golden, and text-goldens.browser.mjs compares it with the engine on every run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const TEXT_GOLDENS_FORMAT = 'frameleaf-studio-text-goldens';
export const TEXT_GOLDENS_VERSION = 1;
export const SINE_TOLERANCE = 1e-12;
export const SINE_PRESETS = ['wave-in', 'pulse', 'wave', 'shimmer', 'swing'];
export const STYLE_FIELDS = [
  'text', 'color', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'underline', 'lineHeight', 'letterSpacing',
  'textAlign', 'verticalAlign', 'textPadding', 'backgroundColor', 'backgroundRadius', 'textShadow', 'stroke',
  'textSpans', 'spanLayout', 'textStylePresetId', 'textStyleScale', 'textMotion',
];

// ---------------------------------------------------------------------------------------------
// Synthetic measurer. Self-contained on purpose: the browser driver sends its source text to the
// page, so the engine and the reference measure with the very same function.
// Advance of a code point = size x a dyadic factor (exact in binary64 for the sizes used):
//   U+0020, U+00A0 and i j l . , : ; ! | '  0.25      m w M W  0.875      other A-Z  0.625
//   U+2E80 and above (CJK)  1                          anything else  0.5
// Weights 600 and above multiply the advance by 1.125. No kerning. The width of a string is the sum
// of its advances plus the letter spacing once per code point. ascent = 0.9375 x size,
// descent = 0.25 x size.
// ---------------------------------------------------------------------------------------------
export function syntheticMeasurer() {
  const size = (font) => {
    const match = /(\d+(?:\.\d+)?)px/.exec(font);
    return match ? parseFloat(match[1]) : 16;
  };
  const heavy = (font) => {
    const match = /^\S+\s+(\d+)\s/.exec(font);
    return match ? Number(match[1]) >= 600 : false;
  };
  const factor = (char) => {
    const code = char.codePointAt(0);
    if (code === 0x20 || code === 0xa0 || "ijl.,:;!|'".includes(char)) return 0.25;
    if ('mwMW'.includes(char)) return 0.875;
    if (code >= 0x41 && code <= 0x5a) return 0.625;
    if (code >= 0x2e80) return 1;
    return 0.5;
  };
  return {
    measure(text, font, letterSpacing) {
      const z = size(font);
      const k = heavy(font) ? 1.125 : 1;
      let width = 0;
      let count = 0;
      for (const char of text) {
        width += z * factor(char) * k;
        count++;
      }
      return width + count * letterSpacing;
    },
    fontMetrics(font) {
      const z = size(font);
      return { ascent: z * 0.9375, descent: z * 0.25 };
    },
  };
}

/** The bundled title fonts: the list server/src/utils/studio-fonts.generated.ts records (families, packages, files, hashes). */
export async function bundledTitleFonts(repository) {
  const source = await readFile(path.join(repository, 'server/src/utils/studio-fonts.generated.ts'), 'utf8');
  const start = source.indexOf('[', source.indexOf('studioBundledFonts'));
  const end = source.lastIndexOf('] as const');
  assert(start > 0 && end > start, 'studio-fonts.generated.ts has an unexpected shape');
  // The list is a plain data literal of this repository (formatted as TypeScript, not JSON).
  const families = new Function(`return ${source.slice(start, end + 1)};`)();
  assert(Array.isArray(families) && families.every((family) => typeof family.family === 'string' && Array.isArray(family.files)));
  return families;
}

/**
 * One record per bundled WOFF2 file, as the goldens store it: the file the goldens were made with,
 * and its lossless TrueType decode (server/resources/studio-fonts) with that file's own hash.
 */
export function bundledFontRecords(families) {
  return families.flatMap((family) => family.files.filter((entry) => entry.format === 'woff2').map((entry) => {
    const decoded = family.files.find((other) => other.decodedFrom === entry.sha256);
    assert(decoded, `${entry.file} has no decoded twin`);
    return {
      file: `${family.package}/files/${entry.file}`, package: family.package, version: family.version, family: family.family,
      subset: entry.subset, weight: entry.weight, style: entry.style, format: entry.format, sha256: entry.sha256,
      decoded: { file: `server/resources/studio-fonts/${decoded.file}`, format: decoded.format, sha256: decoded.sha256 },
    };
  }));
}

/** A measurer over recorded platform measurements (the `platform` cases). */
export function recordedMeasurer(measurements) {
  const widths = new Map(measurements.widths.map(([font, spacing, text, width]) => [`${font}\n${spacing}\n${text}`, width]));
  const metrics = new Map(measurements.metrics.map(([font, ascent, descent]) => [font, { ascent, descent }]));
  return {
    measure(text, font, letterSpacing) {
      const width = widths.get(`${font}\n${letterSpacing}\n${text}`);
      assert(width !== undefined, `no recorded platform width for ${JSON.stringify(text)} in ${font} at spacing ${letterSpacing}`);
      return width;
    },
    fontMetrics(font) {
      const found = metrics.get(font);
      assert(found, `no recorded platform metrics for ${font}`);
      return found;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reference: style resolution and layout (X4 to X11)
// ---------------------------------------------------------------------------------------------
const WEIGHTS = { normal: 400, medium: 500, semibold: 600, bold: 700 };
const pick = (...values) => values.find((value) => value !== undefined && value !== null);

export function referenceSpans(item) {
  const listed = Array.isArray(item.textSpans) ? item.textSpans.filter((span) => typeof span.text === 'string') : [];
  const spans = listed.length > 0 ? listed : [{ text: pick(item.text, '') }];
  return spans.map((span) => {
    const fontSize = pick(span.fontSize, item.fontSize, 60);
    const family = pick(span.fontFamily, item.fontFamily, 'Inter');
    const style = pick(span.fontStyle, item.fontStyle, 'normal');
    const weight = WEIGHTS[pick(span.fontWeight, item.fontWeight, 'normal')] ?? 400;
    return {
      text: span.text,
      fontSize,
      letterSpacing: pick(span.letterSpacing, item.letterSpacing, 0),
      color: pick(span.color, item.color, '#ffffff'),
      underline: pick(span.underline, item.underline, false),
      font: `${style} ${weight} ${fontSize}px "${family}", sans-serif`,
    };
  });
}

function wrapStack(text, font, spacing, available, measurer) {
  const wide = (candidate) => measurer.measure(candidate, font, spacing) > available;
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (wide(candidate) && current !== '') {
        lines.push(current);
        current = word;
        if (wide(word)) {
          const pieces = [];
          let piece = '';
          for (const char of word) {
            if (wide(piece + char) && piece !== '') {
              pieces.push(piece);
              piece = char;
            } else piece += char;
          }
          if (piece !== '') pieces.push(piece);
          lines.push(...pieces.slice(0, -1));
          current = pieces.at(-1) ?? '';
        }
      } else current = candidate;
    }
    if (current !== '') lines.push(current);
  }
  return lines.length > 0 ? lines : [''];
}

function inlineLines(spans, available, measurer) {
  const base = spans[0];
  const width = (text) => measurer.measure(text, base.font, base.letterSpacing);
  // Tokens: paragraphs of words; each word has its text, the spaces before it, and a span index per character.
  const paragraphs = [[]];
  let word = null;
  let pending = { text: '', owners: [] };
  const open = () => {
    const made = { text: '', owners: [], leading: pending.text, leadingOwners: pending.owners };
    pending = { text: '', owners: [] };
    return made;
  };
  const closeWord = () => {
    if (word) paragraphs.at(-1).push(word);
    word = null;
  };
  const closeSpaces = () => {
    if (pending.text !== '') paragraphs.at(-1).push(open());
  };
  spans.forEach((span, index) => {
    for (const char of span.text) {
      if (char === '\n') {
        closeWord();
        closeSpaces();
        paragraphs.push([]);
      } else if (char === ' ') {
        closeWord();
        pending.text += char;
        pending.owners.push(index);
      } else {
        word ??= open();
        word.text += char;
        word.owners.push(index);
      }
    }
  });
  closeWord();
  closeSpaces();

  const lines = [];
  const emit = (words, continued) => {
    let text = '';
    const owners = [];
    words.forEach((entry, position) => {
      if (position > 0 || !continued) {
        text += entry.leading;
        owners.push(...entry.leadingOwners);
      }
      text += entry.text;
      owners.push(...entry.owners);
    });
    const runs = [];
    let start = 0;
    for (let end = 1; end <= text.length; end++) {
      if (end !== text.length && owners[end] === owners[start]) continue;
      const span = spans[owners[start] ?? 0] ?? base;
      const offset = start === 0 ? 0 : width(text.slice(0, start));
      runs.push({ text: text.slice(start, end), color: span.color, underline: span.underline, offset, width: width(text.slice(0, end)) - offset });
      start = end;
    }
    lines.push({ text, runs });
  };
  for (const words of paragraphs) {
    if (words.length === 0) {
      emit([], false);
      continue;
    }
    let onLine = [];
    let lineText = '';
    let continued = false;
    for (const entry of words) {
      const leading = onLine.length > 0 || !continued ? entry.leading : '';
      const candidate = lineText + leading + entry.text;
      if (width(candidate) > available && onLine.length > 0) {
        emit(onLine, continued);
        continued = true;
        onLine = [entry];
        lineText = entry.text;
      } else {
        onLine.push(entry);
        lineText = candidate;
      }
    }
    if (onLine.length > 0) emit(onLine, continued);
  }
  return lines;
}

/** X6 to X10: the laid-out block of an item in a box, in box-local coordinates. */
export function referenceLayout(item, boxWidth, boxHeight, measurer) {
  const spans = referenceSpans(item);
  const lineHeight = pick(item.lineHeight, 1.2);
  const align = ['left', 'right'].includes(item.textAlign) ? item.textAlign : 'center';
  const vertical = ['top', 'bottom'].includes(item.verticalAlign) ? item.verticalAlign : 'middle';
  const padding = Math.max(0, pick(item.textPadding, 16));
  const available = Math.max(1, boxWidth - padding * 2);
  const availableHeight = boxHeight - padding * 2;

  const lines = [];
  const place = (span, text, extra) => {
    const { ascent, descent } = measurer.fontMetrics(span.font);
    const height = span.fontSize * lineHeight;
    lines.push({
      text, font: span.font, fontSize: span.fontSize, color: span.color, letterSpacing: span.letterSpacing,
      underline: span.underline, width: measurer.measure(text, span.font, span.letterSpacing),
      lineHeight: height, baselineOffset: (height - (ascent + descent)) / 2 + ascent, ...extra,
    });
  };
  if (item.spanLayout === 'inline') {
    for (const line of inlineLines(spans, available, measurer)) place({ ...spans[0], underline: false }, line.text, { runs: line.runs });
  } else {
    for (const span of spans) for (const text of wrapStack(span.text, span.font, span.letterSpacing, available, measurer)) place(span, text, {});
  }

  let totalHeight = 0;
  for (const line of lines) totalHeight += line.lineHeight;
  const blockTop = vertical === 'top' ? padding : vertical === 'bottom' ? boxHeight - padding - totalHeight : padding + (availableHeight - totalHeight) / 2;
  let top = blockTop;
  for (const line of lines) {
    line.top = top;
    line.baseline = top + line.baselineOffset;
    line.start = align === 'left' ? padding : align === 'right' ? boxWidth - padding - line.width : (boxWidth - line.width) / 2;
    delete line.baselineOffset;
    top += line.lineHeight;
  }
  const layout = { lines, totalHeight };
  if (item.backgroundColor) {
    const widest = Math.max(...lines.map((line) => line.width));
    const centre = align === 'left' ? padding + widest / 2 : align === 'right' ? boxWidth - padding - widest / 2 : boxWidth / 2;
    const width = Math.min(boxWidth, widest + padding * 2);
    const height = totalHeight + padding * 2;
    layout.background = {
      x: centre - width / 2, y: blockTop - padding, width, height,
      radius: Math.max(0, Math.min(Math.max(0, pick(item.backgroundRadius, 0)), width / 2, height / 2)),
    };
  }
  return layout;
}

/** X6: the box height after auto height. */
export function referenceAutoHeight(item, boxWidth, boxHeight, measurer) {
  const padding = Math.max(0, pick(item.textPadding, 16));
  const stroke = item.stroke ? item.stroke.width : 0;
  const shadow = item.textShadow ? Math.abs(item.textShadow.offsetY) + item.textShadow.blur : 0;
  const required = referenceLayout(item, boxWidth, 0, measurer).totalHeight + padding * 2 + stroke * 2 + shadow * 2;
  return required > boxHeight + 0.5 ? required : boxHeight;
}

/** X11: the underline of a line or run that starts at x with the given advance width. */
function underline(x, baseline, width, line) {
  const length = Math.max(0, width - line.letterSpacing);
  return length <= 0 ? null : { x1: x, x2: x + length, y: baseline + Math.max(1, line.fontSize * 0.08), thickness: Math.max(1, line.fontSize * 0.05) };
}

// ---------------------------------------------------------------------------------------------
// Reference: text motion (X14 to X18)
// ---------------------------------------------------------------------------------------------
export const TEXT_MOTION_PRESETS = {
  typewriter: { slot: 'in', unit: 'character' }, 'fade-up': { slot: 'in', unit: 'word' }, rise: { slot: 'in', unit: 'word' },
  cascade: { slot: 'in', unit: 'character' }, pop: { slot: 'in', unit: 'word' }, 'blur-in': { slot: 'in', unit: 'word' },
  'slide-mask': { slot: 'in', unit: 'line' }, 'wave-in': { slot: 'in', unit: 'character' },
  'fade-down': { slot: 'out', unit: 'word' }, sink: { slot: 'out', unit: 'word' }, 'pop-out': { slot: 'out', unit: 'word' },
  'blur-out': { slot: 'out', unit: 'word' }, 'typewriter-erase': { slot: 'out', unit: 'character' },
  pulse: { slot: 'loop', unit: 'word' }, wave: { slot: 'loop', unit: 'character' }, shimmer: { slot: 'loop', unit: 'word' },
  swing: { slot: 'loop', unit: 'character' },
};
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const TAU = Math.PI * 2;

function hash1(value) {
  const wrapped = ((value % 4096) + 4096) % 4096;
  const x = Math.sin(wrapped * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** X18. Returns [dx, dy, scale, rotation, alpha, soften]. */
function channels(presetId, p, z, boxWidth, intensity, index, seed) {
  const state = { dx: 0, dy: 0, scale: 1, rotation: 0, alpha: 1, soften: 0 };
  switch (presetId) {
    case 'typewriter': state.alpha = p >= 1 ? 1 : 0; break;
    case 'fade-up': state.alpha = clamp01(p); state.dy = (1 - p) * 0.25 * z * intensity; break;
    case 'rise': state.alpha = clamp01(p * 1.5); state.dy = (1 - p) * 0.6 * z * intensity; break;
    case 'cascade': state.alpha = clamp01(p); state.dy = -(1 - p) * 0.8 * z * intensity; break;
    case 'pop': state.alpha = clamp01(p * 2); state.scale = Math.max(0, 1 + (p - 1) * intensity); break;
    case 'blur-in': state.alpha = clamp01(p); state.soften = Math.max(0, (1 - p) * 0.4 * z * intensity); break;
    case 'slide-mask': state.dx = -(1 - p) * boxWidth * intensity; break;
    case 'wave-in': state.alpha = clamp01(p); state.dy = (1 - p) * Math.sin(index * 0.9) * 0.5 * z * intensity; break;
    case 'fade-down': state.alpha = clamp01(1 - p); state.dy = p * 0.25 * z * intensity; break;
    case 'sink': state.alpha = clamp01(1 - p); state.dy = p * 0.6 * z * intensity; break;
    case 'pop-out': state.alpha = clamp01(1 - p); state.scale = Math.max(0, 1 - p * intensity); break;
    case 'blur-out': state.alpha = clamp01(1 - p); state.soften = Math.max(0, p * 0.4 * z * intensity); break;
    case 'typewriter-erase': state.alpha = p >= 1 ? 0 : 1; break;
    case 'pulse': state.scale = 1 + 0.06 * intensity * Math.sin(TAU * p); break;
    case 'wave': state.dy = 0.18 * z * intensity * Math.sin(TAU * p); break;
    case 'shimmer': state.alpha = clamp01(1 - 0.35 * intensity * (0.5 + 0.5 * Math.sin(TAU * (p + hash1(seed * 31 + index))))); break;
    case 'swing': state.rotation = 0.09 * intensity * Math.sin(TAU * p); break;
    default: throw new Error(`unknown text motion preset ${presetId}`);
  }
  return state;
}

function ease(t, easing) {
  switch (easing) {
    case 'linear': return t;
    case 'ease-in': return t * t;
    case 'ease-out': return t * (2 - t);
    case 'ease-in-out': return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 'overshoot': { const u = t - 1; return 1 + (1.70158 + 1) * u * u * u + 1.70158 * u * u; }
    default: throw new Error(`unknown easing ${easing}`);
  }
}

/** X16: the shuffle of order "random". */
export function randomRanks(count, seed) {
  let a = (seed | 0) + 2654435769;
  const next = () => {
    a = (a + 1831565813) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const list = Array.from({ length: count }, (_, i) => i);
  for (let j = count - 1; j > 0; j--) {
    const q = Math.floor(next() * (j + 1));
    [list[j], list[q]] = [list[q], list[j]];
  }
  const ranks = new Array(count).fill(0);
  list.forEach((unit, position) => { ranks[unit] = position; });
  return ranks;
}

function rank(order, index, count, seed) {
  if (order === 'forward') return index;
  if (order === 'backward') return count - 1 - index;
  if (order === 'center') return Math.floor(Math.abs(index - (count - 1) / 2));
  if (order === 'random') return randomRanks(count, seed)[index] ?? index;
  throw new Error(`unknown order ${order}`);
}

function slotWindow(slot, count, length) {
  let duration = Math.max(0, slot.durationFrames);
  let stagger = Math.max(0, slot.staggerFrames);
  const maxRank = slot.order === 'center' ? Math.floor((count - 1) / 2) : Math.max(0, count - 1);
  let total = duration + stagger * maxRank;
  if (total > length / 2 && total > 0) {
    const k = length / 2 / total;
    duration *= k;
    stagger *= k;
    total = length / 2;
  }
  return { duration, stagger, total };
}

/** X14: which slot draws at frame f for a unit count; `count` Infinity gives the coarse decision of X15. */
function dispatch(spec, frame, length, count) {
  if (length <= 0) return null;
  const coarse = (slot) => ({ total: slot.staggerFrames > 0 ? length / 2 : Math.min(Math.max(0, slot.durationFrames), length / 2) });
  const windowOf = (slot) => (count === Infinity ? coarse(slot) : slotWindow(slot, count, length));
  const offsetOf = (slot, window) => Math.min(Math.max(0, slot.offsetFrames ?? 0), Math.max(0, length - window.total));
  if (spec.out) {
    const window = windowOf(spec.out);
    const start = length - offsetOf(spec.out, window) - window.total;
    if (frame >= start) return { slot: 'out', window, start };
  }
  let loopStart = 0;
  if (spec.in) {
    const window = windowOf(spec.in);
    const offset = offsetOf(spec.in, window);
    if (frame < offset + window.total) return { slot: 'in', window, start: offset };
    loopStart = offset + window.total;
  }
  return spec.loop ? { slot: 'loop', window: null, start: loopStart } : null;
}

export const referenceCoarseSlot = (spec, frame, length) => dispatch(spec, frame, length, Infinity)?.slot ?? null;

/** X14: the state of unit `index` at frame f, as [dx, dy, scale, rotation, alpha, soften], or null for the identity. */
export function referenceMotionState(spec, { frame, length, unitIndex, unitCount, fontSize, boxWidth }) {
  const count = Math.max(1, unitCount);
  const active = dispatch(spec, frame, length, count);
  if (!active) return null;
  const slot = spec[active.slot];
  const intensity = clamp(slot.intensity, 0, 2);
  const r = rank(slot.order, unitIndex, count, slot.seed);
  let p;
  if (active.window) {
    const local = frame - active.start;
    const delay = r * active.window.stagger;
    const progress = active.window.duration <= 0 ? (local >= delay ? 1 : 0) : clamp((local - delay) / active.window.duration, 0, 1);
    p = ease(progress, slot.easing);
  } else {
    const local = frame - active.start - r * Math.max(0, slot.staggerFrames);
    if (local <= 0) return null;
    p = (local / Math.max(1e-6, slot.durationFrames)) % 1;
  }
  const s = channels(slot.presetId, p, fontSize, boxWidth, intensity, unitIndex, slot.seed);
  const identity = s.dx === 0 && s.dy === 0 && s.scale === 1 && s.rotation === 0 && s.alpha === 1 && s.soften === 0;
  return identity ? null : s;
}

const WHITE_RANGES = [[0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff]];
const WHITE_SPACE = { test: (char) => WHITE_RANGES.some(([low, high]) => char.codePointAt(0) >= low && char.codePointAt(0) <= high) };

/** X15: the unit index of every code point of the laid-out lines (null: in no unit). */
export function referenceUnits(lines, unit) {
  const blank = (char) => WHITE_SPACE.test(char);
  if (unit === 'whole-clip') return { indices: lines.map((line) => Array.from(line, (char) => (blank(char) ? null : 0))), unitCount: 1 };
  if (unit === 'line') return { indices: lines.map((line, n) => Array.from(line, () => n)), unitCount: lines.length };
  let next = 0;
  if (unit === 'character') return { indices: lines.map((line) => Array.from(line, (char) => (blank(char) ? null : next++))), unitCount: next };
  assert.equal(unit, 'word');
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const indices = lines.map((line) => {
    const out = [];
    let last = null;
    let waiting = [];
    for (const piece of segmenter.segment(line)) {
      if (piece.isWordLike) {
        const mine = next++;
        for (const position of waiting) out[position] = mine;
        waiting = [];
        last = mine;
        for (const _ of piece.segment) out.push(mine);
        continue;
      }
      for (const char of piece.segment) {
        if (blank(char)) out.push(null);
        else if (last !== null) out.push(last);
        else {
          waiting.push(out.length);
          out.push(null);
        }
      }
    }
    if (waiting.length > 0) {
      const mine = next++;
      for (const position of waiting) out[position] = mine;
    }
    return out;
  });
  return { indices, unitCount: next };
}

/** X19: is frame f drawn glyph by glyph? */
function glyphByGlyph(spec, frame, length) {
  if (!spec || length <= 0 || frame < 0) return false;
  if (spec.loop) return true;
  const upper = (slot) => (slot.staggerFrames > 0 ? length / 2 : Math.min(Math.max(0, slot.durationFrames), length / 2));
  if (spec.in && frame < Math.min(length, Math.max(0, spec.in.offsetFrames ?? 0) + upper(spec.in))) return true;
  if (spec.out && frame >= Math.max(0, length - Math.max(0, spec.out.offsetFrames ?? 0) - upper(spec.out))) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Reference: the ordered draws of the 2-D route (X12, X19)
// ---------------------------------------------------------------------------------------------
/**
 * `canvas` is the frame size, `transform` the box (x and y from the canvas centre, as stored).
 * `frame` is relative to the item's start. Coordinates of the result are frame pixels.
 */
export function referencePaint(item, canvas, transform, measurer, frame = 0) {
  const left = canvas.width / 2 + transform.x - transform.width / 2;
  const top = canvas.height / 2 + transform.y - transform.height / 2;
  const layout = referenceLayout(item, transform.width, transform.height, measurer);
  const ops = [{ op: 'clip', x: left, y: top, width: transform.width, height: transform.height }];
  if (item.backgroundColor) {
    const b = layout.background;
    ops.push({ op: 'background', x: left + b.x, y: top + b.y, width: b.width, height: b.height, radius: b.radius, color: item.backgroundColor, shadow: null });
  }
  const shadow = item.textShadow ? { color: item.textShadow.color, blur: item.textShadow.blur, offsetX: item.textShadow.offsetX, offsetY: item.textShadow.offsetY } : null;
  const strokeWidth = item.stroke ? item.stroke.width : 0;
  const stroked = strokeWidth > 0;
  const still = { shadow, alpha: 1, blur: 0, motion: null };

  const spec = item.textMotion;
  const length = item.durationInFrames;
  const slotName = glyphByGlyph(spec, frame, length) ? referenceCoarseSlot(spec, frame, length) : null;

  if (!slotName) {
    for (const line of layout.lines) {
      if (line.text.length === 0) continue;
      const x = left + line.start;
      const y = top + line.baseline;
      const text = { x, y, font: line.font, letterSpacing: line.letterSpacing };
      if (stroked) ops.push({ op: 'stroke', text: line.text, ...text, color: item.stroke.color, lineWidth: strokeWidth * 2, join: 'round', ...still });
      const runs = line.runs?.length ? line.runs : null;
      for (const run of runs ?? [{ text: line.text, color: line.color, underline: line.underline, offset: 0, width: line.width }]) {
        ops.push({ op: 'fill', text: run.text, ...text, x: runs ? x + run.offset : x, color: run.color, ...still });
        const rule = run.underline ? underline(runs ? x + run.offset : x, y, run.width, line) : null;
        if (rule) ops.push({ op: 'underline', ...rule, color: run.color, ...still });
      }
    }
    return ops;
  }

  const slot = spec[slotName];
  const units = referenceUnits(layout.lines.map((line) => line.text), slot.unit ?? TEXT_MOTION_PRESETS[slot.presetId].unit);
  const stateOf = (unitIndex, fontSize) => (unitIndex === null || unitIndex === undefined ? null
    : referenceMotionState(spec, { frame, length, unitIndex, unitCount: units.unitCount, fontSize, boxWidth: transform.width }));
  layout.lines.forEach((line, lineIndex) => {
    if (line.text.length === 0) return;
    const y = top + line.baseline;
    const colours = line.runs?.flatMap((run) => Array.from(run.text, () => run.color));
    let pen = left + line.start;
    Array.from(line.text).forEach((char, position) => {
      const advance = measurer.measure(char, line.font, 0);
      if (char !== ' ') {
        const state = stateOf(units.indices[lineIndex][position], line.fontSize);
        if (!state || state.alpha > 0) {
          const drawn = {
            shadow, alpha: state ? state.alpha : 1, blur: state ? state.soften : 0,
            motion: state ? { dx: state.dx, dy: state.dy, pivotX: pen + advance / 2, pivotY: y - line.fontSize * 0.3, rotation: state.rotation, scale: state.scale } : null,
          };
          const text = { text: char, x: pen, y, font: line.font, letterSpacing: 0 };
          if (stroked) ops.push({ op: 'stroke', ...text, color: item.stroke.color, lineWidth: strokeWidth * 2, join: 'round', ...drawn });
          ops.push({ op: 'fill', ...text, color: colours?.[position] ?? line.color, ...drawn });
        }
      }
      pen += advance + line.letterSpacing;
    });
    if (line.underline) {
      const first = units.indices[lineIndex].find((unit) => unit !== null);
      const state = stateOf(first, line.fontSize);
      const rule = underline(left + line.start, y, line.width, line);
      if (rule && (!state || state.alpha > 0)) {
        ops.push({
          op: 'underline', ...rule, color: line.color, shadow, alpha: state ? state.alpha : 1, blur: 0,
          motion: state ? { dx: state.dx, dy: state.dy, pivotX: left + line.start + Math.max(0, line.width - line.letterSpacing) / 2, pivotY: y, rotation: 0, scale: state.scale } : null,
        });
      }
    }
  });
  return ops;
}

// ---------------------------------------------------------------------------------------------
// Reference: animated style and textStyleScale (X13)
// ---------------------------------------------------------------------------------------------
const round = (value) => Math.floor(value + 0.5);
const TEMPLATE_SPANS = {
  'speaker-card': (z) => [{ fontWeight: 'bold' }, { fontSize: Math.max(20, round(z * 0.44)), fontWeight: 'medium', color: '#cbd5e1' }],
  'lower-third': (z) => [{ fontWeight: 'bold' }, { fontSize: Math.max(22, round(z * 0.54)), fontWeight: 'medium', color: '#cbd5e1' }],
  quote: (z) => [{ fontStyle: 'italic' }, { fontSize: Math.max(18, round(z * 0.4)), fontStyle: 'normal', fontWeight: 'medium', color: '#cbd5e1', letterSpacing: 1 }],
  'breaking-update': (z) => [{ fontSize: Math.max(16, round(z * 0.28)), fontWeight: 'bold', color: '#fca5a5', letterSpacing: 2 }, {},
    { fontSize: Math.max(20, round(z * 0.38)), fontWeight: 'semibold', color: '#fde68a' }],
  'headline-stack': (z) => [{ fontSize: Math.max(16, round(z * 0.3)), fontWeight: 'semibold', color: '#fbbf24', letterSpacing: 2 }, {},
    { fontSize: Math.max(20, round(z * 0.42)), fontWeight: 'medium', color: '#cbd5e1' }],
  'launch-stack': (z) => [{ fontSize: Math.max(16, round(z * 0.26)), fontWeight: 'bold', color: '#67e8f9', letterSpacing: 2 }, {},
    { fontSize: Math.max(20, round(z * 0.4)), fontWeight: 'medium', color: '#bfdbfe' }],
  'event-card': (z) => [{ fontSize: Math.max(18, round(z * 0.28)), fontWeight: 'bold', color: '#fca5a5', letterSpacing: 2 }, {},
    { fontSize: Math.max(22, round(z * 0.38)), fontWeight: 'semibold', color: '#bfdbfe', letterSpacing: 1 }],
  badge: () => [{ letterSpacing: 2 }],
};
export const ANIMATED_STYLE_FIELDS = ['fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'underline', 'color', 'backgroundColor', 'backgroundRadius',
  'textAlign', 'verticalAlign', 'lineHeight', 'letterSpacing', 'textPadding', 'textShadow', 'stroke', 'textSpans', 'textStyleScale'];

/** `animated` maps an animatable property to its interpolated value at the frame; `titleStyles` is the catalogue's. */
export function referenceAnimatedStyle(item, animated, canvas, titleStyles) {
  let style = { ...item };
  const has = (property) => Object.hasOwn(animated, property);
  if (item.textStylePresetId && has('textStyleScale')) {
    const sigma = animated.textStyleScale;
    const preset = titleStyles.presets.find((entry) => entry.id === item.textStylePresetId);
    const size = titleStyles.sizes[preset.fontSize.size];
    const step = clamp(round(canvas.height * size.heightFactor), size.min, size.max);
    const fields = preset.fields;
    const fontSize = round(round(step * preset.fontSize.multiplier) * sigma);
    style = {
      ...style, ...fields, fontSize,
      letterSpacing: fields.letterSpacing * sigma,
      textPadding: round(fields.textPadding * sigma),
      backgroundRadius: fields.backgroundRadius === 999 ? 999 : round(fields.backgroundRadius * sigma),
      backgroundColor: fields.backgroundColor,
      textShadow: fields.textShadow ? { offsetX: fields.textShadow.offsetX * sigma, offsetY: fields.textShadow.offsetY * sigma, blur: fields.textShadow.blur * sigma, color: fields.textShadow.color } : undefined,
      stroke: fields.stroke ? { ...fields.stroke, width: fields.stroke.width * sigma } : undefined,
      textStyleScale: sigma,
    };
    const spans = Array.isArray(item.textSpans) && item.textSpans.length > 0 ? item.textSpans : null;
    const template = TEMPLATE_SPANS[preset.id]?.(fontSize);
    style.textSpans = spans ? spans.map((span, k) => ({ ...span, ...(template ? template[Math.min(k, template.length - 1)] : {}), text: span.text })) : undefined;
  }
  const value = (property, stored, minimum) => (has(property) ? (minimum === undefined ? animated[property] : Math.max(minimum, animated[property])) : stored);
  const out = { ...style };
  out.fontSize = value('fontSize', style.fontSize, 1);
  out.lineHeight = value('lineHeight', style.lineHeight, 0.1);
  out.textPadding = value('textPadding', style.textPadding, 0);
  out.backgroundRadius = value('backgroundRadius', style.backgroundRadius, 0);
  if (has('textShadowOffsetX') || has('textShadowOffsetY') || has('textShadowBlur') || style.textShadow) {
    const shadow = {
      offsetX: value('textShadowOffsetX', style.textShadow?.offsetX) ?? 0,
      offsetY: value('textShadowOffsetY', style.textShadow?.offsetY) ?? 0,
      blur: value('textShadowBlur', style.textShadow?.blur, 0) ?? 0,
      color: style.textShadow?.color || item.textShadow?.color || '#000000',
    };
    out.textShadow = shadow.offsetX === 0 && shadow.offsetY === 0 && shadow.blur === 0 ? undefined : shadow;
  }
  if (has('strokeWidth') || style.stroke) {
    const width = value('strokeWidth', style.stroke?.width, 0) ?? 0;
    out.stroke = width <= 0 ? undefined : { width, color: style.stroke?.color ?? item.stroke?.color ?? '#111827' };
  }
  return Object.fromEntries(ANIMATED_STYLE_FIELDS.map((key) => [key, out[key]]));
}

/** JSON view of a value (drops undefined, folds -0 into 0), the form the goldens store. */
export const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------
const SHADOW = { offsetX: 3, offsetY: 5, blur: 8, color: '#102030' };
const STROKE = { width: 3, color: '#ff8800' };

export function layoutCases() {
  const cases = [];
  const add = (name, item, box = { width: 400, height: 200 }, measurer = 'synthetic') => cases.push({ name, measurer, item, box });
  add('defaults', { text: 'Hello world' });
  add('empty-text', { text: '' });
  add('absent-text', {});
  add('color', { text: 'Hello', color: '#ff3366' });
  for (const textAlign of ['left', 'center', 'right']) {
    for (const verticalAlign of ['top', 'middle', 'bottom']) {
      add(`align/${textAlign}-${verticalAlign}`, { text: 'Hello wide world\nmm', fontSize: 32, textAlign, verticalAlign }, { width: 300, height: 240 });
    }
  }
  add('align/unknown-values', { text: 'Hello', textAlign: 'justify', verticalAlign: 'baseline' });
  add('wrap/sentence', { text: 'The quick brown fox jumps over the lazy dog', fontSize: 32 }, { width: 320, height: 300 });
  add('wrap/exact-fit-is-kept', { text: 'aaaa aaaa', fontSize: 32 }, { width: 96, height: 200 });
  add('wrap/one-under-breaks', { text: 'aaaa aaaa', fontSize: 32 }, { width: 95, height: 200 });
  add('wrap/long-word-after-a-break-is-split', { text: 'a mmmmmmmmmmmmmmmm b', fontSize: 32 }, { width: 200, height: 300 });
  add('wrap/first-word-is-never-split', { text: 'mmmmmmmmmmmmmmmm b', fontSize: 32 }, { width: 200, height: 300 });
  add('wrap/cjk-has-no-break-rule', { text: 'a 日本語のテキストです', fontSize: 32 }, { width: 200, height: 300 });
  add('wrap/hyphen-tab-nbsp-do-not-break', { text: 'well-known a\u00a0b a\tb end', fontSize: 32 }, { width: 150, height: 300 });
  add('spaces/leading-dropped', { text: '  lead', fontSize: 32 });
  add('spaces/inner-kept', { text: 'a  b', fontSize: 32 });
  add('spaces/trailing-kept', { text: 'trail   ', fontSize: 32 });
  add('spaces/second-space-stays-above', { text: 'aaaa  aaaa', fontSize: 32 }, { width: 110, height: 200 });
  add('spaces/only-spaces-give-one-empty-line', { text: '   ', fontSize: 32 });
  add('paragraph/empty-between', { text: 'a\n\nb', fontSize: 32 });
  add('paragraph/spaces-between-give-no-line', { text: 'a\n   \nb', fontSize: 32 });
  add('paragraph/trailing-newline', { text: 'a\n', fontSize: 32 });
  add('paragraph/carriage-return-stays', { text: 'a\r\nb', fontSize: 32 });
  add('letterSpacing/positive-center', { text: 'Hello world', fontSize: 32, letterSpacing: 4 });
  add('letterSpacing/positive-right', { text: 'Hello world', fontSize: 32, letterSpacing: 4, textAlign: 'right' });
  add('letterSpacing/negative', { text: 'Hello world', fontSize: 32, letterSpacing: -2, textAlign: 'left' });
  add('letterSpacing/wraps-earlier', { text: 'aaaa aaaa', fontSize: 32, letterSpacing: 4 }, { width: 190, height: 200 });
  add('lineHeight/tight', { text: 'one\ntwo\nthree', fontSize: 40, lineHeight: 0.8 });
  add('lineHeight/loose', { text: 'one\ntwo', fontSize: 40, lineHeight: 2 });
  add('fontSize/fractional', { text: 'Hello world', fontSize: 37.5 }, { width: 333.25, height: 180.5 });
  add('textPadding/zero', { text: 'Hello world', fontSize: 32, textPadding: 0, textAlign: 'left', verticalAlign: 'top' });
  add('textPadding/large', { text: 'Hello world again', fontSize: 32, textPadding: 40, textAlign: 'right', verticalAlign: 'bottom' });
  add('textPadding/negative-is-zero', { text: 'Hello', fontSize: 32, textPadding: -5, textAlign: 'left', verticalAlign: 'top' });
  add('textPadding/wider-than-the-box', { text: 'ab cd', fontSize: 32, textPadding: 120 }, { width: 200, height: 300 });
  for (const fontWeight of ['normal', 'medium', 'semibold', 'bold']) add(`fontWeight/${fontWeight}`, { text: 'Weight', fontSize: 32, fontWeight });
  add('fontWeight/unknown-is-400', { text: 'Weight', fontSize: 32, fontWeight: 'heavy' });
  add('fontStyle/italic', { text: 'Slant', fontSize: 32, fontStyle: 'italic' });
  add('fontFamily/named', { text: 'Poster', fontSize: 32, fontFamily: 'Anton' });
  add('underline', { text: 'Under line', fontSize: 50, underline: true, letterSpacing: 3 });
  add('overflow/taller-than-the-box-top', { text: 'a\nb\nc\nd', fontSize: 60, verticalAlign: 'top' }, { width: 400, height: 120 });
  add('overflow/taller-than-the-box-middle', { text: 'a\nb\nc\nd', fontSize: 60 }, { width: 400, height: 120 });
  add('overflow/taller-than-the-box-bottom', { text: 'a\nb\nc\nd', fontSize: 60, verticalAlign: 'bottom' }, { width: 400, height: 120 });
  for (const textAlign of ['left', 'center', 'right']) {
    add(`background/${textAlign}`, { text: 'Hello\nwide world', fontSize: 32, textAlign, backgroundColor: '#112233', backgroundRadius: 12 });
  }
  add('background/square', { text: 'Hello', fontSize: 32, backgroundColor: '#112233' });
  add('background/pill', { text: 'Hello', fontSize: 32, backgroundColor: '#112233', backgroundRadius: 999 });
  add('background/negative-radius-is-zero', { text: 'Hello', fontSize: 32, backgroundColor: '#112233', backgroundRadius: -4 });
  add('background/never-wider-than-the-box', { text: 'mmmmmmmmmmmmmmmmmmmm', fontSize: 32, textAlign: 'left', backgroundColor: 'rgba(0, 0, 0, 0.55)', backgroundRadius: 4 }, { width: 300, height: 200 });
  add('background/empty-colour-is-none', { text: 'Hello', fontSize: 32, backgroundColor: '' });
  add('textShadow-and-stroke-do-not-move-the-layout', { text: 'Hello world', fontSize: 32, textShadow: SHADOW, stroke: STROKE });
  add('textStyleScale/stored-value-changes-nothing', { text: 'Hello world', fontSize: 32, textStylePresetId: 'clean-title', textStyleScale: 3 });
  const spans = [
    { text: 'TOP STORY', fontSize: 24, fontWeight: 'semibold', color: '#fbbf24', letterSpacing: 2 },
    { text: 'A headline that wraps onto two lines' },
    { text: 'Subhead', fontSize: 30, fontWeight: 'medium', fontStyle: 'italic', fontFamily: 'Playfair Display', color: '#cbd5e1', underline: true },
  ];
  add('spans/stack-mixed-sizes', { text: 'ignored', textSpans: spans, fontSize: 48, fontWeight: 'bold', lineHeight: 0.96, letterSpacing: -1, color: '#f8fafc' }, { width: 420, height: 320 });
  add('spans/stack-right-bottom-background', { textSpans: spans, fontSize: 48, textAlign: 'right', verticalAlign: 'bottom', backgroundColor: '#0f172a', backgroundRadius: 28, textPadding: 28 }, { width: 520, height: 360 });
  add('spans/text-is-ignored', { text: 'something else entirely', textSpans: [{ text: 'shown' }], fontSize: 32 });
  add('spans/empty-list-uses-text', { text: 'shown', textSpans: [], fontSize: 32 });
  add('spans/non-string-entries-are-dropped', { text: 'unused', textSpans: [{ text: 5 }, { text: 'kept', color: '#00ff00' }, {}], fontSize: 32 });
  add('spans/all-dropped-uses-text', { text: 'shown', textSpans: [{ text: 5 }], fontSize: 32 });
  add('spans/empty-span-is-an-empty-line', { textSpans: [{ text: 'a' }, { text: '' }, { text: 'b' }], fontSize: 32 });
  const inline = [{ text: 'Hello ' }, { text: 'bright', color: '#ffcc00', underline: true }, { text: ' world again and again' }];
  add('inline/runs', { textSpans: inline, spanLayout: 'inline', fontSize: 32, color: '#ffffff' });
  add('inline/wraps', { textSpans: inline, spanLayout: 'inline', fontSize: 32, letterSpacing: 2, textAlign: 'left' }, { width: 260, height: 300 });
  add('inline/later-span-font-is-ignored', { textSpans: [{ text: 'small ', fontSize: 20, fontWeight: 'bold' }, { text: 'BIG', fontSize: 90, fontFamily: 'Anton', letterSpacing: 9, color: '#ff0000' }], spanLayout: 'inline' });
  add('inline/spaces-are-kept', { textSpans: [{ text: '  two  spaces ' }, { text: ' and  more  ', color: '#00ffff' }], spanLayout: 'inline', fontSize: 32 });
  add('inline/spaces-at-a-wrap-are-dropped', { textSpans: [{ text: 'aaaa   ' }, { text: 'aaaa', underline: true }], spanLayout: 'inline', fontSize: 32 }, { width: 120, height: 200 });
  add('inline/paragraphs', { textSpans: [{ text: 'one\n\n  two' }, { text: '\nthree ', color: '#ff00ff' }], spanLayout: 'inline', fontSize: 32, textAlign: 'right' });
  add('inline/long-word-is-not-split', { textSpans: [{ text: 'a mmmmmmmmmmmmmmmm b' }], spanLayout: 'inline', fontSize: 32 }, { width: 200, height: 300 });
  add('inline/background', { textSpans: inline, spanLayout: 'inline', fontSize: 32, backgroundColor: '#000000', backgroundRadius: 10, textAlign: 'left' }, { width: 300, height: 300 });
  add('spanLayout/unknown-is-stack', { textSpans: inline, spanLayout: 'flow', fontSize: 32 });
  add('caption-preset', { text: 'A caption cue of two lines that wraps', textRole: 'caption', fontFamily: 'Inter', fontWeight: 'semibold', fontSize: 43, color: '#ffffff', backgroundColor: 'rgba(0, 0, 0, 0.55)',
    backgroundRadius: 4, textAlign: 'center', verticalAlign: 'middle', lineHeight: 1.15, letterSpacing: 0, textPadding: 12,
    textShadow: { offsetX: 0, offsetY: 2, blur: 6, color: 'rgba(0, 0, 0, 0.6)' } }, { width: 756, height: 173 });
  // The platform's own measurer: its measurements are recorded with the goldens as inputs.
  add('platform/defaults', { text: 'Hello world' }, { width: 400, height: 200 }, 'platform');
  add('platform/wrap-right-bottom', { text: 'The quick brown fox jumps over the lazy dog', fontSize: 32, fontWeight: 'bold', letterSpacing: 1.5, textAlign: 'right', verticalAlign: 'bottom', backgroundColor: '#112233', backgroundRadius: 12 }, { width: 320, height: 300 }, 'platform');
  add('platform/inline', { textSpans: inline, spanLayout: 'inline', fontSize: 28, fontStyle: 'italic', textAlign: 'left' }, { width: 260, height: 300 }, 'platform');
  const families = [['Inter', 'semibold', 'normal'], ['Inter Tight', 'bold', 'normal'], ['Anton', 'normal', 'normal'], ['Bebas Neue', 'normal', 'normal'],
    ['Orbitron', 'semibold', 'normal'], ['Playfair Display', 'semibold', 'italic'], ['Space Grotesk', 'bold', 'normal']];
  for (const [fontFamily, fontWeight, fontStyle] of families) {
    add(`platform/family/${fontFamily}`, { text: 'Frameleaf Studio titles\nAV To fj 0123', fontFamily, fontWeight, fontStyle, fontSize: 48, letterSpacing: -1, lineHeight: 0.96, textAlign: 'left', backgroundColor: '#0f172a' }, { width: 420, height: 320 }, 'platform');
  }
  add('platform/latin-ext', { text: 'Za\u017c\u00f3\u0142\u0107 g\u0119\u015bl\u0105 ja\u017a\u0144', fontFamily: 'Inter', fontWeight: 'medium', fontStyle: 'italic', fontSize: 40 }, { width: 300, height: 240 }, 'platform');
  return cases;
}

export function autoHeightCases() {
  const text = 'The quick brown fox jumps over the lazy dog';
  return [
    { name: 'fits-and-is-unchanged', item: { text: 'Hello' }, box: { width: 400, height: 200 } },
    { name: 'grows-to-the-text', item: { text, fontSize: 48 }, box: { width: 320, height: 100 } },
    { name: 'stroke-and-shadow-add-room', item: { text, fontSize: 48, stroke: STROKE, textShadow: SHADOW, textPadding: 24, lineHeight: 1.4 }, box: { width: 320, height: 100 } },
    { name: 'negative-shadow-offset-counts-by-size', item: { text: 'Hello', fontSize: 100, textShadow: { offsetX: 0, offsetY: -30, blur: 10, color: '#000000' } }, box: { width: 600, height: 150 } },
    { name: 'spans', item: { textSpans: [{ text: 'TOP', fontSize: 24 }, { text }, { text: 'Subhead', fontSize: 30 }], fontSize: 48 }, box: { width: 320, height: 100 } },
  ];
}

const slotOf = (catalogue, presetId, changes = {}) => ({ ...catalogue.textMotion.defaults[presetId], presetId, seed: 0, ...changes });
const MOTION_FRAMES = [0, 1, 2, 3, 4, 6, 9, 10.5, 13, 18, 24, 31, 39, 44, 45, 46, 60, 75, 80, 84, 86, 88, 89];

export function motionCases(catalogue) {
  const cases = [];
  const context = { length: 90, unitCount: 5, fontSize: 80, boxWidth: 800 };
  const add = (name, spec, changes = {}, frames = MOTION_FRAMES) => cases.push({ name, spec, context: { ...context, ...changes }, frames });
  for (const slot of ['in', 'out', 'loop']) {
    for (const presetId of catalogue.textMotion[slot]) add(`preset/${presetId}`, { [slot]: slotOf(catalogue, presetId) });
  }
  for (const order of ['forward', 'backward', 'center', 'random']) {
    add(`order/${order}/fade-up`, { in: slotOf(catalogue, 'fade-up', { order }) });
    add(`order/${order}/typewriter-of-six`, { in: slotOf(catalogue, 'typewriter', { order, seed: 7 }) }, { unitCount: 6 });
    add(`order/${order}/wave-loop`, { loop: slotOf(catalogue, 'wave', { order, seed: 3 }) });
  }
  for (const seed of [0, 1, 7, -3, 2.7, 4294967296 + 5]) add(`order/random/seed=${seed}`, { in: slotOf(catalogue, 'typewriter', { order: 'random', seed }) }, { unitCount: 9 });
  for (const easing of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'overshoot']) {
    add(`easing/${easing}/rise`, { in: slotOf(catalogue, 'rise', { easing }) });
    add(`easing/${easing}/pop-out`, { out: slotOf(catalogue, 'pop-out', { easing }) });
  }
  add('easing/is-ignored-by-loop', { loop: slotOf(catalogue, 'pulse', { easing: 'ease-in' }) });
  for (const intensity of [0, 0.5, 2, 3, -1]) {
    add(`intensity=${intensity}/cascade`, { in: slotOf(catalogue, 'cascade', { intensity }) });
    add(`intensity=${intensity}/pop`, { in: slotOf(catalogue, 'pop', { intensity }) });
    add(`intensity=${intensity}/slide-mask`, { in: slotOf(catalogue, 'slide-mask', { intensity }) });
    add(`intensity=${intensity}/shimmer`, { loop: slotOf(catalogue, 'shimmer', { intensity }) });
  }
  for (const seed of [5, -7, 5000]) add(`shimmer/seed=${seed}`, { loop: slotOf(catalogue, 'shimmer', { seed }) });
  add('window/squeezed-to-half-the-item', { in: slotOf(catalogue, 'fade-up', { durationFrames: 20, staggerFrames: 6 }) }, { length: 20, unitCount: 12 }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9.5, 10, 11, 19]);
  add('window/squeezed-center', { out: slotOf(catalogue, 'sink', { order: 'center', staggerFrames: 9 }) }, { length: 30, unitCount: 7 }, [0, 10, 14, 15, 16, 18, 20, 22, 24, 26, 28, 29]);
  add('window/zero-duration-steps', { in: slotOf(catalogue, 'fade-up', { durationFrames: 0, staggerFrames: 4 }) });
  add('window/negative-values-are-zero', { in: slotOf(catalogue, 'fade-up', { durationFrames: -5, staggerFrames: -2 }) });
  add('window/one-unit', { in: slotOf(catalogue, 'rise') }, { unitCount: 1 });
  add('window/unit-count-zero-is-one', { in: slotOf(catalogue, 'rise') }, { unitCount: 0 });
  add('window/one-frame-item', { in: slotOf(catalogue, 'fade-up'), out: slotOf(catalogue, 'fade-down') }, { length: 1 }, [0, 0.25, 0.5, 0.75]);
  add('window/empty-item-has-no-motion', { in: slotOf(catalogue, 'fade-up') }, { length: 0 }, [0, 1]);
  add('offset/in', { in: slotOf(catalogue, 'fade-up', { offsetFrames: 10 }) });
  add('offset/out-stays-exited', { out: slotOf(catalogue, 'fade-down', { offsetFrames: 10 }) });
  add('offset/limited-to-the-item', { in: slotOf(catalogue, 'fade-up', { offsetFrames: 500 }), out: slotOf(catalogue, 'sink', { offsetFrames: 500 }) });
  add('slots/in-out', { in: slotOf(catalogue, 'rise'), out: slotOf(catalogue, 'sink') });
  add('slots/in-loop-out', { in: slotOf(catalogue, 'cascade'), loop: slotOf(catalogue, 'swing'), out: slotOf(catalogue, 'typewriter-erase') });
  add('slots/in-loop', { in: slotOf(catalogue, 'pop'), loop: slotOf(catalogue, 'pulse', { staggerFrames: 4 }) });
  add('slots/loop-out', { loop: slotOf(catalogue, 'wave'), out: slotOf(catalogue, 'blur-out') });
  add('slots/out-wins-where-windows-meet', { in: slotOf(catalogue, 'fade-up', { durationFrames: 40, staggerFrames: 0 }), out: slotOf(catalogue, 'fade-down', { durationFrames: 40, staggerFrames: 0 }) }, { length: 60 }, [0, 10, 19, 20, 21, 29, 30, 31, 40, 59]);
  add('loop/short-cycle', { loop: slotOf(catalogue, 'swing', { durationFrames: 7, staggerFrames: 1.5 }) });
  add('loop/zero-cycle', { loop: slotOf(catalogue, 'wave', { durationFrames: 0 }) }, {}, [0, 1, 2, 3]);
  add('context/font-size-and-box', { in: slotOf(catalogue, 'blur-in'), out: slotOf(catalogue, 'blur-out') }, { fontSize: 37.5, boxWidth: 333.25 });
  return cases;
}

export function slotCases(catalogue) {
  const frames = Array.from({ length: 61 }, (_, i) => i);
  const make = (name, spec, length = 60) => ({ name, spec, length, frames });
  return [
    make('in-without-stagger', { in: slotOf(catalogue, 'fade-up', { staggerFrames: 0 }) }),
    make('in-with-stagger-holds-to-half', { in: slotOf(catalogue, 'fade-up') }),
    make('in-loop-out', { in: slotOf(catalogue, 'fade-up'), loop: slotOf(catalogue, 'pulse'), out: slotOf(catalogue, 'fade-down', { staggerFrames: 0 }) }),
    make('offsets', { in: slotOf(catalogue, 'rise', { offsetFrames: 8, staggerFrames: 0 }), out: slotOf(catalogue, 'sink', { offsetFrames: 5, staggerFrames: 0 }) }),
    make('loop-only', { loop: slotOf(catalogue, 'wave') }),
    make('long-duration-is-capped', { in: slotOf(catalogue, 'rise', { durationFrames: 100, staggerFrames: 0 }) }),
    make('empty-item', { in: slotOf(catalogue, 'rise') }, 0),
  ];
}

export function unitCases() {
  const sets = {
    words: ['Hello, world!', '  two  spaces ', '', '"Quoted" (text) end.'],
    punctuation: ['...', '- dash first', 'a\u00a0b\tc', "don't stop-go"],
    numbers: ['Take 2 at 10.5 fps', 'e-mail me@home now'],
    single: ['one line only'],
  };
  return Object.entries(sets).flatMap(([name, lines]) => ['character', 'word', 'line', 'whole-clip'].map((unit) => ({ name: `${name}/${unit}`, lines, unit })));
}

export function paintCases(catalogue) {
  const canvas = { width: 640, height: 360 };
  const transform = { x: 20, y: -10, width: 400, height: 200 };
  const cases = [];
  const add = (name, item, frame = 0, box = transform) => cases.push({ name, item: { durationInFrames: 90, ...item }, canvas, transform: box, frame });
  const inline = [{ text: 'Hello ' }, { text: 'bright', color: '#ffcc00', underline: true }, { text: ' world again' }];
  const full = { text: 'Hello\nwide world', fontSize: 40, color: '#f8fafc', underline: true, letterSpacing: 2, backgroundColor: '#0f172a', backgroundRadius: 18, textShadow: SHADOW, stroke: STROKE };
  add('static/plain', { text: 'Hello world', fontSize: 40 });
  add('static/stroke', { text: 'Hello world', fontSize: 40, stroke: STROKE });
  add('static/stroke-of-width-zero-is-not-drawn', { text: 'Hello world', fontSize: 40, stroke: { width: 0, color: '#ff8800' } });
  add('static/shadow', { text: 'Hello world', fontSize: 40, textShadow: SHADOW });
  add('static/underline', { text: 'Hello world', fontSize: 40, underline: true, letterSpacing: 6 });
  add('static/thin-underline-has-a-floor', { text: 'small', fontSize: 9, underline: true });
  add('static/background-square', { text: 'Hello', fontSize: 40, backgroundColor: 'rgba(0, 0, 0, 0.55)' });
  add('static/everything', full);
  add('static/8-digit-colours', { ...full, color: '#f8fafccc', backgroundColor: '#0f172a80', textShadow: { ...SHADOW, color: '#10203099' }, stroke: { width: 3, color: '#ff880080' } });
  add('static/empty-lines-draw-nothing', { text: 'a\n\nb', fontSize: 40, underline: true, backgroundColor: '#112233' });
  add('static/spans', { textSpans: [{ text: 'TOP', fontSize: 24, color: '#fbbf24', underline: true }, { text: 'Headline' }], fontSize: 48, stroke: STROKE, textShadow: SHADOW });
  add('static/inline-runs', { textSpans: inline, spanLayout: 'inline', fontSize: 32, stroke: STROKE, textShadow: SHADOW, letterSpacing: 1 });
  add('static/inline-wrapped', { textSpans: inline, spanLayout: 'inline', fontSize: 32, textAlign: 'left' }, 0, { x: 0, y: 0, width: 220, height: 200 });
  add('static/settled-frame-with-motion', { ...full, textMotion: { in: slotOf(catalogue, 'fade-up', { staggerFrames: 0 }) } }, 40);
  const moving = { text: 'Hello wide\nworld again', fontSize: 40, color: '#f8fafc' };
  for (const [presetId, frame] of [['typewriter', 7], ['fade-up', 5], ['rise', 6], ['cascade', 4], ['pop', 8], ['blur-in', 5], ['slide-mask', 6], ['wave-in', 5]]) {
    add(`motion/${presetId}`, { ...moving, textMotion: { in: slotOf(catalogue, presetId) } }, frame);
  }
  for (const [presetId, frame] of [['fade-down', 80], ['sink', 78], ['pop-out', 82], ['blur-out', 80], ['typewriter-erase', 80]]) {
    add(`motion/${presetId}`, { ...moving, textMotion: { out: slotOf(catalogue, presetId) } }, frame);
  }
  for (const [presetId, frame] of [['pulse', 11], ['wave', 13], ['shimmer', 9], ['swing', 10]]) {
    add(`motion/${presetId}`, { ...moving, textMotion: { loop: slotOf(catalogue, presetId) } }, frame);
  }
  add('motion/everything', { ...full, textMotion: { in: slotOf(catalogue, 'pop') } }, 6);
  add('motion/underline-follows-the-first-unit-without-rotation', { text: 'Hello world', fontSize: 40, underline: true, textMotion: { loop: slotOf(catalogue, 'swing') } }, 10);
  add('motion/hidden-underline-is-skipped', { text: 'Hello world', fontSize: 40, underline: true, textMotion: { in: slotOf(catalogue, 'typewriter') } }, 0);
  add('motion/inline-run-colours-and-no-run-underline', { textSpans: inline, spanLayout: 'inline', fontSize: 32, textMotion: { in: slotOf(catalogue, 'cascade') } }, 5);
  add('motion/unit-override-whole-clip', { ...moving, textMotion: { in: slotOf(catalogue, 'fade-up', { unit: 'whole-clip' }) } }, 5);
  add('motion/unit-override-line', { ...moving, textMotion: { in: slotOf(catalogue, 'typewriter', { unit: 'line' }) } }, 2);
  add('motion/nbsp-and-tab-are-drawn-without-a-unit', { text: 'a\u00a0b\tc d', fontSize: 40, textMotion: { in: slotOf(catalogue, 'cascade') } }, 1);
  add('motion/loop-on-the-units-of-a-finished-staggered-in', { ...moving, textMotion: { in: slotOf(catalogue, 'fade-up'), loop: slotOf(catalogue, 'wave') } }, 30);
  add('motion/loop-after-the-coarse-in-window', { ...moving, textMotion: { in: slotOf(catalogue, 'fade-up'), loop: slotOf(catalogue, 'wave') } }, 50);
  add('motion/letter-spacing-moves-the-pen', { text: 'Hello', fontSize: 40, letterSpacing: 8, textAlign: 'left', textMotion: { loop: slotOf(catalogue, 'pulse') } }, 9);
  add('motion/spans-use-their-own-size', { textSpans: [{ text: 'TOP', fontSize: 24 }, { text: 'Headline' }], fontSize: 48, textMotion: { in: slotOf(catalogue, 'rise') } }, 3);
  return cases;
}

export function styleScaleCases(catalogue) {
  const canvas = { width: 1920, height: 1080, fps: 30 };
  const base = { text: 'Title', color: '#ffffff', fontSize: 80 };
  const cases = [];
  const add = (name, item, animated, size = canvas) => cases.push({ name, item, animated, canvas: size });
  add('nothing-animated', { ...base, textShadow: SHADOW, stroke: STROKE }, {});
  add('fontSize', base, { fontSize: 123.5 });
  add('fontSize/at-least-one', base, { fontSize: -4 });
  add('lineHeight/at-least-a-tenth', base, { lineHeight: 0.01 });
  add('textPadding-and-backgroundRadius', { ...base, textPadding: 20, backgroundRadius: 8 }, { textPadding: -3, backgroundRadius: 31.25 });
  add('shadow/one-number-animated', { ...base, textShadow: SHADOW }, { textShadowBlur: 20 });
  add('shadow/animated-without-a-shadow-is-black', base, { textShadowOffsetX: 4 });
  add('shadow/all-zero-is-removed', { ...base, textShadow: SHADOW }, { textShadowOffsetX: 0, textShadowOffsetY: 0, textShadowBlur: -2 });
  add('shadow/stored-all-zero-is-removed', { ...base, textShadow: { offsetX: 0, offsetY: 0, blur: 0, color: '#000000' } }, {});
  add('stroke/animated', { ...base, stroke: STROKE }, { strokeWidth: 7.5 });
  add('stroke/animated-without-a-stroke-has-the-default-colour', base, { strokeWidth: 2 });
  add('stroke/zero-is-removed', { ...base, stroke: STROKE }, { strokeWidth: 0 });
  add('spans-keep-their-own-size', { ...base, textSpans: [{ text: 'a', fontSize: 30 }, { text: 'b' }] }, { fontSize: 120 });
  add('textStyleScale/without-a-preset-does-nothing', { ...base, textStyleScale: 1 }, { textStyleScale: 2 });
  add('textStyleScale/stored-only-does-nothing', { ...base, textStylePresetId: 'poster', textStyleScale: 2 }, {});
  for (const preset of catalogue.titleStyles.presets) {
    const item = { ...base, ...preset.fields, textSpans: [{ text: 'one' }, { text: 'two', color: '#123456' }, { text: 'three', fontSize: 11 }, { text: 'four' }] };
    add(`textStyleScale/${preset.id}/x1.5`, item, { textStyleScale: 1.5 });
    add(`textStyleScale/${preset.id}/x0.5-no-spans`, { ...base, ...preset.fields }, { textStyleScale: 0.5 }, { width: 1280, height: 720, fps: 30 });
  }
  add('textStyleScale/then-fontSize-wins', { ...base, textStylePresetId: 'clean-title' }, { textStyleScale: 2, fontSize: 50 });
  add('textStyleScale/small-canvas-hits-the-size-floor', { ...base, textStylePresetId: 'cinematic' }, { textStyleScale: 1.25 }, { width: 640, height: 360, fps: 30 });
  return cases;
}

export const IMAGE_SIZE = { width: 64, height: 40 };
const NBSP3 = '\u00a0\u00a0\u00a0';
export function imageCases() {
  const transform = { x: 0, y: 0, width: 56, height: 32 };
  const base = { text: NBSP3, fontSize: 16, textPadding: 6, color: '#ffffff', durationInFrames: 30 };
  const make = (name, item, box = transform) => ({ name, item: { ...base, ...item }, transform: box });
  return [
    make('background-square', { backgroundColor: '#3366cc' }),
    make('background-round', { backgroundColor: '#3366cc', backgroundRadius: 8 }),
    make('background-pill', { backgroundColor: '#3366cc', backgroundRadius: 999 }),
    make('background-translucent', { backgroundColor: 'rgba(0, 0, 0, 0.55)', backgroundRadius: 4 }),
    make('background-left-top', { backgroundColor: '#cc6633', textAlign: 'left', verticalAlign: 'top' }),
    make('underline', { underline: true, fontSize: 40, lineHeight: 0.2, verticalAlign: 'top', letterSpacing: 2 }),
    make('underline-hard-shadow', { underline: true, fontSize: 40, lineHeight: 0.2, verticalAlign: 'top', textShadow: { offsetX: 3, offsetY: 4, blur: 0, color: '#ff0000' } }),
    make('underline-blurred-shadow', { underline: true, fontSize: 40, lineHeight: 0.2, verticalAlign: 'top', textShadow: { offsetX: 0, offsetY: 6, blur: 6, color: '#ff0000' } }),
    make('background-has-no-shadow', { backgroundColor: '#3366cc', textShadow: { offsetX: 5, offsetY: 5, blur: 0, color: '#ff0000' } }),
    make('alpha/background-8-digit', { backgroundColor: '#3366cc80', backgroundRadius: 4 }),
    make('alpha/background-8-digit-equals-caption-rgba', { backgroundColor: '#0000008c', backgroundRadius: 4 }),
    make('alpha/shadow-8-digit', { underline: true, fontSize: 40, lineHeight: 0.2, verticalAlign: 'top', textShadow: { offsetX: 3, offsetY: 4, blur: 0, color: '#ff000080' } }),
    make('alpha/caption-shadow-rgba', { underline: true, fontSize: 40, lineHeight: 0.2, verticalAlign: 'top', textShadow: { offsetX: 3, offsetY: 4, blur: 0, color: 'rgba(0, 0, 0, 0.6)' } }),
    make('alpha/caption-shadow-8-digit', { underline: true, fontSize: 40, lineHeight: 0.2, verticalAlign: 'top', textShadow: { offsetX: 3, offsetY: 4, blur: 0, color: '#00000099' } }),
    make('alpha/text-colour-8-digit-fades-its-shadow', { underline: true, color: '#ffffff80', fontSize: 40, lineHeight: 0.2, verticalAlign: 'top', textShadow: { offsetX: 3, offsetY: 4, blur: 0, color: '#ff000080' } }),
    make('alpha/translucent-background-and-shadow', { underline: true, color: '#ffffffcc', fontSize: 40, lineHeight: 0.2, verticalAlign: 'top', textAlign: 'left', backgroundColor: '#3366cc80',
      textShadow: { offsetX: 16, offsetY: -12, blur: 0, color: '#ff000080' } }),
    make('clipped-to-the-box', { backgroundColor: '#3366cc', textPadding: 14, fontSize: 24 }, { x: 4, y: -2, width: 30, height: 20 }),
  ];
}

/** Engine-free structural validation of a text goldens document. */
export function validateTextGoldens(goldens, catalogue) {
  assert.equal(goldens.format, TEXT_GOLDENS_FORMAT);
  assert.equal(goldens.version, TEXT_GOLDENS_VERSION);
  const lists = {
    layout: layoutCases(), autoHeight: autoHeightCases(), paint: paintCases(catalogue), styleScale: styleScaleCases(catalogue),
    motion: motionCases(catalogue), slot: slotCases(catalogue), units: unitCases(), image: imageCases(),
  };
  const counts = {};
  for (const [kind, expected] of Object.entries(lists)) {
    assert.deepEqual(goldens[kind].map((c) => c.name), expected.map((c) => c.name), `${kind}: cases must be complete and ordered`);
    counts[kind] = expected.length;
  }
  return counts;
}

// Engine-free half of the keyframe-interpolation contract (studio/spec/keyframes.md):
// the case list (a numeric fixture table), a reference implementation written from the
// prose of that page (rules K1..K16), the golden-file validator and the comparison rule.
// keyframe-goldens.browser.mjs evaluates the same cases with the real engine and writes
// studio/spec/goldens/keyframes.json; keyframe-goldens.test.mjs checks the reference
// against those engine values. Nothing here imports the engine.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const KEYFRAME_GOLDENS_FORMAT = 'frameleaf-studio-render-goldens';
export const KEYFRAME_GOLDENS_VERSION = 1;
export const KEYFRAME_GOLDENS_KIND = 'keyframes';
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export const EASING_NAMES = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'cubic-bezier', 'spring'];
export const BEZIER_DEFAULT = { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
export const SPRING_DEFAULT = { tension: 170, friction: 26, mass: 1 };
export const TRANSFORM_FIELDS = ['x', 'y', 'width', 'height', 'anchorX', 'anchorY', 'rotation', 'opacity', 'cornerRadius'];

// The tolerance classes of K16. A case is `exact` unless its evaluation used one of these.
export const TOLERANCES = {
  spring: { abs: 1e-9, reason: 'spring (K6): exp, cos and sin are not correctly rounded by IEEE 754; sqrt and the four operations are' },
  distance: { abs: 1e-9, reason: 'temporal ease (K11): the Euclidean distance of two values that differ in both components is not guaranteed correctly rounded' },
  colour: { channel: 1, reason: 'colour (K14): cube root, power, arctangent, sine and cosine precede the rounding to 8 bits, so a channel may differ by one step' },
};

// ---------------------------------------------------------------------------------------------
// Lossless number encoding. A JSON number round-trips every finite binary64 value except -0
// (ECMAScript prints the shortest decimal that reads back to the same double). The values JSON
// cannot hold are stored as strings.
// ---------------------------------------------------------------------------------------------
export function encodeNumber(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return value;
}
export function decodeNumber(stored) {
  if (typeof stored === 'number') return stored;
  if (stored === 'NaN') return NaN;
  if (stored === 'Infinity') return Infinity;
  if (stored === '-Infinity') return -Infinity;
  if (stored === '-0') return -0;
  throw new Error(`not an encoded number: ${JSON.stringify(stored)}`);
}
export function doubleToHex(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}
export function hexToDouble(hex) {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}
/** The numbers of a result, in a fixed order, whatever the case kind. A colour has none. */
export function resultNumbers(kind, value) {
  if (kind === 'easing' || kind === 'scalar') return [value];
  if (kind === 'vector') return [value.x, value.y];
  if (kind === 'transform') return TRANSFORM_FIELDS.map((field) => value[field]);
  return [];
}
export function encodeResult(kind, value) {
  if (kind === 'colour') return value;
  if (kind === 'easing' || kind === 'scalar') return encodeNumber(value);
  if (kind === 'vector') return { x: encodeNumber(value.x), y: encodeNumber(value.y) };
  return Object.fromEntries(TRANSFORM_FIELDS.map((field) => [field, encodeNumber(value[field])]));
}
export function decodeResult(kind, stored) {
  if (kind === 'colour') return stored;
  if (kind === 'easing' || kind === 'scalar') return decodeNumber(stored);
  if (kind === 'vector') return { x: decodeNumber(stored.x), y: decodeNumber(stored.y) };
  return Object.fromEntries(TRANSFORM_FIELDS.map((field) => [field, decodeNumber(stored[field])]));
}

// ---------------------------------------------------------------------------------------------
// Reference implementation, written from studio/spec/keyframes.md. `notes` collects the
// tolerance classes an evaluation touched (K16).
// ---------------------------------------------------------------------------------------------
const clampTo = (value, low, high) => Math.max(low, Math.min(high, value));

/** K5: the cubic timing curve through (0,0), (x1,y1), (x2,y2), (1,1), solved for x = t. */
function bezierTiming(t, { x1, y1, x2, y2 }) {
  if (t === 0) return 0;
  if (t === 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let s = t;
  for (let step = 0; step < 8; step += 1) {
    const error = ((ax * s + bx) * s + cx) * s - t;
    if (Math.abs(error) < 1e-6) break;
    const slope = (3 * ax * s + 2 * bx) * s + cx;
    if (Math.abs(slope) < 1e-6) break;
    s = clampTo(s - error / slope, 0, 1);
  }
  return ((ay * s + by) * s + cy) * s;
}

/** K6: the unit step response of a damped spring over its normalised settle time. */
function springTiming(t, { tension, friction, mass }, notes) {
  if (t === 0) return 0;
  if (t === 1) return 1;
  notes?.add('spring');
  const omega = Math.sqrt(tension / mass);
  const zeta = friction / (2 * Math.sqrt(tension * mass));
  const tau = t * (4 / (zeta * omega));
  let value;
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    value = 1 - Math.exp(-zeta * omega * tau) * (Math.cos(damped * tau) + ((zeta * omega) / damped) * Math.sin(damped * tau));
  } else if (zeta === 1) {
    value = 1 - Math.exp(-omega * tau) * (1 + omega * tau);
  } else {
    const root = Math.sqrt(zeta * zeta - 1);
    const slow = -omega * (zeta - root);
    const fast = -omega * (zeta + root);
    value = 1 - (fast * Math.exp(slow * tau) - slow * Math.exp(fast * tau)) / (fast - slow);
  }
  return Math.max(0, Math.min(1.2, value));
}

/** K2..K6: eased progress of a segment whose earlier keyframe carries `easing` and maybe `easingConfig`. */
export function referenceEasing(easing, easingConfig, t, notes) {
  const p = clampTo(t, 0, 1);
  const name = easingConfig ? easingConfig.type : easing;
  if (name === 'hold') return 0;
  if (name === 'ease-in') return p * p;
  if (name === 'ease-out') return p * (2 - p);
  if (name === 'ease-in-out') return p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
  if (name === 'cubic-bezier') return bezierTiming(p, easingConfig?.bezier ?? BEZIER_DEFAULT);
  if (name === 'spring') return springTiming(p, easingConfig?.spring ?? SPRING_DEFAULT, notes);
  return p;
}

/**
 * K7, K8: which rule gives the value of a group at a frame. Returns { end: keyframe } for a
 * value taken whole, { from, to } for a segment, or null for the static value.
 */
function locate(keyframes, frame) {
  if (keyframes.length === 0) return null;
  const first = keyframes[0];
  if (keyframes.length === 1 || frame <= first.frame) return { end: first };
  const last = keyframes[keyframes.length - 1];
  if (frame >= last.frame) return { end: last };
  for (let i = 0; i + 1 < keyframes.length; i += 1) {
    if (keyframes[i].frame <= frame && keyframes[i + 1].frame > frame) return { from: keyframes[i], to: keyframes[i + 1] };
  }
  return null;
}

/** K7..K9: a scalar group. */
export function referenceScalar(keyframes, frame, base, notes) {
  const at = locate(keyframes, frame);
  if (!at) return base;
  if (at.end) return at.end.value;
  const { from, to } = at;
  const progress = (frame - from.frame) / (to.frame - from.frame);
  return from.value + (to.value - from.value) * referenceEasing(from.easing, from.easingConfig, progress, notes);
}

/** K11: the timing of a vector segment. */
function vectorTiming(from, to, progress, rate, notes) {
  const out = from.temporalEase?.out;
  const into = to.temporalEase?.in;
  const fallback = () => referenceEasing(from.easing, from.easingConfig, progress, notes);
  if (!out && !into) return fallback();
  const seconds = (to.frame - from.frame) / Math.max(1, rate);
  const dx = to.value.x - from.value.x;
  const dy = to.value.y - from.value.y;
  const distance = dx === 0 ? Math.abs(dy) : dy === 0 ? Math.abs(dx) : Math.sqrt(dx * dx + dy * dy);
  if (seconds <= 0 || distance <= 2 ** -52) return fallback();
  const average = distance / seconds;
  const handle = (h) => ({ influence: clampTo(h?.influence ?? 100 / 3, 0, 100) / 100, speed: Math.max(0, h?.speed ?? average) });
  const o = handle(out);
  const i = handle(into);
  // The distance only reaches the result through a handle that states a speed above zero.
  if (dx !== 0 && dy !== 0 && [[out, o], [into, i]].some(([given, h]) => given && given.speed != null && h.speed > 0)) notes?.add('distance');
  return bezierTiming(progress, { x1: o.influence, y1: o.influence * (o.speed / average), x2: 1 - i.influence, y2: 1 - i.influence * (i.speed / average) });
}

/** K10..K13: a vector group. `rate` is the frame rate R of K11; absent means 30. */
export function referenceVector(property, keyframes, frame, base, rate, notes) {
  const at = locate(keyframes, frame);
  if (!at) return base;
  if (at.end) return at.end.value;
  const { from, to } = at;
  if (from.easing === 'hold') return from.value;
  const progress = (frame - from.frame) / (to.frame - from.frame);
  const u = vectorTiming(from, to, progress, rate ?? 30, notes);
  const p0 = from.value;
  const p3 = to.value;
  if (property === 'position' && (from.spatial || to.spatial)) {
    const leave = from.spatial?.outTangent ?? { x: 0, y: 0 };
    const arrive = to.spatial?.inTangent ?? { x: 0, y: 0 };
    const p1 = { x: p0.x + leave.x, y: p0.y + leave.y };
    const p2 = { x: p3.x + arrive.x, y: p3.y + arrive.y };
    const w = 1 - u;
    const w0 = w * w * w;
    const w1 = 3 * w * w * u;
    const w2 = 3 * w * u * u;
    const w3 = u * u * u;
    return { x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x, y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y };
  }
  return { x: p0.x + (p3.x - p0.x) * u, y: p0.y + (p3.y - p0.y) * u };
}

// K14: colour keyframes.
const RGBA_OFFSET = 2 ** 32;
function normalisePacked(value) {
  if (!Number.isFinite(value)) return 0;
  const whole = Math.floor(value + 0.5);
  if (whole <= 0xffffff) return Math.max(0, whole);
  if (whole < RGBA_OFFSET) return 0xffffff;
  return Math.min(whole, RGBA_OFFSET + 0xffffffff);
}
function unpack(value) {
  const packed = normalisePacked(value);
  const hasAlpha = packed >= RGBA_OFFSET;
  const digits = (hasAlpha ? packed - RGBA_OFFSET : packed).toString(16).padStart(hasAlpha ? 8 : 6, '0');
  const byte = (index) => Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
  return { r: byte(0), g: byte(1), b: byte(2), a: hasAlpha ? byte(3) : 255, hasAlpha, hex: `#${digits}` };
}
function packHex(text) {
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(text.trim());
  if (!match) return null;
  const digits = match[1].length <= 4 ? [...match[1]].map((d) => d + d).join('') : match[1];
  return digits.length === 6 ? Number.parseInt(digits, 16) : RGBA_OFFSET + Number.parseInt(digits, 16);
}
function toOklch({ r, g, b }) {
  const linear = (channel) => {
    const v = clampTo(channel / 255, 0, 1);
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}
function fromOklch({ L, C, h }) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (v) => clampTo(v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055, 0, 1) * 255;
  return [
    encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
/** K14: a colour group; keyframe values are packed colours, the static value and the result are hex strings. */
export function referenceColour(keyframes, frame, baseHex, notes) {
  const base = packHex(baseHex);
  if (base === null) return null;
  const at = locate(keyframes, frame);
  if (!at) return unpack(base).hex;
  if (at.end) return unpack(at.end.value).hex;
  const { from, to } = at;
  const p = referenceEasing(from.easing, from.easingConfig, (frame - from.frame) / (to.frame - from.frame), notes);
  notes?.add('colour');
  const c0 = unpack(from.value);
  const c1 = unpack(to.value);
  const o0 = toOklch(c0);
  const o1 = toOklch(c1);
  if (o0.C < 1e-7) o0.h = o1.h;
  if (o1.C < 1e-7) o1.h = o0.h;
  const turn = ((o1.h - o0.h + 540) % 360) - 180;
  const rgb = fromOklch({ L: o0.L + (o1.L - o0.L) * p, C: o0.C + (o1.C - o0.C) * p, h: o0.h + turn * p });
  const channels = c0.hasAlpha || c1.hasAlpha ? [...rgb, c0.a + (c1.a - c0.a) * p] : rgb;
  return `#${channels.map((v) => clampTo(Math.floor(v + 0.5), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

/** K15: the nine transform fields of a clip from its keyframe entry. `rate` absent means K11's R is 30. */
export function referenceTransform(base, entry, frame, rate, notes) {
  const out = { ...base };
  const lane = (name) => entry.vectorProperties?.find((group) => group.property === name)?.keyframes ?? [];
  const owned = new Set();
  const position = lane('position');
  if (position.length > 0) {
    const v = referenceVector('position', position, frame, { x: base.x, y: base.y }, rate, notes);
    out.x = v.x;
    out.y = v.y;
    owned.add('x').add('y');
  }
  const scale = lane('scale');
  if (scale.length > 0) {
    const v = referenceVector('scale', scale, frame, { x: 100, y: 100 }, rate, notes);
    out.width = base.width * (v.x / 100);
    out.height = base.height * (v.y / 100);
    owned.add('width').add('height');
  }
  const anchor = lane('anchor');
  if (anchor.length > 0) {
    const v = referenceVector('anchor', anchor, frame, { x: base.anchorX, y: base.anchorY }, rate, notes);
    out.anchorX = v.x;
    out.anchorY = v.y;
    owned.add('anchorX').add('anchorY');
  }
  for (const field of TRANSFORM_FIELDS) {
    if (owned.has(field)) continue;
    const group = entry.properties.find((candidate) => candidate.property === field);
    out[field] = referenceScalar(group?.keyframes ?? [], frame, base[field], notes);
  }
  return out;
}

/** Evaluates one case with the reference. Returns { value, notes }. */
export function referenceCase(c) {
  const notes = new Set();
  const i = c.input;
  let value;
  if (c.kind === 'easing') value = referenceEasing(i.easing, i.easingConfig, i.t, notes);
  else if (c.kind === 'scalar') value = referenceScalar(i.keyframes, i.frame, i.base, notes);
  else if (c.kind === 'vector') value = referenceVector(i.property, i.keyframes, i.frame, i.base, i.fps, notes);
  else if (c.kind === 'colour') value = referenceColour(i.keyframes, i.frame, i.base, notes);
  else if (c.kind === 'transform') value = referenceTransform(i.base, i.entry, i.frame, i.fps, notes);
  else throw new Error(`${c.name}: unknown kind ${c.kind}`);
  return { value, notes };
}

/** K16: `{ exact: true }`, or `{ tolerance }` when the evaluation used an operation IEEE 754 does not fix. */
export function classifyCase(c) {
  const { value, notes } = referenceCase(c);
  if (c.kind === 'colour') return notes.has('colour') ? { tolerance: TOLERANCES.colour } : { exact: true };
  // A result that is not a number is the same on every platform: NaN passes through every operation.
  if (notes.size === 0 || resultNumbers(c.kind, value).every(Number.isNaN)) return { exact: true };
  return { tolerance: notes.has('spring') ? TOLERANCES.spring : TOLERANCES.distance };
}

/**
 * The comparison rule. `golden` is a case of keyframes.json; `actual` is a decoded result.
 * exact: every number is the same binary64 value (NaN equals NaN, -0 differs from 0); a colour
 * is the same string. tolerance.abs: |actual - expected| <= abs for every number, NaN only
 * where the golden has NaN. tolerance.channel: every 8-bit channel within that many steps.
 */
export function compareKeyframeCase(golden, actual) {
  const expected = decodeResult(golden.kind, golden.expected);
  if (golden.kind === 'colour') {
    if (typeof actual !== 'string' || actual.length !== expected.length) return { pass: false, worst: Infinity };
    if (golden.exact) return { pass: actual === expected, worst: actual === expected ? 0 : Infinity };
    const bytes = (text) => text.slice(1).match(/../g).map((pair) => Number.parseInt(pair, 16));
    const worst = Math.max(...bytes(expected).map((v, i) => Math.abs(v - bytes(actual)[i])));
    return { pass: worst <= golden.tolerance.channel, worst };
  }
  const want = resultNumbers(golden.kind, expected);
  const got = resultNumbers(golden.kind, actual);
  let worst = 0;
  let pass = want.length === got.length;
  want.forEach((w, i) => {
    const g = got[i];
    if (Object.is(w, g)) return;
    const difference = Math.abs(w - g);
    if (golden.exact || !(difference <= golden.tolerance.abs)) pass = false;
    worst = Number.isNaN(difference) ? Infinity : Math.max(worst, difference);
  });
  return { pass, worst };
}

// ---------------------------------------------------------------------------------------------
// The case list. Every number is written out here; nothing comes from the engine.
// ---------------------------------------------------------------------------------------------
const k = (frame, value, easing = 'linear', extra = {}) => ({ frame, value, easing, ...extra });
const bez = (x1, y1, x2, y2) => ({ type: 'cubic-bezier', bezier: { x1, y1, x2, y2 } });
const spr = (tension, friction, mass) => ({ type: 'spring', spring: { tension, friction, mass } });
const v2 = (x, y) => ({ x, y });

const T_VALUES = [0, 0.1, 0.25, 1 / 3, 0.5, 0.75, 0.9, 1];
const SPRING_T = [0, 0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999, 1];

export const BEZIER_PRESETS = {
  'catalogue-default': [0.42, 0, 0.58, 1],
  'ease-out-cubic': [0.215, 0.61, 0.355, 1],
  'ease-in-cubic': [0.55, 0.055, 0.675, 0.19],
  'in-out': [0.645, 0.045, 0.355, 1],
  overshoot: [0.34, 1.56, 0.64, 1],
  anticipate: [0.36, 0, 0.66, -0.56],
  'back-in-out': [0.68, -0.6, 0.32, 1.6],
  snap: [0.19, 1, 0.22, 1],
  'in-expo': [0.7, 0, 0.84, 0],
  'corners-0-0-1-1': [0, 0, 1, 1],
  'corners-1-0-0-1': [1, 0, 0, 1],
  'flat-start-0-1-0-1': [0, 1, 0, 1],
  'x-out-of-range': [1.4, 0.2, -0.3, 0.9],
};
export const SPRING_PRESETS = {
  default: [170, 26, 1],
  'under-damped': [170, 10, 1],
  bouncy: [300, 5, 1],
  'critically-damped': [100, 20, 1],
  'over-damped': [100, 40, 1],
  'mass-10': [170, 26, 10],
  'mass-0.1': [170, 26, 0.1],
  'friction-0': [170, 0, 1],
  'tension-0': [0, 26, 1],
  'tension-0-friction-0': [0, 0, 1],
  'mass-0': [170, 26, 0],
  'out-of-range': [1000, 200, 0.05],
  'negative-friction': [170, -5, 1],
};

function easingCases() {
  const cases = [];
  const add = (label, easing, easingConfig, ts) => {
    for (const t of ts) cases.push({ name: `easing/${label}/t=${t}`, kind: 'easing', input: { easing, ...(easingConfig && { easingConfig }), t } });
  };
  for (const name of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']) add(name, name, undefined, T_VALUES);
  add('ease-in-out', 'ease-in-out', undefined, [0.49, 0.51]);
  add('cubic-bezier/no-config', 'cubic-bezier', undefined, T_VALUES);
  add('spring/no-config', 'spring', undefined, SPRING_T);
  add('unknown-name', 'bounce', undefined, [0.25, 0.75]);
  for (const name of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier', 'spring', 'hold']) add(`${name}/t-is-clamped`, name, undefined, [-0.25, 1.5]);
  for (const [label, points] of Object.entries(BEZIER_PRESETS)) add(`cubic-bezier/${label}`, 'cubic-bezier', bez(...points), T_VALUES);
  add('cubic-bezier/config-without-points', 'cubic-bezier', { type: 'cubic-bezier' }, [0.25, 0.5, 0.75]);
  for (const [label, params] of Object.entries(SPRING_PRESETS)) add(`spring/${label}`, 'spring', spr(...params), SPRING_T);
  add('spring/config-without-parameters', 'spring', { type: 'spring' }, [0.25, 0.5, 0.75]);
  add('spring/config-without-mass', 'spring', { type: 'spring', spring: { tension: 170, friction: 26 } }, [0, 0.5, 1]);
  // The type inside easingConfig decides; the keyframe's own easing is not read (K3).
  add('config-type-wins/linear-over-ease-in', 'ease-in', { type: 'linear' }, [0.25, 0.5]);
  add('config-type-wins/ease-out-over-spring', 'spring', { type: 'ease-out' }, [0.25, 0.5]);
  add('config-type-wins/hold-over-linear', 'linear', { type: 'hold' }, [0.25, 1]);
  add('config-type-wins/bezier-over-linear', 'linear', bez(0.34, 1.56, 0.64, 1), [0.25, 0.5]);
  add('config-type-wins/unknown-type', 'ease-in', { type: 'bounce' }, [0.25]);
  return cases;
}

function scalarCases() {
  const cases = [];
  const add = (name, keyframes, frames, base = 7) => {
    for (const frame of [].concat(frames)) cases.push({ name: `scalar/${name}/frame=${frame}`, kind: 'scalar', input: { keyframes, frame, base } });
  };
  add('empty-group-gives-static-value', [], [0, 12], 0.625);
  add('single-keyframe', [k(10, 42, 'ease-in')], [0, 10, 25]);
  const pair = [k(10, 100), k(40, 400)];
  add('linear/before-first', pair, [-5, 0, 9.5]);
  add('linear/on-first', pair, 10);
  add('linear/inside', pair, [11, 20, 25, 39]);
  add('linear/fractional-frame', pair, [10.25, 24.5, 39.999]);
  add('linear/on-last', pair, 40);
  add('linear/after-last', pair, [40.5, 1000]);
  add('linear/descending-values', [k(0, 0.75), k(7, -1.5)], [1, 3, 6]);
  add('linear/one-frame-apart', [k(3, 10), k(4, 20)], [3, 3.5, 4]);
  for (const name of ['ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier', 'spring']) add(`${name}/inside`, [k(0, 50, name), k(30, 250, 'linear')], [1, 10, 15, 29]);
  add('hold/inside', [k(0, 5, 'hold'), k(10, 9), k(20, 1)], [0, 5, 9.999, 10, 15]);
  add('hold/via-config-only', [k(0, 5, 'linear', { easingConfig: { type: 'hold' } }), k(10, 9)], [5]);
  // The earlier keyframe's easing shapes each segment; the last keyframe's easing is never read.
  const three = [k(0, 0, 'ease-in'), k(10, 100, 'ease-out'), k(20, 0, 'hold')];
  add('earlier-keyframe-easing-applies', three, [5, 10, 15, 20]);
  add('bezier-overshoot', [k(0, 0, 'cubic-bezier', { easingConfig: bez(0.34, 1.56, 0.64, 1) }), k(24, 1)], [6, 12, 18]);
  add('bezier-anticipate', [k(0, 10, 'cubic-bezier', { easingConfig: bez(0.36, 0, 0.66, -0.56) }), k(24, 20)], [6, 12, 18]);
  add('spring-default', [k(0, 0, 'spring', { easingConfig: spr(170, 26, 1) }), k(30, 1080)], [3, 15, 29, 30]);
  add('spring-bouncy-clamped-at-1.2', [k(0, 0, 'spring', { easingConfig: spr(300, 5, 1) }), k(30, 100)], [1, 2, 3, 29]);
  add('spring-friction-0-is-not-a-number', [k(0, 0, 'spring', { easingConfig: spr(170, 0, 1) }), k(30, 100)], [0, 15, 30]);
  add('config-type-wins', [k(0, 0, 'ease-in', { easingConfig: { type: 'linear' } }), k(10, 100)], [5]);
  add('unknown-easing-is-linear', [k(0, 0, 'bounce'), k(10, 100)], [2.5]);
  // Keyframes on one frame (K8).
  const twin = [k(0, 1), k(10, 2), k(10, 30), k(20, 40)];
  add('same-frame/interior', twin, [5, 9.5, 10, 10.5, 15]);
  add('same-frame/at-start', [k(0, 1), k(0, 50), k(10, 100)], [-1, 0, 0.5, 5]);
  add('same-frame/at-end', [k(0, 1), k(10, 50), k(10, 100)], [9, 10, 11]);
  add('same-frame/whole-group', [k(4, 1), k(4, 2)], [3, 4, 5]);
  // Array order is used as it stands (K8).
  const unsorted = [k(20, 200), k(0, 0), k(40, 400)];
  add('unsorted/first-element-bounds-the-start', unsorted, [10, 20]);
  add('unsorted/later-pair-brackets', unsorted, [30, 39]);
  add('unsorted/last-element-bounds-the-end', [k(0, 0), k(40, 400), k(20, 200)], [10, 20, 30]);
  add('unsorted/descending', [k(30, 3), k(20, 2), k(10, 1)], [5, 15, 25, 35]);
  add('no-rounding', [k(0, 0.1), k(3, 0.2)], [1, 2]);
  add('large-values', [k(0, -1e9), k(1000, 1e9, 'ease-in-out')], [1, 333, 500, 999]);
  return cases;
}

function vectorCases() {
  const cases = [];
  const add = (name, property, keyframes, frames, options = {}) => {
    for (const frame of [].concat(frames)) {
      cases.push({ name: `vector/${name}/frame=${frame}`, kind: 'vector',
        input: { property, keyframes, frame, base: options.base ?? v2(11, 22), ...(options.fps !== undefined && { fps: options.fps }) } });
    }
  };
  const te = (handles) => ({ temporalEase: handles });
  const h = (speed, influence) => ({ speed, influence });
  const a = v2(100, 200);
  const b = v2(400, 600); // 500 units from a
  const along = v2(700, 200); // 600 units from a, on the x axis

  add('empty-group-gives-static-value', 'position', [], [0, 9]);
  add('single-keyframe', 'position', [k(10, a, 'spring')], [0, 10, 30]);
  for (const property of ['position', 'scale', 'anchor']) {
    add(`${property}/linear`, property, [k(10, a), k(40, b)], [0, 10, 17.5, 25, 39, 40, 99]);
  }
  for (const name of ['ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier', 'spring']) add(`easing/${name}`, 'position', [k(0, a, name), k(30, b)], [10, 15, 20]);
  add('easing/bezier-overshoot', 'position', [k(0, a, 'cubic-bezier', { easingConfig: bez(0.34, 1.56, 0.64, 1) }), k(30, b)], [10, 15, 20]);
  add('easing/spring-under-damped', 'scale', [k(0, v2(100, 100), 'spring', { easingConfig: spr(170, 10, 1) }), k(30, v2(150, 50))], [3, 15, 27]);
  add('easing/config-type-wins', 'position', [k(0, a, 'ease-in', { easingConfig: { type: 'linear' } }), k(30, b)], [10]);
  add('earlier-keyframe-easing-applies', 'position', [k(0, a, 'ease-in'), k(10, b, 'ease-out'), k(20, a, 'hold')], [5, 10, 15, 20]);
  add('hold', 'position', [k(0, a, 'hold'), k(30, b)], [0, 15, 29.999, 30]);
  add('hold/beats-temporal-ease-and-spatial', 'position',
    [k(0, a, 'hold', { ...te({ out: h(0, 50) }), spatial: { inTangent: v2(0, 0), outTangent: v2(90, -90) } }), k(30, b)], [15]);
  add('hold/via-config-only-is-a-zero-timing', 'position', [k(0, a, 'linear', { easingConfig: { type: 'hold' } }), k(30, b)], [15]);
  add('hold/via-config-only-loses-to-temporal-ease', 'position', [k(0, a, 'linear', { easingConfig: { type: 'hold' }, ...te({ out: h(0, 50) }) }), k(30, b)], [15]);

  // Temporal ease (K11). Speed 0 and absent handles are exact; a stated speed above zero on a diagonal is not.
  const frames = [3, 10, 15, 20, 27];
  add('temporal/out-only/speed-0', 'position', [k(0, a, 'linear', te({ out: h(0, 100 / 3) })), k(30, b)], frames);
  add('temporal/in-only/speed-0', 'position', [k(0, a), k(30, b, 'linear', te({ in: h(0, 100 / 3) }))], frames);
  add('temporal/both/speed-0', 'position', [k(0, a, 'linear', te({ out: h(0, 100 / 3) })), k(30, b, 'linear', te({ in: h(0, 100 / 3) }))], frames);
  for (const influence of [0.1, 33.33, 100]) {
    add(`temporal/both/speed-0/influence-${influence}`, 'position', [k(0, a, 'linear', te({ out: h(0, influence) })), k(30, b, 'linear', te({ in: h(0, influence) }))], frames);
    add(`temporal/out-only/speed-0/influence-${influence}`, 'position', [k(0, a, 'linear', te({ out: h(0, influence) })), k(30, b)], [10, 20]);
    add(`temporal/both/speed-750/influence-${influence}/axis-aligned`, 'position',
      [k(0, a, 'linear', te({ out: h(750, influence) })), k(30, along, 'linear', te({ in: h(750, influence) }))], [10, 15, 20], { fps: 30 });
  }
  add('temporal/mixed-influences', 'position', [k(0, a, 'linear', te({ out: h(0, 75) })), k(30, b, 'linear', te({ in: h(0, 10) }))], frames);
  add('temporal/speed-equals-average/axis-aligned', 'position', [k(0, a, 'linear', te({ out: h(600, 100 / 3) })), k(30, along, 'linear', te({ in: h(600, 100 / 3) }))], [10, 15, 20], { fps: 30 });
  add('temporal/out-fast-in-0/axis-aligned', 'position', [k(0, a, 'linear', te({ out: h(1800, 25) })), k(30, along, 'linear', te({ in: h(0, 60) }))], [5, 15, 25], { fps: 30 });
  add('temporal/overshooting-speed/axis-aligned', 'position', [k(0, a, 'linear', te({ out: h(3600, 50) })), k(30, along, 'linear', te({ in: h(3600, 50) }))], [5, 15, 25], { fps: 30 });
  add('temporal/diagonal/speed-500', 'position', [k(0, a, 'linear', te({ out: h(500, 100 / 3) })), k(30, b, 'linear', te({ in: h(500, 100 / 3) }))], [10, 15, 20], { fps: 30 });
  add('temporal/diagonal/speed-1200-out-only', 'position', [k(0, a, 'linear', te({ out: h(1200, 40) })), k(30, v2(317, 451))], [10, 15, 20], { fps: 30 });
  add('temporal/diagonal/in-only-speed-250', 'scale', [k(0, v2(100, 100)), k(30, v2(137, 71), 'linear', te({ in: h(250, 20) }))], [10, 15, 20], { fps: 30 });
  // The rate R: per second speeds scale with it; absent means 30; below 1 counts as 1.
  for (const fps of [24, 25, 30, 60, 1, 0.5]) {
    add(`temporal/rate-${fps}`, 'position', [k(0, a, 'linear', te({ out: h(750, 40) })), k(30, along, 'linear', te({ in: h(300, 40) }))], [10, 20], { fps });
  }
  add('temporal/rate-absent-is-30', 'position', [k(0, a, 'linear', te({ out: h(750, 40) })), k(30, along, 'linear', te({ in: h(300, 40) }))], [10, 20]);
  add('temporal/negative-speed-counts-as-0', 'position', [k(0, a, 'linear', te({ out: h(-400, 50) })), k(30, b)], [10, 20]);
  add('temporal/influence-above-100-counts-as-100', 'position', [k(0, a, 'linear', te({ out: h(0, 150) })), k(30, b)], [10, 20]);
  add('temporal/influence-below-0-counts-as-0', 'position', [k(0, a, 'linear', te({ out: h(0, -5) })), k(30, b)], [10, 20]);
  add('temporal/handle-without-speed-or-influence', 'position', [k(0, a, 'linear', te({ out: {} })), k(30, b)], [10, 20]);
  add('temporal/empty-object-falls-back-to-easing', 'position', [k(0, a, 'ease-in', te({})), k(30, b)], [10, 20]);
  add('temporal/replaces-easing-and-config', 'position',
    [k(0, a, 'spring', { easingConfig: spr(300, 5, 1), ...te({ out: h(0, 50) }) }), k(30, b)], [10, 20]);
  add('temporal/zero-distance-falls-back-to-easing', 'position', [k(0, a, 'ease-in', te({ out: h(0, 50) })), k(30, a)], [10]);
  add('temporal/zero-distance-with-spatial-path', 'position',
    [k(0, a, 'ease-in', { ...te({ out: h(0, 50) }), spatial: { inTangent: v2(0, 0), outTangent: v2(120, 0) } }),
      k(30, a, 'linear', { spatial: { inTangent: v2(0, 120), outTangent: v2(0, 0) } })], [10, 15, 20]);
  add('temporal/wrong-side-handles-are-not-read', 'position', [k(0, a, 'ease-out', te({ in: h(0, 90) })), k(30, b, 'linear', te({ out: h(0, 90) }))], [10, 20]);
  add('temporal/on-scale-and-anchor', 'anchor', [k(0, v2(0, 0), 'linear', te({ out: h(0, 60) })), k(20, v2(64, 0), 'linear', te({ in: h(96, 30) }))], [5, 10, 15], { fps: 30 });

  // Spatial tangents (K12): position only; the curve parameter is the timed progress.
  const sp = (inTangent, outTangent, continuous) => ({ spatial: { inTangent, outTangent, ...(continuous !== undefined && { continuous }) } });
  const zero = v2(0, 0);
  add('spatial/zero-tangents-are-not-a-straight-lerp', 'position', [k(0, a, 'linear', sp(zero, zero)), k(30, b, 'linear', sp(zero, zero))], [0, 7.5, 15, 22.5, 30]);
  add('spatial/tangents-along-the-chord', 'position', [k(0, a, 'linear', sp(zero, v2(100, 0))), k(30, along, 'linear', sp(v2(-100, 0), zero))], [10, 15, 20]);
  add('spatial/third-of-the-chord-is-the-straight-lerp', 'position', [k(0, a, 'linear', sp(zero, v2(200, 0))), k(30, along, 'linear', sp(v2(-200, 0), zero))], [10, 15, 20]);
  const curvedFrom = (continuous) => k(0, a, 'linear', sp(v2(-150, 80), v2(150, -80), continuous));
  const curvedTo = (continuous) => k(30, b, 'linear', sp(v2(-60, -220), v2(60, 220), continuous));
  add('spatial/curved', 'position', [curvedFrom(), curvedTo()], [5, 10, 15, 20, 25]);
  add('spatial/curved/continuous-true', 'position', [curvedFrom(true), curvedTo(true)], [5, 10, 15, 20, 25]);
  add('spatial/curved/continuous-false', 'position', [curvedFrom(false), curvedTo(false)], [5, 10, 15, 20, 25]);
  add('spatial/continuous-true-with-unmirrored-tangents', 'position',
    [k(0, a, 'linear', sp(v2(10, 10), v2(150, -80), true)), k(30, b, 'linear', sp(v2(-60, -220), v2(5, 5), true))], [10, 20]);
  add('spatial/only-earlier-keyframe-has-tangents', 'position', [k(0, a, 'linear', sp(zero, v2(150, -80))), k(30, b)], [10, 20]);
  add('spatial/only-later-keyframe-has-tangents', 'position', [k(0, a), k(30, b, 'linear', sp(v2(-60, -220), zero))], [10, 20]);
  add('spatial/middle-keyframe-uses-in-then-out', 'position',
    [k(0, a), k(10, b, 'linear', sp(v2(-90, 0), v2(0, 90))), k(20, a)], [5, 10, 15]);
  add('spatial/ignored-on-scale', 'scale', [curvedFrom(), curvedTo()], [10, 20]);
  add('spatial/ignored-on-anchor', 'anchor', [curvedFrom(), curvedTo()], [10, 20]);
  add('spatial/with-ease-in-out', 'position', [{ ...curvedFrom(), easing: 'ease-in-out' }, curvedTo()], [5, 15, 25]);
  add('spatial/with-bezier-overshoot-leaves-the-segment', 'position', [{ ...curvedFrom(), easing: 'cubic-bezier', easingConfig: bez(0.34, 1.56, 0.64, 1) }, curvedTo()], [10, 15, 20]);
  add('spatial/with-spring', 'position', [{ ...curvedFrom(), easing: 'spring' }, curvedTo()], [3, 15]);
  add('spatial/with-temporal-ease', 'position',
    [{ ...curvedFrom(), ...te({ out: h(0, 100 / 3) }) }, { ...curvedTo(), ...te({ in: h(0, 100 / 3) }) }], [5, 15, 25]);
  add('spatial/with-temporal-speed-uses-chord-distance', 'position',
    [{ ...curvedFrom(), ...te({ out: h(900, 40) }) }, { ...curvedTo(), ...te({ in: h(100, 40) }) }], [5, 15, 25], { fps: 30 });

  add('same-frame/interior', 'position', [k(0, a), k(10, b), k(10, along), k(20, a)], [5, 10, 15]);
  add('same-frame/at-start', 'position', [k(0, a), k(0, b), k(10, along)], [0, 5]);
  add('unsorted', 'position', [k(20, b), k(0, a), k(40, along)], [10, 30]);
  add('fractional-frame-no-rounding', 'position', [k(0, v2(0.1, 0.2)), k(3, v2(0.2, 0.7))], [1, 1.5, 2]);
  return cases;
}

function colourCases() {
  const cases = [];
  const rgb = (hex) => Number.parseInt(hex, 16);
  const rgba = (hex) => 2 ** 32 + Number.parseInt(hex, 16);
  const add = (name, keyframes, frames, base = '#102030') => {
    for (const frame of [].concat(frames)) cases.push({ name: `colour/${name}/frame=${frame}`, kind: 'colour', input: { keyframes, frame, base } });
  };
  add('empty-group-gives-static-value', [], 5, '#AbCdEf');
  add('empty-group-short-static-value', [], 5, '#1af');
  add('single-keyframe', [k(10, rgb('3366cc'))], [0, 10, 20]);
  const pair = [k(0, rgb('ff0000')), k(20, rgb('0000ff'))];
  add('red-to-blue', pair, [-1, 0, 5, 10, 15, 20, 21]);
  add('red-to-blue/ease-in', [k(0, rgb('ff0000'), 'ease-in'), k(20, rgb('0000ff'))], [5, 10, 15]);
  add('hold', [k(0, rgb('ff0000'), 'hold'), k(20, rgb('0000ff'))], [10, 20]);
  add('grey-borrows-hue', [k(0, rgb('808080')), k(20, rgb('00ff80'))], [5, 10, 15]);
  add('to-grey-borrows-hue', [k(0, rgb('ff8000')), k(20, rgb('202020'))], [5, 10, 15]);
  add('black-to-white', [k(0, rgb('000000')), k(20, rgb('ffffff'))], [5, 10, 15]);
  add('hue-takes-the-short-way', [k(0, rgb('ff0040')), k(20, rgb('ff4000'))], [5, 10, 15]);
  add('alpha-both', [k(0, rgba('ff000080')), k(20, rgba('00ff00ff'))], [0, 5, 10, 15, 20]);
  add('alpha-one-side', [k(0, rgb('3366cc')), k(20, rgba('cc663300'))], [0, 10, 20]);
  add('bezier-overshoot', [k(0, rgb('204060'), 'cubic-bezier', { easingConfig: bez(0.34, 1.56, 0.64, 1) }), k(20, rgb('e0c020'))], [5, 10, 15]);
  add('values-are-normalised', [k(0, -5), k(10, 16777215.6), k(20, 2 ** 32 - 7), k(30, 2 ** 33 + 99)], [0, 10, 20, 30]);
  add('fractional-value-is-rounded', [k(0, 255.5), k(10, 0)], [0]);
  return cases;
}

function transformCases() {
  const cases = [];
  const base = { x: 10, y: 20, width: 640, height: 360, anchorX: 320, anchorY: 180, rotation: 15, opacity: 0.8, cornerRadius: 4 };
  const add = (name, entry, frames, fps) => {
    for (const frame of [].concat(frames)) {
      cases.push({ name: `transform/${name}/frame=${frame}`, kind: 'transform',
        input: { base, entry: { itemId: 'clip', ...entry }, frame, ...(fps !== undefined && { fps }) } });
    }
  };
  const group = (property, keyframes) => ({ property, keyframes });
  const xLane = group('x', [k(0, 0), k(30, 300)]);
  const yLane = group('y', [k(0, 0, 'ease-in'), k(30, 600)]);
  const position = group('position', [k(0, v2(1000, 1000)), k(30, v2(1300, 1400))]);
  add('no-groups', { animationVersion: 2, properties: [] }, 15);
  add('scalar-lanes', { animationVersion: 2, properties: [xLane, yLane, group('opacity', [k(0, 0), k(30, 1)]), group('rotation', [k(0, 0, 'hold'), k(30, 90)])] }, [0, 15, 30]);
  add('empty-scalar-group-gives-static-value', { animationVersion: 2, properties: [group('x', [])] }, 15);
  add('vector-lane', { animationVersion: 2, properties: [], vectorProperties: [position] }, [0, 15, 30]);
  // A vector lane with a keyframe owns both components; scalar lanes of those components are not read.
  add('vector-lane-beats-scalar-lanes', { animationVersion: 2, properties: [xLane, yLane], vectorProperties: [position] }, [15]);
  add('separated-flag-is-not-read', { animationVersion: 2, properties: [xLane, yLane], vectorProperties: [position], separatedVectorProperties: ['position'] }, [15]);
  add('separated-flag-without-vector-lane', { animationVersion: 2, properties: [xLane, yLane], separatedVectorProperties: ['position'] }, [15]);
  add('empty-vector-lane-leaves-scalar-lanes', { animationVersion: 2, properties: [xLane, yLane], vectorProperties: [group('position', [])] }, [15]);
  add('animation-version-absent', { properties: [xLane, yLane], vectorProperties: [position] }, [15]);
  add('scale-is-percent-of-static-size', { animationVersion: 2, properties: [group('width', [k(0, 1), k(30, 2)])], vectorProperties: [group('scale', [k(0, v2(100, 100)), k(30, v2(50, 250))])] }, [0, 10, 30]);
  add('anchor-lane', { animationVersion: 2, properties: [], vectorProperties: [group('anchor', [k(0, v2(0, 0), 'ease-out'), k(30, v2(640, 360))])] }, [10]);
  add('first-group-of-a-name-wins', { animationVersion: 2, properties: [xLane, group('x', [k(0, -1), k(30, -2)])] }, [15]);
  const timed = group('position', [k(0, v2(0, 0), 'linear', { temporalEase: { out: { speed: 900, influence: 40 } } }), k(30, v2(600, 0), 'linear', { temporalEase: { in: { speed: 0, influence: 40 } } })]);
  add('rate-absent-is-30', { animationVersion: 2, properties: [], vectorProperties: [timed] }, [10, 20]);
  add('rate-from-project-24', { animationVersion: 2, properties: [], vectorProperties: [timed] }, [10, 20], 24);
  add('rate-from-project-60', { animationVersion: 2, properties: [], vectorProperties: [timed] }, [10, 20], 60);
  return cases;
}

/** Every case, in the order of the golden file. */
export function keyframeCases() {
  return [...easingCases(), ...scalarCases(), ...vectorCases(), ...colourCases(), ...transformCases()];
}

// ---------------------------------------------------------------------------------------------
// Golden-file validation.
// ---------------------------------------------------------------------------------------------
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Checks structure, the case list, the exact/tolerance marking and coverage. Returns counts. */
export function validateKeyframeGoldens(doc) {
  assert.equal(doc.format, KEYFRAME_GOLDENS_FORMAT);
  assert.equal(doc.version, KEYFRAME_GOLDENS_VERSION);
  assert.equal(doc.kind, KEYFRAME_GOLDENS_KIND);
  assert.equal(doc.contract, 'studio/spec/keyframes.md');
  assert.match(doc.engine?.revision ?? '', /^[0-9a-f]{40}$/);
  assert.match(doc.engine?.sourceDigest?.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(doc.generatedBy, 'studio/tools/keyframe-goldens.browser.mjs --write');
  assert.equal(typeof doc.numbers, 'string');
  assert.deepEqual(doc.tolerances, plain(TOLERANCES));
  const wanted = keyframeCases();
  assert.equal(new Set(wanted.map((c) => c.name)).size, wanted.length, 'case names must be unique');
  assert.equal(doc.cases.length, wanted.length, 'case count');
  const counts = { cases: wanted.length, exact: 0, toleranced: 0, byKind: {}, byTolerance: {} };
  doc.cases.forEach((c, index) => {
    const want = wanted[index];
    assert.equal(c.name, want.name, `case ${index}`);
    assert.equal(c.kind, want.kind, c.name);
    assert.deepEqual(c.input, plain(want.input), `${c.name}: input`);
    assert.deepEqual(Object.keys(c).sort(), ['expected', c.exact ? 'exact' : 'tolerance', 'input', 'kind', 'name'].sort(), `${c.name}: fields`);
    const marking = classifyCase(want);
    if (marking.exact) assert.equal(c.exact, true, `${c.name}: must be exact`);
    else assert.deepEqual(c.tolerance, plain(marking.tolerance), `${c.name}: tolerance`);
    const expected = decodeResult(c.kind, c.expected);
    if (c.kind === 'colour') assert.match(expected, /^#([0-9a-f]{6}|[0-9a-f]{8})$/, c.name);
    else for (const n of resultNumbers(c.kind, expected)) assert.equal(typeof n, 'number', c.name);
    assert.deepEqual(encodeResult(c.kind, expected), c.expected, `${c.name}: expected is not in canonical encoding`);
    counts[c.exact ? 'exact' : 'toleranced'] += 1;
    counts.byKind[c.kind] = (counts.byKind[c.kind] ?? 0) + 1;
    if (!c.exact) {
      const cls = Object.keys(TOLERANCES).find((key) => TOLERANCES[key].reason === c.tolerance.reason);
      counts.byTolerance[cls] = (counts.byTolerance[cls] ?? 0) + 1;
    }
  });
  // Coverage the contract promises.
  const names = doc.cases.map((c) => c.name);
  const has = (fragment) => assert(names.some((n) => n.includes(fragment)), `coverage: no case named *${fragment}*`);
  for (const easing of EASING_NAMES) {
    for (const t of [0, 0.5, 1]) has(`easing/${easing === 'cubic-bezier' ? 'cubic-bezier/no-config' : easing === 'spring' ? 'spring/no-config' : easing}/t=${t}`);
  }
  for (const preset of Object.keys(BEZIER_PRESETS)) has(`easing/cubic-bezier/${preset}/`);
  for (const preset of Object.keys(SPRING_PRESETS)) has(`easing/spring/${preset}/`);
  for (const fragment of ['scalar/empty-group', 'scalar/single-keyframe', 'before-first', 'after-last', 'fractional-frame', 'scalar/hold', 'scalar/same-frame',
    'scalar/unsorted', 'vector/hold', 'temporal/out-only', 'temporal/in-only', 'temporal/both', 'influence-0.1', 'influence-33.33', 'influence-100',
    'speed-0', 'speed-750', 'spatial/zero-tangents', 'spatial/curved/continuous-true', 'spatial/curved/continuous-false', 'separated-flag', 'colour/']) has(fragment);
  return counts;
}

/** One case per line, like the other goldens. */
export function serialiseKeyframeGoldens(doc) {
  const { cases, ...rest } = doc;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
  return `${head},\n  "cases": [\n${cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]\n}\n`;
}

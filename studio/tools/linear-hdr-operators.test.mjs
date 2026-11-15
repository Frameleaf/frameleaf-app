// Engine-free check of the linear HDR operators of FL-1556 against studio/spec, written from the
// pages alone: transition endpoints and the equations of the mix and selection transitions
// (README T5), the grades' extended-sRGB rule (README C4) against the SDR goldens, and the
// HDR unsharp mask of gpu-sharpen. The goldens are the engine's; this file is the prose.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeBuffer, roundHalf, transitionHdrInputs, effectHdrInput, effectSdrInput, EFFECT_SIZE, TRANSITION_SIZE,
  LINEAR_HDR_TRANSITIONS,
} from './render-goldens.mjs';
import { chromaKeyReference, colorWheelsReference, sharpenReference } from './grade-reference.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (rel) => JSON.parse(await readFile(path.join(studio, rel), 'utf8'));
const effects = await readJson('spec/goldens/effects.json');
const transitions = await readJson('spec/goldens/transitions.json');
const output = (c) => decodeBuffer(c.output.data, c.output.encoding);

// README C4 floor for linear HDR: 0.004 plus 0.2 % of the value.
const within = (got, want, extra = 0) => Math.abs(got - want) <= Math.max(0.004, 0.002 * Math.abs(want)) + extra;
// H5, both directions, odd.
const srgbDecode = (v) => { const a = Math.abs(v); return Math.sign(v) * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4); };
const srgbEncode = (v) => { const a = Math.abs(v); return Math.sign(v) * (a <= 0.0031308 ? 12.92 * a : 1.055 * a ** (1 / 2.4) - 0.055); };
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ---- transitions ---------------------------------------------------------------------------
const { width: TW, height: TH } = TRANSITION_SIZE;
const hdrIn = transitionHdrInputs();
const stored = { a: hdrIn.a.map(roundHalf), b: hdrIn.b.map(roundHalf) };
// T2: each input is premultiplied (stored as binary16) before any filtered sampling.
const premultiplied = (values) => {
  const out = [];
  for (let k = 0; k < values.length; k += 4) {
    const alpha = Math.min(1, Math.max(0, values[k + 3]));
    for (let c = 0; c < 3; c++) out.push(alpha <= 0 ? 0 : roundHalf(values[k + c] * alpha));
    out.push(alpha <= 0 ? 0 : alpha);
  }
  return out;
};
const pa = premultiplied(stored.a);
const pb = premultiplied(stored.b);
const texel = (values, x, y) => values.slice((y * TW + x) * 4, (y * TW + x) * 4 + 4);
// T5 output: straight RGB over the unrounded coverage; coverage <= 0 is (0, 0, 0, 0).
const straight = ([r, g, b, a]) => (roundHalf(a) <= 0 ? [0, 0, 0, 0] : [r / a, g / a, b / a, roundHalf(a)]);
const hdrCases = (id) => transitions.cases.filter((c) => c.id === id && c.domain === 'hdr' && c.outcome === 'rendered');

/** The page equation at texel centres, on premultiplied A and B; null where the page needs filtering. */
function transitionReference(c, x, y) {
  const p = c.progress;
  const A = texel(pa, x, y);
  const B = texel(pb, x, y);
  const u = (x + 0.5) / TW;
  const v = (y + 0.5) / TH;
  switch (c.id) {
    case 'dissolve': {
      const t = 0.5 - 0.5 * Math.cos(p * Math.PI);
      return straight(A.map((value, k) => mix(value, B[k], t)));
    }
    case 'additiveDissolve': {
      const flash = Math.sin(p * Math.PI) * 0.22;
      return straight([0, 1, 2].map((k) => A[k] * (1 - p) + B[k] * p + (A[k] + B[k]) * flash).concat(mix(A[3], B[3], p)));
    }
    case 'nonAdditiveDissolve': {
      const neutral = [0, 1, 2].map((k) => mix(A[k], B[k], p));
      const luma = 0.2126 * neutral[0] + 0.7152 * neutral[1] + 0.0722 * neutral[2];
      const w = Math.sin(p * Math.PI) * 0.18;
      return straight(neutral.map((n) => mix(n, Math.min(n, luma + 0.18), w)).concat(mix(A[3], B[3], p)));
    }
    case 'dipToColorDissolve': {
      const colour = (c.properties?.color ?? [0, 0, 0]).map(srgbDecode).concat(1);
      const result = p < 0.5
        ? A.map((value, k) => mix(value, colour[k], smoothstep(0, 0.5, p)))
        : colour.map((value, k) => mix(value, B[k], smoothstep(0.5, 1, p)));
      return straight(result);
    }
    case 'wipe': {
      const sweep = { 'from-left': u, 'from-right': 1 - u, 'from-top': v, 'from-bottom': 1 - v }[c.direction];
      if (Math.abs(sweep - p) < 1e-4) return null; // the rasteriser's coordinate decides an exact tie
      return straight(sweep <= p ? B : A);
    }
    case 'slide': {
      // Horizontal pushes move by whole texels on a 48-wide frame; vertical ones filter.
      const shift = p * TW;
      if (c.direction === 'from-left') return straight(u <= p ? texel(pb, x - shift + TW, y) : texel(pa, x - shift, y));
      if (c.direction === 'from-right') return straight(u >= 1 - p ? texel(pb, x - (TW - shift), y) : texel(pa, x + shift, y));
      return null;
    }
    default: return null;
  }
}

test('linear HDR transitions: endpoints are the clips, straight, with binary16 coverage', () => {
  for (const id of LINEAR_HDR_TRANSITIONS) {
    for (const c of hdrCases(id).filter((x) => x.progress === 0 || x.progress === 1)) {
      const got = output(c);
      const source = c.progress === 0 ? pa : pb;
      for (let i = 0; i < TW * TH; i++) {
        const want = straight(source.slice(i * 4, i * 4 + 4));
        want.forEach((value, k) => assert(within(got[i * 4 + k], value), `${c.name}: pixel ${i} channel ${k} ${got[i * 4 + k]} != ${value}`));
      }
    }
  }
});

test('linear HDR transitions: the mix and selection pages reproduce the goldens at texel centres', () => {
  let checked = 0;
  for (const id of ['dissolve', 'additiveDissolve', 'nonAdditiveDissolve', 'dipToColorDissolve', 'wipe', 'slide']) {
    for (const c of hdrCases(id)) {
      const got = output(c);
      for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
        const want = transitionReference(c, x, y);
        if (!want) continue;
        const at = (y * TW + x) * 4;
        want.forEach((value, k) => assert(within(got[at + k], value), `${c.name}: (${x}, ${y}) channel ${k} ${got[at + k]} != ${value}`));
        checked++;
      }
    }
  }
  assert(checked > 40000, `only ${checked} pixels checked`);
});

test('linear HDR transitions keep highlights and signed light, and hidden RGB never shows', () => {
  for (const id of LINEAR_HDR_TRANSITIONS) {
    const cases = hdrCases(id);
    assert(cases.length >= 5, `${id}: HDR goldens missing`);
    let above = false;
    let below = false;
    for (const c of cases) {
      const got = output(c);
      for (let k = 0; k < got.length; k++) {
        if (k % 4 === 3) { assert(got[k] >= 0 && got[k] <= 1, `${c.name}: coverage ${got[k]}`); continue; }
        // The visible inputs span [-0.5, 8]; the hidden 50 and 40 under zero alpha must not leak.
        assert(got[k] >= -0.5 - 0.004 && got[k] <= 8 * 1.002, `${c.name}: channel ${k} = ${got[k]}`);
        above ||= got[k] > 1;
        below ||= got[k] < 0;
      }
    }
    assert(above && below, `${id}: light above reference white or a signed component did not survive`);
  }
});

// ---- grading effects -----------------------------------------------------------------------
const { width: EW, height: EH } = EFFECT_SIZE;
const sdrIn = effectSdrInput();
const hdrEffectIn = effectHdrInput().map(roundHalf);
// Pixels whose HDR input is exactly the decoded SDR input (all but the highlights placed on it).
const MODIFIED = new Set([0, 1, EW - 1]);
for (let y = 2; y <= 5; y++) for (let x = 2; x <= 5; x++) MODIFIED.add(y * EW + x);
const WHITE = new Set([...MODIFIED].filter((i) => i >= 2 * EW));
const pairs = (id) => {
  const sdr = new Map(effects.cases.filter((c) => c.id === id && c.domain === 'sdr').map((c) => [c.name.slice(`${id}/sdr/`.length), c]));
  return effects.cases.filter((c) => c.id === id && c.domain === 'hdr' && c.outcome === 'rendered')
    .map((c) => ({ hdr: c, sdr: sdr.get(c.name.slice(`${id}/hdr/`.length)) }));
};

test('HDR curves and LUT: the SDR table on the extended sRGB encoding, offset kept outside [0, 1]', () => {
  for (const id of ['gpu-curves', 'gpu-lut']) {
    const list = pairs(id);
    assert(list.length >= 4 && list.every((x) => x.sdr), `${id}: paired goldens`);
    for (const { hdr, sdr } of list) {
      const got = output(hdr);
      const table = output(sdr);
      for (let i = 0; i < EW * EH; i++) {
        if (MODIFIED.has(i) && !WHITE.has(i)) continue;
        for (let k = 0; k < 4; k++) {
          const at = i * 4 + k;
          // White square: SDR input 1 is the clamp of the encoded 4.0; the encoded excess is kept.
          const want = k === 3 ? table[at] : srgbDecode(table[at] + (WHITE.has(i) ? srgbEncode(hdrEffectIn[at]) - 1 : 0));
          // A channel's table value moves by under 1/255 when its coordinate moves by a rounding step.
          assert(within(got[at], want, 0.002 * Math.abs(want) + 0.001), `${hdr.name}: pixel ${i} channel ${k} ${got[at]} != ${want}`);
        }
      }
    }
  }
});

test('HDR chroma key and colour wheels: the SDR result decoded, for SDR pixels', () => {
  for (const id of ['gpu-chroma-key', 'gpu-color-wheels']) {
    const list = pairs(id);
    assert(list.length >= 5 && list.every((x) => x.sdr), `${id}: paired goldens`);
    let compared = 0;
    for (const { hdr, sdr } of list) {
      const got = output(hdr);
      const encoded = output(sdr);
      for (let i = 0; i < EW * EH; i++) {
        if (MODIFIED.has(i)) continue;
        const rgb = encoded.slice(i * 4, i * 4 + 3);
        // The wheels clamp in SDR and keep their range in HDR: compare where SDR did not clamp.
        if (id === 'gpu-color-wheels' && !rgb.every((v) => v > 0.002 && v < 0.998)) continue;
        for (let k = 0; k < 4; k++) {
          const at = i * 4 + k;
          const want = k === 3 ? encoded[at] : srgbDecode(encoded[at]);
          assert(within(got[at], want, 0.002 * Math.abs(want)), `${hdr.name}: pixel ${i} channel ${k} ${got[at]} != ${want}`);
          compared++;
        }
      }
    }
    assert(compared > 2000, `${id}: only ${compared} channels compared`);
  }
  // The pages' HDR arithmetic on every pixel, highlights and signed light included.
  for (const [id, reference] of [['gpu-chroma-key', chromaKeyReference], ['gpu-color-wheels', colorWheelsReference]]) {
    for (const { hdr } of pairs(id)) {
      const got = output(hdr);
      reference(hdrEffectIn, hdr.params).forEach((value, k) =>
        assert(within(got[k], value, 0.002 * Math.abs(value)), `${hdr.name}: channel ${k} ${got[k]} != ${value} (page)`));
    }
  }
  // Grey highlights are not green or blue: the key leaves the 4.0 square opaque and unchanged.
  const key = output(effects.cases.find((c) => c.name === 'gpu-chroma-key/hdr/default'));
  for (const i of WHITE) for (let k = 0; k < 4; k++) assert(within(key[i * 4 + k], hdrEffectIn[i * 4 + k]), `chroma key highlight ${i}`);
});

test('HDR sharpen: the unsharp mask of the page on premultiplied linear light', () => {
  const cases = effects.cases.filter((c) => c.id === 'gpu-sharpen' && c.domain === 'hdr');
  assert.equal(cases.length, 3);
  for (const c of cases) {
    const got = output(c);
    const want = sharpenReference(hdrEffectIn, EW, EH, c.params, roundHalf);
    want.forEach((value, k) => assert(within(got[k], value), `${c.name}: channel ${k} ${got[k]} != ${value}`));
    assert(got.some((v, k) => k % 4 !== 3 && v < 0), `${c.name}: overshoot below zero keeps its sign`);
  }
  // Hidden RGB (1, 0, 1) under alpha 0 at (15, 11) must not reach its visible neighbours.
  const plain = output(cases[0]);
  assert.deepEqual(plain.slice(-4), [0, 0, 0, 0]);
  assert.equal(sdrIn.at(-1), 0);
});

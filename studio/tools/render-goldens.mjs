// Render goldens for the Studio effect and transition spec (studio/spec, the native-app contract).
// Engine-free: the inputs, the case list, the encodings and the comparison rule are defined here
// from the parameter catalogue alone, so a native client can rebuild every case without the engine.
// render-goldens.browser.mjs renders the cases through the real engine and writes the outputs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const GOLDENS_FORMAT = 'frameleaf-studio-render-goldens';
export const GOLDENS_VERSION = 1;
export const EFFECT_SIZE = { width: 16, height: 12 };
export const TRANSITION_SIZE = { width: 48, height: 27 };
export const TRANSITION_PROGRESS = [0.25, 0.5, 0.75];
export const TRANSITION_ENDPOINTS = [0, 1];
export const EFFECT_CLOCKS = [0.75, 2.5];
// The 16 effects that render in linear HDR (effect-hdr-semantics.json); every other effect is refused.
export const LINEAR_HDR_EFFECTS = [
  'gpu-brightness', 'gpu-contrast', 'gpu-exposure', 'gpu-saturation', 'gpu-temperature', 'gpu-vibrance',
  'gpu-grayscale', 'gpu-sepia', 'gpu-invert', 'gpu-box-blur', 'gpu-gaussian-blur', 'gpu-motion-blur',
  'gpu-pixelate', 'gpu-twirl', 'gpu-wave', 'gpu-bulge',
];
// Transitions drawn by the GPU transition pipeline; the rest are drawn with Canvas 2D.
export const GPU_TRANSITIONS = [
  'fade', 'wipe', 'slide', 'flip', 'clockWipe', 'iris', 'dissolve', 'additiveDissolve', 'blurDissolve',
  'dipToColorDissolve', 'nonAdditiveDissolve', 'smoothCut', 'sparkles', 'glitch', 'pixelate', 'chromatic',
  'radialBlur', 'liquidDistort', 'lensWarpZoom', 'lightLeakBurn', 'filmGateSlip',
];

const q8 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255) / 255;

/**
 * Effect input, 16x12, straight alpha, values k/255 (then stored as binary16):
 *   base       R = x/15, G = y/11, B = ((x + 2y) mod 7)/6
 *   x 2..5, y 2..5     white square (hard edges)
 *   x 10..13, y 2..5   2x2 blocks: red, green / blue, yellow
 *   x 0..15, y 7       grey ramp x/15
 *   x >= 12, y >= 8    alpha 0.5; pixel (15, 11) alpha 0 with RGB (1, 0, 1)
 */
export function effectSdrInput() {
  const { width: W, height: H } = EFFECT_SIZE;
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let rgb = [x / 15, y / 11, ((x + 2 * y) % 7) / 6];
      let a = 1;
      if (x >= 2 && x <= 5 && y >= 2 && y <= 5) rgb = [1, 1, 1];
      if (x >= 10 && x <= 13 && y >= 2 && y <= 5) {
        const block = (x >= 12 ? 1 : 0) + (y >= 4 ? 2 : 0);
        rgb = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]][block];
      }
      if (y === 7) rgb = [x / 15, x / 15, x / 15];
      if (x >= 12 && y >= 8) a = 0.5;
      if (x === 15 && y === 11) { rgb = [1, 0, 1]; a = 0; }
      out.push(...rgb.map(q8), q8(a));
    }
  }
  return out;
}

/**
 * Linear HDR effect input: the SDR input decoded with the sRGB EOTF, then
 *   white square x 2..5, y 2..5 = 4.0 (about 812 cd/m2), pixel (0, 0) = (-0.25, 0.5, 1.25),
 *   pixel (1, 0) = (8, 2, 0.5), pixel (15, 0) = (1.5, 1.5, 1.5).
 */
export function effectHdrInput() {
  const { width: W } = EFFECT_SIZE;
  const decode = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const sdr = effectSdrInput();
  const out = sdr.map((v, i) => (i % 4 === 3 ? v : decode(v)));
  const set = (x, y, rgb) => { const at = (y * W + x) * 4; out.splice(at, 3, ...rgb); };
  for (let y = 2; y <= 5; y++) for (let x = 2; x <= 5; x++) set(x, y, [4, 4, 4]);
  set(0, 0, [-0.25, 0.5, 1.25]);
  set(1, 0, [8, 2, 0.5]);
  set(15, 0, [1.5, 1.5, 1.5]);
  return out;
}

/**
 * Transition inputs, W x H = 48 x 27, opaque, values k/255 (clamped to [0, 1]):
 *   A (outgoing) R = x/(W-1), G = y/(H-1) + 0.25 where floor(x/4) + floor(y/4) is odd, B = 0.2
 *   B (incoming) R = 0.1, G = ((x + y) mod 5)/4, B = 0.9 - 0.6 y/(H-1); white 1-px lines on x = W/2 - 1 and y = floor(H/2)
 */
export function transitionInputs() {
  const { width: W, height: H } = TRANSITION_SIZE;
  const a = [];
  const b = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const checker = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 1 ? 0.25 : 0;
      a.push(q8(x / (W - 1)), q8(y / (H - 1) + checker), q8(0.2), 1);
      const cross = x === W / 2 - 1 || y === Math.floor(H / 2);
      b.push(...(cross ? [1, 1, 1] : [q8(0.1), q8(((x + y) % 5) / 4), q8(0.9 - 0.6 * (y / (H - 1)))]), 1);
    }
  }
  return { a, b };
}

// A size-3 3D LUT (red fastest, then green, then blue), rgba8, base64; deliberately non-identity.
export function lutFixture() {
  const bytes = [];
  for (let b = 0; b < 3; b++) for (let g = 0; g < 3; g++) for (let r = 0; r < 3; r++) {
    bytes.push(Math.round(255 * (r / 2) ** 2), Math.round(255 * (1 - g / 2)), Math.round(255 * (b / 2 + r / 2) / 2), 255);
  }
  return { lutName: 'fixture', lutSize: '3', lutData: Buffer.from(bytes).toString('base64') };
}

// Extra effect cases for parameters the one-at-a-time sweep cannot reach meaningfully.
// `params` are laid over the defaults; `omit` removes keys so the stored parameter object lacks
// them (README C9: a graph written by another client can lack keys); `clock` sets the effect
// clock of a temporal effect. A `null` value is a key that is present but not a finite number.
export const EFFECT_EXTRA_CASES = {
  'gpu-curves': [
    { name: 'points', params: { masterPoints: '[[0,0],[0.3,0.15],[0.7,0.9],[1,1]]', redPoints: '[[0,0.1],[1,0.9]]' } },
    { name: 'points-invalid-json', params: { masterPoints: 'not json' } },
    // The four master keys are present but none is a finite number: C9 draws each at its default (two-point mode).
    { name: 'master-keys-not-finite', params: { masterShadowX: null, masterShadowY: null, masterHighlightX: null, masterHighlightY: null } },
    // One finite key among non-finite ones.
    { name: 'master-one-finite-key', params: { masterShadowX: null, masterShadowY: 0.5, masterHighlightX: null, masterHighlightY: null } },
    // The four master keys are absent: legacy mode reads the undeclared sliders.
    { name: 'master-keys-absent-legacy', params: { shadows: 40, midtones: -20, highlights: 30, contrast: 25 },
      omit: ['masterShadowX', 'masterShadowY', 'masterHighlightX', 'masterHighlightY'] },
    { name: 'red-keys-absent-legacy', params: { red: 60 }, omit: ['redShadowX', 'redShadowY', 'redHighlightX', 'redHighlightY'] },
  ],
  'gpu-gradient-map': [{ name: 'custom-stops', params: { preset: 'custom', customStops: '#ff0000, #00ff00, #0000ff' } }],
  'gpu-lut': [
    { name: 'fixture-lut', params: lutFixture() },
    { name: 'fixture-lut-half', params: { ...lutFixture(), intensity: 0.5 } },
  ],
  'gpu-ascii': [{ name: 'charSet=custom', params: { charSet: 'custom', customChars: ' .:#' } }],
  'gpu-temperature': [{ name: 'temperature=-0.375,tint=0.625', params: { temperature: -0.375, tint: 0.625 } }],
  // The shutter rule of the page: an absent shutterAngle is 360 when the stored object has any
  // other key, declared or not, and 180 only when the object is empty.
  'gpu-motion-blur': [
    { name: 'shutterAngle-absent', params: {}, omit: ['shutterAngle'] },
    { name: 'only-an-undeclared-key', params: { note: 1 }, omit: ['amount', 'angle', 'samples', 'shutterAngle'] },
    { name: 'empty-parameters', params: {}, omit: ['amount', 'angle', 'samples', 'shutterAngle'] },
    { name: 'shutterAngle-not-finite', params: { shutterAngle: null } },
  ],
  // The 16 x 12 frame is one block at the default block size. These cases use the smallest
  // block (2 x 1.5 blocks) so that blocks glitch, shift, split and corrupt.
  'gpu-block-glitch': [
    { name: 'coverage=1,blockSize=8', params: { coverage: 1, blockSize: 8 } },
    { name: 'coverage=1,blockSize=8,intensity=1@t=0.3', params: { coverage: 1, blockSize: 8, intensity: 1 }, clock: 0.3 },
    { name: 'coverage=1,blockSize=8,intensity=1@t=1.1', params: { coverage: 1, blockSize: 8, intensity: 1 }, clock: 1.1 },
    { name: 'coverage=1,blockSize=8,intensity=1@t=2.5', params: { coverage: 1, blockSize: 8, intensity: 1 }, clock: 2.5 },
    { name: 'coverage=0.5,blockSize=8@t=1.6', params: { coverage: 0.5, blockSize: 8 }, clock: 1.6 },
    { name: 'coverage=1,blockSize=8,speed=4@t=2.5', params: { coverage: 1, blockSize: 8, speed: 4 }, clock: 2.5 },
    { name: 'coverage=1@t=8.75', params: { coverage: 1 }, clock: 8.75 },
  ],
};

// Extra transition cases: properties the sweep does not reach, at p = 0.5 in the first direction.
export const TRANSITION_EXTRA_CASES = {
  // The tap count: the largest blur separates 12 taps from its neighbours, and the hidden
  // `samples` property (T4) is read when a graph carries it.
  radialBlur: [
    { name: 'blurStrength=3', properties: { blurStrength: 3 } },
    { name: 'blurStrength=3,samples=5', properties: { blurStrength: 3, samples: 5 } },
  ],
};

const COLOR_VARIANT = '#3366cc';

/** One case per parameter: numbers halfway from the default towards max (or min), each other select option, flipped flags, a colour. */
export function effectCases(catalogue) {
  const cases = [];
  for (const effect of catalogue.effects) {
    const defaults = Object.fromEntries(effect.parameters.map((p) => [p.name, p.default]));
    const hdr = LINEAR_HDR_EFFECTS.includes(effect.id);
    const list = [{ name: 'default', params: {} }];
    for (const p of effect.parameters) {
      if (p.type === 'number') {
        const target = p.max !== p.default ? p.max : p.min;
        if (target === p.default) continue;
        const value = Number((p.default + (target - p.default) / 2).toPrecision(6));
        list.push({ name: `${p.name}=${value}`, params: { [p.name]: value } });
      } else if (p.type === 'select') {
        for (const option of p.options) if (option !== p.default) list.push({ name: `${p.name}=${option}`, params: { [p.name]: option } });
      } else if (p.type === 'boolean') {
        list.push({ name: `${p.name}=${!p.default}`, params: { [p.name]: !p.default } });
      } else if (p.type === 'color') {
        list.push({ name: `${p.name}=${COLOR_VARIANT}`, params: { [p.name]: COLOR_VARIANT } });
      }
    }
    list.push(...(EFFECT_EXTRA_CASES[effect.id] ?? []));
    for (const entry of list) {
      const params = { ...defaults, ...entry.params };
      for (const key of entry.omit ?? []) delete params[key];
      const clocks = entry.clock !== undefined ? [entry.clock] : effect.temporal && entry.name === 'default' ? EFFECT_CLOCKS : [EFFECT_CLOCKS[0]];
      for (const clock of clocks) {
        const suffix = effect.temporal && entry.name === 'default' ? `@t=${clock}` : '';
        cases.push({ name: `${effect.id}/sdr/${entry.name}${suffix}`, id: effect.id, domain: 'sdr', params, clock });
        if (hdr) cases.push({ name: `${effect.id}/hdr/${entry.name}${suffix}`, id: effect.id, domain: 'hdr', params, clock });
      }
    }
    if (!hdr) cases.push({ name: `${effect.id}/hdr/refused`, id: effect.id, domain: 'hdr', params: defaults, clock: EFFECT_CLOCKS[0], refused: true });
  }
  return cases;
}

export function transitionCases(catalogue) {
  const cases = [];
  for (const t of catalogue.transitions) {
    const directions = t.directions?.length ? t.directions : [null];
    const route = GPU_TRANSITIONS.includes(t.id) ? 'gpu' : 'canvas';
    const tag = (d) => (d ? `/${d}` : '');
    for (const direction of directions) {
      for (const progress of TRANSITION_PROGRESS) {
        cases.push({ name: `${t.id}${tag(direction)}/p=${progress}`, id: t.id, route, direction, progress, properties: null });
      }
    }
    for (const progress of TRANSITION_ENDPOINTS) {
      cases.push({ name: `${t.id}${tag(directions[0])}/p=${progress}`, id: t.id, route, direction: directions[0], progress, properties: null });
    }
    for (const p of t.parameters ?? []) {
      let value;
      if (p.type === 'number') value = Number((p.default + ((p.max !== p.default ? p.max : p.min) - p.default) / 2).toPrecision(6));
      else if (p.type === 'color') value = [0.2, 0.4, 0.8];
      else continue;
      cases.push({ name: `${t.id}${tag(directions[0])}/p=0.5/${p.name}=${JSON.stringify(value)}`, id: t.id, route, direction: directions[0], progress: 0.5, properties: { [p.name]: value } });
    }
    for (const extra of TRANSITION_EXTRA_CASES[t.id] ?? []) {
      cases.push({ name: `${t.id}${tag(directions[0])}/p=0.5/${extra.name}`, id: t.id, route, direction: directions[0], progress: 0.5, properties: extra.properties });
    }
  }
  return cases;
}

// Progress curve fixtures: (localFrame, duration, timing, bezier) -> progress, computed by the engine.
export const PROGRESS_CURVE_CASES = (() => {
  const out = [];
  const bezier = [null, { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }, { x1: 0.1, y1: 0.7, x2: 0.3, y2: 1.2 }];
  for (const duration of [1, 2, 10, 30]) {
    for (const timing of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier', 'unknown']) {
      for (const points of timing === 'cubic-bezier' ? bezier : [null]) {
        for (const localFrame of [...new Set([0, 1, Math.floor(duration / 3), Math.floor(duration / 2), duration - 1])]) {
          out.push({ localFrame, duration, timing, bezierPoints: points });
        }
      }
    }
  }
  return out;
})();

// ---- binary16 and buffer encodings (no Float16Array dependency) ----
export function toHalfBits(value) {
  const f32 = new Float32Array([value]);
  const bits = new Uint32Array(f32.buffer)[0];
  const sign = (bits >>> 16) & 0x8000;
  const exp = (bits >>> 23) & 0xff;
  let mant = bits & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (half & 1))) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++;
  return sign | half;
}
export function fromHalfBits(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}
export const roundHalf = (v) => fromHalfBits(toHalfBits(v));

// Buffers are RGBA, row-major from the top-left pixel, compressed with raw DEFLATE (RFC 1951,
// no zlib header) and base64-encoded. f16le: IEEE binary16 little-endian per channel;
// rgba8: one byte per channel, value = byte / 255.
export const ENCODINGS = ['f16le-deflate-base64', 'rgba8-deflate-base64'];
export function encodeBuffer(values, encoding) {
  let buf;
  if (encoding === 'f16le-deflate-base64') {
    buf = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => buf.writeUInt16LE(toHalfBits(v), i * 2));
  } else {
    assert.equal(encoding, 'rgba8-deflate-base64');
    buf = Buffer.from(values.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)));
  }
  return deflateRawSync(buf, { level: 9 }).toString('base64');
}
export function decodeBuffer(data, encoding) {
  const buf = inflateRawSync(Buffer.from(data, 'base64'));
  if (encoding === 'f16le-deflate-base64') return Array.from({ length: buf.length / 2 }, (_, i) => fromHalfBits(buf.readUInt16LE(i * 2)));
  assert.equal(encoding, 'rgba8-deflate-base64');
  return Array.from(buf, (v) => v / 255);
}
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Comparison rule. A native render passes a case when
 *   - every channel is finite and the buffer has W x H x 4 channels,
 *   - at most `outliers` channels differ from the golden by more than max(abs, relative x |golden|),
 *   - the mean absolute difference over all channels is at most `meanAbs`.
 * Alpha is compared like RGB. Tolerances are measured, not guessed: the generator renders every
 * case on the canonical software WebGPU backend (SwiftShader, CPU Canvas 2D) and on a hardware
 * backend (Metal, GPU Canvas 2D) and sets, from the cross-backend differences d,
 *   abs      = max(floor, 1.5 x the largest d among channels with d <= 0.03) when at most 10 % of
 *              channels have d > 0.03; otherwise max(floor, 1.5 x max d), capped at 0.25
 *   outliers = 2 x the channels that bound still misses
 *   meanAbs  = max(floor / 2, 1.5 x mean d)
 * HASH_DRIVEN ids are always `statistical`, with at least 10 % outliers and meanAbs 0.02.
 * with floor 2/255 for SDR and 0.004 (plus 0.2 % relative) for linear HDR.
 * `class` names what the case pins: `pixel` (every channel within 0.03), `edge` (outliers only on
 * anti-aliased or sub-pixel edges, at most 10 % of channels), or `statistical` (the result depends
 * on GPU transcendental precision or the platform rasteriser; only its structure and mean are pinned).
 */
export const TOLERANCE_FLOOR = { sdr: 2 / 255, hdr: 0.004 };
export function compareCase(golden, actual) {
  const { abs, outliers, relative = 0, meanAbs } = golden.tolerance;
  if (actual.length !== golden.expected.length) return { pass: false, missed: Infinity, worst: Infinity, mean: Infinity };
  let missed = 0;
  let worst = 0;
  let total = 0;
  golden.expected.forEach((want, i) => {
    const got = actual[i];
    assert(Number.isFinite(got), `${golden.name}: channel ${i} is not finite`);
    const diff = Math.abs(got - want);
    if (diff > Math.max(abs, relative * Math.abs(want))) missed++;
    worst = Math.max(worst, diff);
    total += diff;
  });
  const mean = total / golden.expected.length;
  return { pass: actual.length === golden.expected.length && missed <= outliers && mean <= meanAbs, missed, worst, mean };
}

const sig = (v) => Number(v.toPrecision(3));
// Ids whose pixels are driven by HASH at large arguments (README C6): their cases are always
// `statistical`, with at least 10 % outlier channels and a mean bound of at least 0.02.
export const HASH_DRIVEN = [
  'gpu-grain', 'gpu-color-glitch', 'gpu-block-glitch', 'gpu-vhs', 'gpu-halftone', 'gpu-fluted-glass',
  'glitch', 'sparkles', 'lightLeakBurn', 'filmGateSlip', 'smoothCut', 'liquidDistort',
];
export function deriveTolerance(domain, canonical, other, id) {
  const floor = TOLERANCE_FLOOR[domain];
  const relative = domain === 'hdr' ? 0.002 : 0;
  const n = canonical.length;
  let abs = floor;
  let outliers = 0;
  let measured = null;
  let mean = 0;
  if (other) {
    const diffs = canonical.map((v, i) => Math.abs(v - other[i]));
    const worst = Math.max(0, ...diffs);
    mean = diffs.reduce((a, b) => a + b, 0) / n;
    measured = { max: sig(worst), mean: Number(mean.toPrecision(3)) };
    // Sparse divergence (a few channels on edges or exact level boundaries): keep a tight bound
    // for every other channel and count the divergent ones as outliers.
    const big = diffs.map((d, i) => d > Math.max(0.03, relative * Math.abs(canonical[i])));
    const bound = (limit) => Math.max(floor, sig(limit * 1.5));
    abs = big.filter(Boolean).length <= 0.1 * n
      ? bound(Math.max(0, ...diffs.filter((_, i) => !big[i])))
      : Math.min(0.25, bound(worst));
    outliers = 2 * canonical.filter((v, i) => diffs[i] > Math.max(abs, relative * Math.abs(v))).length;
  }
  let meanAbs = Math.max(floor / 2, sig(mean * 1.5));
  let cls = abs <= 0.03 && outliers === 0 ? 'pixel' : outliers <= 0.1 * n && meanAbs <= 0.02 ? 'edge' : 'statistical';
  if (HASH_DRIVEN.includes(id)) {
    cls = 'statistical';
    outliers = Math.max(outliers, Math.ceil(0.1 * n));
    meanAbs = Math.max(meanAbs, 0.02);
  }
  return { class: cls, abs, relative, outliers, meanAbs, measured };
}

/** Structural and coverage validation of a goldens file against the catalogue (engine-free). */
export function validateGoldens(kind, goldens, catalogue) {
  assert.equal(goldens.format, GOLDENS_FORMAT);
  assert.equal(goldens.version, GOLDENS_VERSION);
  assert.equal(goldens.kind, kind);
  const expectedCases = kind === 'effects' ? effectCases(catalogue) : transitionCases(catalogue);
  assert.deepEqual(goldens.cases.map((c) => c.name), expectedCases.map((c) => c.name), `${kind}: cases must be complete and ordered`);
  const inputs = kind === 'effects'
    ? { sdr: effectSdrInput(), hdr: effectHdrInput() }
    : transitionInputs();
  for (const [name, values] of Object.entries(inputs)) {
    const stored = goldens.inputs[name];
    assert(stored, `${kind}: input ${name} missing`);
    const encoding = stored.encoding;
    const decoded = decodeBuffer(stored.data, encoding);
    const want = encoding === 'f16le-deflate-base64' ? values.map(roundHalf) : values.map((v) => Math.round(v * 255) / 255);
    assert.equal(decoded.length, want.length, `${kind}: input ${name} size`);
    decoded.forEach((v, i) => assert(Object.is(v, want[i]) || Math.abs(v - want[i]) < 1e-12, `${kind}: input ${name}[${i}] is not the documented formula`));
    assert.equal(stored.sha256, sha256(stored.data));
  }
  let channels = 0;
  goldens.cases.forEach((c, index) => {
    const spec = expectedCases[index];
    assert.equal(c.id, spec.id);
    if (kind === 'effects') {
      assert.equal(c.domain, spec.domain);
      assert.deepEqual(c.params, spec.params, `${c.name}: params`);
      assert.equal(c.clock, spec.clock);
      if (spec.refused) {
        assert.equal(c.outcome, 'refused', `${c.name}: must be refused in HDR`);
        return;
      }
    } else {
      assert.equal(c.route, spec.route);
      assert.equal(c.direction, spec.direction);
      assert.equal(c.progress, spec.progress);
      assert.deepEqual(c.properties, spec.properties);
    }
    assert.equal(c.outcome, 'rendered', `${c.name}: not rendered`);
    const values = decodeBuffer(c.output.data, c.output.encoding);
    const size = kind === 'effects' ? EFFECT_SIZE : TRANSITION_SIZE;
    assert.equal(values.length, size.width * size.height * 4, `${c.name}: output size`);
    assert(values.every(Number.isFinite), `${c.name}: non-finite output`);
    assert(c.tolerance && c.tolerance.abs > 0 && c.tolerance.abs <= 0.25 && Number.isInteger(c.tolerance.outliers) && c.tolerance.meanAbs > 0 && ['pixel', 'edge', 'statistical'].includes(c.tolerance.class), `${c.name}: tolerance`);
    assert(ENCODINGS.includes(c.output.encoding), `${c.name}: encoding`);
    // Self-consistency: the stored output passes its own rule.
    assert(compareCase({ ...c, expected: values }, values).pass);
    channels += values.length;
  });
  return { cases: goldens.cases.length, channels };
}

/**
 * spec/index.json from the catalogue and the goldens. `status` (`full` or `partial`) and
 * `notSpecifiable` are editorial and kept from the previous index; counts are recomputed.
 */
export function buildIndex(catalogue, effectGoldens, transitionGoldens, previous = { effects: [], transitions: [] }) {
  const counts = (cases) => ({
    cases: cases.length,
    pixel: cases.filter((c) => c.tolerance?.class === 'pixel').length,
    edge: cases.filter((c) => c.tolerance?.class === 'edge').length,
    statistical: cases.filter((c) => c.tolerance?.class === 'statistical').length,
    refused: cases.filter((c) => c.outcome === 'refused').length,
  });
  const keep = (kind, id) => previous[kind]?.find((x) => x.id === id) ?? {};
  return {
    format: 'frameleaf-studio-render-spec-index',
    version: 1,
    contract: 'studio/spec/README.md',
    engine: { name: 'freecut', revision: catalogue.engine.revision },
    effects: catalogue.effects.map((e) => {
      const old = keep('effects', e.id);
      return {
        id: e.id, category: e.category, temporal: Boolean(e.temporal), spec: `effects/${e.id}.md`,
        hdr: LINEAR_HDR_EFFECTS.includes(e.id) ? 'linear-display-bt709-v1' : 'refused',
        status: old.status ?? 'full', notSpecifiable: old.notSpecifiable ?? [],
        goldens: counts(effectGoldens.cases.filter((c) => c.id === e.id)),
      };
    }),
    transitions: catalogue.transitions.map((t) => {
      const old = keep('transitions', t.id);
      return {
        id: t.id, category: t.category, directions: t.directions ?? [], spec: `transitions/${t.id}.md`,
        route: GPU_TRANSITIONS.includes(t.id) ? 'gpu' : 'canvas', hdr: 'refused',
        status: old.status ?? 'full', notSpecifiable: old.notSpecifiable ?? [],
        goldens: counts(transitionGoldens.cases.filter((c) => c.id === t.id)),
      };
    }),
  };
}

/** The coverage section of spec/README.md, between its index markers, rendered from index.json. */
export function renderIndexMarkdown(index, progressValues) {
  const sum = (list, key) => list.reduce((total, x) => total + x.goldens[key], 0);
  const ids = (list) => list.filter((x) => x.status === 'partial').map((x) => `\`${x.id}\``).join(', ');
  const E = index.effects;
  const T = index.transitions;
  const counts = (x) => `${x.goldens.pixel} / ${x.goldens.edge} / ${x.goldens.statistical}`;
  const lines = [
    `- **Effects:** ${E.length} specified, ${E.filter((x) => x.status === 'full').length} fully and ${E.filter((x) => x.status === 'partial').length} partly (${ids(E)}). Goldens: ${sum(E, 'cases')} cases, of which ${sum(E, 'pixel')} are pixel, ${sum(E, 'edge')} edge and ${sum(E, 'statistical')} statistical, plus ${sum(E, 'refused')} HDR refusals.`,
    `- **Transitions:** ${T.length} specified, ${T.filter((x) => x.status === 'full').length} fully and ${T.filter((x) => x.status === 'partial').length} partly (${ids(T)}); ${T.filter((x) => x.route === 'gpu').length} on the GPU route and ${T.filter((x) => x.route === 'canvas').length} on Canvas 2D. Goldens: ${sum(T, 'cases')} cases, of which ${sum(T, 'pixel')} are pixel, ${sum(T, 'edge')} edge and ${sum(T, 'statistical')} statistical, plus ${progressValues} progress-curve values.`,
    '',
    '| Effect | Category | HDR | Status | Goldens (pixel / edge / statistical) |',
    '| --- | --- | --- | --- | --- |',
    ...E.map((x) => `| [\`${x.id}\`](${x.spec}) | ${x.category}${x.temporal ? ', temporal' : ''} | ${x.hdr === 'refused' ? 'refused' : 'linear'} | ${x.status} | ${counts(x)} |`),
    '',
    '| Transition | Category | Route | Status | Goldens (pixel / edge / statistical) |',
    '| --- | --- | --- | --- | --- |',
    ...T.map((x) => `| [\`${x.id}\`](${x.spec}) | ${x.category} | ${x.route === 'gpu' ? 'GPU' : 'Canvas 2D'} | ${x.status} | ${counts(x)} |`),
  ];
  return `${INDEX_START}\n${lines.join('\n')}\n${INDEX_END}`;
}
export const INDEX_START = '<!-- index:start (generated by render-goldens.browser.mjs --write) -->';
export const INDEX_END = '<!-- index:end -->';
export function replaceIndexMarkdown(readme, markdown) {
  const start = readme.indexOf(INDEX_START);
  const end = readme.indexOf(INDEX_END);
  assert(start >= 0 && end > start, 'spec/README.md lacks its index markers');
  return readme.slice(0, start) + markdown + readme.slice(end + INDEX_END.length);
}

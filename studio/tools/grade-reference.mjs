// Independent references for the grading effects in linear HDR (FL-1556), written from
// studio/spec (README C4 and the gpu-curves, gpu-lut, gpu-color-wheels, gpu-chroma-key and
// gpu-sharpen pages), never from engine source. Pixels are flat RGBA arrays, straight alpha,
// linear display-referred BT.709 with 1.0 = reference white.

/** H5, odd extension: encoded to linear. */
export const srgbDecode = (v) => {
  const a = Math.abs(v);
  return Math.sign(v) * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4);
};
/** H5, odd extension: linear to encoded. */
export const srgbEncode = (v) => {
  const a = Math.abs(v);
  return Math.sign(v) * (a <= 0.0031308 ? 12.92 * a : 1.055 * a ** (1 / 2.4) - 0.055);
};
const limit = (v) => Math.max(-65504, Math.min(65504, v));
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const luma601 = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Curves and LUT (domain-bounded tables): the HDR result of a pixel x with encoding e is
 * SRGB^-1(T(clamp(e)) + (e - clamp(e))), where T(clamp(e)) is the SDR result of the same
 * parameters on the clamped encoding. `sdrOfClamped` is that SDR result (alpha unchanged).
 */
export function tableReference(input, sdrOfClamped) {
  return input.map((v, i) => {
    if (i % 4 === 3) return v;
    const e = srgbEncode(v);
    return limit(srgbDecode(sdrOfClamped[i] + (e - clamp01(e))));
  });
}

/** The clamped encoding a table effect reads: alpha unchanged. */
export const clampedEncoding = (input) => input.map((v, i) => (i % 4 === 3 ? v : clamp01(srgbEncode(v))));

/** gpu-chroma-key, HDR: matte, tolerances and spill on the extended encoding; RGB decoded. */
export function chromaKeyReference(input, params) {
  const key = params.keyColor === 'blue' ? [0, 0, 1] : [0, 1, 0];
  const tolerance = params.tolerance ?? 0.2;
  const softness = params.softness ?? 0.1;
  const spill = params.spillSuppression ?? 0.5;
  const ycc = ([r, g, b]) => { const y = 0.299 * r + 0.587 * g + 0.114 * b; return [0.564 * (b - y), 0.713 * (r - y)]; };
  const [kb, kr] = ycc(key);
  const out = [];
  for (let k = 0; k < input.length; k += 4) {
    const c = [0, 1, 2].map((ch) => srgbEncode(input[k + ch]));
    const [cb, cr] = ycc(c);
    const dist = Math.hypot(cb - kb, cr - kr);
    let alpha = dist > tolerance + 1 / 65536 ? 1 : 0;
    if (tolerance + softness > tolerance) alpha = smoothstep(tolerance, tolerance + softness, dist);
    if (spill > 0) {
      const [hi, lo1, lo2] = key[1] === 1 ? [1, 0, 2] : [2, 0, 1];
      const amount = Math.max(0, c[hi] - Math.max(c[lo1], c[lo2])) * spill;
      c[hi] -= amount; c[lo1] += amount * 0.5; c[lo2] += amount * 0.5;
    }
    out.push(...c.map((v) => limit(srgbDecode(v))), input[k + 3] * alpha);
  }
  return out;
}

// C7: RGB -> HSV and HSV -> RGB.
function rgbToHsv([r, g, b]) {
  const P = g >= b ? [g, b, 0, -1 / 3] : [b, g, -1, 2 / 3];
  const Q = r >= P[0] ? [r, P[1], P[2], P[0]] : [P[0], P[1], P[3], r];
  const d = Q[0] - Math.min(Q[3], Q[1]);
  return [Math.abs(Q[2] + (Q[3] - Q[1]) / (6 * d + 1e-10)), d / (Q[0] + 1e-10), Q[0]];
}
function hsvToRgb([h, s, v]) {
  return [1, 2 / 3, 1 / 3].map((o) => {
    const x = h + o;
    const k = Math.abs((x - Math.floor(x)) * 6 - 3);
    return v * mix(1, clamp01(k - 1), s);
  });
}

/** gpu-color-wheels, HDR: the page's arithmetic on the extended encoding, unclamped, decoded. */
export function colorWheelsReference(input, raw) {
  const p = { shadowsHue: 0, shadowsAmount: 0, midtonesHue: 0, midtonesAmount: 0, highlightsHue: 0, highlightsAmount: 0,
    offsetHue: 0, offsetAmount: 0, temperature: 0, tint: 0, saturation: 0, exposure: 0, contrast: 1, pivot: 0.5,
    lift: 0, gamma: 1, gain: 1, offset: 0, blackPoint: 0, whitePoint: 1, midDetail: 0, colorBoost: 0, shadows: 0,
    highlights: 0, hue: 50, lumMix: 100 };
  for (const key of Object.keys(p)) if (typeof raw[key] === 'number') p[key] = raw[key];
  const tint = (c, hue, amount, mask) => {
    if (amount < 0.001) return c;
    const colour = hsvToRgb([hue / 360, 1, 1]);
    return c.map((v, k) => mix(v, v * mix(1, colour[k], amount), mask));
  };
  const out = [];
  for (let k = 0; k < input.length; k += 4) {
    let c = [0, 1, 2].map((ch) => srgbEncode(input[k + ch]));
    const luma = luma601(c);
    const shadowMask = 1 - smoothstep(0, 0.5, luma);
    const highlightMask = smoothstep(0.5, 1, luma);
    const midMask = 1 - shadowMask - highlightMask;
    c = tint(c, p.shadowsHue, p.shadowsAmount, shadowMask);
    c = tint(c, p.midtonesHue, p.midtonesAmount, midMask);
    c = tint(c, p.highlightsHue, p.highlightsAmount, highlightMask);
    c = tint(c, p.offsetHue, p.offsetAmount, 1);
    const temp = p.temperature / 100;
    const ti = p.tint / 100;
    c = [c[0] + temp * 0.1 + ti * 0.05, c[1] - ti * 0.1, c[2] - temp * 0.1 + ti * 0.05];
    c = c.map((v) => v * 2 ** p.exposure);
    c = c.map((v) => (v - p.pivot) * p.contrast + p.pivot);
    if (Math.abs(p.midDetail) > 0.001) {
      const l = luma601(c);
      c = c.map((v) => mix(v, l + (v - l) * (1 + p.midDetail / 100), midMask));
    }
    c = c.map((v) => (v + p.lift + p.offset) * p.gain);
    c = c.map((v) => Math.sign(v) * Math.abs(v) ** (1 / Math.max(p.gamma, 0.05)));
    c = c.map((v) => (v - p.blackPoint) / Math.max(p.whitePoint - p.blackPoint, 0.001));
    c = c.map((v) => v + (p.shadows / 100) * shadowMask + (p.highlights / 100) * highlightMask);
    const gray = luma601(c);
    c = c.map((v) => mix(gray, v, 1 + p.saturation / 100));
    const boost = p.colorBoost / 100;
    if (Math.abs(boost) > 0.001) {
      const l = luma601(c);
      const chroma = c.map((v) => v - l);
      const scale = 1 + boost * (1 - clamp01(Math.hypot(...chroma)));
      c = chroma.map((v) => l + v * scale);
    }
    if (Math.abs(p.hue - 50) > 0.001) {
      const hsv = rgbToHsv(c);
      const h = hsv[0] + (p.hue - 50) / 100;
      c = hsvToRgb([h - Math.floor(h), hsv[1], hsv[2]]);
    }
    const post = luma601(c);
    c = c.map((v) => mix(post, v, clamp01(p.lumMix / 100)));
    out.push(...c.map((v) => limit(srgbDecode(v))), input[k + 3]);
  }
  return out;
}

/**
 * gpu-sharpen, HDR: 7 x 7 taps of premultiplied light (PB of C4) at offsets x radius texels,
 * weighted GAUSS(|offset|, radius / 2 + 1/2); the reference colour is their coverage-weighted
 * mean; result = centre + (centre - reference) x amount; alpha = the centre's coverage, rounded
 * to binary16 by the caller's storage; zero coverage writes (0, 0, 0, 0).
 */
export function sharpenReference(input, width, height, { amount = 1, radius = 1 } = {}, roundCoverage = (v) => v) {
  const tap = (u, v) => {
    const x = u * width - 0.5;
    const y = v * height - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const sum = [0, 0, 0, 0];
    for (const dy of [0, 1]) for (const dx of [0, 1]) {
      const w = (dx ? x - x0 : 1 - (x - x0)) * (dy ? y - y0 : 1 - (y - y0));
      const tx = Math.min(width - 1, Math.max(0, x0 + dx));
      const ty = Math.min(height - 1, Math.max(0, y0 + dy));
      const at = (ty * width + tx) * 4;
      const a = input[at + 3];
      sum[0] += w * input[at] * a; sum[1] += w * input[at + 1] * a; sum[2] += w * input[at + 2] * a; sum[3] += w * a;
    }
    return sum;
  };
  const sigma = radius * 0.5 + 0.5;
  const out = [];
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const u = (i + 0.5) / width;
    const v = (j + 0.5) / height;
    const centre = tap(u, v);
    const blur = [0, 0, 0, 0];
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
      const w = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      const t = tap(u + (dx / width) * radius, v + (dy / height) * radius);
      for (let k = 0; k < 4; k++) blur[k] += t[k] * w;
    }
    const coverage = roundCoverage(clamp01(centre[3]));
    if (coverage <= 0 || blur[3] <= 0) { out.push(0, 0, 0, 0); continue; }
    for (let k = 0; k < 3; k++) {
      const s = centre[k] / centre[3];
      out.push(limit(s + (s - blur[k] / blur[3]) * amount));
    }
    out.push(coverage);
  }
  return out;
}

/** A size-3 3D LUT (red fastest), rgba8 base64, deliberately non-identity (as render-goldens.mjs). */
export function lutFixture() {
  const bytes = [];
  for (let b = 0; b < 3; b++) for (let g = 0; g < 3; g++) for (let r = 0; r < 3; r++) {
    bytes.push(Math.round(255 * (r / 2) ** 2), Math.round(255 * (1 - g / 2)), Math.round(255 * (b / 2 + r / 2) / 2), 255);
  }
  return { lutName: 'fixture', lutSize: '3', lutData: Buffer.from(bytes).toString('base64') };
}

export const HDR_GRADES = ['gpu-curves', 'gpu-lut', 'gpu-color-wheels', 'gpu-chroma-key', 'gpu-sharpen'];

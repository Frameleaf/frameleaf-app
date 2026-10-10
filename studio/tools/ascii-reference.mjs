// Independent CPU implementation of spec/effects/gpu-ascii.md's atlas path.
// Glyph coverage is a platform INPUT; no engine math or GPU output enters this oracle.
import assert from 'node:assert/strict';
import { roundHalf } from './render-goldens.mjs';

const RAMPS = { ascii: '@%#*+=-:. ', dense: '@WB#$oahkbn+=-:. ', binary: '01', symbols: '#@&$%*+!=;:-. ' };
const FONTS = { monospace: 'monospace', courier: '"Courier New", Courier, monospace',
  consolas: 'Consolas, "Lucida Console", monospace', lucida: '"Lucida Console", Monaco, monospace' };

export function asciiAtlasSpec(params) {
  const ramp = params.charSet === 'custom' ? [...params.customChars].slice(0, 64).join('') : RAMPS[params.charSet];
  if (!ramp) return null;
  assert(Object.hasOwn(FONTS, params.font), 'ASCII atlas font is unknown');
  return { ramp, font: `20px ${FONTS[params.font]}`, width: [...ramp].length * 24, height: 24, depth: 1,
    key: `${ramp}|${params.font}` };
}

function checkAtlas(atlas, spec) {
  assert(atlas && spec, 'ASCII atlas input is missing');
  for (const field of ['width', 'height', 'depth']) assert.equal(atlas[field], spec[field], `ASCII atlas ${field}`);
  assert.equal(atlas.data?.length, spec.width * spec.height * 4, 'ASCII atlas data length');
  for (let i = 0; i < atlas.data.length; i += 4) {
    const alpha = atlas.data[i + 3];
    assert(Number.isInteger(alpha) && alpha >= 0 && alpha <= 255, 'ASCII atlas coverage must be bytes');
    for (let c = 0; c < 3; c++) assert.equal(atlas.data[i + c], alpha, 'ASCII atlas RGBA must contain coverage');
  }
}

export function validateAsciiAtlas(actual, reference, params) {
  const spec = asciiAtlasSpec(params);
  checkAtlas(actual, spec);
  checkAtlas(reference, spec);
  for (let i = 0; i < actual.data.length; i++) {
    assert.equal(actual.data[i], reference.data[i], `ASCII atlas byte ${i} differs from independently rasterized ramp/font/layout`);
  }
  return true;
}

const clamp = (x, low = 0, high = 1) => Math.min(high, Math.max(low, x));
const f = Math.fround;
const add = (a, b) => f(f(a) + f(b));
const mul = (a, b) => f(f(a) * f(b));
const luma = (c) => add(add(mul(c[0], 0.299), mul(c[1], 0.587)), mul(c[2], 0.114));
function color(value, fallback) {
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return fallback;
  const digits = value.slice(1);
  return (digits.length <= 4 ? [...digits.slice(0, 3)].map((x) => parseInt(x + x, 16))
    : [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16))).map((x) => f(x / 255));
}

export function renderAsciiReference(input, width, height, params, atlas) {
  const spec = asciiAtlasSpec(params);
  checkAtlas(atlas, spec);
  assert(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, 'ASCII input size');
  assert.equal(input?.length, width * height * 4, 'ASCII input length');
  assert(input.every(Number.isFinite), 'ASCII input must be finite');
  for (const key of ['fontSize', 'letterSpacing', 'lineHeight', 'asciiOpacity', 'originalOpacity', 'contrast', 'brightness', 'colorSaturation']) {
    assert(Number.isFinite(params[key]), `ASCII parameter ${key} must be finite`);
  }
  const source = input.map(roundHalf);
  const fetch = (x, y) => {
    const i = (clamp(Math.trunc(y), 0, height - 1) * width + clamp(Math.trunc(x), 0, width - 1)) * 4;
    return source.slice(i, i + 4);
  };
  const contrast = f(params.contrast / 100), brightness = f(params.brightness / 255);
  const saturation = f(params.colorSaturation / 100), inkOpacity = f(params.asciiOpacity / 100), underOpacity = f(params.originalOpacity / 100);
  const adjust = (c) => c.slice(0, 3).map((v) => clamp(add(add(mul(add(v, -0.5), contrast), 0.5), brightness)));
  const cw = Math.max(mul(params.fontSize, Math.max(0.25, add(0.6, mul(0.05, params.letterSpacing)))), 1);
  const ch = Math.max(mul(params.fontSize, Math.max(params.lineHeight, 0.25)), 1);
  const extentX = mul(Math.max(1, Math.floor(f(width / cw))), cw), extentY = mul(Math.max(1, Math.floor(f(height / ch))), ch);
  const ox = mul(add(width, -extentX), 0.5), oy = mul(add(height, -extentY), 0.5);
  const text = color(params.textColor, [1, 1, 1]), background = color(params.bgColor, [f(10 / 255), f(10 / 255), f(15 / 255)]);
  const mix = (a, b, t) => a.map((v, c) => add(mul(v, add(1, -t)), mul(b[c], t)));
  const n = [...spec.ramp].length;
  const coverage = (u, v) => {
    const x = f(mul(u, atlas.width) - 0.5), y = f(mul(v, atlas.height) - 0.5);
    const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
    const tap = (a, b) => atlas.data[(clamp(b, 0, atlas.height - 1) * atlas.width + clamp(a, 0, atlas.width - 1)) * 4 + 3] / 255;
    return (tap(ix, iy) * (1 - tx) + tap(ix + 1, iy) * tx) * (1 - ty)
      + (tap(ix, iy + 1) * (1 - tx) + tap(ix + 1, iy + 1) * tx) * ty;
  };
  const out = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const base = fetch(x, y), a = adjust(base), px = x + 0.5, py = y + 0.5;
    if (base[3] <= 0.0001) { out.push(0, 0, 0, 0); continue; }
    const back = mix(background, a, underOpacity);
    if (px < ox || py < oy || px >= add(ox, extentX) || py >= add(oy, extentY)) {
      out.push(...(params.transparentBg ? [...a, mul(base[3], underOpacity)] : [...back, base[3]]));
      continue;
    }
    const gx = f(add(px, -ox) / cw), gy = f(add(py, -oy) / ch);
    const sx = add(ox, mul(add(Math.floor(gx), 0.5), cw)), sy = add(oy, mul(add(Math.floor(gy), 0.5), ch));
    const sample = adjust(fetch(sx, sy));
    let density = luma(sample);
    if (params.edgeDetect) {
      const Y = (dx, dy) => luma(fetch(add(sx, mul(dx, Math.max(cw, 1))), add(sy, mul(dy, Math.max(ch, 1)))));
      const dx = add(add(add(Y(1, -1), mul(2, Y(1, 0))), Y(1, 1)), -add(add(Y(-1, -1), mul(2, Y(-1, 0))), Y(-1, 1)));
      const dy = add(add(add(Y(-1, 1), mul(2, Y(0, 1))), Y(1, 1)), -add(add(Y(-1, -1), mul(2, Y(0, -1))), Y(1, -1)));
      density = clamp(f(Math.hypot(dx, dy)));
    }
    if (params.invert) density = add(1, -density);
    const glyph = clamp(Math.floor(mul(density, n)), 0, n - 1);
    const mask = coverage(f(add(glyph, clamp(gx - Math.floor(gx), f(0.04), f(0.96))) / n), gy - Math.floor(gy));
    const ink = clamp(mul(mask, inkOpacity));
    const lum = luma(sample);
    const glyphColor = params.matchSourceColor ? sample.map((v) => clamp(add(lum, mul(add(v, -lum), saturation)))) : text;
    if (params.transparentBg) {
      const under = mul(underOpacity, add(1, -ink)), alpha = add(ink, under);
      const rgb = glyphColor.map((v, c) => f(add(mul(v, ink), mul(a[c], under)) / Math.max(alpha, 0.0001)));
      out.push(...rgb, mul(base[3], alpha));
    } else out.push(...mix(back, glyphColor, ink), base[3]);
  }
  assert(out.every(Number.isFinite), 'ASCII reference output must be finite');
  return out.map(roundHalf);
}

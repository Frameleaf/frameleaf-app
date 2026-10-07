import assert from 'node:assert/strict';

// Independent historical extended sRGB-encoded equations. Their signed/highlight
// discriminators remain pinned; they do not qualify the current linear HDR domain.
export const photometricCases = [
  { name: 'brightness-lift', id: 'gpu-brightness', params: { amount: 0.125 } },
  { name: 'brightness-lower', id: 'gpu-brightness', params: { amount: -0.125 } },
  { name: 'contrast-expand', id: 'gpu-contrast', params: { amount: 1.5 } },
  { name: 'contrast-contract', id: 'gpu-contrast', params: { amount: 0.75 } },
  { name: 'exposure-lift-gamma', id: 'gpu-exposure', params: { exposure: 1, offset: 0.125, gamma: 2 } },
  { name: 'exposure-lower-gamma', id: 'gpu-exposure', params: { exposure: -1, offset: -0.125, gamma: 0.75 } },
  { name: 'levels-linear', id: 'gpu-levels', params: { inputBlack: 0.25, inputWhite: 0.75, gamma: 1, outputBlack: 0.125, outputWhite: 0.875 } },
  { name: 'levels-gamma', id: 'gpu-levels', params: { inputBlack: 0.125, inputWhite: 0.875, gamma: 2, outputBlack: 0, outputWhite: 1 } },
];

// Exactly representable binary16 RGB and alpha: zero, signed values, white,
// highlights, translucent pixels and hidden RGB at alpha zero, in every row.
const ramp = [-0.5, -0.25, 0, 0.25, 0.5, 1, 2, 4];
const alpha = [0, 0.125, 0.5, 0.875, 1, 0.5, 0.125, 1];
export const photometricInput = Array.from({ length: 32 }, (_, i) => [
  ramp[i % 8], ramp[(i + 2) % 8], ramp[(i + 5) % 8], alpha[i % 8],
]).flat();

const limit = (x) => Math.min(65504, Math.max(-65504, x));
const power = (x, gamma, unsigned) => (unsigned ? 1 : Math.sign(x)) * Math.abs(x) ** (1 / gamma);
export function photometricExpected(entry, unsigned = false) {
  const p = entry.params;
  return photometricInput.map((c, i) => {
    if (i % 4 === 3) return c;
    switch (entry.id) {
      case 'gpu-brightness': return limit(c + p.amount);
      case 'gpu-contrast': return limit((c - 0.5) * p.amount + 0.5);
      case 'gpu-exposure': return limit(power(c * 2 ** p.exposure + p.offset, p.gamma, unsigned));
      case 'gpu-levels': {
        const span = p.inputWhite - p.inputBlack;
        const safeSpan = Math.abs(span) < 1e-4 ? (span >= 0 ? 1e-4 : -1e-4) : span;
        const normalized = limit((c - p.inputBlack) / safeSpan);
        return limit(p.outputBlack + (p.outputWhite - p.outputBlack) * power(normalized, p.gamma, unsigned));
      }
      default: assert.fail(`unbound photometric node ${entry.id}`);
    }
  });
}

// Half storage plus f32 arithmetic/pow. Alpha uses exact binary16 fractions.
export const photometricTolerance = (value, i) => i % 4 === 3 ? 1e-6 : Math.max(0.004, Math.abs(value) * 0.002);
export function photometricSdrExpected(entry) {
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const p = entry.params;
  return photometricInput.map((c, i) => {
    if (i % 4 === 3) return c;
    switch (entry.id) {
      case 'gpu-brightness': return clamp(c + p.amount);
      case 'gpu-contrast': return clamp((c - 0.5) * p.amount + 0.5);
      case 'gpu-exposure': return clamp(Math.max(0, c * 2 ** p.exposure + p.offset) ** (1 / p.gamma));
      case 'gpu-levels': {
        const span = p.inputWhite - p.inputBlack;
        const safeSpan = Math.abs(span) < 1e-4 ? (span >= 0 ? 1e-4 : -1e-4) : span;
        return clamp(p.outputBlack + (p.outputWhite - p.outputBlack) * clamp((c - p.inputBlack) / safeSpan) ** (1 / p.gamma));
      }
      default: assert.fail(`unbound SDR photometric node ${entry.id}`);
    }
  });
}

// Brightness/contrast keep their affine equations when the input is linear light.
// Other historical encoded equations remain ineligible for the linear domain.
export const linearColorCases = photometricCases.filter(entry => ['gpu-brightness', 'gpu-contrast'].includes(entry.id));

export function validatePhotometricResults(results, domain = 'historical-encoded-hdr') {
  assert(['historical-encoded-hdr', 'srgb-display-bt709', 'linear-display-bt709-v1'].includes(domain), 'unqualified photometric working domain');
  assert.deepEqual(results.map(({ name, id, params }) => ({ name, id, params })), domain === 'linear-display-bt709-v1' ? linearColorCases : photometricCases,
    'photometric cases must be complete, ordered, unique and retain their parameters');
  let channels = 0;
  for (const entry of results) {
    assert(!entry.error, `${entry.name}: GPU render failed: ${entry.error}`);
    assert.equal(entry.pixels?.length, photometricInput.length, `${entry.name}: incomplete GPU pixels`);
    const expected = domain === 'srgb-display-bt709' ? photometricSdrExpected(entry) : photometricExpected(entry);
    if (domain !== 'srgb-display-bt709') {
      const rgb = expected.filter((_, i) => i % 4 !== 3);
      assert(rgb.some((v) => v < -0.05) && rgb.some((v) => v > 1.05), `${entry.name}: missing signed/highlight discriminator`);
      const distinguish = (alternative, label) => assert(expected.some((v, i) => i % 4 !== 3 &&
        Math.abs(v - alternative[i]) > 8 * photometricTolerance(v, i)), `${entry.name}: weak ${label} discriminator`);
      distinguish(photometricInput, 'identity');
      distinguish(expected.map((v, i) => i % 4 === 3 ? v : Math.max(0, v)), 'negative clipping');
      distinguish(expected.map((v, i) => i % 4 === 3 ? v : Math.min(1, v)), 'reference-white clipping');
      if (entry.id === 'gpu-exposure' || entry.id === 'gpu-levels') distinguish(photometricExpected(entry, true), 'unsigned gamma');
    } else {
      assert(expected.some((v, i) => i % 4 !== 3 && Math.abs(v - Math.min(1, Math.max(0, photometricInput[i]))) > 8 * photometricTolerance(v, i)), `${entry.name}: weak SDR identity discriminator`);
    }
    expected.forEach((want, i) => {
      const got = entry.pixels[i];
      assert(Number.isFinite(got) && Math.abs(got - want) <= photometricTolerance(want, i),
        `${entry.name}: channel ${i}, got ${got}, independent expected ${want}`);
      channels++;
    });
  }
  assert.equal(channels, domain === 'linear-display-bt709-v1' ? 512 : 1024, 'all declared 8x4 RGBA numerical cases are mandatory');
  return { cases: results.length, channels };
}

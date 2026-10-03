// Explicit image qualification gate. Requires a genuine, consented RAW mounted read-only.
// node verify-darktable-develop.mjs <fixture> <oriented-width> <oriented-height> [renderer-module]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { verifyNativeRuntime } from './verify-darktable.mjs';

const [fixture, width, height, modulePath = '/usr/src/app/server/dist/utils/darktable-renderer.js', lensExpectation] =
  process.argv.slice(2);
assert.ok(
  !lensExpectation || ['calibrated', 'missing'].includes(lensExpectation),
  'Lens expectation must be calibrated or missing',
);
assert.ok(fixture && Number(width) > 0 && Number(height) > 0, 'Actual RAW and qualified oriented dimensions required');
verifyNativeRuntime('/usr/local');
const url = pathToFileURL(modulePath);
const sharp = createRequire(url)('sharp');
const { renderDarktable, encodeNativeDevelopOutput } = await import(url.href);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const original = digest(readFileSync(fixture));
const base = { version: 2, renderer: 'darktable/5.6.1', exposureEV: 0 };
const baseline = await renderDarktable(fixture, base);
if (lensExpectation === 'missing') {
  await assert.rejects(
    renderDarktable(fixture, { ...base, lensCorrection: true }),
    /Native lens calibration unavailable/,
  );
} else if (lensExpectation === 'calibrated') {
  const corrected = await renderDarktable(fixture, { ...base, lensCorrection: true });
  assert.ok((await sharp(corrected).metadata()).icc?.length);
}

const metadata = await sharp(baseline).metadata();
assert.equal(metadata.width, Number(width));
assert.equal(metadata.height, Number(height));
assert.equal(metadata.bitsPerSample, 16);
assert.ok(metadata.icc?.length, 'Native profile is absent');
const pixels = async (bytes) => sharp(bytes).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer();
const baselinePixels = digest(await pixels(baseline));
assert.equal(digest(await pixels(await renderDarktable(fixture, base))), baselinePixels, 'Repeat native pixels differ');
for (const controls of [
  { exposureEV: 1 },
  { whiteBalance: { red: 1.15, green: 1, blue: 0.85 } },
  { shadows: 30 },
  { highlights: -30 },
  { saturation: 0.5 },
  { contrast: 1.1 },
  {
    curve: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.6 },
      { x: 1, y: 1 },
    ],
  },
  { noiseThreshold: 0.3 },
  { sharpen: { radius: 2, amount: 1, threshold: 0.5 } },
]) {
  const rendered = await renderDarktable(fixture, { ...base, ...controls });
  assert.notEqual(
    digest(await pixels(rendered)),
    baselinePixels,
    `No isolated native control effect: ${JSON.stringify(controls)}`,
  );
}
const masked = await renderDarktable(fixture, {
  ...base,
  rotation: 90,
  crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
  straighten: 1,
  masks: [
    {
      id: 'qualification',
      kind: 'radial',
      coordinates: 'sensor-active',
      x: 0.5,
      y: 0.5,
      adjustments: { exposureEV: 0.7 },
    },
  ],
});
assert.notEqual(digest(await pixels(masked)), baselinePixels);
const maskedMetadata = await sharp(masked).metadata();
assert.equal(maskedMetadata.bitsPerSample, 16);
assert.ok(maskedMetadata.icc?.length);
assert.ok(Math.max(maskedMetadata.width, maskedMetadata.height) < Math.max(metadata.width, metadata.height));
const master = await encodeNativeDevelopOutput(baseline, { format: 'jpeg', quality: 92 });
const preview = await encodeNativeDevelopOutput(baseline, { format: 'jpeg', quality: 92, size: 640 });
assert.equal((await sharp(master).metadata()).width, metadata.width);
const previewMetadata = await sharp(preview).metadata();
assert.equal(Math.max(previewMetadata.width, previewMetadata.height), 640);
assert.deepEqual((await sharp(master).metadata()).icc, previewMetadata.icc, 'Preview/final encoder ICC differ');
assert.equal(digest(readFileSync(fixture)), original, 'Original RAW changed');
console.log(
  'Native RAW fixture gate passed: package, repeat, isolated controls, geometry/mask, high-bit/ICC and original checksum',
);

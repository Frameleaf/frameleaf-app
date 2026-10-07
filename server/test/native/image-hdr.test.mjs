import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const codec = createRequire(import.meta.url)(
  process.env.FRAMELEAF_HDR_BINDING ?? '/usr/local/lib/frameleaf/image-hdr.node',
);
const limits = [200_000_000, 1024 ** 3];
const width = 64;
const height = 64;
const pixels = new Float32Array(width * height * 4);
const bars = [0.1, 0.5, 1, 2, 4, 8, 16, 32];
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    pixels.set([bars[Math.floor(x / 8)], bars[Math.floor(x / 8)], bars[Math.floor(x / 8)], 1], offset);
  }
const bytes = () => Buffer.from(pixels.buffer);

test('explicit larger surface budgets work without weakening pixel or encoded-input limits', () => {
  const budget = 4 * 1024 ** 3;
  for (const encode of [codec.encode, codec.encodeHeic]) {
    const image = encode(bytes(), width, height, 0, limits[0], budget);
    const decoded = codec.decode(image, limits[0], budget);
    assert.deepEqual([decoded.width, decoded.height], [width, height]);
    assert.throws(() => codec.inspect(image, 1, budget), { code: 'RESOURCE_LIMIT' });
    assert.throws(() => encode(bytes(), width, height, 0, limits[0], 8 * 1024 ** 3 + 1), { code: 'RESOURCE_LIMIT' });
  }
});

test('HEIC export is ten-bit PQ, retains HDR headroom and rejects invalid input', () => {
  const encoded = codec.encodeHeic(bytes(), width, height, 2, ...limits);
  const metadata = codec.inspect(encoded, ...limits);
  assert.equal(metadata.codec, 'hevc');
  assert.equal(metadata.bitDepth, 10);
  assert.equal(metadata.transfer, 16);
  assert.equal(metadata.colorPrimaries, 9);
  assert.equal(metadata.dynamicRange, 'hdr');
  assert.equal(metadata.reconstructionAvailable, true);
  const decoded = codec.decode(encoded, ...limits);
  assert.deepEqual([decoded.width, decoded.height, decoded.gamut], [width, height, 2]);
  const result = new Float32Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length / 4);
  for (let x = 4; x < width; x += 8) {
    const offset = (32 * width + x) * 4;
    assert.ok(Math.abs(result[offset] - pixels[offset]) < 0.7);
  }
  assert.throws(() => codec.encodeHeic(bytes(), width, height, 2, 1, limits[1]), { code: 'RESOURCE_LIMIT' });
  const invalid = new Float32Array(pixels);
  invalid[0] = NaN;
  assert.throws(() => codec.encodeHeic(Buffer.from(invalid.buffer), width, height, 2, ...limits), {
    code: 'INVALID_LINEAR_PIXELS',
  });
  for (const gamut of [0, 1, 2]) {
    const transparent = new Float32Array(pixels);
    for (let i = 3; i < transparent.length; i += 4) transparent[i] = 0.5;
    const image = codec.encodeHeic(Buffer.from(transparent.buffer), width, height, gamut, ...limits);
    const alpha = codec.decode(image, ...limits);
    assert.equal(alpha.gamut, gamut);
    const data = new Float32Array(alpha.data.buffer, alpha.data.byteOffset, alpha.data.length / 4);
    assert.ok(Math.abs(data[3] - 0.5) < 0.002);
  }
});

test('linear HDR survives the codec round trip without intermediate 8-bit clipping', () => {
  const image = codec.encode(bytes(), width, height, 0, ...limits);
  const metadata = codec.inspect(image, ...limits);
  assert.equal(metadata.dynamicRange, 'hdr');
  assert.equal(metadata.reconstructionAvailable, true);
  assert.equal(metadata.container, 'jpeg');
  assert.equal(metadata.codec, 'jpeg');
  assert.equal(metadata.gainMap, 'iso-21496');
  const decoded = codec.decode(image, ...limits);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.equal(decoded.referenceWhite, 203);
  const result = new Float32Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length / 4);
  let worst = 0;
  for (let i = 0; i < pixels.length; i++) {
    assert.ok(Number.isFinite(result[i]));
    if (i % 4 === 3) assert.equal(result[i], 1);
    else worst = Math.max(worst, Math.abs(result[i] - pixels[i]));
  }
  assert.ok(worst < 0.5, `synthetic neutral reconstruction error ${worst}`);
  assert.ok(result[(32 * width + 60) * 4] > 31);
  assert.equal(image.includes(Buffer.from('GPSLatitude')), false);
});

test('resource limits and invalid working pixels fail before encoding', () => {
  assert.throws(() => codec.encode(bytes(), width, height, 0, 1, 1024 ** 3), { code: 'RESOURCE_LIMIT' });
  assert.throws(() => codec.encode(bytes(), width, height, 0, 200_000_000, 100), { code: 'RESOURCE_LIMIT' });
  assert.throws(() => codec.encode(bytes(), NaN, height, 0, ...limits), { code: 'RESOURCE_LIMIT' });
  assert.throws(() => codec.encode(bytes(), width, height, 0, NaN, limits[1]), { code: 'RESOURCE_LIMIT' });
  const bad = new Float32Array(pixels);
  bad[0] = NaN;
  assert.throws(() => codec.encode(Buffer.from(bad.buffer), width, height, 0, ...limits), {
    code: 'INVALID_LINEAR_PIXELS',
  });
  bad[0] = 1;
  bad[3] = 0.5;
  assert.throws(() => codec.encode(Buffer.from(bad.buffer), width, height, 0, ...limits), {
    code: 'HDR_JPEG_ALPHA_UNSUPPORTED',
  });
});

test('an authored SDR baseline survives HDR reconstruction and re-encoding', () => {
  const sdr = Buffer.alloc(width * height * 4, 60);
  for (let i = 3; i < sdr.length; i += 4) sdr[i] = 255;
  const encoded = codec.encodePaired(bytes(), width, height, 0, ...limits, sdr, 0);
  const pair = codec.decodePaired(encoded, ...limits);
  assert.deepEqual([pair.width, pair.height, pair.gamut], [width, height, 0]);
  assert.equal(pair.sdrGamut, 0);
  assert.equal(pair.sdr.length, sdr.length);
  for (let i = 0; i < sdr.length; i++) assert.ok(Math.abs(pair.sdr[i] - sdr[i]) <= 2);
  const decoded = new Float32Array(pair.data.buffer, pair.data.byteOffset, pair.data.length / 4);
  assert.ok(decoded[(32 * width + 60) * 4] > 31);
  assert.throws(() => codec.encodePaired(bytes(), width, height, 0, ...limits, sdr.subarray(4), 0), {
    code: 'INVALID_SDR_BASELINE',
  });
  assert.throws(() => codec.encodePaired(bytes(), width, height, 0, ...limits, sdr, NaN), {
    code: 'INVALID_SDR_BASELINE',
  });
  sdr[3] = 0;
  assert.throws(() => codec.encodePaired(bytes(), width, height, 0, ...limits, sdr, 0), {
    code: 'HDR_JPEG_ALPHA_UNSUPPORTED',
  });
});

test('invalid gain-map metadata is never advertised as SDR', () => {
  const fake = Buffer.concat([Buffer.from([255, 216]), Buffer.from('hdrgm:Version'), Buffer.from([255, 217])]);
  const metadata = codec.inspect(fake, ...limits);
  assert.equal(metadata.dynamicRange, 'hdr');
  assert.equal(metadata.reconstructionAvailable, false);
  assert.equal(metadata.fallbackReason, 'invalid-gain-map');
});

test('an unsupported ISO-adaptive HEIF never decodes its base as a complete HDR image', () => {
  const input = Buffer.from(readFileSync(new URL('./fixtures/pq-rotated.avif', import.meta.url)));
  assert.equal(input.toString('ascii', 4, 8), 'ftyp');
  assert.ok(input.readUInt32BE(0) >= 20);
  input.write('tmap', 16, 'ascii'); // compatible brand only; leaves offsets and the primary intact
  const metadata = codec.inspect(input, ...limits);
  assert.equal(metadata.dynamicRange, 'hdr');
  assert.equal(metadata.reconstructionAvailable, false);
  assert.equal(metadata.fallbackReason, 'iso-heif-gain-map-decoder-unavailable');
  assert.throws(() => codec.decode(input, ...limits), { code: 'ISO_HEIF_GAIN_MAP_UNAVAILABLE' });
});

// Generated 10-bit AVIF fixtures isolate source transfer/primary/geometry interpretation.
// Real authored Apple/ISO media and physical display acceptance are separate qualification gates.
test('PQ primary image applies its container quarter turn exactly once and retains headroom', () => {
  const input = readFileSync(new URL('./fixtures/pq-rotated.avif', import.meta.url));
  const metadata = codec.inspect(input, ...limits);
  assert.equal(metadata.bitDepth, 10);
  assert.equal(metadata.transfer, 16);
  assert.equal(metadata.colorPrimaries, 9);
  assert.equal(metadata.container, 'avif');
  assert.equal(metadata.codec, 'av1');
  const image = codec.decode(input, ...limits);
  assert.deepEqual([image.width, image.height, image.gamut], [32, 64, 2]);
  const data = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
  for (const [y, light] of [
    [8, 0],
    [24, 100 / 203],
    [40, 1],
    [56, 6500 / 203],
  ]) {
    assert.ok(Math.abs(data[(y * image.width + 16) * 4] - light) < 0.2);
    assert.equal(data[(y * image.width + 16) * 4 + 3], 1);
  }
  assert.throws(() => codec.decode(input, 1, limits[1]), { code: 'RESOURCE_LIMIT' });
});

test('HLG uses the explicit nominal display policy and retains values above reference white', () => {
  const input = readFileSync(new URL('./fixtures/hlg.avif', import.meta.url));
  const image = codec.decode(input, ...limits);
  assert.equal(image.renderingPolicy, 'bt2100-reference-203-hlg-1000-v1');
  const data = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
  assert.ok(Math.abs(data[(16 * image.width + 56) * 4] - 1000 / 203) < 0.001);
  assert.ok(Math.abs(data[(16 * image.width + 40) * 4] - 1) < 0.02);
});

function orientedJpeg(image, orientation) {
  const exif = Buffer.alloc(36);
  exif.set([255, 225, 0, 34]);
  exif.write('Exif\0\0', 4, 'binary');
  exif.write('II', 10);
  exif.writeUInt16LE(42, 12);
  exif.writeUInt32LE(8, 14);
  exif.writeUInt16LE(1, 18);
  exif.writeUInt16LE(274, 20);
  exif.writeUInt16LE(3, 22);
  exif.writeUInt32LE(1, 24);
  exif.writeUInt16LE(orientation, 28);
  return Buffer.concat([image.subarray(0, 2), exif, image.subarray(2)]);
}
test('all JPEG EXIF orientations transform reconstructed HDR exactly once', () => {
  const w = 64,
    h = 32,
    input = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) input.set([1 + Math.floor(x / 16) + 4 * Math.floor(y / 16), 1, 1, 1], (y * w + x) * 4);
  const jpeg = codec.encode(Buffer.from(input.buffer), w, h, 0, ...limits);
  const original = codec.decode(jpeg, ...limits);
  const base = new Float32Array(original.data.buffer, original.data.byteOffset, original.data.length / 4);
  for (let orientation = 1; orientation <= 8; orientation++) {
    const image = codec.decode(orientedJpeg(jpeg, orientation), ...limits);
    assert.deepEqual([image.width, image.height], orientation >= 5 ? [h, w] : [w, h]);
    const result = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++) {
        const [sx, sy] = [
          [x, y],
          [w - 1 - x, y],
          [w - 1 - x, h - 1 - y],
          [x, h - 1 - y],
          [y, x],
          [y, h - 1 - x],
          [w - 1 - y, h - 1 - x],
          [w - 1 - y, x],
        ][orientation - 1];
        for (let c = 0; c < 4; c++)
          assert.ok(
            Math.abs(result[(y * image.width + x) * 4 + c] - base[(sy * w + sx) * 4 + c]) < 0.002,
            `orientation ${orientation} pixel ${x},${y}`,
          );
      }
  }
  assert.throws(() => codec.decode(orientedJpeg(jpeg, 9), ...limits), { code: 'INVALID_JPEG_METADATA' });
});

test('paired decoding retains the independently signaled SDR gamut and aligned orientation', () => {
  const sdr = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      sdr.set([40 + 30 * Math.floor(x / 16), 80 + 20 * Math.floor(y / 16), 30, 255], (y * width + x) * 4);
  const encoded = codec.encodePaired(bytes(), width, height, 1, ...limits, sdr, 0);
  const original = codec.decodePaired(encoded, ...limits);
  assert.equal(original.sdrGamut, 0);
  for (let i = 0; i < sdr.length; i++) assert.ok(Math.abs(original.sdr[i] - sdr[i]) <= 4);
  for (let orientation = 1; orientation <= 8; orientation++) {
    const pair = codec.decodePaired(orientedJpeg(encoded, orientation), ...limits);
    assert.deepEqual([pair.width, pair.height, pair.sdrGamut], [width, height, 0]);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const [sx, sy] = [
          [x, y],
          [width - 1 - x, y],
          [width - 1 - x, height - 1 - y],
          [x, height - 1 - y],
          [y, x],
          [y, height - 1 - x],
          [width - 1 - y, height - 1 - x],
          [width - 1 - y, x],
        ][orientation - 1];
        for (let c = 0; c < 4; c++)
          assert.equal(pair.sdr[(y * width + x) * 4 + c], original.sdr[(sy * width + sx) * 4 + c]);
      }
  }
});

test('installed decoder availability is distinct from output codec availability', () => {
  const caps = codec.capabilities();
  assert.match(caps.libheif, /^\d+\.\d+\.\d+/);
  assert.equal(caps.libultrahdr, '2.0.2');
  assert.equal(typeof caps.heicDecoder, 'boolean');
  assert.equal(typeof caps.avifDecoder, 'boolean');
});

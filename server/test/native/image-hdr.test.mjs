import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
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

test('narrow HEIF images reserve padded decoder surfaces in both orientations', () => {
  for (const [w, h] of [
    [16, 1024],
    [1024, 16],
  ]) {
    const data = new Float32Array(w * h * 4).fill(1);
    const image = codec.encodeHeic(Buffer.from(data.buffer), w, h, 2, ...limits);
    // Two MiB covers the unpadded estimate but not the actual padded surfaces.
    assert.throws(() => codec.decode(image, limits[0], 2 * 1024 ** 2), { code: 'RESOURCE_LIMIT' });
    const decoded = codec.decode(image, limits[0], 8 * 1024 ** 2);
    assert.deepEqual([decoded.width, decoded.height], [w, h]);
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
  assert.equal(caps.appleGainMapDecoder, caps.heicDecoder);
});

test('Apple auxiliary reconstruction retains HDR headroom and the authored SDR baseline', () => {
  const input = readFileSync(new URL('./fixtures/apple-gain-map-p3.heic', import.meta.url));
  const info = codec.inspect(input, ...limits);
  assert.equal(info.gainMap, 'apple-legacy');
  assert.equal(info.dynamicRange, 'hdr');
  assert.equal(info.contentHeadroom, 8);
  assert.equal(info.reconstructionAvailable, true);
  assert.equal(info.renderingPolicy, 'apple-legacy-imageio-2.2-reference-203-v1');
  const pair = codec.decodePaired(input, ...limits);
  const values = new Float32Array(pair.data.buffer, pair.data.byteOffset, pair.data.length / 4);
  assert.ok(values[(16 * pair.width + 56) * 4] > 1);
  for (let i = 3; i < values.length; i += 4) assert.equal(values[i], 1);
  const roundTrip = codec.decodePaired(
    codec.encodePaired(pair.data, pair.width, pair.height, pair.gamut, ...limits, pair.sdr, pair.sdrGamut),
    ...limits,
  );
  for (let i = 0; i < pair.sdr.length; i++) assert.ok(Math.abs(pair.sdr[i] - roundTrip.sdr[i]) <= 2);
  assert.throws(() => codec.inspect(input, 1, limits[1]), { code: 'RESOURCE_LIMIT' });
});

test('Apple gain-map metadata rejects unknown versions, namespace spoofing and invalid MakerNote values', () => {
  const original = readFileSync(new URL('./fixtures/apple-gain-map-p3.heic', import.meta.url));
  const mutations = [
    ['APPLE_GAIN_MAP_VERSION_UNSUPPORTED', (bytes) => bytes.write('65537', bytes.indexOf('65536'))],
    ['INVALID_APPLE_GAIN_MAP', (bytes) => bytes.write('X', bytes.indexOf('http://ns.apple.com/HDRGainMap/1.0/'))],
    ['INVALID_APPLE_GAIN_MAP', (bytes) => bytes.writeUInt32BE(0, bytes.indexOf('Apple iOS\0') + 48)],
    ['INVALID_APPLE_GAIN_MAP', (bytes) => bytes.writeUInt32BE(0xffffffff, bytes.indexOf('Apple iOS\0') + 26)],
    ['INVALID_APPLE_GAIN_MAP', (bytes) => bytes.writeUInt16BE(9, bytes.indexOf('Apple iOS\0') + 18)],
    ['RESOURCE_LIMIT', (bytes) => bytes.writeUInt16BE(65535, bytes.indexOf('Apple iOS\0') + 14)],
  ];
  for (const [code, mutate] of mutations) {
    const bytes = Buffer.from(original);
    mutate(bytes);
    if (code === 'RESOURCE_LIMIT') assert.throws(() => codec.inspect(bytes, ...limits), { code });
    else {
      const info = codec.inspect(bytes, ...limits);
      assert.equal(info.dynamicRange, 'hdr');
      assert.equal(info.reconstructionAvailable, false);
      assert.equal(
        info.fallbackReason,
        code === 'APPLE_GAIN_MAP_VERSION_UNSUPPORTED'
          ? 'apple-gain-map-interpretation-unqualified'
          : 'invalid-gain-map',
      );
    }
    assert.throws(() => codec.decode(bytes, ...limits), { code });
  }
  const xmpStart = original.indexOf('<x:xmpmeta'),
    xmpEnd = original.indexOf('</x:xmpmeta>') + '</x:xmpmeta>'.length;
  const doctype = '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///must-not-be-read">]><x/>';
  const invalid = Buffer.from(original);
  invalid.fill(32, xmpStart, xmpEnd);
  invalid.write(doctype, xmpStart);
  assert.equal(codec.inspect(invalid, ...limits).reconstructionAvailable, false);
  assert.equal(codec.inspect(invalid, ...limits).fallbackReason, 'invalid-gain-map');
});

test('Apple MakerNotes normalize signed rationals, inline floats and either byte order', () => {
  const original = readFileSync(new URL('./fixtures/apple-gain-map-p3.heic', import.meta.url));
  const maker = original.indexOf('Apple iOS\0');
  assert.ok(maker >= 0);
  for (const [maker33, maker48] of [
    [0.5, 0],
    [0.5, 0.05],
    [1, 0],
    [1, 0.05],
    [1, -0.001],
  ]) {
    const stops =
      maker33 < 1
        ? maker48 <= 0.01
          ? -20 * maker48 + 1.8
          : -0.101 * maker48 + 1.601
        : maker48 <= 0.01
          ? -70 * maker48 + 3
          : -0.303 * maker48 + 2.303;
    for (const little of [false, true])
      for (const float of [false, true]) {
        const bytes = Buffer.from(original);
        bytes.write(little ? 'II' : 'MM', maker + 12);
        const u16 = (v, at) => (little ? bytes.writeUInt16LE(v, at) : bytes.writeUInt16BE(v, at));
        const u32 = (v, at) => (little ? bytes.writeUInt32LE(v, at) : bytes.writeUInt32BE(v, at));
        const i32 = (v, at) => (little ? bytes.writeInt32LE(v, at) : bytes.writeInt32BE(v, at));
        u16(2, maker + 14);
        for (const [i, tag, value] of [
          [0, 33, maker33],
          [1, 48, maker48],
        ]) {
          const entry = maker + 16 + i * 12,
            offset = 44 + i * 8;
          u16(tag, entry);
          u16(float ? 11 : 10, entry + 2);
          u32(1, entry + 4);
          if (float) {
            if (little) bytes.writeFloatLE(value, entry + 8);
            else bytes.writeFloatBE(value, entry + 8);
          } else {
            u32(offset, entry + 8);
            i32(Math.round(value * 1000), maker + offset);
            i32(1000, maker + offset + 4);
          }
        }
        const info = codec.inspect(bytes, ...limits);
        assert.equal(info.reconstructionAvailable, true);
        assert.ok(Math.abs(info.contentHeadroom - 2 ** Math.max(stops, 0)) < 0.00001);
      }
  }
});

test('Apple XMP accepts namespaced attributes and rejects duplicates or excessive nesting', () => {
  const original = readFileSync(new URL('./fixtures/apple-gain-map-p3.heic', import.meta.url));
  const begin = original.indexOf('<x:xmpmeta'),
    end = original.indexOf('</x:xmpmeta>') + '</x:xmpmeta>'.length;
  const namespace = 'http://ns.apple.com/HDRGainMap/1.0/';
  for (const [xmp, valid] of [
    [`<x xmlns:a="${namespace}" a:HDRGainMapVersion="65536"/>`, true],
    [
      `<x xmlns:a="${namespace}" a:HDRGainMapVersion="65536"><a:HDRGainMapVersion>65536</a:HDRGainMapVersion></x>`,
      false,
    ],
    [
      `<x xmlns:a="${namespace}">${'<b>'.repeat(33)}<a:HDRGainMapVersion>65536</a:HDRGainMapVersion>${'</b>'.repeat(33)}</x>`,
      false,
    ],
  ]) {
    assert.ok(Buffer.byteLength(xmp) <= end - begin);
    const bytes = Buffer.from(original);
    bytes.fill(32, begin, end);
    bytes.write(xmp, begin);
    const info = codec.inspect(bytes, ...limits);
    assert.equal(info.reconstructionAvailable, valid);
    if (!valid) assert.equal(info.fallbackReason, 'invalid-gain-map');
    if (valid) assert.equal(info.contentHeadroom, 8);
  }
});

for (const [fixture, maximum] of [
  ['ramp', 0.015],
  ['colors', 0.05],
]) {
  test(`Apple ${fixture} reconstruction matches independent ImageIO linear RGB across all 256 codes`, () => {
    const input = readFileSync(new URL(`./fixtures/apple-gain-map-${fixture}.heic`, import.meta.url));
    const reference = JSON.parse(
      readFileSync(new URL(`./fixtures/apple-gain-map-${fixture}-reference.json`, import.meta.url), 'utf8'),
    );
    assert.equal(createHash('sha256').update(input).digest('hex'), reference.sourceSha256);
    assert.equal(codec.inspect(input, ...limits).reconstructionAvailable, true);
    const image = codec.decodePaired(input, ...limits);
    const values = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
    assert.deepEqual([image.width, image.height], [reference.width, reference.height]);
    let max = 0,
      squared = 0,
      count = 0;
    for (let row = 0; row < reference.rgb.length; row++)
      for (let i = 0; i < reference.rgb[row].length; i++)
        for (let c = 0; c < 3; c++) {
          const at = (reference.sampleY[row] * image.width + i * reference.sampleStep + reference.sampleOffset) * 4 + c;
          const error = values[at] - reference.rgb[row][i][c];
          max = Math.max(max, Math.abs(error));
          squared += error ** 2;
          count++;
        }
    assert.ok(max < maximum, `Apple reference max RGB error ${max}`);
    assert.ok(Math.sqrt(squared / count) < maximum / 2, `Apple reference RMS error ${Math.sqrt(squared / count)}`);
  });
}

test('Apple primary container rotations and mirrors keep the gain map and SDR baseline aligned', () => {
  const original = readFileSync(new URL('./fixtures/apple-gain-map-p3.heic', import.meta.url));
  const base = codec.decodePaired(original, ...limits);
  const baseData = new Float32Array(base.data.buffer, base.data.byteOffset, base.data.length / 4);
  for (const [property, values] of [
    ['irot', [0, 1, 2, 3]],
    ['imir', [0, 1]],
  ]) {
    for (const value of values) {
      const bytes = Buffer.from(original),
        propertyOffset = bytes.indexOf('irot');
      bytes.write(property, propertyOffset);
      bytes[propertyOffset + 4] = value;
      const image = codec.decodePaired(bytes, ...limits);
      const swapped = property === 'irot' && value % 2 === 1;
      assert.deepEqual([image.width, image.height], swapped ? [32, 64] : [64, 32]);
      const data = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
          const [sx, sy] =
            property === 'imir'
              ? value === 1
                ? [63 - x, y]
                : [x, 31 - y]
              : [
                  [x, y],
                  [63 - y, x],
                  [63 - x, 31 - y],
                  [y, 31 - x],
                ][value];
          const offset = (y * image.width + x) * 4,
            source = (sy * 64 + sx) * 4;
          for (let c = 0; c < 4; c++) {
            assert.ok(Math.abs(data[offset + c] - baseData[source + c]) < 0.00001);
            assert.equal(image.sdr[offset + c], base.sdr[source + c]);
          }
        }
    }
  }
});

test('unimplemented Apple metadata overrides and invalid profiles block reconstruction explicitly', () => {
  const original = readFileSync(new URL('./fixtures/apple-gain-map-p3.heic', import.meta.url));
  const begin = original.indexOf('<x:xmpmeta'),
    end = original.indexOf('</x:xmpmeta>') + '</x:xmpmeta>'.length;
  const bytes = Buffer.from(original);
  const xmp = '<x xmlns:a="http://ns.apple.com/HDRGainMap/1.0/" a:HDRGainMapVersion="65536" a:HDRGainMapHeadroom="2"/>';
  bytes.fill(32, begin, end);
  bytes.write(xmp, begin);
  assert.equal(codec.inspect(bytes, ...limits).fallbackReason, 'apple-gain-map-interpretation-unqualified');
  assert.throws(() => codec.decode(bytes, ...limits), { code: 'APPLE_GAIN_MAP_VERSION_UNSUPPORTED' });
  const profile = Buffer.from(original);
  const icc = profile.indexOf('acsp');
  assert.ok(icc >= 0);
  profile.fill(0, icc, icc + 4);
  assert.equal(codec.inspect(profile, ...limits).fallbackReason, 'hdr-profile-unsupported');
  assert.throws(() => codec.decode(profile, ...limits), { code: 'HDR_PROFILE_UNSUPPORTED' });
});

// Give the auxiliary its own property rather than the primary's shared rotation.
test('independent Apple auxiliary geometry cannot be advertised as aligned HDR', () => {
  const original = readFileSync(new URL('./fixtures/apple-gain-map-p3.heic', import.meta.url));
  const ipma = original.indexOf('ipma'),
    insertion = ipma - 4;
  const rotation = Buffer.from([0, 0, 0, 9, 105, 114, 111, 116, 1]);
  const bytes = Buffer.concat([original.subarray(0, insertion), rotation, original.subarray(insertion)]);
  for (const type of ['meta', 'iprp', 'ipco']) {
    const offset = bytes.indexOf(type) - 4;
    bytes.writeUInt32BE(bytes.readUInt32BE(offset) + rotation.length, offset);
  }
  const iloc = bytes.indexOf('iloc');
  assert.equal(bytes[iloc + 8], 0x44);
  assert.equal(bytes[iloc + 9], 0);
  const count = bytes.readUInt16BE(iloc + 10);
  for (let i = 0; i < count; i++) {
    const item = iloc + 12 + i * 14;
    assert.equal(bytes.readUInt16BE(item + 4), 1);
    bytes.writeUInt32BE(bytes.readUInt32BE(item + 6) + rotation.length, item + 6);
  }
  assert.equal(bytes[ipma + rotation.length + 28], 0x84);
  bytes[ipma + rotation.length + 28] = 0x8b;
  assert.equal(codec.inspect(bytes, ...limits).reconstructionAvailable, false);
  assert.throws(() => codec.decode(bytes, ...limits), { code: 'APPLE_GAIN_MAP_GEOMETRY_UNSUPPORTED' });
});

for (const [extension, format, maximum, rms, source] of [
  ['jpg', 'jpeg', 0.2, 0.02],
  ['heic', 'heic', 0.08, 0.015],
  ['jpg', 'Pixel 7 Pro', 0.12, 0.012, 'android-ultrahdr/cityscape'],
]) {
  test(`${source ? `Camera HDR ${format}` : `Develop HDR ${format} export`} agrees with independent Apple reconstruction`, () => {
    const input = readFileSync(new URL(`./fixtures/${source ?? 'develop-hdr'}.${extension}`, import.meta.url));
    const reference = JSON.parse(
      readFileSync(new URL(`./fixtures/${source ?? `develop-hdr-${format}`}-reference.json`, import.meta.url), 'utf8'),
    );
    assert.equal(createHash('sha256').update(input).digest('hex'), reference.sourceSha256);
    assert.equal(reference.colorSpace, 'extended-linear-display-p3');
    if (source) {
      const info = codec.inspect(input, ...limits);
      assert.equal(info.reconstructionAvailable, true);
      assert.equal(info.gainMap, 'ultra-hdr');
      assert.equal(info.dynamicRange, 'hdr');
      assert.ok(Math.abs(info.contentHeadroom - 2.4599926471710205) < 0.001);
    }
    const image = codec.decode(input, ...limits);
    assert.deepEqual([image.width, image.height, image.gamut], [reference.width, reference.height, 1]);
    const values = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
    let max = 0,
      squared = 0,
      count = 0;
    for (let row = 0; row < reference.rgb.length; row++)
      for (let x = 0; x < reference.rgb[row].length; x++)
        for (let c = 0; c < 3; c++) {
          const at = (reference.sampleY[row] * image.width + x * reference.sampleStep + reference.sampleOffset) * 4 + c;
          const error = values[at] - reference.rgb[row][x][c];
          max = Math.max(max, Math.abs(error));
          squared += error ** 2;
          count++;
        }
    assert.ok(max < maximum, `${format} maximum reconstruction error ${max}`);
    assert.ok(Math.sqrt(squared / count) < rms, `${format} RMS reconstruction error ${Math.sqrt(squared / count)}`);
    assert.equal(createHash('sha256').update(input).digest('hex'), reference.sourceSha256);
    if (format === 'jpeg') {
      assert.ok(input.includes(Buffer.from('hdrgm:Version')));
      assert.ok(input.includes(Buffer.from('urn:iso:std:iso:ts:21496:-1')));
    }
  });
}

// Install the experimental ISO codec port before opting into its pre-parse limit checks.
test(
  'ISO codec budgets remain resource failures during probing and decoding',
  {
    skip: process.env.FRAMELEAF_HDR_ISO_TEST !== '1',
  },
  () => {
    const input = readFileSync(new URL('./fixtures/apple-iso-gain-map.heic', import.meta.url));
    for (const operation of [codec.inspect, codec.decode, codec.decodePaired]) {
      assert.throws(() => operation(input, 1, limits[1]), { code: 'RESOURCE_LIMIT' });
      assert.throws(() => operation(input, limits[0], input.length * 2 + 128), { code: 'RESOURCE_LIMIT' });
    }
    assert.equal(codec.inspect(input, ...limits).reconstructionAvailable, true);
  },
);

// The corrected encoder is tied to renderer 2; historical builds retain their own identity.
test(
  'the versioned codec preserves colored HDR across sRGB, P3 and BT.2020 inputs',
  {
    skip: process.env.FRAMELEAF_HDR_ISO_TEST !== '1',
  },
  () => {
    assert.equal(codec.capabilities().renderer, 'frameleaf-develop-hdr/4');
    assert.equal(codec.capabilities().isoGainMapDecoder, true);
    const pixels = new Float32Array(64 * 64 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([8, 4, 2, 1], i);
    // D65 RGB/XYZ conversions, expressed in the tone mapper's Display P3 output gamut.
    const expected = [
      [7.28985, 4.13278, 2.24729, 1],
      [8, 4, 2, 1],
      [9.49711, 3.759788, 1.977738, 1],
    ];
    for (const gamut of [0, 1, 2]) {
      const encoded = codec.encode(Buffer.from(pixels.buffer), 64, 64, gamut, ...limits);
      const decoded = codec.decode(encoded, ...limits);
      assert.equal(decoded.gamut, 1);
      const values = new Float32Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length / 4);
      const center = (32 * 64 + 32) * 4;
      for (let channel = 0; channel < 4; channel++)
        assert.ok(
          Math.abs(values[center + channel] - expected[gamut][channel]) < 0.15,
          `gamut ${gamut} channel ${channel} differs from its Display P3 reference`,
        );
    }
  },
);

// A 10-bit primary is reconstructed before any SDR rendition quantization.
test(
  'ISO 10-bit reconstruction agrees with the independent linear reference',
  {
    skip: process.env.FRAMELEAF_HDR_ISO_TEST !== '1',
  },
  () => {
    const input = readFileSync(new URL('./fixtures/iso-gain-map-10bit.heic', import.meta.url));
    const reference = JSON.parse(
      readFileSync(new URL('./fixtures/iso-gain-map-10bit-reference.json', import.meta.url), 'utf8'),
    );
    assert.equal(createHash('sha256').update(input).digest('hex'), reference.sourceSha256);
    const info = codec.inspect(input, ...limits);
    assert.equal(info.bitDepth, 10);
    assert.equal(info.reconstructionAvailable, true);
    const image = codec.decode(input, ...limits);
    assert.deepEqual([image.width, image.height, image.gamut], [reference.width, reference.height, 2]);
    const pixels = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
    let maximum = 0,
      squared = 0,
      count = 0;
    for (let row = 0; row < reference.rgb.length; row++)
      for (let x = 0; x < reference.rgb[row].length; x++)
        for (let c = 0; c < 3; c++) {
          const at = (reference.sampleY[row] * image.width + x * reference.sampleStep + reference.sampleOffset) * 4 + c;
          const error = pixels[at] - reference.rgb[row][x][c];
          maximum = Math.max(maximum, Math.abs(error));
          squared += error * error;
          count++;
        }
    assert.ok(maximum < 0.003, `ISO 10-bit reference maximum ${maximum}`);
    assert.ok(Math.sqrt(squared / count) < 0.001, `ISO 10-bit reference RMS ${Math.sqrt(squared / count)}`);
    assert.ok(pixels.some((value) => value > 7.9));
    for (const operation of [codec.inspect, codec.decode, codec.decodePaired])
      assert.throws(() => operation(input, 1, limits[1]), { code: 'RESOURCE_LIMIT' });
  },
);

for (const corpus of ['iso-quarter', 'iso-hdr-base/geometry'])
  test(
    `ISO ${corpus} geometry keeps authored HDR/SDR aligned and enforces resource limits`,
    {
      skip: process.env.FRAMELEAF_HDR_ISO_TEST !== '1',
    },
    () => {
      const input = readFileSync(new URL(`./fixtures/${corpus}/source.heic`, import.meta.url));
      const source = codec.decodePaired(input, ...limits),
        cases = JSON.parse(readFileSync(new URL(`./fixtures/${corpus}/geometry.json`, import.meta.url))),
        checksums = JSON.parse(readFileSync(new URL(`./fixtures/${corpus}/checksums.json`, import.meta.url)));
      assert.equal(createHash('sha256').update(input).digest('hex'), checksums['source.heic']);
      const pixels = (image) => new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
      for (let i = 0; i < cases.length; ++i) {
        let width = source.width,
          height = source.height;
        let indices = Array.from({ length: width * height }, (_, x) => x);
        for (const [op, ...args] of cases[i]) {
          if (op === 'crop') {
            const [left, top, w, h] = args;
            indices = Array.from(
              { length: w * h },
              (_, j) => indices[(Math.floor(j / w) + top) * width + (j % w) + left],
            );
            width = w;
            height = h;
          } else if (op === 'rotate') {
            for (let turns = 0; turns < args[0] / 90; ++turns) {
              const oldWidth = width,
                oldHeight = height,
                original = indices;
              width = oldHeight;
              height = oldWidth;
              indices = Array.from(
                { length: width * height },
                (_, j) => original[(j % width) * oldWidth + oldWidth - 1 - Math.floor(j / width)],
              );
            }
          } else {
            const original = indices;
            indices = Array.from(
              { length: width * height },
              (_, j) =>
                original[
                  args[0] === 'horizontal'
                    ? Math.floor(j / width) * width + width - 1 - (j % width)
                    : (height - 1 - Math.floor(j / width)) * width + (j % width)
                ],
            );
          }
        }
        const encoded = readFileSync(new URL(`./fixtures/${corpus}/geometry-${i}.heic`, import.meta.url));
        assert.equal(createHash('sha256').update(encoded).digest('hex'), checksums[`geometry-${i}.heic`]);
        const decoded = codec.decodePaired(encoded, ...limits),
          actual = pixels(decoded),
          expected = pixels(source);
        assert.deepEqual([decoded.width, decoded.height], [width, height]);
        for (let j = 0; j < indices.length; ++j)
          for (let ch = 0; ch < 4; ++ch) {
            assert.equal(actual[j * 4 + ch], expected[indices[j] * 4 + ch], `HDR case ${i} pixel ${j} channel ${ch}`);
            assert.equal(
              decoded.sdr[j * 4 + ch],
              source.sdr[indices[j] * 4 + ch],
              `SDR case ${i} pixel ${j} channel ${ch}`,
            );
          }
        for (const operation of [codec.inspect, codec.decode, codec.decodePaired])
          assert.throws(() => operation(encoded, width * height, limits[1]), { code: 'RESOURCE_LIMIT' });
      }

      if (corpus !== 'iso-quarter') return;
      const cropped = readFileSync(new URL('./fixtures/iso-quarter/geometry-0.heic', import.meta.url));
      const admitted = 65536 * 64 + 16384 * 16 + cropped.length * 2 + 512 * 16 * 16;
      assert.doesNotThrow(() => codec.decode(cropped, limits[0], admitted - 1));
      assert.throws(() => codec.decodePaired(cropped, limits[0], admitted - 1), { code: 'RESOURCE_LIMIT' });
      assert.doesNotThrow(() => codec.decodePaired(cropped, limits[0], admitted + 1));
      const reference = JSON.parse(readFileSync(new URL('./fixtures/iso-quarter/reference.json', import.meta.url)));
      assert.equal(createHash('sha256').update(input).digest('hex'), reference.sourceSha256);
      const values = pixels(source);
      let maximum = 0,
        squared = 0,
        count = 0;
      for (let row = 0; row < reference.rgb.length; ++row)
        for (let x = 0; x < reference.rgb[row].length; ++x)
          for (let ch = 0; ch < 3; ++ch) {
            const at =
              (reference.sampleY[row] * source.width + x * reference.sampleStep + reference.sampleOffset) * 4 + ch;
            const error = values[at] - reference.rgb[row][x][ch];
            maximum = Math.max(maximum, Math.abs(error));
            squared += error * error;
            ++count;
          }
      assert.ok(maximum < 0.1, `ISO quarter-map reference maximum ${maximum}`);
      assert.ok(Math.sqrt(squared / count) < 0.02, `ISO quarter-map reference RMS ${Math.sqrt(squared / count)}`);
    },
  );

test(
  'ISO 12-bit primary preserves low bits against independent HEVC and gain-map reconstruction',
  {
    skip: process.env.FRAMELEAF_HDR_ISO_TEST !== '1',
  },
  () => {
    const input = readFileSync(new URL('fixtures/iso-12bit/source.heic', import.meta.url));
    const reference = JSON.parse(readFileSync(new URL('fixtures/iso-12bit/reference.json', import.meta.url)));
    assert.equal(createHash('sha256').update(input).digest('hex'), reference.sourceSha256);
    const info = codec.inspect(input, ...limits);
    assert.equal(info.bitDepth, 12);
    assert.equal(info.reconstructionAvailable, true);
    const image = codec.decode(input, ...limits);
    assert.deepEqual([image.width, image.height, image.gamut], [reference.width, reference.height, 2]);
    const pixels = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
    let maximum = 0,
      squared = 0,
      count = 0;
    for (let row = 0; row < reference.rgb.length; row++)
      for (let x = 0; x < reference.rgb[row].length; x++)
        for (let c = 0; c < 3; c++) {
          const at = (reference.sampleY[row] * image.width + x * reference.sampleStep + reference.sampleOffset) * 4 + c;
          const error = pixels[at] - reference.rgb[row][x][c];
          maximum = Math.max(maximum, Math.abs(error));
          squared += error * error;
          count++;
        }
    // Half-float encoded RGB, analytic transfer and half-float linear output each contribute rounding.
    assert.ok(maximum < 0.007, `ISO 12-bit reference maximum ${maximum}`);
    assert.ok(Math.sqrt(squared / count) < 0.002, `ISO 12-bit reference RMS ${Math.sqrt(squared / count)}`);
    for (const x of [128, 256, 384]) {
      const lowBits = [4, 5, 6, 7].map((y) => pixels[(y * image.width + x) * 4]);
      assert.ok(
        lowBits.every((value, index) => index === 0 || value > lowBits[index - 1]),
        'low two bits must remain distinct',
      );
    }
    for (const operation of [codec.inspect, codec.decode, codec.decodePaired])
      assert.throws(() => operation(input, 1, limits[1]), { code: 'RESOURCE_LIMIT' });
  },
);

for (const [name, headroom, gamut, maximumBound, rmsBound] of [
  ['pq-candidate', 8, 2, 0.004, 0.0015],
  ['pq-colors', 8, 1, 0.08, 0.015],
  ['pq-alternate', 8, 1, 0.08, 0.015],
  ['hlg-candidate', 4, 2, 0.002, 0.0007],
]) {
  const input = readFileSync(new URL(`./fixtures/iso-hdr-base/${name}.heic`, import.meta.url));
  const reference = JSON.parse(
    readFileSync(new URL(`./fixtures/iso-hdr-base/${name}-reference.json`, import.meta.url)),
  );
  const sdrReference =
    name === 'pq-colors' || name === 'pq-alternate'
      ? JSON.parse(readFileSync(new URL(`./fixtures/iso-hdr-base/${name}-sdr-reference.json`, import.meta.url)))
      : null;
  test(
    `HDR-base ${name} retains the primary and reconstructs authored SDR rather than flattening it`,
    { skip: process.env.FRAMELEAF_HDR_ISO_TEST !== '1' },
    () => {
      const checksum = createHash('sha256').update(input).digest('hex');
      assert.equal(checksum, reference.sourceSha256);
      const info = codec.inspect(input, ...limits);
      assert.equal(info.reconstructionAvailable, true);
      assert.equal(info.contentHeadroom, headroom);
      const image = codec.decodePaired(input, ...limits);
      assert.deepEqual([image.width, image.height, image.gamut, image.sdrGamut], [1024, 32, gamut, 2]);
      const pixels = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
      let maximum = 0,
        squared = 0,
        count = 0,
        sdrMaximum = 0;
      for (let row = 0; row < reference.rgb.length; row++)
        for (let x = 0; x < reference.rgb[row].length; x++)
          for (let c = 0; c < 3; c++) {
            const at = (reference.sampleY[row] * image.width + x * 4 + 2) * 4 + c;
            const light = reference.rgb[row][x][c];
            const error = pixels[at] - light;
            maximum = Math.max(maximum, Math.abs(error));
            squared += error * error;
            count++;
            const sdr = Math.max(
              0,
              Math.min(1, sdrReference ? sdrReference.rgb[row][x][c] : (light + 0.00002) / headroom - 0.00001),
            );
            const gamma = sdr <= 0.0031308 ? sdr * 12.92 : 1.055 * sdr ** (1 / 2.4) - 0.055;
            sdrMaximum = Math.max(sdrMaximum, Math.abs(image.sdr[at] - Math.round(gamma * 255)));
          }
      assert.ok(maximum < maximumBound, `HDR maximum ${maximum}`);
      assert.ok(Math.sqrt(squared / count) < rmsBound, `HDR RMS ${Math.sqrt(squared / count)}`);
      assert.ok(sdrMaximum <= 1, `SDR maximum code error ${sdrMaximum}`);
      const exported = codec.encodePaired(
        image.data,
        image.width,
        image.height,
        image.gamut,
        ...limits,
        image.sdr,
        image.sdrGamut,
      );
      assert.equal(codec.inspect(exported, ...limits).reconstructionAvailable, true);
      if (name !== 'pq-alternate') {
        const encoded = readFileSync(new URL(`./fixtures/iso-hdr-base/${name}-export.jpg`, import.meta.url));
        const independent = JSON.parse(
          readFileSync(new URL(`./fixtures/iso-hdr-base/${name}-export-reference.json`, import.meta.url)),
        );
        assert.equal(createHash('sha256').update(encoded).digest('hex'), independent.sourceSha256);
        for (const bytes of [encoded, exported]) {
          const reconstructed = codec.decode(bytes, ...limits);
          assert.equal(reconstructed.gamut, 2);
          const values = new Float32Array(
            reconstructed.data.buffer,
            reconstructed.data.byteOffset,
            reconstructed.data.length / 4,
          );
          let maximum = 0,
            squared = 0,
            count = 0;
          for (let row = 0; row < independent.rgb.length; ++row)
            for (let x = 0; x < independent.rgb[row].length; ++x)
              for (let c = 0; c < 3; ++c) {
                const at =
                  (independent.sampleY[row] * reconstructed.width +
                    x * independent.sampleStep +
                    independent.sampleOffset) *
                    4 +
                  c;
                const error = values[at] - independent.rgb[row][x][c];
                maximum = Math.max(maximum, Math.abs(error));
                squared += error * error;
                ++count;
              }
          assert.ok(maximum < 0.08, `independent export maximum ${maximum}`);
          assert.ok(Math.sqrt(squared / count) < 0.015, `independent export RMS ${Math.sqrt(squared / count)}`);
        }
      }

      assert.equal(createHash('sha256').update(input).digest('hex'), checksum);
    },
  );
}
const inverseInput = readFileSync(new URL('./fixtures/iso-hdr-base/pq-candidate.heic', import.meta.url));
test(
  'invalid inverse metadata and budgets cannot advertise reconstruction',
  { skip: process.env.FRAMELEAF_HDR_ISO_TEST !== '1' },
  () => {
    for (const operation of [codec.inspect, codec.decode, codec.decodePaired])
      assert.throws(() => operation(inverseInput, 1, limits[1]), { code: 'RESOURCE_LIMIT' });
    for (const offset of [38 + 16, 38 + 40 + 16, 38 + 80 + 16]) {
      const invalid = Buffer.from(inverseInput);
      const metadata = invalid.indexOf(Buffer.from('idat')) + 4;
      invalid.writeUInt32BE(0, metadata + offset);
      assert.equal(codec.inspect(invalid, ...limits).reconstructionAvailable, false);
      assert.throws(() => codec.decodePaired(invalid, ...limits));
    }
  },
);

test('Ultra HDR JPEG without a valid primary ICC cannot advertise or render reconstructed HDR', () => {
  const original = readFileSync(new URL('./fixtures/android-ultrahdr/cityscape.jpg', import.meta.url));
  const checksum = createHash('sha256').update(original).digest('hex');
  for (const invalid of ['missing', 'corrupt']) {
    const input = Buffer.from(original);
    const at = input.indexOf(invalid === 'missing' ? 'ICC_PROFILE\0' : 'acsp');
    assert.ok(at >= 0);
    // Keep segment lengths and MPF offsets intact: only remove routing or corrupt the profile signature.
    input.write(invalid === 'missing' ? 'ICC_MISSING' : 'xxxx', at);
    const info = codec.inspect(input, ...limits);
    assert.equal(info.dynamicRange, 'hdr');
    assert.equal(info.reconstructionAvailable, false, invalid);
    assert.equal(info.fallbackReason, 'hdr-profile-unsupported');
    for (const operation of [codec.decode, codec.decodePaired])
      assert.throws(() => operation(input, ...limits), { code: 'HDR_PROFILE_UNSUPPORTED' });
  }
  assert.equal(createHash('sha256').update(original).digest('hex'), checksum);
});

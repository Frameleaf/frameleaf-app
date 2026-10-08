import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeDevelopCleanup } from '../../dist/utils/develop-cleanup.js';
import { defaultDevelopRecipe, normalizeDevelopMasks } from '../../dist/utils/develop-recipe.js';
import { SharpProcessPool } from '../../dist/queue/sharp-pool.js';
import { SharpResourceLimitError } from '../../dist/queue/sharp-protocol.js';

const codec = createRequire(import.meta.url)(
  process.env.FRAMELEAF_HDR_BINDING ?? '/usr/local/lib/frameleaf/image-hdr.node',
);
const limits = [200_000_000, 1024 ** 3];

test('explicit SDR still export embeds sRGB, strips capture metadata and orients exactly once', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-photo-export-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 0 });
  const sharp = createRequire(import.meta.url)('sharp');
  try {
    const source = join(folder, 'source.jpg'),
      output = join(folder, 'still.jpg');
    const original = await sharp({ create: { width: 16, height: 8, channels: 3, background: '#808080' } })
      .withIccProfile('p3')
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Artist: 'private capture identity' } })
      .jpeg()
      .toBuffer();
    await writeFile(source, original);
    await pool.run('writeStrippedStill', [source, output, 'jpeg', 'srgb']);
    const result = await readFile(output),
      metadata = await sharp(result).metadata();
    assert.equal(metadata.width, 8);
    assert.equal(metadata.height, 16);
    assert.ok(metadata.icc);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(metadata.orientation, undefined);
    assert.equal(codec.inspect(result, ...limits).dynamicRange, 'sdr');
    assert.deepEqual(await readFile(source), original);
  } finally {
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('worker renditions retain authored SDR, HDR headroom, and the immutable source', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-hdr-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 0 });
  const generate = (input, outputs) => pool.run('generateHdrRenditions', [input, outputs]);
  try {
    const source = join(folder, 'source.jpg'),
      preview = join(folder, 'preview.jpg'),
      master = join(folder, 'master.jpg');
    const pixels = new Float32Array(64 * 64 * 4),
      sdr = Buffer.alloc(64 * 64 * 4, 60);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels.set([8, 8, 8, 1], i);
      sdr[i + 3] = 255;
    }
    const encoded = codec.encodePaired(Buffer.from(pixels.buffer), 64, 64, 1, ...limits, sdr, 0);
    const xml = Buffer.from(
      'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="49,16.0N" /></rdf:RDF></x:xmpmeta>',
    );
    const app1 = Buffer.alloc(4);
    app1.set([255, 225]);
    app1.writeUInt16BE(xml.length + 2, 2);
    const original = Buffer.concat([encoded.subarray(0, 2), app1, xml, encoded.subarray(2)]);
    await writeFile(source, original);
    const result = await generate(source, [{ path: preview, size: 32 }, { path: master }]);
    assert.deepEqual(
      result.map((r) => [r.width, r.height]),
      [
        [32, 32],
        [64, 64],
      ],
    );
    assert.deepEqual(await readFile(source), original);
    for (const path of [preview, master]) {
      const rendition = await readFile(path);
      assert.equal(rendition.includes(Buffer.from('GPSLatitude')), false);
      const paired = codec.decodePaired(rendition, ...limits);
      assert.equal(paired.sdrGamut, 0);
      for (let i = 0; i < paired.sdr.length; i++) assert.ok(Math.abs(paired.sdr[i] - (i % 4 === 3 ? 255 : 60)) <= 2);
      const linear = new Float32Array(paired.data.buffer, paired.data.byteOffset, paired.data.length / 4);
      assert.ok(linear[0] > 7.8);
    }
    await assert.rejects(generate(source, [{ path: source }]), /original/);
    await assert.rejects(generate(source, [{ path: preview }]), /EEXIST/);
    assert.deepEqual(await readFile(source), original);
    const attempt = join(folder, 'attempt.jpg');
    await assert.rejects(
      generate(source, [{ path: attempt }, { path: join(folder, 'missing', 'output.jpg') }]),
      /ENOENT/,
    );
    await assert.rejects(stat(attempt), { code: 'ENOENT' });
    assert.ok((await stat(preview)).size > 0);
  } finally {
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('one isolated Develop call publishes newly paired HDR and SDR without modifying the source', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-hdr-develop-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 0 });
  try {
    const pixels = new Float32Array(64 * 32 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([8, 8, 8, 1], i);
    const original = codec.encode(Buffer.from(pixels.buffer), 64, 32, 1, ...limits);
    const source = join(folder, 'source.jpg');
    await writeFile(source, original);
    const outputs = ['master-hdr', 'preview-hdr', 'master-sdr', 'preview-sdr'].map((name, i) => ({
      path: join(folder, `${name}.jpg`),
      size: i % 2 ? 16 : undefined,
      dynamicRange: i < 2 ? 'hdr' : 'sdr',
      histogram: i === 1,
    }));
    const result = await pool.run('generateHdrRenditions', [
      source,
      outputs,
      {
        recipe: { ...defaultDevelopRecipe(), exposure: -1, rotation: 90 },
        seed: 1,
        masks: {},
        fills: {},
      },
    ]);
    assert.deepEqual(
      result.map((r) => [r.width, r.height]),
      [
        [32, 64],
        [8, 16],
        [32, 64],
        [8, 16],
      ],
    );
    for (const { path } of outputs.slice(0, 2)) {
      const linear = codec.decode(await readFile(path), ...limits);
      const values = new Float32Array(linear.data.buffer, linear.data.byteOffset, linear.data.length / 4);
      assert.ok(values[0] > 3.7 && values[0] < 4.3, `exposure must halve HDR light: ${values[0]}`);
    }
    for (const { path } of outputs.slice(2))
      assert.equal(codec.inspect(await readFile(path), ...limits).dynamicRange, 'sdr');
    assert.equal(result[1].histogram.version, 1);
    assert.ok(result[1].histogram.peakStops > 1.9);
    assert.equal(result[1].histogram.samples, result[1].width * result[1].height);
    assert.deepEqual(await readFile(source), original);
    const maskId = '5'.repeat(64),
      fillId = '4'.repeat(64);
    const combinedPath = join(folder, 'combined.jpg');
    const combined = {
      recipe: {
        ...defaultDevelopRecipe(),
        exposure: 1,
        rotation: 90,
        sharpen: 50,
        noiseReduction: 50,
        clarity: 50,
        masks: normalizeDevelopMasks([{ id: 'sky', kind: 'sky', artifact: maskId, adjustments: { exposure: 1 } }]),
        cleanup: normalizeDevelopCleanup([
          { id: 'fill', method: 'remove', fill: fillId, feather: 0, region: { x: 0, y: 0, w: 1, h: 1 } },
        ]),
      },
      seed: 7,
      masks: { [maskId]: { data: Buffer.alloc(64 * 32, 255), width: 64, height: 32, channels: 1 } },
      fills: { [fillId]: { data: Buffer.alloc(64 * 32 * 4, 255), width: 64, height: 32, channels: 4 } },
    };
    await pool.run('generateHdrRenditions', [source, [{ path: combinedPath }], combined]);
    const combinedImage = codec.decode(await readFile(combinedPath), ...limits);
    const combinedPixels = new Float32Array(
      combinedImage.data.buffer,
      combinedImage.data.byteOffset,
      combinedImage.data.length / 4,
    );
    assert.ok(
      combinedPixels[0] > 3.7 && combinedPixels[0] < 4.3,
      `SDR fill must receive fresh tone/mask gain, not the source gain: ${combinedPixels[0]}`,
    );
    const missingPath = join(folder, 'missing-mask.jpg');
    await assert.rejects(
      pool.run('generateHdrRenditions', [source, [{ path: missingPath }], { ...combined, masks: {} }]),
      /MISSING_DEVELOP_ARTIFACT/,
    );
    await assert.rejects(stat(missingPath), { code: 'ENOENT' });
    const limited = new SharpProcessPool({ workers: 1, pending: 0, maxBytes: original.length + 64 * 32 * 96 });
    try {
      await assert.rejects(
        limited.run('generateHdrRenditions', [
          source,
          [{ path: join(folder, 'limited.jpg') }],
          {
            recipe: {
              ...defaultDevelopRecipe(),
              masks: normalizeDevelopMasks([
                {
                  id: 'brush',
                  kind: 'brush',
                  strokes: [{ points: [[0.5, 0.5]], radius: 0.3 }],
                  adjustments: { exposure: 0.1 },
                },
              ]),
            },
            seed: 1,
            masks: {},
            fills: {},
          },
        ]),
        (error) => error instanceof SharpResourceLimitError,
      );
      await assert.rejects(stat(join(folder, 'limited.jpg')), { code: 'ENOENT' });
    } finally {
      await limited.close();
    }
    const attempt = join(folder, 'attempt.jpg');
    await assert.rejects(
      pool.run('generateHdrRenditions', [
        source,
        [{ path: attempt }, { path: join(folder, 'absent', 'failure.jpg') }],
        { recipe: defaultDevelopRecipe(), seed: 1, masks: {}, fills: {} },
      ]),
      /ENOENT/,
    );
    await assert.rejects(stat(attempt), { code: 'ENOENT' });
    for (const { path } of outputs) assert.ok((await stat(path)).size > 0);
  } finally {
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('capability probing stays inside the admitted image worker', async () => {
  const pool = new SharpProcessPool({ workers: 1, pending: 0 });
  try {
    assert.deepEqual(await pool.run('getHdrCodecCapabilities', []), { ...codec.capabilities(), heicPqEncoder: true });
  } finally {
    await pool.close();
  }
});

test('existing worker generates validated PQ HEIC without rewriting the source or leaking capture metadata', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-heic-export-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 0 });
  try {
    const source = join(folder, 'source.jpg'),
      output = join(folder, 'still.heic');
    const pixels = new Float32Array(64 * 64 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([8, 8, 8, 1], i);
    const original = codec.encode(Buffer.from(pixels.buffer), 64, 64, 1, ...limits);
    await writeFile(source, original);
    const results = await pool.run('generateHdrRenditions', [source, [{ path: output, format: 'heic' }]]);
    assert.equal(results[0].encoding.bitDepth, 10);
    const encoded = await readFile(output),
      metadata = codec.inspect(encoded, ...limits);
    assert.equal(metadata.transfer, 16);
    assert.equal(metadata.colorPrimaries, 12);
    const decoded = codec.decode(encoded, ...limits);
    const data = new Float32Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length / 4);
    assert.ok(Math.abs(data[0] - 8) < 0.3);
    const sharp = createRequire(import.meta.url)('sharp');
    assert.equal((await sharp(encoded).metadata()).exif, undefined);
    assert.deepEqual(await readFile(source), original);
    await assert.rejects(
      pool.run('generateHdrRenditions', [source, [{ path: output, format: 'heic', dynamicRange: 'sdr' }]]),
      /INVALID_HDR_OUTPUT_FORMAT/,
    );
  } finally {
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('unedited still exports bind decoded bytes to the original checksum and regenerate HDR metadata', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-original-still-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 0 });
  const pixels = new Float32Array(16 * 16 * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set([4, 2, 1, 1], index);
  const original = codec.encode(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), 16, 16, 1, ...limits);
  const source = join(folder, 'original.jpg');
  await writeFile(source, original);
  try {
    for (const [format, extension] of [
      ['sdr-jpeg', 'jpg'],
      ['hdr-jpeg', 'jpg'],
      ['hdr-heic', 'heic'],
    ]) {
      const output = join(folder, `${format}.${extension}`);
      const checksum = createHash(format === 'sdr-jpeg' ? 'sha1' : 'sha256')
        .update(original)
        .digest();
      await pool.run('exportPhotoStill', [source, output, format, checksum]);
      const result = await readFile(output);
      const metadata = codec.inspect(result, ...limits);
      assert.equal(metadata.dynamicRange, format === 'sdr-jpeg' ? 'sdr' : 'hdr');
      if (format === 'hdr-heic') {
        assert.equal(metadata.bitDepth, 10);
        assert.equal(metadata.transfer, 16);
      }
      if (format !== 'sdr-jpeg') {
        const decoded = codec.decode(result, ...limits);
        const rgba = new Float32Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length / 4);
        assert.ok(Math.max(...rgba.subarray(0, 3)) > 1, 'export retains headroom');
      }
    }
    const refused = join(folder, 'changed.jpg');
    await assert.rejects(
      pool.run('exportPhotoStill', [source, refused, 'sdr-jpeg', Buffer.alloc(32)]),
      /IMAGE_SOURCE_CHANGED/,
    );
    await assert.rejects(stat(refused), { code: 'ENOENT' });
    assert.deepEqual(await readFile(source), original);
  } finally {
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  }
});

for (const fixture of ['pq-rotated.avif', 'apple-gain-map-p3.heic']) {
  test(`still export refuses unreconstructible HDR (${fixture}) without publishing an SDR conversion`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'frameleaf-unsupported-hdr-'));
    const pool = new SharpProcessPool({ workers: 1, pending: 0 });
    try {
      const bytes = await readFile(new URL(`./fixtures/${fixture}`, import.meta.url));
      if (fixture.endsWith('.avif')) bytes.write('tmap', 16, 'ascii');
      else bytes.write('65537', bytes.indexOf('65536'));
      const encoding = await pool.run('inspectImageEncoding', [bytes]);
      assert.equal(encoding.dynamicRange, 'hdr');
      assert.equal(encoding.reconstructionAvailable, false);
      if (fixture.endsWith('.heic')) {
        assert.equal(encoding.fallbackReason, 'apple-gain-map-interpretation-unqualified');
      }
      const source = join(folder, fixture);
      await writeFile(source, bytes);
      const checksum = createHash('sha256').update(bytes).digest();
      for (const format of ['sdr-jpeg', 'hdr-jpeg', 'hdr-heic']) {
        const output = join(folder, `${format}.out`);
        await assert.rejects(
          pool.run('exportPhotoStill', [source, output, format, checksum]),
          /HDR_RECONSTRUCTION_UNAVAILABLE/,
        );
        await assert.rejects(stat(output), { code: 'ENOENT' });
      }
      assert.deepEqual(await readFile(source), bytes);
    } finally {
      await pool.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
}

test('Apple HEIC traverses HDR renditions, Develop and exports while retaining its source and SDR appearance', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-apple-hdr-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 0 });
  try {
    const original = await readFile(new URL('./fixtures/apple-gain-map-p3.heic', import.meta.url));
    const source = join(folder, 'source.heic');
    await writeFile(source, original);
    const baseline = codec.decodePaired(original, ...limits);
    const master = join(folder, 'master.jpg'),
      edited = join(folder, 'edited.jpg');
    await pool.run('generateHdrRenditions', [source, [{ path: master }]]);
    const pair = codec.decodePaired(await readFile(master), ...limits);
    for (let i = 0; i < pair.sdr.length; i++) assert.ok(Math.abs(pair.sdr[i] - baseline.sdr[i]) <= 2);
    await pool.run('generateHdrRenditions', [
      source,
      [{ path: edited }],
      {
        recipe: { ...defaultDevelopRecipe(), exposure: 1, rotation: 90 },
        seed: 1,
        masks: {},
        fills: {},
      },
    ]);
    const hdr = codec.decode(await readFile(edited), ...limits);
    assert.deepEqual([hdr.width, hdr.height], [32, 64]);
    const values = new Float32Array(hdr.data.buffer, hdr.data.byteOffset, hdr.data.length / 4);
    assert.ok(Math.max(...values) > 1.8, 'Develop must retain edited values above reference white');
    const checksum = createHash('sha256').update(original).digest();
    for (const format of ['sdr-jpeg', 'hdr-jpeg', 'hdr-heic']) {
      const path = join(folder, `${format}.out`);
      await pool.run('exportPhotoStill', [source, path, format, checksum]);
      const encoded = await readFile(path),
        info = codec.inspect(encoded, ...limits);
      assert.equal(info.dynamicRange, format === 'sdr-jpeg' ? 'sdr' : 'hdr');
      assert.equal(encoded.includes(Buffer.from('Apple iOS')), false);
      if (format !== 'sdr-jpeg') assert.equal(codec.decode(encoded, ...limits).height, 32);
    }
    assert.deepEqual(await readFile(source), original);
  } finally {
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  }
});

// Opt-in until the ISO HEIF codec port is qualified and installed in the target build.
test(
  'ISO HEIC retains its authored SDR appearance through the admitted rendition worker',
  {
    skip: process.env.FRAMELEAF_HDR_ISO_TEST !== '1',
  },
  async () => {
    const input = new URL('./fixtures/apple-iso-gain-map.heic', import.meta.url);
    const original = await readFile(input);
    assert.equal(codec.inspect(original, ...limits).reconstructionAvailable, true);
    const base = codec.decodePaired(original, ...limits);
    const folder = await mkdtemp(join(tmpdir(), 'frameleaf-iso-worker-'));
    const pool = new SharpProcessPool({ workers: 1, pending: 0 });
    try {
      const output = join(folder, 'rendition.jpg');
      await pool.run('generateHdrRenditions', [original, [{ path: output }]]);
      const actual = codec.decodePaired(await readFile(output), ...limits);
      assert.equal(actual.sdrGamut, base.sdrGamut);
      assert.deepEqual([actual.width, actual.height], [base.width, base.height]);
      let maximum = 0,
        squared = 0,
        count = 0;
      for (let i = 0; i < actual.sdr.length; i++)
        if (i % 4 !== 3) {
          const error = actual.sdr[i] - base.sdr[i];
          maximum = Math.max(maximum, Math.abs(error));
          squared += error * error;
          count++;
        }
      const rms = Math.sqrt(squared / count);
      assert.ok(maximum <= 8 && rms <= 2, `authored SDR error max ${maximum}, RMS ${rms}`);
      assert.deepEqual(await readFile(input), original);
    } finally {
      await pool.close();
      await rm(folder, { recursive: true, force: true });
    }
  },
);

for (const [fixture, peak] of [
  ['iso-gain-map-10bit.heic', 16],
  ['iso-hdr-base/pq-candidate.heic', 16],
  ['iso-hdr-base/hlg-candidate.heic', 8],
])
  test(
    `${fixture} Develop retains edited headroom and the immutable still`,
    {
      skip: process.env.FRAMELEAF_HDR_ISO_TEST !== '1',
    },
    async () => {
      const input = await readFile(new URL(`./fixtures/${fixture}`, import.meta.url));
      const folder = await mkdtemp(join(tmpdir(), 'frameleaf-iso-10bit-develop-'));
      const pool = new SharpProcessPool({ workers: 1, pending: 0 });
      try {
        const source = join(folder, 'original.heic');
        await writeFile(source, input);
        const output = join(folder, 'edited-hdr.jpg');
        await pool.run('generateHdrRenditions', [
          source,
          [{ path: output, dynamicRange: 'hdr' }],
          {
            recipe: { ...defaultDevelopRecipe(), exposure: 1, rotation: 90 },
            seed: 1,
            masks: {},
            fills: {},
          },
        ]);
        const result = codec.decode(await readFile(output), ...limits);
        assert.deepEqual([result.width, result.height], [32, 1024]);
        const pixels = new Float32Array(result.data.buffer, result.data.byteOffset, result.data.length / 4);
        const highlight = pixels[((result.height - 8) * result.width + 16) * 4];
        assert.ok(highlight > peak * 0.93 && highlight < peak * 1.04, `edited highlight ${highlight}`);
        assert.deepEqual(await readFile(source), input);
      } finally {
        await pool.close();
        await rm(folder, { recursive: true, force: true });
      }
    },
  );

test('explicit SDR export remains available when primary ICC blocks HDR reconstruction', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-hdr-profile-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 0 });
  const sharp = createRequire(import.meta.url)('sharp');
  try {
    const pixels = new Float32Array(16 * 8 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([2, 2, 2, 1], i);
    const encoded = codec.encode(Buffer.from(pixels.buffer), 16, 8, 0, ...limits);
    for (const invalid of ['missing', 'corrupt']) {
      const source = join(folder, `${invalid}.jpg`),
        output = join(folder, `${invalid}-sdr.jpg`);
      const bytes = Buffer.from(encoded);
      const at = bytes.indexOf(invalid === 'missing' ? 'ICC_PROFILE\0' : 'acsp');
      assert.ok(at >= 0);
      bytes.write(invalid === 'missing' ? 'ICC_MISSING' : 'xxxx', at);
      await writeFile(source, bytes);
      const checksum = createHash('sha256').update(bytes).digest();
      await pool.run('exportPhotoStill', [source, output, 'sdr-jpeg', checksum]);
      const result = await readFile(output),
        metadata = await sharp(result).metadata();
      assert.deepEqual([metadata.width, metadata.height], [16, 8]);
      assert.ok(metadata.icc);
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.xmp, undefined);
      assert.equal(codec.inspect(result, ...limits).dynamicRange, 'sdr');
      for (const format of ['hdr-jpeg', 'hdr-heic']) {
        const refused = join(folder, `${invalid}-${format}.out`);
        await assert.rejects(
          pool.run('exportPhotoStill', [source, refused, format, checksum]),
          /HDR_RECONSTRUCTION_UNAVAILABLE/,
        );
        await assert.rejects(stat(refused), { code: 'ENOENT' });
      }
      assert.deepEqual(await readFile(source), bytes);
    }
  } finally {
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  }
});

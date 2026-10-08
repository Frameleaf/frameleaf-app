import { watch, statSync } from 'node:fs';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises';
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

test('HDR rendering binds the decoded snapshot to its source checksum before producing any output', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-hdr-source-change-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 0 });
  try {
    const pixels = new Float32Array(16 * 8 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([8, 4, 2, 1], i);
    const original = codec.encode(Buffer.from(pixels.buffer), 16, 8, 1, ...limits);
    const source = join(folder, 'original.jpg');
    const prior = Buffer.from('previous working rendition');
    await writeFile(source, original);
    await writeFile(join(folder, 'prior.jpg'), prior);
    const develop = { recipe: defaultDevelopRecipe(), seed: 1, masks: {}, fills: {} };
    for (const recipe of [undefined, develop]) {
      const output = join(folder, 'attempt.jpg');
      await assert.rejects(
        pool.run('generateHdrRenditions', [source, [{ path: output }], recipe, Buffer.alloc(32, 1)]),
        /IMAGE_SOURCE_CHANGED/,
      );
      assert.deepEqual((await readdir(folder)).sort(), ['original.jpg', 'prior.jpg']);
      await assert.rejects(
        pool.run('generateHdrRenditions', [source, [{ path: output }], recipe, Buffer.alloc(31)]),
        /INVALID_HDR_SOURCE_CHECKSUM/,
      );
      for (const algorithm of ['sha1', 'sha256']) {
        const checksum = createHash(algorithm).update(original).digest();
        await pool.run('generateHdrRenditions', [source, [{ path: output }], recipe, checksum]);
        assert.equal(codec.inspect(await readFile(output), ...limits).dynamicRange, 'hdr');
        await rm(output);
      }
    }
    assert.deepEqual(await readFile(source), original);
    assert.deepEqual(await readFile(join(folder, 'prior.jpg')), prior);
  } finally {
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('a native worker crash removes partial HDR output before queued work and a fresh retry', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-hdr-worker-crash-'));
  let child;
  const pool = new SharpProcessPool({
    workers: 1,
    pending: 1,
    createChild: () => {
      child = fork(new URL('../../dist/queue/sharp-worker.js', import.meta.url), [], {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [],
      });
      return child;
    },
  });
  let watcher;
  try {
    const pixels = new Float32Array(1024 * 512 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([8, 4, 2, 1], i);
    const original = codec.encode(Buffer.from(pixels.buffer), 1024, 512, 1, ...limits);
    const source = join(folder, 'original.jpg');
    await writeFile(source, original);
    await writeFile(join(folder, 'prior.jpg'), 'previous working rendition');
    let killed;
    watcher = watch(folder, { recursive: true }, (_event, name) => {
      if (!killed && String(name).endsWith('preview.jpg')) {
        try {
          if (statSync(join(folder, String(name))).size > 0) {
            killed = child;
            child.kill('SIGKILL');
          }
        } catch {
          /* The native writer may have opened the file without writing yet. */
        }
      }
    });
    const outputs = [{ path: join(folder, 'preview.jpg'), size: 16 }, { path: join(folder, 'master.jpg') }];
    const failed = assert.rejects(pool.run('generateHdrRenditions', [source, outputs]), /Sharp child closed.*SIGKILL/);
    const queued = pool.run('inspectImageEncoding', [source]).then(async () => {
      assert.deepEqual((await readdir(folder)).sort(), ['original.jpg', 'prior.jpg']);
    });
    await Promise.all([failed, queued]);
    assert.ok(killed);
    assert.throws(() => process.kill(killed.pid, 0), { code: 'ESRCH' });
    await pool.run('generateHdrRenditions', [source, outputs]);
    assert.equal(codec.inspect(await readFile(outputs[1].path), ...limits).dynamicRange, 'hdr');
    assert.deepEqual(await readFile(source), original);
    assert.equal(await readFile(join(folder, 'prior.jpg'), 'utf8'), 'previous working rendition');
  } finally {
    watcher?.close();
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('ENOSPC during HDR publication rolls back the new set and permits a clean retry', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-hdr-disk-full-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 0 });
  const originalLink = fs.link;
  try {
    const pixels = new Float32Array(16 * 8 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([8, 4, 2, 1], i);
    const original = codec.encode(Buffer.from(pixels.buffer), 16, 8, 1, ...limits);
    const source = join(folder, 'original.jpg');
    await writeFile(source, original);
    await writeFile(join(folder, 'prior.jpg'), 'previous working rendition');
    const outputs = [{ path: join(folder, 'preview.jpg'), size: 16 }, { path: join(folder, 'master.jpg') }];
    let published = false;
    fs.link = async (source, destination) => {
      if (destination === outputs[1].path) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      await originalLink(source, destination);
      if (destination === outputs[0].path) published = true;
    };
    syncBuiltinESMExports();
    await assert.rejects(pool.run('generateHdrRenditions', [source, outputs]), { code: 'ENOSPC' });
    assert.equal(published, true);
    assert.deepEqual((await readdir(folder)).sort(), ['original.jpg', 'prior.jpg']);
    fs.link = originalLink;
    syncBuiltinESMExports();
    await pool.run('generateHdrRenditions', [source, outputs]);
    assert.equal(codec.inspect(await readFile(outputs[1].path), ...limits).dynamicRange, 'hdr');
    assert.deepEqual(await readFile(source), original);
    assert.equal(await readFile(join(folder, 'prior.jpg'), 'utf8'), 'previous working rendition');
  } finally {
    fs.link = originalLink;
    syncBuiltinESMExports();
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  }
});

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
    for (const invalid of ['missing', 'corrupt', 'custom-primaries', 'custom-transfer']) {
      const source = join(folder, `${invalid}.jpg`),
        output = join(folder, `${invalid}-sdr.jpg`);
      const bytes = Buffer.from(encoded);
      if (invalid.startsWith('custom-')) {
        const base = bytes.indexOf('ICC_PROFILE\0') + 14;
        assert.ok(base >= 14);
        const tag = invalid === 'custom-primaries' ? 'rXYZ' : 'rTRC';
        let changed = false;
        for (let i = 0; i < bytes.readUInt32BE(base + 128); i++) {
          const at = base + 132 + i * 12;
          if (bytes.toString('ascii', at, at + 4) === tag) {
            const data = base + bytes.readUInt32BE(at + 4);
            bytes.writeInt32BE(Math.round((tag === 'rXYZ' ? 0.65 : 1) * 65536), data + (tag === 'rXYZ' ? 8 : 12));
            changed = true;
            break;
          }
        }
        assert.ok(changed, invalid);
      } else {
        const at = bytes.indexOf(invalid === 'missing' ? 'ICC_PROFILE\0' : 'acsp');
        assert.ok(at >= 0);
        bytes.write(invalid === 'missing' ? 'ICC_MISSING' : 'xxxx', at);
      }
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

test('cancellation removes partial HDR outputs before admitting the next task', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-hdr-abort-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 1, graceMs: 100 });
  const keepAlive = setInterval(() => {}, 1000);
  let watcher;
  try {
    const pixels = new Float32Array(1024 * 512 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([8, 4, 2, 1], i);
    const original = codec.encode(Buffer.from(pixels.buffer), 1024, 512, 1, ...limits);
    const input = join(folder, 'original.jpg');
    const prior = Buffer.from('previous working rendition');
    await writeFile(input, original);
    await writeFile(join(folder, 'prior.jpg'), prior);
    const abort = new AbortController();
    let observed = false;
    watcher = watch(folder, { recursive: true }, (_event, name) => {
      // Observe the first actual output write, including inside parent-owned staging.
      if (String(name).endsWith('attempt-preview.jpg') && !observed) {
        observed = true;
        abort.abort(new Error('cancel after partial output'));
      }
    });
    const work = pool.run(
      'generateHdrRenditions',
      [input, [{ path: join(folder, 'attempt-preview.jpg'), size: 16 }, { path: join(folder, 'attempt-master.jpg') }]],
      abort.signal,
    );
    const failed = assert.rejects(work, /cancel after partial output/);
    const queued = pool.run('inspectImageEncoding', [input]).then(async () => {
      assert.deepEqual((await readdir(folder)).sort(), ['original.jpg', 'prior.jpg']);
    });
    await failed;
    await queued;
    assert.equal(observed, true);
    assert.deepEqual(await readFile(input), original);
    assert.deepEqual(await readFile(join(folder, 'prior.jpg')), prior);
  } finally {
    watcher?.close();
    await pool.close();
    clearInterval(keepAlive);
    await rm(folder, { recursive: true, force: true });
  }
});

test('HDR publication rolls back only its own files when a destination already exists', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-hdr-conflict-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 0 });
  try {
    const pixels = new Float32Array(16 * 8 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([8, 4, 2, 1], i);
    const original = codec.encode(Buffer.from(pixels.buffer), 16, 8, 1, ...limits);
    const input = join(folder, 'original.jpg'),
      first = join(folder, 'first.jpg'),
      prior = join(folder, 'prior.jpg');
    const previous = Buffer.from('keep this working rendition');
    await writeFile(input, original);
    await writeFile(prior, previous);
    await assert.rejects(pool.run('generateHdrRenditions', [input, [{ path: first }, { path: prior }]]), /EEXIST/);
    assert.deepEqual((await readdir(folder)).sort(), ['original.jpg', 'prior.jpg']);
    assert.deepEqual(await readFile(prior), previous);
    await assert.rejects(pool.run('generateHdrRenditions', [input, [{ path: input }]]), /overwrite original/);
    await assert.rejects(
      pool.run('exportPhotoStill', [input, input, 'hdr-jpeg', createHash('sha256').update(original).digest()]),
      /overwrite original/,
    );
    assert.deepEqual(await readFile(input), original);
    const results = await pool.run('generateHdrRenditions', [input, [{ path: first }]]);
    assert.equal(results[0].path, first);
    assert.deepEqual((await readdir(folder)).sort(), ['first.jpg', 'original.jpg', 'prior.jpg']);
  } finally {
    await pool.close();
    await rm(folder, { recursive: true, force: true });
  }
});

for (const operation of ['generateHdrRenditions', 'exportPhotoStill']) {
  test(`${operation} rolls back publication cancelled after the exclusive link`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'frameleaf-hdr-publish-abort-'));
    const pool = new SharpProcessPool({ workers: 1, pending: 1, graceMs: 100 });
    const keepAlive = setInterval(() => {}, 1000);
    const originalLink = fs.link;
    try {
      const pixels = new Float32Array(16 * 8 * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set([8, 4, 2, 1], i);
      const original = codec.encode(Buffer.from(pixels.buffer), 16, 8, 1, ...limits);
      const input = join(folder, 'original.jpg'),
        output = join(folder, 'published.jpg');
      await writeFile(input, original);
      const abort = new AbortController();
      let observed = false;
      // Cancel at the syscall boundary; filesystem notifications can arrive after completion.
      fs.link = async (source, destination) => {
        await originalLink(source, destination);
        if (destination === output) {
          observed = true;
          abort.abort(new Error('cancel during publication'));
        }
      };
      syncBuiltinESMExports();
      const work =
        operation === 'generateHdrRenditions'
          ? pool.run(operation, [input, [{ path: output }]], abort.signal)
          : pool.run(
              operation,
              [input, output, 'hdr-jpeg', createHash('sha256').update(original).digest()],
              abort.signal,
            );
      const failed = assert.rejects(work, /cancel during publication/);
      const queued = pool.run('inspectImageEncoding', [input]).then(async () => {
        assert.deepEqual(await readdir(folder), ['original.jpg']);
      });
      const queuedOutcome = queued.then(
        () => undefined,
        (error) => error,
      );
      await failed;
      const error = await queuedOutcome;
      if (error) throw error;
      assert.equal(observed, true);
      assert.deepEqual(await readFile(input), original);
    } finally {
      fs.link = originalLink;
      syncBuiltinESMExports();
      await pool.close();
      clearInterval(keepAlive);
      await rm(folder, { recursive: true, force: true });
    }
  });
}

test('failed owned-output cleanup closes admission instead of starting queued work', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-hdr-cleanup-failure-'));
  const pool = new SharpProcessPool({ workers: 1, pending: 1, graceMs: 100 });
  const originalRm = fs.rm;
  const keepAlive = setInterval(() => {}, 1000);
  let watcher;
  try {
    const pixels = new Float32Array(1024 * 512 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([8, 4, 2, 1], i);
    const original = codec.encode(Buffer.from(pixels.buffer), 1024, 512, 1, ...limits);
    const input = join(folder, 'original.jpg');
    await writeFile(input, original);
    fs.rm = async (file, options) => {
      if (String(file).startsWith(join(folder, '.sharp-'))) {
        throw Object.assign(new Error('owned cleanup denied'), { code: 'EACCES' });
      }
      return originalRm(file, options);
    };
    syncBuiltinESMExports();
    const abort = new AbortController();
    watcher = watch(folder, { recursive: true }, (_event, name) => {
      if (String(name).endsWith('preview.jpg')) abort.abort(new Error('cancel partial output'));
    });
    const work = pool.run(
      'generateHdrRenditions',
      [input, [{ path: join(folder, 'preview.jpg'), size: 16 }, { path: join(folder, 'master.jpg') }]],
      abort.signal,
    );
    const failed = assert.rejects(work, /owned cleanup denied/);
    const queued = assert.rejects(pool.run('inspectImageEncoding', [input]), /owned cleanup denied/);
    await Promise.all([failed, queued]);
    await assert.rejects(pool.run('inspectImageEncoding', [input]), /pool is closed/);
    assert.deepEqual(await readFile(input), original);
    assert.equal((await readdir(folder)).filter((name) => name.startsWith('.sharp-')).length, 2);
  } finally {
    fs.rm = originalRm;
    syncBuiltinESMExports();
    watcher?.close();
    await pool.close();
    clearInterval(keepAlive);
    await rm(folder, { recursive: true, force: true });
  }
});

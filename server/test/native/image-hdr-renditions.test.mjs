import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeDevelopCleanup } from '../../dist/utils/develop-cleanup.js';
import { defaultDevelopRecipe, normalizeDevelopMasks } from '../../dist/utils/develop-recipe.js';
import { SharpProcessPool } from '../../dist/queue/sharp-pool.js';

const codec = createRequire(import.meta.url)(
  process.env.FRAMELEAF_HDR_BINDING ?? '/usr/local/lib/frameleaf/image-hdr.node',
);
const limits = [200_000_000, 1024 ** 3];

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
        /combined surface budget/,
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

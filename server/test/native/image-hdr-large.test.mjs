import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Explicit opt-in: this regression exercises gigabytes of real codec surfaces.
test(
  '48 MP HDR survives reconstruction within an explicit surface budget',
  {
    skip: process.env.FRAMELEAF_HDR_LARGE_TEST !== '1',
    timeout: 180_000,
  },
  async () => {
    const { SharpProcessPool } = await import('../../dist/queue/sharp-pool.js');
    const codec = createRequire(import.meta.url)(
      process.env.FRAMELEAF_HDR_BINDING ?? '/usr/local/lib/frameleaf/image-hdr.node',
    );
    const width = 8000,
      height = 6000;
    const pixels = new Float32Array(width * height * 4);
    for (let index = 0; index < pixels.length; index += 4) pixels.set([8, 4, 2, 1], index);
    const source = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    const digest = () => createHash('sha256').update(source).digest('hex');
    const original = digest();
    assert.throws(() => codec.encode(source, width, height, 1, 200_000_000, 1024 ** 3), { code: 'RESOURCE_LIMIT' });
    const budget = 4 * 1024 ** 3;
    const encoded = codec.encode(source, width, height, 1, 200_000_000, budget);
    const metadata = codec.inspect(encoded, 200_000_000, budget);
    assert.equal(metadata.dynamicRange, 'hdr');
    assert.equal(metadata.reconstructionAvailable, true);
    const decoded = codec.decode(encoded, 200_000_000, budget);
    assert.deepEqual([decoded.width, decoded.height], [width, height]);
    const values = new Float32Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length / 4);
    const center = (3000 * width + 4000) * 4;
    // Use Display P3 for both input and output; RGB values cannot be compared across gamuts.
    assert.equal(decoded.gamut, 1);
    for (const [channel, expected] of [8, 4, 2, 1].entries())
      assert.ok(Math.abs(values[center + channel] - expected) < 0.5);
    assert.equal(digest(), original);
    console.log(
      JSON.stringify({
        fixture: 'synthetic-48mp',
        encodedBytes: encoded.length,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      }),
    );
    const folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-hdr-large-'));
    // Paired reconstruction also retains the authored SDR base and its gain map.
    const pool = new SharpProcessPool({ workers: 1, pending: 0, maxBytes: 6 * 1024 ** 3 });
    try {
      const preview = path.join(folder, 'preview.jpg'),
        master = path.join(folder, 'master.jpg');
      const outputs = await pool.run('generateHdrRenditions', [
        encoded,
        [{ path: preview, size: 256 }, { path: master }],
      ]);
      assert.deepEqual(
        outputs.map(({ width, height }) => [width, height]),
        [
          [256, 192],
          [width, height],
        ],
      );
      for (const { encoding } of outputs) {
        assert.equal(encoding.dynamicRange, 'hdr');
        assert.equal(encoding.reconstructionAvailable, true);
      }
      const restored = codec.decode(await readFile(preview), 200_000_000, budget);
      const sample = new Float32Array(restored.data.buffer, restored.data.byteOffset, restored.data.length / 4);
      assert.ok(sample[0] > 7 && sample[1] > 3 && sample[2] > 1);
    } finally {
      await pool.close();
      await rm(folder, { recursive: true, force: true });
    }
  },
);

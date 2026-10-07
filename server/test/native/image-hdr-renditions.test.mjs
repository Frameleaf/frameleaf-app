import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
    const original = codec.encodePaired(Buffer.from(pixels.buffer), 64, 64, 1, ...limits, sdr, 0);
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
      const paired = codec.decodePaired(await readFile(path), ...limits);
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

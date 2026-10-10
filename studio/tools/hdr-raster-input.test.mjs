import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { crc32, deflateSync } from 'node:zlib';
import { decodeHdrRaster } from './hdr-raster-input.mjs';
const sharp = createRequire(
  process.env.FRAMELEAF_RASTER_TEST_ENGINE ?? new URL('../engine/package.json', import.meta.url),
)('sharp');
function chunk(type, data) {
  const t = Buffer.from(type);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(data.length);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([n, t, data, c]);
}
function png(profile = Buffer.from([9, 16, 0, 1]), depth = 16) {
  const h = Buffer.alloc(13);
  h.writeUInt32BE(2);
  h.writeUInt32BE(1, 4);
  h[8] = depth;
  h[9] = 2;
  const s = Buffer.alloc(13);
  [32768, 32769, 32770, 32771, 32772, 32773].forEach((v, i) => s.writeUInt16BE(v, 1 + 2 * i));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', h),
    ...(profile ? [chunk('cICP', profile)] : []),
    chunk('IDAT', deflateSync(s)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
test('actual decoder preserves each adjacent real16bitPNG code', async () => {
  for (const transfer of [16, 18]) {
    const bytes = png(Buffer.from([9, transfer, 0, 1]));
    const original = Buffer.from(bytes);
    const got = await decodeHdrRaster(bytes, sharp);
    assert.deepEqual(Array.from(got.rgb), [32768, 32769, 32770, 32771, 32772, 32773]);
    assert.equal(got.transfer, transfer === 16 ? 'pq' : 'hlg');
    assert.deepEqual(bytes, original);
  }
});
test('ambiguous or unsupported profile and8bit refused', async () => {
  for (const bytes of [
    png(null),
    png(Buffer.from([1, 16, 0, 1])),
    png(Buffer.from([9, 16, 9, 1])),
    png(Buffer.from([9, 16, 0, 0])),
    png(undefined, 8),
  ])
    await assert.rejects(decodeHdrRaster(bytes, sharp));
});
test('corrupt/truncated PNG andpreabort refuse beforedecode', async () => {
  const bad = png();
  bad[bad.length - 1] ^= 1;
  await assert.rejects(decodeHdrRaster(bad, sharp));
  await assert.rejects(decodeHdrRaster(png().subarray(0, 25), sharp));
  const a = new AbortController();
  a.abort();
  await assert.rejects(
    decodeHdrRaster(
      png(),
      () => {
        throw new Error('decoder mustnotrun');
      },
      a.signal,
    ),
  );
});

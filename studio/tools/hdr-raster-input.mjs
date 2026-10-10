import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';

/** Decode only explicitly signalled, opaque BT.2020 PQ/HLG RGB16 PNG. */
export async function decodeHdrRaster(bytes, sharp, signal) {
  signal?.throwIfAborted();
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 32 * 1024 * 1024, 'RASTER_BYTE_LIMIT');
  assert.ok(
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'HDR_PNG_REQUIRED',
  );
  let header;
  let profile;
  let ended = false;
  const counts = new Map();
  for (let offset = 8; offset < bytes.length; ) {
    assert.ok(offset + 12 <= bytes.length && !ended, 'INVALID_HDR_PNG');
    const size = bytes.readUInt32BE(offset);
    assert.ok(size <= bytes.length - offset - 12, 'INVALID_HDR_PNG');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.ok(['IHDR', 'cICP', 'IDAT', 'IEND'].includes(type), 'AMBIGUOUS_HDR_PNG');
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    assert.equal(
      crc32(bytes.subarray(offset + 4, offset + 8 + size)),
      bytes.readUInt32BE(offset + 8 + size),
      'INVALID_HDR_PNG_CRC',
    );
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (type === 'IHDR') {
      assert.ok(offset === 8 && size === 13 && counts.get(type) === 1, 'INVALID_HDR_PNG');
      assert.ok(
        data[8] === 16 && data[9] === 2 && data[10] === 0 && data[11] === 0 && data[12] === 0,
        'RGB16_PNG_REQUIRED',
      );
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4) };
      assert.ok(
        header.width > 0 && header.height > 0 && header.width * header.height <= 48_000_000,
        'RASTER_PIXEL_LIMIT',
      );
    }
    if (type === 'cICP') {
      assert.ok(
        header && !counts.get('IDAT') && counts.get(type) === 1 && size === 4,
        'INVALID_HDR_PROFILE',
      );
      assert.ok(
        data[0] === 9 && [16, 18].includes(data[1]) && data[2] === 0 && data[3] === 1,
        'UNSUPPORTED_HDR_PROFILE',
      );
      profile = data[1] === 16 ? 'pq' : 'hlg';
    }
    if (type === 'IDAT') assert.ok(header && profile, 'EXPLICIT_HDR_PROFILE_REQUIRED');
    if (type === 'IEND') {
      assert.ok(size === 0 && counts.get('IDAT'), 'INVALID_HDR_PNG');
      ended = true;
    }
    offset += size + 12;
  }
  assert.ok(ended && profile, 'INVALID_HDR_PNG');
  const decoder = sharp(bytes, { limitInputPixels: 48_000_000, failOn: 'warning' }).timeout({
    seconds: 5,
  });
  try {
    const metadata = await decoder.metadata();
    assert.ok(
      metadata.depth === 'ushort' &&
        metadata.space === 'rgb16' &&
        !metadata.hasAlpha &&
        !metadata.hasProfile,
      'RGB16_PNG_REQUIRED',
    );
    signal?.throwIfAborted();
    const { data, info } = await decoder
      .toColourspace('rgb16')
      .raw({ depth: 'ushort' })
      .toBuffer({ resolveWithObject: true });
    try {
      signal?.throwIfAborted();
      assert.ok(
        info.width === header.width &&
          info.height === header.height &&
          info.channels === 3 &&
          info.depth === 'ushort' &&
          data.length === header.width * header.height * 6,
        'RASTER_DECODE_MISMATCH',
      );
      return {
        ...header,
        transfer: profile,
        rgb: Uint16Array.from(new Uint16Array(data.buffer, data.byteOffset, data.length / 2)),
      };
    } finally {
      data.fill(0);
    }
  } finally {
    decoder.destroy();
  }
}

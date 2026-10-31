import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LockedFileCorruptError,
  type LockedFileInfo,
  SEGMENT_SIZE,
  WrongSecretError,
  decryptFile,
  encryptFile,
  generateKeyPair,
  isLockedFile,
  keyId,
  openDecrypt,
  readHeader,
  rewrapFile,
  verifyFile,
} from '../src/index.js';

const SEALED = SEGMENT_SIZE + 16;
const info: LockedFileInfo = {
  assetId: '0b6e5c7e-3f0b-4c8e-9a51-2f1f3c4d5e6f',
  kind: 'original',
  originalFileName: 'IMG_0001.HEIC',
  mime: 'image/heic',
};

let dir: string;
let counter = 0;
const path = (name: string) => join(dir, `${counter++}-${name}`);
const owner = generateKeyPair();
const partner = generateKeyPair();
const stranger = generateKeyPair();

const collect = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** Reads until the stream fails; returns what was emitted before the failure and the error. */
const collectUntilError = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) chunks.push(chunk as Buffer);
  } catch (error) {
    return { emitted: Buffer.concat(chunks), error };
  }
  return { emitted: Buffer.concat(chunks), error: undefined };
};

const encrypted = async (plain: Buffer, recipients = [owner]) => {
  const src = path('plain');
  const dst = path('locked');
  await writeFile(src, plain);
  await encryptFile(
    src,
    dst,
    recipients.map(({ publicKey }) => ({ publicKey })),
    info,
  );
  return dst;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'locked-crypto-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('locked file format', () => {
  it('round-trips files of 0, 1, 65535, 65536, 65537 and 3×65536+7 bytes', async () => {
    for (const size of [0, 1, 65_535, 65_536, 65_537, 3 * 65_536 + 7]) {
      const plain = randomBytes(size);
      const src = path('plain');
      const dst = path('locked');
      const out = path('out');
      await writeFile(src, plain);
      await expect(encryptFile(src, dst, [{ publicKey: owner.publicKey }], info)).resolves.toEqual({
        plaintextLength: size,
      });
      expect((await readHeader(dst)).plaintextLength).toBe(size);
      await expect(decryptFile(dst, out, owner.privateKey)).resolves.toEqual(info);
      expect((await readFile(out)).equals(plain)).toBe(true);
    }
  });

  it('with verify, decrypts what it wrote with the file key and returns the SHA-256 of the plaintext', async () => {
    for (const size of [0, 1, SEGMENT_SIZE, 2 * SEGMENT_SIZE + 3]) {
      const plain = randomBytes(size);
      const src = path('plain');
      const dst = path('locked');
      await writeFile(src, plain);
      const result = await encryptFile(src, dst, [{ publicKey: owner.publicKey }], info, { verify: true });
      expect(result.plaintextLength).toBe(size);
      expect(result.sha256?.equals(createHash('sha256').update(plain).digest())).toBe(true);
      expect(await isLockedFile(dst)).toBe(true);
    }
  });

  it('writes the header and segment layout from the spec', async () => {
    const plain = randomBytes(SEGMENT_SIZE + 10);
    const dst = await encrypted(plain, [owner, partner]);
    const bytes = await readFile(dst);
    const header = await readHeader(dst);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('FLLK');
    expect(bytes[4]).toBe(1);
    expect(bytes.readBigUInt64BE(6)).toBe(BigInt(plain.length));
    expect(bytes.readUInt32BE(14)).toBe(SEGMENT_SIZE);
    expect(bytes[18]).toBe(2);
    expect(header.version).toBe(1);
    expect(header.keyIds).toEqual([keyId(owner.publicKey), keyId(partner.publicKey)]);
    expect(bytes.length).toBe(header.headerLength + SEALED + 10 + 16);
    expect(bytes.includes(plain.subarray(0, 32))).toBe(false);
  });

  it('serves any range', async () => {
    const plain = randomBytes(200_000);
    const dst = await encrypted(plain);
    for (const range of [
      { start: 65_530, end: 65_545 },
      { start: 196_600, end: 199_999 },
      { start: 0, end: 0 },
    ]) {
      const { stream, plaintextLength, info: opened } = await openDecrypt(dst, owner.privateKey, range);
      expect(plaintextLength).toBe(200_000);
      expect(opened).toEqual(info);
      expect((await collect(stream)).equals(plain.subarray(range.start, range.end + 1))).toBe(true);
    }
    await expect(openDecrypt(dst, owner.privateKey, { start: 10, end: 200_000 })).rejects.toThrow(RangeError);
  });

  it('opens with each recipient', async () => {
    const plain = randomBytes(1000);
    const dst = await encrypted(plain, [owner, partner]);
    for (const { privateKey } of [owner, partner]) {
      const { stream } = await openDecrypt(dst, privateKey);
      expect((await collect(stream)).equals(plain)).toBe(true);
    }
  });

  it('refuses a non-recipient', async () => {
    const dst = await encrypted(randomBytes(1000), [owner, partner]);
    await expect(openDecrypt(dst, stranger.privateKey)).rejects.toBeInstanceOf(WrongSecretError);
    await expect(verifyFile(dst, stranger.privateKey)).rejects.toBeInstanceOf(WrongSecretError);
  });

  describe('detects tampering', () => {
    const size = 3 * SEGMENT_SIZE + 7;
    let plain: Buffer;
    let original: Buffer;
    let headerLength: number;

    beforeAll(async () => {
      plain = randomBytes(size);
      const dst = await encrypted(plain);
      original = await readFile(dst);
      headerLength = (await readHeader(dst)).headerLength;
    });

    const segment = (bytes: Buffer, index: number) =>
      bytes.subarray(headerLength + index * SEALED, headerLength + (index + 1) * SEALED);

    const cases: Array<{ name: string; tamper: (bytes: Buffer) => Buffer; maxSegments: number }> = [
      {
        name: 'one byte flipped in segment 2',
        tamper: (bytes) => {
          const copy = Buffer.from(bytes);
          copy[headerLength + 2 * SEALED + 100]! ^= 0x01;
          return copy;
        },
        maxSegments: 2,
      },
      { name: 'the last segment truncated', tamper: (bytes) => bytes.subarray(0, bytes.length - 3), maxSegments: 0 },
      {
        name: 'segments 1 and 2 swapped',
        tamper: (bytes) =>
          Buffer.concat([
            bytes.subarray(0, headerLength),
            segment(bytes, 0),
            segment(bytes, 2),
            segment(bytes, 1),
            bytes.subarray(headerLength + 3 * SEALED),
          ]),
        maxSegments: 1,
      },
      {
        name: 'the last segment dropped',
        tamper: (bytes) => bytes.subarray(0, headerLength + 3 * SEALED),
        maxSegments: 0,
      },
    ];

    for (const { name, tamper, maxSegments } of cases) {
      it(name, async () => {
        const dst = path('tampered');
        await writeFile(dst, tamper(original));
        await expect(verifyFile(dst, owner.privateKey)).rejects.toBeInstanceOf(LockedFileCorruptError);

        const { stream } = await openDecrypt(dst, owner.privateKey);
        const { emitted, error } = await collectUntilError(stream);
        expect(error).toBeInstanceOf(LockedFileCorruptError);
        // Only whole segments that authenticated before the failure are ever emitted.
        expect(emitted.length).toBeLessThanOrEqual(maxSegments * SEGMENT_SIZE);
        expect(emitted.equals(plain.subarray(0, emitted.length))).toBe(true);

        const out = path('out');
        await expect(decryptFile(dst, out, owner.privateKey)).rejects.toBeInstanceOf(LockedFileCorruptError);
        await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    }

    it('emits the segments before a flipped byte and nothing after', async () => {
      const dst = path('tampered');
      await writeFile(dst, cases[0]!.tamper(original));
      const { stream } = await openDecrypt(dst, owner.privateKey);
      const { emitted } = await collectUntilError(stream);
      expect(emitted.equals(plain.subarray(0, 2 * SEGMENT_SIZE))).toBe(true);
    });

    it('a changed header', async () => {
      const dst = path('tampered');
      const copy = Buffer.from(original);
      copy[13]! ^= 0x01; // plaintext length, part of the HKDF salt
      await writeFile(dst, copy);
      await expect(verifyFile(dst, owner.privateKey)).rejects.toBeInstanceOf(LockedFileCorruptError);
    });

    it('a bad magic or version', async () => {
      for (const offset of [0, 4]) {
        const dst = path('tampered');
        const copy = Buffer.from(original);
        copy[offset]! ^= 0x01;
        await writeFile(dst, copy);
        await expect(readHeader(dst)).rejects.toBeInstanceOf(LockedFileCorruptError);
      }
    });
  });

  it('refuses to write over its own input', async () => {
    const src = path('plain');
    const plain = randomBytes(100);
    await writeFile(src, plain);
    await expect(encryptFile(src, src, [{ publicKey: owner.publicKey }], info)).rejects.toThrow(/must differ/);
    expect((await readFile(src)).equals(plain)).toBe(true);
  });

  it('isLockedFile is true for an encrypted file and false for a JPEG', async () => {
    const jpeg = path('photo.jpg');
    await writeFile(jpeg, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(500)]));
    const empty = path('empty');
    await writeFile(empty, Buffer.alloc(0));
    expect(await isLockedFile(await encrypted(randomBytes(10)))).toBe(true);
    expect(await isLockedFile(jpeg)).toBe(false);
    expect(await isLockedFile(empty)).toBe(false);
  });

  it('rewrapFile keeps the segments byte-identical after the header, and only the new recipients open the result', async () => {
    const plain = randomBytes(2 * SEGMENT_SIZE + 5);
    const src = await encrypted(plain, [owner]);
    const dst = path('rewrapped');
    await rewrapFile(src, dst, owner.privateKey, [{ publicKey: partner.publicKey }, { publicKey: stranger.publicKey }]);

    const before = await readFile(src);
    const after = await readFile(dst);
    const beforeHeader = await readHeader(src);
    const afterHeader = await readHeader(dst);
    expect(afterHeader.keyIds).toEqual([keyId(partner.publicKey), keyId(stranger.publicKey)]);
    expect(afterHeader.plaintextLength).toBe(plain.length);
    expect(after.subarray(afterHeader.headerLength).equals(before.subarray(beforeHeader.headerLength))).toBe(true);

    await expect(openDecrypt(dst, owner.privateKey)).rejects.toBeInstanceOf(WrongSecretError);
    for (const { privateKey } of [partner, stranger]) {
      const out = path('out');
      await expect(decryptFile(dst, out, privateKey)).resolves.toEqual(info);
      expect((await readFile(out)).equals(plain)).toBe(true);
    }
    await expect(
      rewrapFile(src, path('x'), stranger.privateKey, [{ publicKey: stranger.publicKey }]),
    ).rejects.toBeInstanceOf(WrongSecretError);
  });

  it('streams in constant memory', { timeout: 120_000 }, async () => {
    const sparse = async (size: number) => {
      const file = path('sparse');
      const handle = await open(file, 'w');
      await handle.close();
      await truncate(file, size);
      return file;
    };
    const roundTrip = async (src: string) => {
      const dst = path('locked');
      const out = path('out');
      await encryptFile(src, dst, [{ publicKey: owner.publicKey }], info);
      await verifyFile(dst, owner.privateKey);
      await decryptFile(dst, out, owner.privateKey);
      const { size } = await stat(out);
      await rm(dst);
      await rm(out);
      return size;
    };

    // Warm up first: the heap and buffer pool grow once on first use, whatever the file size.
    await roundTrip(await sparse(16 * 1024 * 1024));

    const size = 256 * 1024 * 1024;
    const src = await sparse(size);
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 20);
    try {
      expect(await roundTrip(src)).toBe(size);
    } finally {
      clearInterval(timer);
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(peak - baseline).toBeLessThan(64 * 1024 * 1024);
  });
});

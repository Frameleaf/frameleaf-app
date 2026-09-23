import { crc32, deflateRawSync } from 'node:zlib';
import {
  TakeoutZipError,
  TakeoutZipSource,
  readTakeoutZipDirectory,
  takeoutZipDataOffset,
  zipDosDate,
} from 'src/utils/takeout-zip.js';

/* A small ZIP writer, so the reader is tested against real archive bytes. */

type TestEntry = {
  name: string;
  data: Buffer;
  method?: 0 | 8 | 99;
  flags?: number;
  /** Write the sizes and offset as ZIP64 extra fields. */
  zip64?: boolean;
  /** Unix mode in the external attributes (made by Unix). */
  mode?: number;
};

const buildZip = (entries: TestEntry[], options: { zip64Directory?: boolean; spanned?: boolean } = {}): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 8;
    const payload = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0x8_00, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const extra = entry.zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0);
    if (entry.zip64) {
      extra.writeUInt16LE(0x00_01, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(entry.data.length), 4);
      extra.writeBigUInt64LE(BigInt(payload.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }

    const central = Buffer.alloc(46 + name.length + extra.length);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(entry.mode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(45, 6);
    central.writeUInt16LE(entry.flags ?? 0x8_00, 8);
    central.writeUInt16LE(method, 10);
    // 12 June 2021 10:30:00
    central.writeUInt16LE((10 << 11) | (30 << 5), 12);
    central.writeUInt16LE(((2021 - 1980) << 9) | (6 << 5) | 12, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.zip64 ? 0xff_ff_ff_ff : payload.length, 20);
    central.writeUInt32LE(entry.zip64 ? 0xff_ff_ff_ff : entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(entry.mode === undefined ? 0 : (entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(entry.zip64 ? 0xff_ff_ff_ff : offset, 42);
    name.copy(central, 46);
    extra.copy(central, 46 + name.length);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const parts = [...locals, directory];

  if (options.zip64Directory) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06_06_4b_50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeUInt32LE(options.spanned ? 1 : 0, 16);
    record.writeUInt32LE(0, 20);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07_06_4b_50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(!options.zip64Directory && options.spanned ? 1 : 0, 4);
  eocd.writeUInt16LE(options.zip64Directory ? 0xff_ff : entries.length, 8);
  eocd.writeUInt16LE(options.zip64Directory ? 0xff_ff : entries.length, 10);
  eocd.writeUInt32LE(options.zip64Directory ? 0xff_ff_ff_ff : directory.length, 12);
  eocd.writeUInt32LE(options.zip64Directory ? 0xff_ff_ff_ff : offset, 16);
  parts.push(eocd);

  return Buffer.concat(parts);
};

const sourceOf = (bytes: Buffer): TakeoutZipSource => ({
  size: bytes.length,
  read: (position, length) => Promise.resolve(bytes.subarray(position, position + length)),
});

describe('readTakeoutZipDirectory', () => {
  it('lists entries with their sizes, compression and dates', async () => {
    const zip = buildZip([
      { name: 'Takeout/Google Photos/Trip/IMG_1.jpg', data: Buffer.alloc(4096, 1), method: 0 },
      { name: 'Takeout/Google Photos/Trip/IMG_1.jpg.json', data: Buffer.from('{"title":"IMG_1.jpg"}') },
    ]);

    const entries = await readTakeoutZipDirectory(sourceOf(zip));

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: 'Takeout/Google Photos/Trip/IMG_1.jpg',
      compression: 'store',
      compressedSize: 4096,
      uncompressedSize: 4096,
      localHeaderOffset: 0,
    });
    expect(entries[1]).toMatchObject({ compression: 'deflate', uncompressedSize: 21 });
    expect(entries[0].modifiedAt).toEqual(new Date(2021, 5, 12, 10, 30, 0));
    expect(entries[0].refused).toBeUndefined();
  });

  it('reads ZIP64 archives, which Takeout writes for large exports', async () => {
    const zip = buildZip(
      [
        { name: 'Takeout/Google Photos/IMG_2.jpg', data: Buffer.alloc(100, 2), zip64: true },
        { name: 'Takeout/Google Photos/IMG_3.jpg', data: Buffer.alloc(50, 3), zip64: true },
      ],
      { zip64Directory: true },
    );

    const entries = await readTakeoutZipDirectory(sourceOf(zip));

    expect(entries.map((entry) => entry.uncompressedSize)).toEqual([100, 50]);
    expect(entries[1].localHeaderOffset).toBeGreaterThan(0);
  });

  it('refuses a spanned archive', async () => {
    const zip = buildZip([{ name: 'a.jpg', data: Buffer.alloc(10) }], { zip64Directory: true, spanned: true });
    await expect(readTakeoutZipDirectory(sourceOf(zip))).rejects.toBeInstanceOf(TakeoutZipError);
  });

  it('refuses a file that is not a ZIP archive', async () => {
    await expect(readTakeoutZipDirectory(sourceOf(Buffer.alloc(100)))).rejects.toThrow(TakeoutZipError);
  });

  it('refuses an archive whose upload stopped part way', async () => {
    const zip = buildZip([{ name: 'a.jpg', data: Buffer.alloc(1000, 7), method: 0 }]);
    await expect(readTakeoutZipDirectory(sourceOf(zip.subarray(0, -10)))).rejects.toThrow(TakeoutZipError);
  });

  it('marks encrypted entries, links and unknown methods as refused instead of failing the archive', async () => {
    const zip = buildZip([
      { name: 'secret.jpg', data: Buffer.alloc(10), method: 0, flags: 0x8_01 },
      { name: 'link.jpg', data: Buffer.from('/etc/passwd'), method: 0, mode: 0o12_0777 },
      { name: 'odd.jpg', data: Buffer.alloc(10), method: 99 },
      { name: 'fine.jpg', data: Buffer.alloc(10), method: 0, mode: 0o10_0644 },
    ]);

    const entries = await readTakeoutZipDirectory(sourceOf(zip));

    expect(entries.map((entry) => entry.refused)).toEqual(['encrypted', 'link', 'compression', undefined]);
  });

  it('refuses an entry that inflates past the ratio limit', async () => {
    const zip = buildZip([{ name: 'bomb.jpg', data: Buffer.alloc(8 * 1024 * 1024) }]);
    await expect(readTakeoutZipDirectory(sourceOf(zip))).rejects.toThrow(/inflates more than/);
  });

  it('reads a name without the UTF-8 flag as UTF-8 when it is valid UTF-8', async () => {
    const zip = buildZip([{ name: 'café.jpg', data: Buffer.alloc(4), method: 0, flags: 0 }]);
    const entries = await readTakeoutZipDirectory(sourceOf(zip));
    expect(entries[0].name).toBe('café.jpg');
  });
});

describe('takeoutZipDataOffset', () => {
  it('points past the local header to the entry bytes', async () => {
    const data = Buffer.from('hello takeout');
    const zip = buildZip([{ name: 'a.txt', data, method: 0 }]);
    const [entry] = await readTakeoutZipDirectory(sourceOf(zip));

    const start = await takeoutZipDataOffset(sourceOf(zip), entry);

    expect(zip.subarray(start, start + entry.compressedSize).toString()).toBe('hello takeout');
  });
});

describe('entry bounds', () => {
  it('refuses an entry whose local header pushes its data into the next entry', async () => {
    const zip = buildZip([
      { name: 'a.jpg', data: Buffer.alloc(16, 1), method: 0 },
      { name: 'b.jpg', data: Buffer.alloc(16, 2), method: 0 },
    ]);
    // Claim a 40-byte extra field in the first local header, so its data would start in b.jpg.
    zip.writeUInt16LE(40, 28);
    const entries = await readTakeoutZipDirectory(sourceOf(zip));

    await expect(takeoutZipDataOffset(sourceOf(zip), entries[0])).rejects.toThrow(/runs into the entry after it/);
  });
});

describe('zipDosDate', () => {
  it('reads an invalid date as the epoch rather than guessing', () => {
    expect(zipDosDate(0, 0)).toEqual(new Date(0));
  });
});

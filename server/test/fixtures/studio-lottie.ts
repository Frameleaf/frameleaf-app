import { crc32, deflateRawSync } from 'node:zlib';

export type TestEntry = {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Override what the central directory declares, to test a lying archive. */
  declare?: { compressedSize?: number; uncompressedSize?: number; flags?: number; method?: number };
};

export const buildZip = (entries: TestEntry[], options: { eocdEntries?: number } = {}): Buffer => {
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
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.declare?.flags ?? 0, 8);
    central.writeUInt16LE(entry.declare?.method ?? method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.declare?.compressedSize ?? payload.length, 20);
    central.writeUInt32LE(entry.declare?.uncompressedSize ?? entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(options.eocdEntries ?? entries.length, 8);
  eocd.writeUInt16LE(options.eocdEntries ?? entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, eocd]);
};

export const lottieAnimation = (width = 64, height = 32, frameRate = 24, totalFrames = 48) => ({
  v: '5.7',
  w: width,
  h: height,
  fr: frameRate,
  ip: 0,
  op: totalFrames,
  layers: [],
});
export const ownedLottieArchive = (
  version: '1' | '2',
  options: {
    first?: Record<string, unknown>;
    selected?: Record<string, unknown>;
    manifest?: Record<string, unknown>;
    extra?: TestEntry[];
  } = {},
) => {
  const prefix = version === '2' ? 'a' : 'animations';
  return buildZip([
    { name: `${prefix}/first.json`, data: Buffer.from(JSON.stringify(options.first ?? lottieAnimation())) },
    {
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify(
          options.manifest ?? {
            version,
            animations: [{ id: 'first' }, { id: 'selected' }],
            initial: { animation: 'selected' },
          },
        ),
      ),
    },
    {
      name: `${prefix}/selected.json`,
      data: Buffer.from(JSON.stringify(options.selected ?? lottieAnimation(32, 64, 30, 90))),
    },
    ...(options.extra ?? []),
  ]);
};

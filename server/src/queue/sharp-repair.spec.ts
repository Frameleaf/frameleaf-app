import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp, { type JpegOptions } from 'sharp';
import { SharpOperations } from 'src/queue/sharp-operations.js';
import { STANDARD_DHT } from 'src/utils/jpeg-repair.js';

/** The segments of a JPEG header up to its first scan, as [marker, whole segment]. */
const segments = (bytes: Buffer) => {
  const found: Array<[number, Buffer]> = [];
  let position = 2;
  while (bytes[position + 1] !== 0xda) {
    const end = position + 2 + bytes.readUInt16BE(position + 2);
    found.push([bytes[position + 1], bytes.subarray(position, end)]);
    position = end;
  }
  return { found, scan: position };
};
const without = (bytes: Buffer, marker: number) => {
  const { found, scan } = segments(bytes);
  return Buffer.concat([
    bytes.subarray(0, 2),
    ...found.filter(([item]) => item !== marker).map(([, segment]) => segment),
    bytes.subarray(scan),
  ]);
};
/** Huffman tables as "class/id:bits+values" hex, whatever segments they came in. */
const huffmanTables = (bytes: Buffer) =>
  segments(bytes)
    .found.filter(([marker]) => marker === 0xc4)
    .flatMap(([, segment]) => {
      const tables: string[] = [];
      for (let index = 4; index < segment.length;) {
        const count = [...segment.subarray(index + 1, index + 17)].reduce((sum, value) => sum + value, 0);
        tables.push(segment.subarray(index, index + 17 + count).toString('hex'));
        index += 17 + count;
      }
      return tables;
    })
    .sort();
const pixels = (bytes: Buffer) => sharp(bytes).raw().toBuffer();

describe('SharpOperations.repairJpeg', () => {
  let directory: string;
  let good: Buffer;
  const sut = new SharpOperations();
  const picture = (width: number, height: number, options: JpegOptions = {}) =>
    sharp({ create: { width, height, channels: 3, background: 'teal' } })
      .composite([
        {
          input: Buffer.from(
            `<svg width="${width}" height="${height}"><circle cx="40" cy="40" r="30" fill="orange"/></svg>`,
          ),
        },
      ])
      .jpeg(options)
      .toBuffer();

  beforeAll(async () => {
    good = await picture(320, 240);
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sharp-repair-'));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  const repair = async (bytes: Buffer) => {
    const input = join(directory, 'broken.jpg');
    await writeFile(input, bytes);
    const result = await sut.repairJpeg(
      input,
      join(directory, 'out.jpg'),
      join(directory, 'preview.jpg'),
      join(directory, 'header.jpg'),
    );
    await expect(sharp(join(directory, 'preview.jpg')).metadata()).resolves.toMatchObject({ format: 'jpeg' });
    return { result, output: await readFile(join(directory, 'out.jpg')) };
  };

  it('keeps the picture exactly when only a header before it was wrong', async () => {
    // the same failure as "improper image header … ReadTGAImage": no JPEG marker at the start
    await expect(sharp(Buffer.concat([Buffer.alloc(128), good])).metadata()).rejects.toThrow();
    const { result, output } = await repair(Buffer.concat([Buffer.alloc(128), good]));
    expect(result).toEqual({ method: 'lossless', width: 320, height: 240, metadataKept: true });
    expect(output.equals(good)).toBe(true);
  });

  it('removes a duplicate start-of-image marker', async () => {
    const { result, output } = await repair(Buffer.concat([Buffer.from([0xff, 0xd8]), good]));
    expect(result.method).toBe('lossless');
    expect(output.equals(good)).toBe(true);
  });

  it('puts back a missing start-of-image marker', async () => {
    const { result, output } = await repair(Buffer.concat([Buffer.from('junk'), good.subarray(2)]));
    expect(result.method).toBe('lossless');
    expect(output.equals(good)).toBe(true);
  });

  it('rebuilds a cut-off file from what decodes', async () => {
    const { result, output } = await repair(good.subarray(0, Math.floor(good.length * 0.7)));
    expect(result).toMatchObject({ method: 'rebuilt', width: 320, height: 240 });
    await expect(sharp(output, { failOn: 'warning' }).raw().toBuffer()).resolves.toBeDefined();
  });

  it('trims zero padding after a cut', async () => {
    const cut = good.subarray(0, Math.floor(good.length * 0.7));
    const { result } = await repair(Buffer.concat([cut, Buffer.alloc(4096)]));
    expect(result).toMatchObject({ method: 'rebuilt', width: 320, height: 240 });
  });

  it('decodes past scrambled picture data', async () => {
    const scrambled = Buffer.from(good);
    const { scan } = segments(good);
    scrambled.fill(0xd8, scan + Math.floor((good.length - scan) / 2), scan + Math.floor((good.length - scan) / 2) + 64);
    const { result } = await repair(scrambled);
    expect(result).toMatchObject({ width: 320, height: 240 });
  });

  it('drops a broken metadata segment and says when the details went with it', async () => {
    const tagged = await sharp(good)
      .withExif({ IFD0: { Make: 'Old Camera Co', Software: 'x'.repeat(200) } })
      .toBuffer();
    const app1 = segments(tagged).found.find(([marker]) => marker === 0xe1)![1];
    const broken = Buffer.from(tagged);
    // a length running past the next marker: "Bogus marker length"
    broken.writeUInt16BE(app1.length + 40, tagged.indexOf(app1) + 2);
    const { result, output } = await repair(broken);
    expect(result).toEqual({ method: 'lossless', width: 320, height: 240, metadataKept: false });
    await expect(pixels(output)).resolves.toEqual(await pixels(tagged));
    // the original's header is handed over so the details can be copied back
    await expect(access(join(directory, 'header.jpg'))).resolves.toBeUndefined();
  });

  it('adds the standard Huffman tables a Motion-JPEG frame leaves out', async () => {
    const standard = await picture(320, 240, { optimiseCoding: false });
    expect(huffmanTables(standard)).toEqual(
      huffmanTables(Buffer.concat([Buffer.from([0xff, 0xd8]), STANDARD_DHT, Buffer.from([0xff, 0xda, 0, 2])])),
    );
    const { result, output } = await repair(without(standard, 0xc4));
    expect(result.method).toBe('lossless');
    await expect(pixels(output)).resolves.toEqual(await pixels(standard));
  });

  it('takes the whole picture when two files were joined and the first is broken', async () => {
    const { result, output } = await repair(Buffer.concat([good.subarray(0, 200), good]));
    expect(result.method).toBe('lossless');
    await expect(pixels(output)).resolves.toEqual(await pixels(good));
  });

  it('saves the embedded preview when the main picture is lost', async () => {
    const small = await picture(32, 24);
    const { scan } = segments(good);
    // the main picture's header survives, its data does not; a small preview follows
    const { result } = await repair(Buffer.concat([good.subarray(0, scan), Buffer.alloc(2048, 0x11), small]));
    expect(result).toMatchObject({ method: 'preview', width: 32, height: 24 });
  });

  it('converts another image format saved under a .jpg name', async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const { result, output } = await repair(png);
    expect(result).toMatchObject({ method: 'converted', width: 40, height: 30 });
    await expect(sharp(output).metadata()).resolves.toMatchObject({ format: 'jpeg' });
  });

  it('refuses a file with no picture in it', async () => {
    await expect(repair(Buffer.from('definitely not a jpeg'))).rejects.toThrow('JPEG_NOT_REPAIRABLE');
  });
});

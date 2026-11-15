import { brotliCompressSync } from 'node:zlib';

/**
 * Small synthetic fonts for the FL-1562 font import tests: an sfnt with the tables a font needs
 * (the outline tables hold placeholder bytes, which the import check does not draw), and a WOFF2
 * wrapping of the same tables with null transforms.
 */
export type StudioFontStub = {
  family?: string;
  subfamily?: string;
  weight?: number;
  italic?: boolean;
  flavor?: 'ttf' | 'otf';
  /** Leave this table out. */
  omit?: string;
  /** Write no OS/2 table. */
  noOs2?: boolean;
};

const utf16 = (text: string) => {
  const out = Buffer.alloc(text.length * 2);
  for (let index = 0; index < text.length; index++) {
    out.writeUInt16BE(text.codePointAt(index)!, index * 2);
  }
  return out;
};

const nameTable = (names: Array<[number, string]>) => {
  const strings = names.map(([, text]) => utf16(text));
  const header = Buffer.alloc(6 + names.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(names.length, 2);
  header.writeUInt16BE(header.length, 4);
  let offset = 0;
  for (const [index, [id]] of names.entries()) {
    const record = 6 + index * 12;
    header.writeUInt16BE(3, record);
    header.writeUInt16BE(1, record + 2);
    header.writeUInt16BE(0x04_09, record + 4);
    header.writeUInt16BE(id, record + 6);
    header.writeUInt16BE(strings[index].length, record + 8);
    header.writeUInt16BE(offset, record + 10);
    offset += strings[index].length;
  }
  return Buffer.concat([header, ...strings]);
};

export const studioFontTables = (options: StudioFontStub = {}): Array<[string, Buffer]> => {
  const { family = 'Brand Sans', subfamily = 'Regular', weight = 400, italic = false, flavor = 'ttf' } = options;
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00_01_00_00, 0);
  head.writeUInt32BE(0x5f_0f_3c_f5, 12);
  head.writeUInt16BE(1000, 18);
  head.writeUInt16BE((weight >= 700 ? 1 : 0) | (italic ? 2 : 0), 44);
  const maxp = Buffer.alloc(6);
  maxp.writeUInt32BE(0x00_00_50_00, 0);
  maxp.writeUInt16BE(2, 4);
  const os2 = Buffer.alloc(96);
  os2.writeUInt16BE(weight, 4);
  os2.writeUInt16BE(italic ? 0x01 : 0x40, 62);
  const tables: Array<[string, Buffer]> = [
    ['cmap', Buffer.alloc(4)],
    ['head', head],
    ['hhea', Buffer.alloc(36)],
    ['hmtx', Buffer.alloc(8)],
    ['maxp', maxp],
    [
      'name',
      nameTable([
        [1, family],
        [2, subfamily],
      ]),
    ],
    ...(options.noOs2 ? [] : ([['OS/2', os2]] as Array<[string, Buffer]>)),
    ...(flavor === 'ttf'
      ? ([
          ['glyf', Buffer.alloc(12)],
          ['loca', Buffer.alloc(6)],
        ] as Array<[string, Buffer]>)
      : ([['CFF ', Buffer.alloc(16)]] as Array<[string, Buffer]>)),
  ];
  return tables.filter(([tag]) => tag !== options.omit);
};

/** An sfnt (TrueType or OpenType) file. */
export const makeStudioFont = (options: StudioFontStub = {}): Buffer => {
  const tables = studioFontTables(options);
  const header = Buffer.alloc(12 + tables.length * 16);
  header.writeUInt32BE(options.flavor === 'otf' ? 0x4f_54_54_4f : 0x00_01_00_00, 0);
  header.writeUInt16BE(tables.length, 4);
  let offset = header.length;
  const bodies: Buffer[] = [];
  for (const [index, [tag, body]] of tables.entries()) {
    const record = 12 + index * 16;
    header.write(tag, record, 'latin1');
    header.writeUInt32BE(offset, record + 8);
    header.writeUInt32BE(body.length, record + 12);
    const padded = Buffer.alloc(Math.ceil(body.length / 4) * 4);
    body.copy(padded);
    bodies.push(padded);
    offset += padded.length;
  }
  return Buffer.concat([header, ...bodies]);
};

const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca'];

const base128 = (value: number) => {
  const out: number[] = [];
  do {
    out.unshift(value & 0x7f);
    value = Math.floor(value / 128);
  } while (value > 0);
  return out.map((byte, index) => (index < out.length - 1 ? byte | 0x80 : byte));
};

/** A WOFF2 file of the same tables, every one stored untransformed. */
export const makeStudioWoff2 = (options: StudioFontStub = {}): Buffer => {
  const tables = studioFontTables(options);
  const directory: number[] = [];
  for (const [tag, body] of tables) {
    const known = KNOWN.indexOf(tag);
    // `glyf` and `loca` are untransformed at version 3; every other table at version 0.
    const version = tag === 'glyf' || tag === 'loca' ? 3 : 0;
    if (known === -1) {
      directory.push((version << 6) | 63, ...Buffer.from(tag, 'latin1'));
    } else {
      directory.push((version << 6) | known);
    }
    directory.push(...base128(body.length));
  }
  const compressed = brotliCompressSync(Buffer.concat(tables.map(([, body]) => body)));
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(options.flavor === 'otf' ? 0x4f_54_54_4f : 0x00_01_00_00, 4);
  const length = 48 + directory.length + compressed.length;
  header.writeUInt32BE(length, 8);
  header.writeUInt16BE(tables.length, 12);
  header.writeUInt32BE(compressed.length, 20);
  return Buffer.concat([header, Buffer.from(directory), compressed]);
};

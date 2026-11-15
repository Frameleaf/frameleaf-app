/**
 * Font files a person keeps with a Studio project (FL-1562): TrueType and OpenType (sfnt) and
 * WOFF2. The bytes are untrusted, so they are read here before they are kept, never handed to a
 * font engine first: the table directory must be sane (every table inside the file, no duplicate
 * or unprintable tag, the tables a font needs present), the `head` table must carry its magic
 * number, and the name, weight and style are read from `name`, `OS/2` and `head` for the editor
 * to offer. A WOFF2 file is decompressed with a bounded output size to read the same tables.
 * Collections (.ttc, or a WOFF2 that holds one) and WOFF 1 files are refused.
 *
 * Framework-free: shared by the upload, the Buddy backup restore and the project font list.
 */
import { brotliDecompressSync } from 'node:zlib';

/** Largest font file kept with a project. A large CJK family file is about 20 MB. */
export const STUDIO_FONT_MAX_BYTES = 32 * 1024 * 1024;

/** A WOFF2 file decompresses to at most this many bytes of table data. */
const WOFF2_MAX_TABLE_BYTES = 128 * 1024 * 1024;

/** More tables than any real font has; bounds the directory read. */
const MAX_TABLES = 256;

export const STUDIO_FONT_CONTENT_TYPES = { ttf: 'font/ttf', otf: 'font/otf', woff2: 'font/woff2' } as const;
export type StudioFontFormat = keyof typeof STUDIO_FONT_CONTENT_TYPES;

export const isStudioFontContentType = (contentType: string): boolean =>
  Object.values(STUDIO_FONT_CONTENT_TYPES).includes(contentType as never);

export const studioFontFormatOf = (contentType: string): StudioFontFormat | undefined =>
  (Object.keys(STUDIO_FONT_CONTENT_TYPES) as StudioFontFormat[]).find(
    (format) => STUDIO_FONT_CONTENT_TYPES[format] === contentType,
  );

/** What a font file says about itself. */
export type StudioFontDescription = {
  format: StudioFontFormat;
  /** The typographic family (name ID 16), else the family (name ID 1). */
  family: string;
  /** The typographic subfamily (name ID 17), else the subfamily (name ID 2), e.g. "Bold Italic". */
  subfamily: string;
  /** `OS/2` usWeightClass, read as 100 to 900. */
  weight: number;
  style: 'normal' | 'italic';
  glyphs: number;
};

export class StudioFontFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioFontFileError';
  }
}

function refuse(message: string): never {
  throw new StudioFontFileError(message);
}

const tagAt = (bytes: Uint8Array, offset: number) => String.fromCodePoint(...bytes.subarray(offset, offset + 4));

/** The format a file's first four bytes name, or a refusal for a font Studio does not keep. */
export function studioFontSignature(head: Uint8Array): StudioFontFormat | undefined {
  if (head.length < 4) {
    return undefined;
  }
  const signature = tagAt(head, 0);
  if (signature === '\0\u{1}\0\0' || signature === 'true') {
    return 'ttf';
  }
  if (signature === 'OTTO') {
    return 'otf';
  }
  if (signature === 'wOF2') {
    return 'woff2';
  }
  if (signature === 'ttcf') {
    refuse('A font collection (.ttc) cannot be imported; import each font as its own file');
  } else if (signature === 'wOFF') {
    refuse('WOFF 1 fonts cannot be imported; use the .ttf, .otf or .woff2 file');
  }
  return undefined;
}

type Tables = Map<string, Uint8Array>;

const SFNT_REQUIRED = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name'];

/** Every table a font needs, and outlines of the kind its flavour says. */
const checkTableSet = (tags: Set<string>, flavor: 'ttf' | 'otf') => {
  for (const tag of SFNT_REQUIRED) {
    if (!tags.has(tag)) {
      refuse(`The font has no '${tag}' table`);
    }
  }
  if (flavor === 'ttf' ? !(tags.has('glyf') && tags.has('loca')) : !(tags.has('CFF ') || tags.has('CFF2'))) {
    refuse('The font has no glyph outlines');
  }
};

const checkTag = (tag: string) => {
  if (!/^[ -~]{4}$/.test(tag)) {
    refuse('The font has a table with an invalid name');
  }
};

/** The tables of an sfnt file: the directory read and checked, each table a view of the file. */
function readSfntTables(bytes: Uint8Array, flavor: 'ttf' | 'otf'): Tables {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) {
    refuse('The font file is truncated');
  }
  const count = view.getUint16(4);
  if (count === 0 || count > MAX_TABLES) {
    refuse('The font has no table directory');
  }
  const directoryEnd = 12 + count * 16;
  if (directoryEnd > bytes.length) {
    refuse('The font file is truncated');
  }
  const tables: Tables = new Map();
  for (let index = 0; index < count; index++) {
    const record = 12 + index * 16;
    const tag = tagAt(bytes, record);
    checkTag(tag);
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset < directoryEnd || offset + length > bytes.length) {
      refuse(`The font's '${tag.trim()}' table lies outside the file`);
    }
    if (tables.has(tag)) {
      refuse(`The font lists its '${tag.trim()}' table twice`);
    }
    tables.set(tag, bytes.subarray(offset, offset + length));
  }
  checkTableSet(new Set(tables.keys()), flavor);
  return tables;
}

/** The 63 tags a WOFF2 directory names by index (WOFF2 5.1). */
const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ',
  'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS',
  'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc',
  'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
]; // prettier-ignore

/** A WOFF2 UIntBase128: at most five bytes, no leading zero byte, no overflow past 32 bits. */
const readBase128 = (bytes: Uint8Array, cursor: { at: number }): number => {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    if (cursor.at >= bytes.length) {
      refuse('The font file is truncated');
    }
    const byte = bytes[cursor.at++];
    if (index === 0 && byte === 0x80) {
      refuse('The font has an invalid table directory');
    }
    if (value & 0xfe_00_00_00) {
      refuse('The font has an invalid table directory');
    }
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      return value;
    }
  }
  return refuse('The font has an invalid table directory');
};

/**
 * The untransformed tables of a WOFF2 file. The header must describe the file exactly, the table
 * data must decompress to precisely the lengths the directory gives, and no more than
 * {@link WOFF2_MAX_TABLE_BYTES}. Transformed tables (`glyf`, `loca`, `hmtx`) are counted, not read.
 */
function readWoff2Tables(bytes: Uint8Array): { tables: Tables; flavor: 'ttf' | 'otf' } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 48) {
    refuse('The font file is truncated');
  }
  const flavorTag = tagAt(bytes, 4);
  if (flavorTag === 'ttcf') {
    refuse('A font collection cannot be imported; import each font as its own file');
  }
  const flavor = flavorTag === 'OTTO' ? 'otf' : flavorTag === '\0\u{1}\0\0' ? 'ttf' : undefined;
  if (!flavor) {
    refuse('The WOFF2 file does not hold a TrueType or OpenType font');
  }
  if (view.getUint32(8) !== bytes.length) {
    refuse('The WOFF2 header does not match the file size');
  }
  const count = view.getUint16(12);
  if (count === 0 || count > MAX_TABLES || view.getUint16(14) !== 0) {
    refuse('The font has no table directory');
  }
  const compressedSize = view.getUint32(20);
  const cursor = { at: 48 };
  const directory: Array<{ tag: string; length: number; stored: number; transformed: boolean }> = [];
  for (let index = 0; index < count; index++) {
    if (cursor.at >= bytes.length) {
      refuse('The font file is truncated');
    }
    const flags = bytes[cursor.at++];
    let tag = WOFF2_KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      if (cursor.at + 4 > bytes.length) {
        refuse('The font file is truncated');
      }
      tag = tagAt(bytes, cursor.at);
      cursor.at += 4;
    }
    checkTag(tag);
    const version = flags >> 6;
    const length = readBase128(bytes, cursor);
    // `glyf` and `loca` are transformed at version 0; every other table at any other version.
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const stored = transformed ? readBase128(bytes, cursor) : length;
    if (directory.some((entry) => entry.tag === tag)) {
      refuse(`The font lists its '${tag.trim()}' table twice`);
    }
    directory.push({ tag, length, stored, transformed });
  }
  const total = directory.reduce((sum, entry) => sum + entry.stored, 0);
  if (total === 0 || total > WOFF2_MAX_TABLE_BYTES || cursor.at + compressedSize > bytes.length) {
    refuse('The WOFF2 table data is not valid');
  }
  let data: Buffer;
  try {
    data = brotliDecompressSync(bytes.subarray(cursor.at, cursor.at + compressedSize), { maxOutputLength: total });
  } catch {
    return refuse('The WOFF2 table data does not decompress');
  }
  if (data.length !== total) {
    refuse('The WOFF2 table data does not match its directory');
  }
  const tables: Tables = new Map();
  let offset = 0;
  for (const entry of directory) {
    if (!entry.transformed) {
      tables.set(entry.tag, new Uint8Array(data.buffer, data.byteOffset + offset, entry.stored));
    }
    offset += entry.stored;
  }
  checkTableSet(new Set(directory.map((entry) => entry.tag)), flavor);
  return { tables, flavor };
}

const decodeUtf16 = (bytes: Uint8Array) => {
  let text = '';
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    text += String.fromCodePoint((bytes[index] << 8) | bytes[index + 1]);
  }
  return text;
};

/** Readable text: no controls, no quotes or backslashes (it becomes a CSS family), one line. */
const cleanName = (text: string) =>
  text
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\u{0}-\u{1F}\u{7F}-\u{9F}"\\\u{D800}-\u{DFFF}\u{FFFE}\u{FFFF}]/gu, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 128);

/** Name records by ID, preferring Windows English, then any Windows or Unicode record, then Mac Roman. */
function readNames(table: Uint8Array): Map<number, string> {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  if (table.length < 6) {
    refuse("The font's 'name' table is truncated");
  }
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  if (6 + count * 12 > table.length) {
    refuse("The font's 'name' table is truncated");
  }
  const best = new Map<number, { rank: number; text: string }>();
  for (let index = 0; index < count; index++) {
    const record = 6 + index * 12;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const language = view.getUint16(record + 4);
    const id = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const start = storage + view.getUint16(record + 10);
    if (start + length > table.length) {
      refuse("The font's 'name' table is truncated");
    }
    const raw = table.subarray(start, start + length);
    let rank: number;
    let text: string;
    if (platform === 3 && [0, 1, 10].includes(encoding)) {
      rank = language === 0x04_09 ? 0 : 1;
      text = decodeUtf16(raw);
    } else if (platform === 0) {
      rank = 2;
      text = decodeUtf16(raw);
    } else if (platform === 1 && encoding === 0 && language === 0) {
      rank = 3;
      text = new TextDecoder('latin1').decode(raw);
    } else {
      continue;
    }
    const cleaned = cleanName(text);
    const current = best.get(id);
    if (cleaned && (!current || rank < current.rank)) {
      best.set(id, { rank, text: cleaned });
    }
  }
  return new Map([...best].map(([id, { text }]) => [id, text]));
}

/** `OS/2` usWeightClass as 100 to 900; a few old fonts write 1 to 9 for the hundreds. */
const weightOf = (value: number) => {
  const weight = value >= 1 && value <= 9 ? value * 100 : value;
  return Math.min(900, Math.max(100, weight || 400));
};

/**
 * Read a font file whole and describe it, or refuse it with a message a person can act on. The
 * file must be at most {@link STUDIO_FONT_MAX_BYTES} and one TrueType, OpenType or WOFF2 font.
 */
export function describeStudioFont(bytes: Uint8Array): StudioFontDescription {
  if (bytes.length > STUDIO_FONT_MAX_BYTES) {
    refuse(`A font may be at most ${STUDIO_FONT_MAX_BYTES / 1024 / 1024} MB`);
  }
  const format = studioFontSignature(bytes);
  if (!format) {
    return refuse('The file is not a TrueType, OpenType or WOFF2 font');
  }
  const tables =
    format === 'woff2' ? readWoff2Tables(bytes).tables : readSfntTables(bytes, format === 'otf' ? 'otf' : 'ttf');
  const head = tables.get('head')!;
  if (head.length < 54) {
    refuse("The font's 'head' table is truncated");
  }
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (headView.getUint32(12) !== 0x5f_0f_3c_f5) {
    refuse("The font's 'head' table is not valid");
  }
  const unitsPerEm = headView.getUint16(18);
  if (unitsPerEm < 16 || unitsPerEm > 16_384) {
    refuse('The font has an invalid em size');
  }
  const macStyle = headView.getUint16(44);
  const maxp = tables.get('maxp')!;
  if (maxp.length < 6) {
    refuse("The font's 'maxp' table is truncated");
  }
  const glyphs = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4);
  if (glyphs === 0) {
    refuse('The font has no glyphs');
  }
  let weight = macStyle & 1 ? 700 : 400;
  let italic = (macStyle & 2) !== 0;
  const os2 = tables.get('OS/2');
  if (os2 && os2.length >= 64) {
    const os2View = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
    weight = weightOf(os2View.getUint16(4));
    // fsSelection: ITALIC (bit 0) or OBLIQUE (bit 9).
    italic = (os2View.getUint16(62) & 0x02_01) !== 0;
  }
  const names = readNames(tables.get('name')!);
  const family = names.get(16) ?? names.get(1);
  if (!family) {
    refuse('The font has no family name');
  }
  return {
    format,
    family: family!,
    subfamily: names.get(17) ?? names.get(2) ?? '',
    weight,
    style: italic ? 'italic' : 'normal',
    glyphs,
  };
}

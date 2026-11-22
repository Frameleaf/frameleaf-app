import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STUDIO_FONT_MAX_BYTES,
  StudioFontFileError,
  describeStudioFont,
  isStudioFontContentType,
  studioFontFormatOf,
  studioFontSignature,
} from 'src/utils/studio-font-file.js';
import { makeStudioFont, makeStudioWoff2 } from 'test/fixtures/studio-font.stub.js';

const fonts = join(dirname(fileURLToPath(import.meta.url)), '../../resources/studio-fonts');
const inter = createRequire(import.meta.url).resolve('@fontsource/inter/package.json');

describe('studio font files (FL-1562)', () => {
  it('describes a TrueType font from its name, OS/2 and head tables', () => {
    expect(describeStudioFont(makeStudioFont({ family: 'Brand Sans', subfamily: 'Bold', weight: 700 }))).toEqual({
      format: 'ttf',
      family: 'Brand Sans',
      subfamily: 'Bold',
      weight: 700,
      style: 'normal',
      glyphs: 2,
    });
    expect(describeStudioFont(makeStudioFont({ flavor: 'otf', weight: 100, italic: true }))).toMatchObject({
      format: 'otf',
      weight: 100,
      style: 'italic',
    });
  });

  it('reads a WOFF2 font by decompressing its tables', () => {
    expect(describeStudioFont(makeStudioWoff2({ family: 'Brand Serif', weight: 900, italic: true }))).toMatchObject({
      format: 'woff2',
      family: 'Brand Serif',
      weight: 900,
      style: 'italic',
    });
  });

  it('reads the real bundled files: a decoded TrueType font and its WOFF2 twin', () => {
    expect(describeStudioFont(readFileSync(join(fonts, 'inter-latin-400-italic.ttf')))).toMatchObject({
      format: 'ttf',
      family: 'Inter',
      weight: 400,
      style: 'italic',
    });
    const woff2 = readFileSync(join(dirname(inter), 'files', 'inter-latin-700-normal.woff2'));
    expect(describeStudioFont(woff2)).toMatchObject({ format: 'woff2', family: 'Inter', weight: 700, style: 'normal' });
  });

  it('falls back to head when there is no OS/2 table, and reads weights 1 to 9 as hundreds', () => {
    expect(describeStudioFont(makeStudioFont({ noOs2: true, weight: 700, italic: true }))).toMatchObject({
      weight: 700,
      style: 'italic',
    });
    expect(describeStudioFont(makeStudioFont({ weight: 3 })).weight).toBe(300);
    expect(describeStudioFont(makeStudioFont({ weight: 1000 })).weight).toBe(900);
  });

  it('keeps a family name a CSS font string can carry', () => {
    expect(describeStudioFont(makeStudioFont({ family: ' Quote"d\u{7} \\Name ' })).family).toBe('Quoted Name');
  });

  it('refuses collections, WOFF 1 and files that are not fonts', () => {
    const header = (tag: string) => Buffer.concat([Buffer.from(tag, 'latin1'), Buffer.alloc(60)]);
    expect(() => studioFontSignature(header('ttcf'))).toThrow(/collection/);
    expect(() => studioFontSignature(header('wOFF'))).toThrow(/WOFF 1/);
    expect(studioFontSignature(header('RIFF'))).toBeUndefined();
    expect(() => describeStudioFont(header('RIFF'))).toThrow(StudioFontFileError);
    const woff2Collection = makeStudioWoff2();
    woff2Collection.write('ttcf', 4, 'latin1');
    expect(() => describeStudioFont(woff2Collection)).toThrow(/collection/);
  });

  it('refuses a table directory that is not sane', () => {
    expect(() => describeStudioFont(makeStudioFont({ omit: 'name' }))).toThrow(/'name' table/);
    expect(() => describeStudioFont(makeStudioFont({ omit: 'glyf' }))).toThrow(/outlines/);
    expect(() => describeStudioFont(makeStudioFont({ flavor: 'otf', omit: 'CFF ' }))).toThrow(/outlines/);

    const outside = makeStudioFont();
    outside.writeUInt32BE(outside.length, 12 + 8);
    expect(() => describeStudioFont(outside)).toThrow(/outside the file/);

    const twice = makeStudioFont();
    twice.write('head', 12 + 16 * 2, 'latin1');
    expect(() => describeStudioFont(twice)).toThrow(/twice/);

    const unprintable = makeStudioFont();
    unprintable.writeUInt8(0x01, 12);
    expect(() => describeStudioFont(unprintable)).toThrow(/invalid name/);

    const tooMany = makeStudioFont();
    tooMany.writeUInt16BE(1000, 4);
    expect(() => describeStudioFont(tooMany)).toThrow(/table directory/);

    expect(() => describeStudioFont(makeStudioFont().subarray(0, 40))).toThrow(/truncated/);
  });

  it('refuses a head table without its magic number and a font without glyphs or a family', () => {
    const font = makeStudioFont();
    const headOffset = font.readUInt32BE(12 + 16 + 8);
    font.writeUInt32BE(0, headOffset + 12);
    expect(() => describeStudioFont(font)).toThrow(/'head' table is not valid/);
    expect(() => describeStudioFont(makeStudioFont({ family: '\u{1}' }))).toThrow(/family name/);
  });

  it('refuses a WOFF2 file whose header or data does not match', () => {
    const resized = makeStudioWoff2();
    resized.writeUInt32BE(resized.length + 1, 8);
    expect(() => describeStudioFont(resized)).toThrow(/file size/);

    const corrupt = makeStudioWoff2();
    corrupt.fill(0xff, corrupt.length - 8);
    expect(() => describeStudioFont(corrupt)).toThrow(/WOFF2 table data/);

    const longer = makeStudioWoff2();
    // The first table claims a byte more than the stream holds.
    longer.writeUInt8(longer.readUInt8(49) + 1, 49);
    expect(() => describeStudioFont(longer)).toThrow(/WOFF2 table data/);
  });

  it('refuses a file larger than a kept font may be', () => {
    expect(() => describeStudioFont(new Uint8Array(STUDIO_FONT_MAX_BYTES + 1))).toThrow(/at most 32 MB/);
  });

  it('maps the three content types', () => {
    expect(studioFontFormatOf('font/woff2')).toBe('woff2');
    expect(studioFontFormatOf('font/woff')).toBeUndefined();
    expect(isStudioFontContentType('font/otf')).toBe(true);
    expect(isStudioFontContentType('image/png')).toBe(false);
  });
});

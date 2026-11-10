import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  fontFactsFromName,
  fontScripts,
  fontSpecimenText,
  hasFontSignature,
  isBrowserFont,
  readFontFacts,
} from 'src/utils/font-file.js';

const anton = () => readFileSync('resources/studio-fonts/anton-latin-400-normal.ttf');
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

// the real parser, with `create` replaceable for one test
vi.mock('fontkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fontkit')>();
  return { ...actual, create: vi.fn(actual.create) };
});

describe('font files (FL-1359)', () => {
  it.each([
    ['a.ttf', '00010000', true],
    ['a.otf', '4f54544f', true],
    ['a.TTC', '74746366', true],
    ['a.woff', '774f4646', true],
    ['a.woff2', '774f4632', true],
    ['a.dfont', '00000100', true],
    ['a.pfb', '8001aabb', true],
    ['a.pfa', '2521aabb', true],
    ['a.ttf', '4d5a9000', false], // a program renamed to .ttf
    ['a.woff2', '774f4646', false],
    ['a.jpg', '00010000', false],
    ['a.ttf', '', false],
  ])('checks the first bytes of %s (%s)', (name, hex, expected) => {
    expect(hasFontSignature(Buffer.from(hex, 'hex'), name)).toBe(expected);
  });

  it('knows which files a browser loads itself', () => {
    expect(['a.ttf', 'a.OTF', 'a.woff', 'a.woff2'].every((name) => isBrowserFont(name))).toBe(true);
    expect(['a.ttc', 'a.otc', 'a.dfont', 'a.pfb', 'a.pfa'].some((name) => isBrowserFont(name))).toBe(false);
  });

  it('reads the facts of a real font', () => {
    const { facts, sample } = readFontFacts(anton(), 'anton.ttf');
    expect(facts).toMatchObject({ family: 'Anton', style: 'Regular', weight: 400, italic: false, faces: [], axes: [] });
    expect(facts.glyphCount).toBeGreaterThan(100);
    expect(facts.scripts).toContain('latin');
    expect(facts.licenseUrl).toContain('OFL');
    expect(sample).toContain('Aa');
  });

  it('throws on a file that is not a font, and the name stands in', () => {
    expect(() => readFontFacts(Buffer.from('not a font at all'), 'x.ttf')).toThrow();
    expect(fontFactsFromName('Lodge Serif.pfb', { weight: 700 })).toMatchObject({
      family: 'Lodge Serif',
      weight: 700,
      glyphCount: 0,
      scripts: [],
    });
  });

  it('names a script only when the font covers enough of it', () => {
    expect(fontScripts(range(0x61, 0x7a))).toEqual(['latin']);
    expect(fontScripts(range(0x61, 0x70))).toEqual([]);
    expect(fontScripts([...range(0x61, 0x7a), ...range(0x4e_00, 0x52_00)])).toEqual(['han', 'latin']);
  });

  it('sets the specimen in the most distinctive script, or in the font’s own characters', () => {
    expect(fontSpecimenText(['han', 'latin'])).toContain('永');
    expect(fontSpecimenText(['latin', 'cyrillic'])).toContain('Aa');
    expect(fontSpecimenText([], [0x20, 0xe0_01, 0xe0_02])).toBe('');
    expect(fontSpecimenText([])).toBe('Aa');
  });

  it('never builds the font’s whole character list, which a hostile file can make billions long', async () => {
    const fontkit = await import('fontkit');
    const asked: number[] = [];
    const hostile = {
      familyName: 'Trap',
      get characterSet(): number[] {
        throw new Error('the whole character list was asked for');
      },
      hasGlyphForCodePoint: (point: number) => {
        asked.push(point);
        return point >= 0x61 && point <= 0x7a;
      },
    };
    vi.mocked(fontkit.create).mockReturnValueOnce(hostile as never);
    const { facts, sample } = readFontFacts(Buffer.alloc(8), 'trap.ttf');
    expect(facts).toMatchObject({ family: 'Trap', scripts: ['latin'] });
    expect(sample).toContain('Aa');
    // only the ranges that name a script are asked about: tens of thousands of lookups, not billions
    expect(asked.length).toBeLessThan(40_000);
  });
});

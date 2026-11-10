import * as fontkit from 'fontkit';
import { getFilenameExtension } from 'src/utils/file.js';

/**
 * FL-1359: fonts in Boards. What a font file says about itself, read with fontkit (pure JavaScript,
 * so a hostile file can at worst throw), and the words its specimen picture shows.
 */

/** A font is read whole to list its facts; anything larger keeps its name only. */
export const FONT_PARSE_LIMIT = 256 * 1024 * 1024;
const TEXT_MAX = 300;
const LICENCE_MAX = 4000;
const LIST_MAX = 256;
const FACES_MAX = 64;

export interface FontAxis {
  tag: string;
  name: string;
  min: number;
  default: number;
  max: number;
}
export interface FontInstance {
  name: string;
  coordinates: Record<string, number>;
}
export interface FontFace {
  family: string;
  style: string;
  weight: number | null;
  italic: boolean;
  glyphCount: number;
}
export interface FontFacts extends FontFace {
  axes: FontAxis[];
  instances: FontInstance[];
  features: string[];
  scripts: string[];
  license: string | null;
  licenseUrl: string | null;
  faces: FontFace[];
}

const SFNT = new Set(['00010000', '4f54544f', '74727565', '74797031', '74746366']); // 1.0, OTTO, true, typ1, ttcf
const SIGNATURES: Record<string, (head: Buffer) => boolean> = {
  '.ttf': (head) => SFNT.has(head.subarray(0, 4).toString('hex')),
  '.woff': (head) => head.subarray(0, 4).toString('latin1') === 'wOFF',
  '.woff2': (head) => head.subarray(0, 4).toString('latin1') === 'wOF2',
  // A resource-fork file: its data starts at byte 256.
  '.dfont': (head) => head.subarray(0, 4).toString('hex') === '00000100',
  '.pfb': (head) => head[0] === 0x80 && head[1] === 0x01,
  '.pfa': (head) => head.subarray(0, 2).toString('latin1') === '%!',
};
for (const extension of ['.otf', '.ttc', '.otc']) SIGNATURES[extension] = SIGNATURES['.ttf'];

/** Whether the first bytes of a file are those of the font type its name claims. */
export const hasFontSignature = (head: Buffer, filename: string): boolean =>
  SIGNATURES[getFilenameExtension(filename).toLowerCase()]?.(head) ?? false;

/** File types a browser loads itself, for the live type tester. Collections and Type 1 show the specimen only. */
export const isBrowserFont = (filename: string) =>
  ['.ttf', '.otf', '.woff', '.woff2'].includes(getFilenameExtension(filename).toLowerCase());

const clean = (value: unknown, max = TEXT_MAX) =>
  // eslint-disable-next-line no-control-regex
  (typeof value === 'string' ? value : '')
    .replaceAll(/[\u0000-\u001F\u007F]+/g, ' ')
    .trim()
    .slice(0, max);
const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const attempt = <T>(read: () => T, fallback: T): T => {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
};

/** The writing systems a font covers well enough to set a line in, most distinctive first. */
const SCRIPTS: { name: string; from: number; to: number; needs: number; sample: string }[] = [
  { name: 'han', from: 0x4e_00, to: 0x9f_ff, needs: 500, sample: '永字八法 風景写真' },
  { name: 'kana', from: 0x30_41, to: 0x30_96, needs: 40, sample: 'あいうえお かきくけこ' },
  { name: 'hangul', from: 0xac_00, to: 0xd7_a3, needs: 100, sample: '가나다라 마바사' },
  { name: 'arabic', from: 0x06_21, to: 0x06_4a, needs: 20, sample: 'أبجد هوز حطي' },
  { name: 'hebrew', from: 0x05_d0, to: 0x05_ea, needs: 20, sample: 'אבגד הוז חטי' },
  { name: 'devanagari', from: 0x09_05, to: 0x09_39, needs: 20, sample: 'अआइई कखगघ' },
  { name: 'thai', from: 0x0e_01, to: 0x0e_2e, needs: 20, sample: 'กขคง จฉชซ' },
  { name: 'latin', from: 0x61, to: 0x7a, needs: 26, sample: 'Aa Bb Cc\nHandgloves 0123' },
  { name: 'cyrillic', from: 0x04_10, to: 0x04_4f, needs: 32, sample: 'Аа Бб Вв\nШирокая 0123' },
  { name: 'greek', from: 0x03_91, to: 0x03_c9, needs: 20, sample: 'Αα Ββ Γγ\nΔοκιμή 0123' },
  { name: 'emoji', from: 0x1_f6_00, to: 0x1_f6_4f, needs: 20, sample: '😀🌿📷🎨' },
];

export function fontScripts(codePoints: Iterable<number>): string[] {
  const counts = new Array<number>(SCRIPTS.length).fill(0);
  for (const point of codePoints) {
    for (const [index, { from, to }] of SCRIPTS.entries()) {
      if (point >= from && point <= to) counts[index]++;
    }
  }
  return SCRIPTS.filter(({ needs }, index) => counts[index] >= needs).map(({ name }) => name);
}

/**
 * The words on the specimen picture: a line in the most distinctive script the font covers. A symbol
 * font (none of the scripts) shows its own first characters, so the picture is never set in another font.
 */
export function fontSpecimenText(scripts: string[], codePoints: number[] = []): string {
  const script = SCRIPTS.find(({ name }) => scripts.includes(name));
  if (script) return script.sample;
  const own = codePoints.filter((point) => point > 0x20 && (point < 0x7f || point > 0xa0)).slice(0, 12);
  return own.length > 0 ? String.fromCodePoint(...own) : 'Aa';
}

type Kit = Omit<fontkit.Font, 'variationAxes'> & {
  'OS/2'?: { usWeightClass?: number; fsSelection?: { italic?: boolean } };
  variationAxes?: Record<string, { name: string; min: number; default: number; max: number }>;
  namedVariations?: Record<string, Record<string, number>>;
  getName?: (key: string) => string | null;
};

const face = (font: Kit, fallbackName: string): FontFace => ({
  family: attempt(() => clean(font.familyName), '') || fallbackName,
  style: attempt(() => clean(font.subfamilyName), '') || 'Regular',
  weight: attempt(() => finite(font['OS/2']?.usWeightClass) || null, null),
  italic: attempt(() => !!font['OS/2']?.fsSelection?.italic || finite(font.italicAngle) !== 0, false),
  glyphCount: attempt(() => finite(font.numGlyphs), 0),
});

/** Facts for a file fontkit cannot read (Type 1, or one that is too large or broken): its name only. */
export const fontFactsFromName = (filename: string, known: Partial<FontFace> = {}): FontFacts => {
  const name = clean(filename.slice(0, filename.length - getFilenameExtension(filename).length)) || 'Font';
  const base = { family: name, style: 'Regular', weight: null, italic: false, glyphCount: 0, ...known };
  return { ...base, axes: [], instances: [], features: [], scripts: [], license: null, licenseUrl: null, faces: [] };
};

/** What the font says about itself. Throws when fontkit cannot read the file; the caller falls back to the name. */
export function readFontFacts(data: Buffer, filename: string): { facts: FontFacts; sample: string } {
  const opened = fontkit.create(data) as unknown as Kit | { fonts: Kit[] };
  const fonts = 'fonts' in opened ? opened.fonts : [opened];
  const first = fonts[0];
  if (!first) throw new Error('The font file holds no font');
  const fallback = fontFactsFromName(filename).family;
  const codePoints = attempt(() => first.characterSet, []);
  const scripts = fontScripts(codePoints);
  const axes = attempt(
    () =>
      Object.entries(first.variationAxes ?? {})
        .slice(0, 32)
        .map(([tag, axis]) => ({
          tag: clean(tag, 4),
          name: clean(axis.name) || tag,
          min: finite(axis.min),
          default: finite(axis.default),
          max: finite(axis.max),
        })),
    [],
  );
  const instances = attempt(
    () =>
      Object.entries(first.namedVariations ?? {})
        .slice(0, LIST_MAX)
        .map(([name, coordinates]) => ({
          name: clean(name),
          coordinates: Object.fromEntries(
            Object.entries(coordinates).map(([tag, value]) => [clean(tag, 4), finite(value)]),
          ),
        })),
    [],
  );
  const name = (key: string) => attempt(() => clean(first.getName?.(key), LICENCE_MAX) || null, null);
  return {
    sample: fontSpecimenText(scripts, codePoints),
    facts: {
      ...face(first, fallback),
      axes,
      instances,
      features: attempt(() => [...new Set(first.availableFeatures)].slice(0, LIST_MAX).map((tag) => clean(tag, 4)), []),
      scripts,
      license: name('license'),
      licenseUrl: name('licenseURL')?.slice(0, 500) ?? null,
      faces: fonts.length > 1 ? fonts.slice(0, FACES_MAX).map((font) => face(font, fallback)) : [],
    },
  };
}

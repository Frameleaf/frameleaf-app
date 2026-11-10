/**
 * Fonts in Boards (FL-1359, approved prototype `src/boards-fonts.mjs`). A font is an ordinary Boards
 * item whose thumbnail is a specimen picture made on the server. The viewer loads the font file
 * itself to try it, and a text annotation can be set in it.
 */
import {
  AssetMediaSize,
  AssetTypeEnum,
  LibraryAssetItemKind,
  LibraryItemSearchKind,
  LibraryViewScope,
  searchLibraryItems,
  type AssetAnnotationStyle,
  type AssetFontResponseDto,
  type LibraryItemDto,
} from '@frameleaf/sdk';
import { getAssetMediaUrl } from '$lib/utils';

const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'ttc', 'otc', 'woff', 'woff2', 'dfont', 'pfb', 'pfa']);
/** The file types a browser loads itself; the server says the same in `browserLoadable`. */
const BROWSER_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2']);

const extension = (name: string | null | undefined) =>
  name?.includes('.') ? name.split('.').pop()!.toLowerCase() : '';

export const isFontName = (name: string | null | undefined) => FONT_EXTENSIONS.has(extension(name));
export const isBrowserFontName = (name: string | null | undefined) => BROWSER_EXTENSIONS.has(extension(name));
/** "TTF", "WOFF2"… for the tile and the picker. */
export const fontFormat = (name: string | null | undefined) => extension(name).toUpperCase();
/** A font's file name without its extension, shown until the family name is known. */
export const fontFileTitle = (name: string | null | undefined) => (name ?? '').replace(/\.[^.]+$/, '');

export type FontKind = 'collection' | 'variable' | 'colour' | 'font';
/** The badge in the viewer, like the play badge on a video. */
export const fontKind = (font: Pick<AssetFontResponseDto, 'faces' | 'axes' | 'scripts'>): FontKind =>
  font.faces.length > 1
    ? 'collection'
    : font.axes.length > 0
      ? 'variable'
      : font.scripts.includes('emoji')
        ? 'colour'
        : 'font';

/** CSS `font-variation-settings` for axis values, or `normal` when there are none. */
export const variationCss = (variation: Record<string, number> | undefined) => {
  const entries = Object.entries(variation ?? {});
  return entries.length > 0 ? entries.map(([tag, value]) => `"${tag}" ${value}`).join(', ') : 'normal';
};

/** The switches the viewer offers, of the features a font has. The rest (kerning, mark placement…) are always on. */
export const FEATURE_CHOICES = ['liga', 'dlig', 'smcp', 'onum', 'tnum', 'zero', 'frac', 'palt'] as const;
export const offeredFeatures = (features: string[]) => [
  ...FEATURE_CHOICES.filter((tag) => features.includes(tag)),
  ...features.filter((tag) => /^ss(0[1-9]|1\d|20)$/.test(tag)).sort(),
];
/** CSS `font-feature-settings`: ligatures are on unless switched off, everything else off unless switched on. */
export const featureCss = (on: Record<string, boolean>) => {
  const settings = Object.entries(on).flatMap(([tag, enabled]) =>
    tag === 'liga' ? (enabled ? [] : ['"liga" 0', '"calt" 0']) : enabled ? [`"${tag}" 1`] : [],
  );
  return settings.length > 0 ? settings.join(', ') : 'normal';
};

/** A few characters of each writing system, for the viewer's glyph grid. */
const SCRIPT_GLYPHS: Record<string, string> = {
  latin: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&@#%!?.,:;()“”‘’—+=€£$',
  cyrillic: 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя',
  greek: 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω',
  han: '永字八法山川森湖火光木道空雪春夏秋冬日月水金土人家旅写真静暖灯',
  kana: 'あいうえおかきくけこさしすせそたちつてとアイウエオカキクケコサシスセソ',
  hangul: '가나다라마바사아자차카타파하',
  arabic: 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي',
  hebrew: 'אבגדהוזחטיכלמנסעפצקרשת',
  devanagari: 'अआइईउऊएऐओऔकखगघचछजझटठडढतथदधन',
  thai: 'กขคงจฉชซญดตถทธนบปผฝพฟภมยรลวสหอ',
  emoji: '😀😍🤔🎉👍👋🌲🔥🌸🌿🌙⭐📷🎨🧭☕',
};
export const sampleGlyphs = (scripts: string[]) => {
  const text = scripts.map((script) => SCRIPT_GLYPHS[script] ?? '').join('');
  const segmenter =
    typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('und', { granularity: 'grapheme' }) : null;
  return segmenter ? Array.from(segmenter.segment(text), ({ segment }) => segment) : [...text];
};
/** The words the tester starts with, in the font's most distinctive script. */
const SCRIPT_SAMPLE: Record<string, string> = {
  han: '永字八法 風景写真',
  kana: 'あいうえお かきくけこ',
  hangul: '가나다라 마바사',
  arabic: 'أبجد هوز حطي',
  hebrew: 'אבגד הוז חטי',
  devanagari: 'अआइई कखगघ',
  thai: 'กขคง จฉชซ',
  cyrillic: 'Широкая электрификация южных губерний 0123',
  greek: 'Ξεσκεπάζω την ψυχοφθόρα βδελυγμία 0123',
  emoji: '😀🌿📷🎨🌲🔥🌸⭐',
};
export const sampleText = (scripts: string[], fallback: string) =>
  scripts.includes('latin') && scripts.every((script) => !['han', 'kana', 'hangul'].includes(script))
    ? fallback
    : (scripts.map((script) => SCRIPT_SAMPLE[script]).find(Boolean) ?? fallback);

const loaded = new Map<string, Promise<string>>();
/**
 * Loads a Boards font into the page and answers the CSS family name to use it by. The file comes
 * from this server only. It fails when the font has gone, is not one a browser reads, or may not be
 * downloaded (a shared link with downloads off); the caller then keeps the standard font.
 */
export function loadBoardsFont(id: string): Promise<string> {
  let pending = loaded.get(id);
  if (!pending) {
    const family = `fl-font-${id}`;
    pending = (async () => {
      const url = getAssetMediaUrl({ id, size: AssetMediaSize.Original, edited: false });
      const face = new FontFace(family, `url("${url}")`);
      await face.load();
      document.fonts.add(face);
      return family;
    })();
    pending.catch(() => loaded.delete(id));
    loaded.set(id, pending);
  }
  return pending;
}

export type BoardsFontChoice = { id: string; name: string; format: string; usable: boolean };
/** The fonts in Boards, for the font list of a text annotation. */
export async function listBoardsFonts(): Promise<BoardsFontChoice[]> {
  // ponytail: up to 25 pages of 200 items; a server-side "fonts only" list if anyone keeps more than that
  const items: LibraryItemDto[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 25; page++) {
    const response = await searchLibraryItems({
      libraryItemSearchDto: {
        filter: { libraryScope: LibraryViewScope.Design, type: { eq: AssetTypeEnum.Other } },
        kinds: [LibraryItemSearchKind.Asset],
        limit: 200,
        cursor,
      },
    });
    items.push(...response.items);
    cursor = response.nextCursor ?? undefined;
    if (!cursor) {
      break;
    }
  }
  return items.flatMap((item) => {
    const name =
      item.kind === LibraryAssetItemKind.Asset && 'originalFileName' in item.asset ? item.asset.originalFileName : null;
    return item.kind === LibraryAssetItemKind.Asset && isFontName(name)
      ? [{ id: item.asset.id, name: fontFileTitle(name), format: fontFormat(name), usable: isBrowserFontName(name) }]
      : [];
  });
}

/** Text sizes, as multiples of the standard annotation text. */
export const TEXT_SIZES = [
  { id: 's', scale: 0.8 },
  { id: 'm', scale: 1 },
  { id: 'l', scale: 1.4 },
  { id: 'xl', scale: 1.9 },
] as const;
export const textSizeId = (size: number | undefined) =>
  TEXT_SIZES.toSorted((a, b) => Math.abs(a.scale - (size ?? 1)) - Math.abs(b.scale - (size ?? 1)))[0].id;

/** Colours that stay readable on the dark label behind annotation text. The first is the standard amber. */
export const TEXT_COLOURS = [
  { value: undefined, label: 'frameleaf_boards_text_colour_standard' },
  { value: '#ffffff', label: 'frameleaf_magic_colour_white' },
  { value: '#ef5350', label: 'frameleaf_magic_colour_red' },
  { value: '#d9639b', label: 'frameleaf_magic_colour_pink' },
  { value: '#a996f5', label: 'frameleaf_magic_colour_purple' },
  { value: '#6ea4f8', label: 'frameleaf_magic_colour_blue' },
  { value: '#2fc4bf', label: 'frameleaf_magic_colour_teal' },
  { value: '#3fb46a', label: 'frameleaf_magic_colour_green' },
] as const;

/** A style with its empty parts left out, or nothing at all when it is the standard look. */
export const tidyStyle = (style: AssetAnnotationStyle): AssetAnnotationStyle | undefined => {
  const next: AssetAnnotationStyle = {};
  if (style.fontAssetId) {
    next.fontAssetId = style.fontAssetId;
    // axis values mean nothing without the font they belong to
    if (style.variation && Object.keys(style.variation).length > 0) {
      next.variation = style.variation;
    }
  }
  if (style.size !== undefined && style.size !== 1) {
    next.size = style.size;
  }
  if (style.color) {
    next.color = style.color;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

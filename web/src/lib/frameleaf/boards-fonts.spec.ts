import { describe, expect, it } from 'vitest';
import {
  featureCss,
  fontFileTitle,
  fontFormat,
  fontKind,
  isBrowserFontName,
  isFontName,
  offeredFeatures,
  sampleGlyphs,
  sampleText,
  textSizeId,
  tidyStyle,
  variationCss,
} from '$lib/frameleaf/boards-fonts';

describe('fonts in Boards (FL-1359)', () => {
  it('knows a font by its file name, and which ones a browser loads', () => {
    expect(['a.ttf', 'A.OTF', 'a.woff2', 'a.ttc', 'a.pfb', 'a.dfont'].every((name) => isFontName(name))).toBe(true);
    expect([null, 'a.jpg', 'ttf', 'a.ttf.zip'].some((name) => isFontName(name))).toBe(false);
    expect(isBrowserFontName('a.woff')).toBe(true);
    expect(isBrowserFontName('a.ttc')).toBe(false);
    expect(fontFormat('Lodge Serif.otf')).toBe('OTF');
    expect(fontFileTitle('Lodge Serif.v2.otf')).toBe('Lodge Serif.v2');
  });

  it('names the kind of font for its badge', () => {
    const font = { faces: [], axes: [], scripts: ['latin'] };
    const axis = { tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900 };
    const face = { family: 'A', style: 'Regular', weight: 400, italic: false, glyphCount: 1 };
    expect(fontKind(font)).toBe('font');
    expect(fontKind({ ...font, scripts: ['emoji'] })).toBe('colour');
    expect(fontKind({ ...font, axes: [axis] })).toBe('variable');
    expect(fontKind({ ...font, axes: [axis], faces: [face, face] })).toBe('collection');
  });

  it('writes the CSS for axis values and features', () => {
    expect(variationCss(undefined)).toBe('normal');
    expect(variationCss({ wght: 650, wdth: 80 })).toBe('"wght" 650, "wdth" 80');
    expect(featureCss({ liga: true, tnum: false })).toBe('normal');
    expect(featureCss({ liga: false, tnum: true, ss01: true })).toBe('"liga" 0, "calt" 0, "tnum" 1, "ss01" 1');
  });

  it('offers only the features people switch, stylistic sets last', () => {
    expect(offeredFeatures(['kern', 'ss02', 'tnum', 'mark', 'liga', 'ss01', 'ss99'])).toEqual([
      'liga',
      'tnum',
      'ss01',
      'ss02',
    ]);
  });

  it('samples the scripts a font covers', () => {
    expect(sampleGlyphs(['latin']).slice(0, 3)).toEqual(['A', 'B', 'C']);
    expect(sampleGlyphs(['emoji'])).toContain('😀');
    expect(sampleGlyphs(['unknown'])).toEqual([]);
    expect(sampleText(['latin', 'greek'], 'Hello')).toBe('Hello');
    expect(sampleText(['han', 'latin'], 'Hello')).toContain('永');
    expect(sampleText([], 'Hello')).toBe('Hello');
  });

  it('keeps a text style small: the standard look is no style at all', () => {
    expect(tidyStyle({})).toBeUndefined();
    expect(tidyStyle({ size: 1, color: undefined })).toBeUndefined();
    // axis values mean nothing without the font they belong to
    expect(tidyStyle({ variation: { wght: 700 }, size: 1.4 })).toEqual({ size: 1.4 });
    expect(tidyStyle({ fontAssetId: 'f', variation: { wght: 700 }, color: '#ffffff' })).toEqual({
      fontAssetId: 'f',
      variation: { wght: 700 },
      color: '#ffffff',
    });
    expect(textSizeId(undefined)).toBe('m');
    expect(textSizeId(1.5)).toBe('l');
  });
});

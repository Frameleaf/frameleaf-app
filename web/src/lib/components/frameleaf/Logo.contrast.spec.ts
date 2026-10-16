import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * FL-29: "verify logo contrast in both themes". This measures the lockups the app swaps by theme
 * (D7, 2026-10-16) against the theme canvases (tokens.css `--fl-canvas`): on the dark surface the
 * whole wordmark is the kit's near-white (text, 4.5:1; no green "leaf"), the gradient symbol is a
 * graphic (3:1), and on the light surface "Frame" is the dark-ink derivative's #111d26. The light
 * lockup keeps the brand's green "leaf" lettering, which is below 3:1 there, so the name is always
 * in the image's accessible name as well.
 */
const assets = resolve(import.meta.dirname, '../../assets/frameleaf');
const colours = (file: string, attribute: 'fill' | 'stop-color') =>
  [...readFileSync(resolve(assets, file), 'utf8').matchAll(new RegExp(`${attribute}="(#[0-9a-fA-F]{6})"`, 'g'))].map(
    ([, hex]) => hex,
  );

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

const tokens = readFileSync(resolve(import.meta.dirname, '../../frameleaf/tokens.css'), 'utf8');
const canvas = (theme: 'dark' | 'light') => {
  const block = tokens.split(`.frameleaf[data-theme='${theme}']`)[1] ?? '';
  const match = block.match(/--fl-canvas:\s*(#[0-9a-fA-F]{6})/);
  if (!match) {
    throw new Error(`no ${theme} canvas`);
  }
  return match[1];
};

describe('Frameleaf logo contrast (FL-29)', () => {
  it('reads the whole dark wordmark at 4.5:1 or more on the dark canvas, with no green leaf (D7)', () => {
    const fills = colours('frameleaf-logo-on-dark.svg', 'fill');
    // "Frame" and "leaf", both the near-white; no gradient fill is left in the wordmark.
    expect(fills).toEqual(['#f7f9fc', '#f7f9fc']);
    expect(readFileSync(resolve(assets, 'frameleaf-logo-on-dark.svg'), 'utf8')).not.toContain('wordmark-leaf');
    for (const fill of fills) {
      expect(contrast(fill, canvas('dark'))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('reads "Frame" at 4.5:1 or more on the light canvas', () => {
    const fills = colours('frameleaf-logo-on-light.svg', 'fill');
    expect(fills).toEqual(['#111d26']);
    expect(contrast(fills[0], canvas('light'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps every symbol colour at 3:1 or more on the dark canvas', () => {
    const stops = colours('frameleaf-symbol.svg', 'stop-color');
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) {
      expect(contrast(stop, canvas('dark'))).toBeGreaterThanOrEqual(3);
    }
  });

  it('never relies on the green lettering alone for the name on the light canvas', () => {
    const weakest = Math.min(
      ...colours('frameleaf-logo-on-light.svg', 'stop-color').map((stop) => contrast(stop, canvas('light'))),
    );
    // Measured below 3:1: which is why the lockup always carries the name as its accessible name.
    expect(weakest).toBeLessThan(3);
    const logo = readFileSync(resolve(import.meta.dirname, 'Logo.svelte'), 'utf8');
    expect(logo).toMatch(/src=\{onDark \? \(white \? logoWhiteUrl : logoOnDarkUrl\) : logoOnLightUrl\}/);
    expect(logo).toMatch(/alt=\{decorative \? '' : name\}/);
  });
});

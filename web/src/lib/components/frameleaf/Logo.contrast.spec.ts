import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * FL-29: "verify logo contrast in both themes". The brand-kit artwork is used as supplied (never
 * recoloured), so this measures it against the theme canvases (tokens.css `--fl-canvas`) and pins the
 * placement rules `Logo.svelte` follows: the near-white wordmark only on the dark surface (text,
 * 4.5:1), the gradient symbol as a graphic (3:1) on the dark surface, and on the light surface the
 * product name carried by real text in `--fl-text`, because the symbol's lightest stop is below 3:1
 * there and the kit has no dark-ink wordmark.
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
  it('reads the wordmark at 4.5:1 or more on the dark canvas', () => {
    const fills = colours('frameleaf-logo-dark.svg', 'fill');
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) {
      expect(contrast(fill, canvas('dark'))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps every symbol colour at 3:1 or more on the dark canvas', () => {
    const stops = colours('frameleaf-symbol.svg', 'stop-color');
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) {
      expect(contrast(stop, canvas('dark'))).toBeGreaterThanOrEqual(3);
    }
  });

  it('never relies on the symbol alone for the name on the light canvas', () => {
    const weakest = Math.min(
      ...colours('frameleaf-symbol.svg', 'stop-color').map((stop) => contrast(stop, canvas('light'))),
    );
    // Measured below 3:1: which is why the light lockup pairs the symbol with the name as text
    expect(weakest).toBeLessThan(3);
    const logo = readFileSync(resolve(import.meta.dirname, 'Logo.svelte'), 'utf8');
    expect(logo).toMatch(/<span aria-hidden=\{decorative \|\| undefined\}>\{name\}<\/span>/);
    expect(logo).toMatch(/\.fl-logo-inline[^}]*color: var\(--fl-text/s);
  });
});

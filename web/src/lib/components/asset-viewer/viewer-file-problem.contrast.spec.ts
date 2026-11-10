import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * FL-1338 (final review W5): the viewer's "Original missing" / "Damaged file" pill is the only sign on the photo, so
 * its words keep 4.5:1 or more over any photo. happy-dom computes no styles, so the CSS is read from the component:
 * the tint has to sit on the viewer's opaque panel colour (not on the see-through glass), and hover or keyboard focus
 * must not lighten it below that.
 */
const source = readFileSync(resolve(import.meta.dirname, 'AssetViewerNavBar.svelte'), 'utf8');
const css = source.slice(source.indexOf('<style>'));
const tokens = readFileSync(resolve(import.meta.dirname, '../../frameleaf/tokens.css'), 'utf8');

const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`no rule for ${selector}`);
  }
  return css.slice(start, css.indexOf('}', start));
};

const hex = (value: string) => [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** `color-mix(in srgb, a p%, b)` */
const mix = (a: number[], b: number[], percent: number) =>
  a.map((value, index) => (value * percent + b[index] * (100 - percent)) / 100);

const panelColours = [...tokens.matchAll(/--fl-viewer-panel:\s*(#[0-9a-fA-F]{6})/g)].map(([, value]) => value);
const problemColour = (selector: string) => rule(selector).match(/--fl-problem:\s*(#[0-9a-fA-F]{6})/)?.[1];
const pills = [
  ['Original missing', problemColour('.fl-file-problem')],
  ['Damaged file', problemColour('.fl-file-problem.is-damaged')],
] as const;

describe('the viewer file problem pill (W5)', () => {
  it('tints the opaque panel colour, never the see-through glass', () => {
    expect(rule('.fl-file-problem')).toMatch(
      /background: color-mix\(in srgb, var\(--fl-problem\) \d+%, var\(--fl-viewer-panel\)\);/,
    );
    expect(css).not.toMatch(/\.fl-file-problem[^{]*{[^}]*background: color-mix\([^)]*transparent\)/);
    expect(panelColours.length).toBeGreaterThan(0);
  });

  it.each(pills)('reads "%s" at 4.5:1 or more at rest, on hover and with keyboard focus', (_name, colour) => {
    expect(colour).toMatch(/^#[0-9a-fA-F]{6}$/);
    const percent = Number(rule('.fl-file-problem').match(/var\(--fl-problem\) (\d+)%, var\(--fl-viewer-panel\)/)?.[1]);
    expect(percent).toBeGreaterThan(0);
    for (const panel of panelColours) {
      expect(contrast(hex(colour!), mix(hex(colour!), hex(panel), percent))).toBeGreaterThanOrEqual(4.5);
    }
    // hover and focus keep the resting background: they add a ring
    const hover = rule('.fl-file-problem:hover,\n  .fl-file-problem:focus-visible');
    expect(hover).not.toContain('background');
    expect(hover).toContain('box-shadow: inset 0 0 0 1px');
  });
});

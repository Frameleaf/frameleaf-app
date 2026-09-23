import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import tokens from '../../../../design/frameleaf/tokens.json';

const css = readFileSync('src/lib/frameleaf/tokens.css', 'utf8');

/** Reads one rule's custom properties. `selector` must be the literal text in the sheet. */
const declarations = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`tokens.css is missing the rule ${selector}`);
  }
  const body = css.slice(start + selector.length + 2, css.indexOf('}', start));
  const values = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    values.set(name, value.trim());
  }
  return values;
};

const themes = {
  dark: declarations(".frameleaf[data-theme='dark']"),
  light: declarations(".frameleaf[data-theme='light']"),
};
const base = declarations('.frameleaf');

const hex = (theme: 'dark' | 'light', name: string) => {
  const value = themes[theme].get(`--fl-${name}`);
  expect(value, `missing --fl-${name} in the ${theme} theme`).toMatch(/^#[0-9a-f]{6}$/);
  return value as string;
};

const luminance = (color: string) => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  return channels.reduce(
    (sum, value, index) =>
      sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index],
    0,
  );
};

const contrast = (a: string, b: string) => {
  const pair = [luminance(a), luminance(b)].sort((first, second) => first - second);
  return (pair[1] + 0.05) / (pair[0] + 0.05);
};

/** Foregrounds that must stay readable on every Frameleaf surface. */
const foregrounds = ['text', 'muted', 'accent', 'teal', 'blue', 'warning', 'danger'] as const;
const surfaces = ['canvas', 'panel', 'raised'] as const;
/** Foregrounds on the viewer chrome, which stays dark in both themes. */
const viewerForegrounds = ['viewer-text', 'viewer-muted', 'viewer-focus'] as const;
const viewerSurfaces = ['viewer-canvas', 'viewer-panel', 'viewer-raised'] as const;
/** Each fill and the foreground token that is placed on top of it. */
const fillPairs = [
  ['accent', 'accent-text'],
  ['teal', 'teal-text'],
  ['blue', 'blue-text'],
  ['warning', 'warning-text'],
  ['danger', 'danger-text'],
] as const;

describe('Frameleaf theme contract', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`matches approved ${theme} colors and readable foreground contrast`, () => {
      for (const [name, value] of Object.entries(tokens[theme])) {
        expect(themes[theme].get(`--fl-${name}`)).toBe(value);
      }
      for (const foreground of foregrounds) {
        for (const surface of surfaces) {
          expect(
            contrast(hex(theme, foreground), hex(theme, surface)),
            `${foreground} on ${surface} (${theme})`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`keeps ${theme} status fills readable and the viewer chrome legible`, () => {
      // Status is never carried by hue alone, but where it is, the text on it must be read.
      for (const [fill, onFill] of fillPairs) {
        const ratio = contrast(hex(theme, fill), hex(theme, onFill));
        expect(ratio, `${onFill} on ${fill} (${theme})`).toBeGreaterThanOrEqual(4.5);
      }
      // The viewer keeps a dark surround in both themes so photographs are judged
      // against neutral chrome; its own pairs are asserted per theme all the same.
      for (const foreground of viewerForegrounds) {
        for (const surface of viewerSurfaces) {
          expect(
            contrast(hex(theme, foreground), hex(theme, surface)),
            `${foreground} on ${surface} (${theme})`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`declares every shared ${theme} token the primitives consume`, () => {
      for (const name of [
        ...foregrounds,
        ...surfaces,
        ...viewerForegrounds,
        ...viewerSurfaces,
        ...fillPairs.map(([, onFill]) => onFill),
        'viewer-border',
        'shadow-1',
        'shadow-2',
      ]) {
        expect(themes[theme].has(`--fl-${name}`), `missing --fl-${name} in the ${theme} theme`).toBe(true);
      }
    });
  }

  it('uses the approved type scale with nothing below 11px', () => {
    expect(base.get('--fl-font-size')).toBe('14px');
    expect(base.get('--fl-font-small')).toBe('12px');
    expect(base.get('--fl-font-micro')).toBe('11px');
    const sizes = [...base]
      .filter(([name]) => name.startsWith('--fl-font-'))
      // Every size in the scale is in px; anything else reads as NaN and fails the check below.
      .map(([, value]) => Number(value.replace(/px$/, '')));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11);
    // The scope raises its own base size rather than inheriting the host application's.
    expect(css).toContain('font-size: var(--fl-font-size)');
  });

  it('uses the approved motion and radius scales', () => {
    expect(base.get('--fl-motion-fast')).toBe('120ms');
    expect(base.get('--fl-motion')).toBe('180ms');
    expect(base.get('--fl-motion-slow')).toBe('240ms');
    expect(base.get('--fl-ease')).toBeDefined();
    expect(base.get('--fl-radius-control')).toBe('6px');
    expect(base.get('--fl-radius-card')).toBe('10px');
    expect(base.get('--fl-radius-dialog')).toBe('14px');
    expect(base.get('--fl-radius-pill')).toBe('999px');
  });

  it('honours reduced motion and keeps native touch targets', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/transition-duration: 0\.01ms !important/);
    expect(css).toMatch(/min-height: 44px/);
    expect(css).toMatch(/@media \(pointer: coarse\)[\S\s]*min-height: 48px/);
  });

  it('never leaks the prototype stylesheet into production', () => {
    // Every rule stays under the .frameleaf scope; no bare element, html/body or :root
    // rules, so mounting Theme.svelte cannot restyle the surrounding application.
    const withoutComments = css.replaceAll(/\/\*[\S\s]*?\*\//g, '');
    const selectors = [...withoutComments.matchAll(/([^{}]+)\{/g)]
      .map(([, selector]) => selector.trim())
      .filter((selector) => selector.length > 0 && !selector.startsWith('@'));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector, 'unscoped rule').toContain('.frameleaf');
    }
  });
});

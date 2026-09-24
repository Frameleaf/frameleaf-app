import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import tokens from '../../../../design/frameleaf/tokens.json';

const css = readFileSync('src/lib/frameleaf/tokens.css', 'utf8');
const baseline = readFileSync('src/lib/frameleaf/base.css', 'utf8');

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

  it('loads the bundled Inter weights through the prototype baseline', () => {
    expect(css.trimStart().startsWith("@import './base.css';")).toBe(true);
    const sources = new Map<string, string>();
    for (const [, body] of baseline.matchAll(/@font-face\s*{([^}]+)}/g)) {
      const [, weight] = /font-weight: (\d+);/.exec(body) ?? [];
      const [, source] = /url\('([^']+)'\)/.exec(body) ?? [];
      sources.set(weight, source);
    }
    for (const weight of [400, 500, 600]) {
      const source = sources.get(String(weight));
      expect(source).toBe(`../assets/fonts/Inter/inter-latin-${weight}-normal.woff2`);
      expect(existsSync(`src/lib/frameleaf/${source}`)).toBe(true);
    }
    expect(existsSync('src/lib/assets/fonts/Inter/LICENSE')).toBe(true);
  });

  it('keeps the prototype baseline below component styles and the touch-target floor', () => {
    const withoutComments = baseline.replaceAll(/\/\*[\S\s]*?\*\//g, '');
    const selectors = [...withoutComments.matchAll(/([^{}]+)\{/g)]
      .map(([, selector]) => selector.trim())
      .filter((selector) => selector.length > 0 && !selector.startsWith('@'));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      // Zero specificity: a component's own rules, and the 44px/48px floors, always win.
      expect(selector, 'baseline rule outside :where()').toMatch(/^:where\([\S\s]*\)$/);
      expect(selector, 'unscoped baseline rule').toContain('.frameleaf');
    }
    // The prototype's 34px button height is not ported; nothing in the baseline shrinks a control.
    expect(withoutComments).not.toMatch(/min-height:\s*(?:[0-3]?\d|4[0-3])px/);
  });

  it('layers the prototype baseline below Tailwind and @immich/ui utilities', () => {
    const order = '@layer properties, theme, base, frameleaf-base, components, utilities;';
    // Declared before Tailwind's own statement in app.css, and again in base.css, so the order
    // holds whichever sheet loads first.
    const app = readFileSync('src/app.css', 'utf8');
    expect(app.indexOf(order)).toBeGreaterThan(-1);
    expect(app.indexOf(order)).toBeLessThan(app.indexOf("@import 'tailwindcss';"));
    const withoutComments = baseline.replaceAll(/\/\*[\S\s]*?\*\//g, '');
    expect(withoutComments.trimStart().startsWith(order)).toBe(true);
    // Only the font faces and the order statement sit outside the layer; every rule is inside it,
    // so an unlayered utility or component style is never beaten by the baseline.
    const outside = withoutComments
      .replace(order, '')
      .replaceAll(/@font-face\s*{[^}]+}/g, '')
      .trim();
    expect(outside.startsWith('@layer frameleaf-base {')).toBe(true);
    expect(outside.endsWith('}')).toBe(true);
    expect(outside.match(/@layer/g)).toHaveLength(1);
  });

  it('stacks only prototype field labels, not every label', () => {
    const withoutComments = baseline.replaceAll(/\/\*[\S\s]*?\*\//g, '');
    for (const [, selector] of withoutComments.matchAll(/([^{}]+)\{/g)) {
      if (/\blabel\b/.test(selector)) {
        // A caption <span> then the control: search bars and text-plus-control rows keep their layout.
        expect(selector).toContain('label:has(> span:first-child + :is(');
      }
    }
  });

  it('leaves @immich/ui form controls to their own ring', () => {
    const withoutComments = baseline.replaceAll(/\/\*[\S\s]*?\*\//g, '');
    const rules = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
      selector: selector.trim(),
      body,
    }));
    const exclusion = ":not([class~='ring-1'], .immich-form-input, [class~='ring-1'] > *)";
    const fieldChrome = rules.filter(
      ({ selector, body }) => /border(-color)?:/.test(body) && /\b(input|select|textarea)\b/.test(selector),
    );
    expect(fieldChrome.length).toBeGreaterThanOrEqual(2);
    for (const { selector } of fieldChrome) {
      // A second border inside the Input/PasswordInput/Textarea ring, accent on focus, is the bug.
      expect(selector).toContain(exclusion);
    }
    // The hook the exclusion relies on: @immich/ui draws its field ring with the ring-1 utility.
    const immichStyles = readFileSync('node_modules/@immich/ui/dist/styles.js', 'utf8');
    expect(immichStyles).toMatch(/inputContainerCommon: '[^']*\bring-1\b/);
  });

  it('spaces only fields placed directly in a dialog, not those in a gap-spaced form', () => {
    const withoutComments = baseline.replaceAll(/\/\*[\S\s]*?\*\//g, '');
    const spaced = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*margin-bottom: 18px[^{}]*)\}/g)];
    expect(spaced).toHaveLength(1);
    expect(spaced[0][1]).toContain(':is(.frameleaf.dialog, .frameleaf.dialog > .dialog-body)');
    expect(spaced[0][1]).toMatch(/\)\s*>\s*label:has\(/);
  });

  it('keeps the primary hover readable in both themes', () => {
    const channels = (color: string) => [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
    const toHex = (values: number[]) =>
      `#${values.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
    const mix = (base: string, other: string, share: number) =>
      toHex(channels(base).map((value, index) => value * (1 - share) + channels(other)[index] * share));
    for (const theme of ['dark', 'light'] as const) {
      const hover = themes[theme].get('--fl-accent-hover');
      const [, other, share] =
        /^color-mix\(in srgb, var\(--fl-accent\), (white|var\(--fl-text\)) (\d+)%\)$/.exec(hover ?? '') ?? [];
      expect(other, `unexpected --fl-accent-hover in the ${theme} theme`).toBeDefined();
      const fill = mix(hex(theme, 'accent'), other === 'white' ? '#ffffff' : hex(theme, 'text'), Number(share) / 100);
      expect(contrast(hex(theme, 'accent-text'), fill), `accent-text on hover (${theme})`).toBeGreaterThanOrEqual(4.5);
    }
    // The prototype's own lightening mix stays in the dark theme.
    expect(themes.dark.get('--fl-accent-hover')).toBe('color-mix(in srgb, var(--fl-accent), white 10%)');
  });

  it('never leaks the prototype stylesheet into production', () => {
    // Every rule stays under the .frameleaf scope; no bare element, html/body or :root
    // rules, so mounting Theme.svelte cannot restyle the surrounding application.
    const withoutComments = css.replaceAll(/\/\*[\S\s]*?\*\//g, '').replaceAll(/@import[^;]+;/g, '');
    const selectors = [...withoutComments.matchAll(/([^{}]+)\{/g)]
      .map(([, selector]) => selector.trim())
      .filter((selector) => selector.length > 0 && !selector.startsWith('@'));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector, 'unscoped rule').toContain('.frameleaf');
    }
  });
});

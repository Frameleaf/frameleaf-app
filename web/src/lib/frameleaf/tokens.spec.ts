import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import tokens from '../../../../design/frameleaf/tokens.json';
import brand from './brand-tokens.json';
import {
  CONTROL_HEIGHT,
  DURATION,
  EASE,
  EXIT_DURATION,
  ICON_PX,
  ICON_SIZE,
  LOGO_CLEAR_SPACE,
  LOGO_MIN_HEIGHT,
  SNAPPY,
  SPRING_STOPS,
  STAGGER_MS,
  Z_INDEX,
} from './tokens';

const css = readFileSync('src/lib/frameleaf/tokens.css', 'utf8');
const baseline = readFileSync('src/lib/frameleaf/base.css', 'utf8');
const appCss = readFileSync('src/app.css', 'utf8');

/** The body of the first block that follows `opener` (an at-rule or selector) in `sheet`. */
const blockAfter = (sheet: string, opener: string) => {
  const start = sheet.indexOf(opener);
  if (start === -1) {
    throw new Error(`missing ${opener}`);
  }
  let depth = 0;
  for (let index = sheet.indexOf('{', start); index < sheet.length; index++) {
    if (sheet[index] === '{') {
      depth++;
    } else if (sheet[index] === '}' && --depth === 0) {
      return sheet.slice(sheet.indexOf('{', start) + 1, index);
    }
  }
  throw new Error(`unterminated ${opener}`);
};

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

const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** Relative luminance of a `color(display-p3 r g b)` value (P3 primaries, sRGB transfer curve). */
const p3Luminance = (color: string) => {
  const match = /^color\(display-p3 ([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  expect(match, `not a display-p3 colour: ${color}`).not.toBeNull();
  const [r, g, b] = (match as RegExpExecArray).slice(1).map((value) => linear(Number(value)));
  return 0.2289746 * r + 0.6917385 * g + 0.0792869 * b;
};

const ratio = (first: number, second: number) => {
  const pair = [first, second].sort((a, b) => a - b);
  return (pair[1] + 0.05) / (pair[0] + 0.05);
};

const contrast = (a: string, b: string) => ratio(luminance(a), luminance(b));

/** `share` of `top` composited over `bottom`, per channel, as a hex colour. */
const composite = (top: string, bottom: string, share: number) => {
  const channel = (color: string, offset: number) => Number.parseInt(color.slice(offset, offset + 2), 16);
  return `#${[1, 3, 5]
    .map((offset) => Math.round(channel(top, offset) * share + channel(bottom, offset) * (1 - share)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
};

/** Foregrounds that must stay readable on every Frameleaf surface. */
const foregrounds = ['text', 'muted', 'accent', 'teal', 'blue', 'warning', 'danger', 'ai-ink'] as const;
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
  // The reserved AI tile: the sparkle and "AI" badge sit on solid indigo (tokens.json `ai`).
  ['ai', 'ai-text'],
] as const;

describe('Frameleaf theme contract', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`matches approved ${theme} colors and readable foreground contrast`, () => {
      for (const [name, value] of Object.entries(tokens.color[theme])) {
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

  it('keeps design/frameleaf/tokens.json a copy of brand-tokens.json', () => {
    // One source, two homes: the web reads brand-tokens.json; design/frameleaf/tokens.json is the
    // same document for the design reference, bound by the brand asset inventory
    // (scripts/frameleaf-brand-assets.py). Edit brand-tokens.json, copy it over, regenerate.
    expect(brand.version).toBe(3);
    expect(tokens).toEqual(brand);
  });

  for (const theme of ['dark', 'light'] as const) {
    it(`keeps ${theme} non-text marks and outlines at 3:1`, () => {
      const minimum = brand.focus.nonTextContrast;
      // The focus ring is the accent; a control drawn by its edge alone uses border-strong; status
      // colours double as icons. Each is checked on every surface it can sit on.
      for (const mark of ['accent', 'border-strong', 'teal', 'blue', 'warning', 'danger', 'ai-ink']) {
        for (const surface of surfaces) {
          expect(
            contrast(hex(theme, mark), hex(theme, surface)),
            `${mark} on ${surface} (${theme})`,
          ).toBeGreaterThanOrEqual(minimum);
        }
      }
      for (const surface of viewerSurfaces) {
        expect(contrast(hex(theme, 'viewer-focus'), hex(theme, surface))).toBeGreaterThanOrEqual(minimum);
      }
    });
  }

  it('keeps the logo rules where scripts and specs can read them', () => {
    expect(LOGO_CLEAR_SPACE).toBe(brand.logo.clearSpace);
    expect(LOGO_MIN_HEIGHT).toEqual(brand.logo.minHeight);
  });

  it('lets page content use the baseline classes through .fl-scope without restyling elements', () => {
    const withoutComments = baseline.replaceAll(/\/\*[\S\s]*?\*\//g, '');
    const scoped = [...withoutComments.matchAll(/\.fl-scope ([^,){]+)/g)].map(([, rest]) => rest.trim());
    expect(scoped.length).toBeGreaterThan(20);
    for (const selector of scoped) {
      // Classes only: a bare element selector under .fl-scope would restyle the pages already there.
      expect(selector, selector).toMatch(/^\.(fl-[\w-]+|button|sr-only|muted)\b/);
    }
    for (const name of [
      '.button',
      '.sr-only',
      '.muted',
      '.fl-skeleton',
      '.fl-spinner',
      '.fl-reveal',
      '.fl-type-title',
    ]) {
      expect(scoped, name).toContain(name);
    }
    // The ring and the height floor reach only what opts in by class.
    expect(css).toMatch(
      /\.fl-scope :where\(\.button, \.fl-control, \.fl-press\):focus-visible {\s*outline: var\(--fl-focus-ring\);/,
    );
    expect(css).toMatch(/\.fl-scope :where\(\.button, \.fl-control\) {\s*min-height: 44px;/);
    expect(readFileSync('src/lib/components/layouts/UserPageLayout.svelte', 'utf8')).toMatch(
      /class="[^"]*\bfl-scope\b/,
    );
  });

  for (const theme of ['dark', 'light'] as const) {
    it(`declares every ${theme} colour role and elevation from brand-tokens.json`, () => {
      for (const [name, value] of Object.entries(brand.color[theme])) {
        expect(themes[theme].get(`--fl-${name}`), `--fl-${name} (${theme})`).toBe(value);
      }
      for (const [level, value] of Object.entries(brand.elevation[theme])) {
        expect(themes[theme].get(`--fl-shadow-${level}`), `--fl-shadow-${level} (${theme})`).toBe(value);
      }
    });
  }

  it('declares the type scale: size, line height, weight and tracking for every step', () => {
    const sizeTokens: Record<string, string> = {
      display: 'display',
      title: 'title',
      headline: 'headline',
      hero: 'hero',
      body: 'size',
      callout: 'callout',
      caption: 'small',
      micro: 'micro',
    };
    for (const [step, { size, lineHeight, weight, tracking }] of Object.entries(brand.type)) {
      const sizeToken = `--fl-font-${sizeTokens[step]}`;
      expect(base.get(sizeToken), sizeToken).toBe(`${size}px`);
      expect(base.get(`--fl-type-${step}`), `--fl-type-${step}`).toBe(
        `${weight} var(${sizeToken}) / ${lineHeight} var(--fl-family-ui)`,
      );
      expect(base.get(`--fl-tracking-${step}`), `--fl-tracking-${step}`).toBe(tracking);
      // Every step has its class in the baseline.
      expect(baseline).toMatch(
        new RegExp(String.raw`:where\(\.frameleaf \.fl-type-${step}, \.fl-scope \.fl-type-${step}\) {`),
      );
    }
  });

  it('declares the spacing, radius, icon, control, layer and focus scales', () => {
    for (const [step, value] of Object.entries(brand.space)) {
      expect(base.get(`--fl-space-${step}`), `--fl-space-${step}`).toBe(`${value}px`);
      // A 4px grid, with one 2px half step.
      expect(value % 4 === 0 || step === 'half').toBe(true);
    }
    const radiusTokens = {
      xs: 'xs',
      sm: 'sm',
      control: 'control',
      'control-compact': 'control-compact',
      card: 'card',
      capsule: 'capsule',
      pill: 'pill',
    };
    for (const [name, token] of Object.entries(radiusTokens)) {
      expect(base.get(`--fl-radius-${token}`), `--fl-radius-${token}`).toBe(
        `${brand.radius[name as keyof typeof radiusTokens]}px`,
      );
    }
    expect(base.get('--fl-radius-dialog')).toBe(`${brand.radius.sheet}px`);

    expect(Object.keys(brand.icon)).toHaveLength(6);
    expect(ICON_PX).toEqual(brand.icon);
    // The Icon component takes its size as a string; the same numbers, as strings.
    expect(ICON_SIZE).toEqual(
      Object.fromEntries(Object.entries(brand.icon).map(([name, value]) => [name, String(value)])),
    );
    for (const [name, value] of Object.entries(brand.icon)) {
      expect(base.get(`--fl-icon-${name}`), `--fl-icon-${name}`).toBe(`${value}px`);
    }

    expect(CONTROL_HEIGHT).toEqual(brand.control);
    expect(base.get('--fl-control-height')).toBe(`${brand.control.default}px`);
    expect(base.get('--fl-control-height-touch')).toBe(`${brand.control.touch}px`);
    expect(base.get('--fl-control-height-compact')).toBe(`${brand.control.compact}px`);
    expect(brand.control.default).toBe(brand.touchTarget.iosPoints);
    expect(brand.control.touch).toBe(brand.touchTarget.androidDp);

    expect(Z_INDEX).toEqual(brand.z);
    for (const [name, value] of Object.entries(brand.z)) {
      expect(base.get(`--fl-z-${name}`), `--fl-z-${name}`).toBe(String(value));
    }
    // A modal sits above its scrim, a toast above a modal, a menu above a toast, a tooltip above all.
    const { popover, scrim, modal, toast, menu, tooltip } = brand.z;
    const layers = [popover, scrim, modal, toast, menu, tooltip];
    expect(layers).toEqual([...layers].sort((a, b) => a - b));
  });

  it('defines one focus ring with one offset for controls and one for edge-to-edge items', () => {
    expect(base.get('--fl-focus-ring')).toBe(`${brand.focus.width}px solid var(--fl-accent)`);
    expect(base.get('--fl-focus-offset')).toBe(`${brand.focus.offset}px`);
    expect(base.get('--fl-focus-inset')).toBe(`${brand.focus.inset}px`);
    expect(css).toMatch(
      /\.frameleaf :focus-visible,[^{]*{\s*outline: var\(--fl-focus-ring\);\s*outline-offset: var\(--fl-focus-offset\);/,
    );
    expect(css).toMatch(/\.frameleaf \.fl-focus-inset:focus-visible {\s*outline-offset: var\(--fl-focus-inset\);/);
  });

  it('declares one duration per motion pattern, mirrored for script use', () => {
    const cssNames: Record<string, string> = {
      fast: '--fl-motion-fast',
      base: '--fl-motion',
      slow: '--fl-motion-slow',
      spring: '--fl-duration',
    };
    for (const [name, value] of Object.entries(brand.motion.duration)) {
      expect(base.get(cssNames[name] ?? `--fl-duration-${name}`), name).toBe(`${value}ms`);
    }
    expect(DURATION).toEqual(brand.motion.duration);
    for (const [name, value] of Object.entries(brand.motion.exit)) {
      expect(base.get(`--fl-duration-${name}-out`), `${name} exit`).toBe(`${value}ms`);
      // An exit is always quicker than its entrance.
      expect(value).toBeLessThan(brand.motion.duration[name as keyof typeof brand.motion.exit]);
    }
    expect(EXIT_DURATION).toEqual(brand.motion.exit);
    expect(base.get('--fl-stagger')).toBe(`${brand.motion.staggerMs}ms`);
    expect(STAGGER_MS).toBe(brand.motion.staggerMs);
    expect(base.get('--fl-ease')).toBe(brand.motion.ease);
    expect(EASE).toBe(brand.motion.ease);
    expect(SNAPPY).toBe(brand.motion.snappy);
    // Seven patterns.
    expect(Object.keys(brand.motion.patterns).sort()).toEqual(
      ['press', 'pop', 'sheet', 'dock', 'reflow', 'hero', 'reveal'].sort(),
    );
    // The view transition's pseudo-elements hang off <html>: the hero duration comes from the root tokens.
    expect(appCss).toMatch(/::view-transition-group\(fl-hero\) {\s*animation-duration: var\(--fl-duration-hero\);/);
  });

  it('mirrors the CSS spring as script stops', () => {
    const entries = (base.get('--fl-spring') ?? '')
      .replace(/^linear\(/, '')
      .replace(/\)$/, '')
      .split(',')
      .map((entry) => entry.trim().split(/\s+/))
      .map(([value, at]) => ({ value: Number(value), at: at ? Number(at.replace('%', '')) / 100 : undefined }));
    entries[0].at ??= 0;
    entries.at(-1)!.at ??= 1;
    // A stop without a position sits evenly between its positioned neighbours, as linear() does.
    for (let index = 0; index < entries.length; index++) {
      if (entries[index].at !== undefined) {
        continue;
      }
      let next = index;
      while (entries[next].at === undefined) {
        next++;
      }
      const from = entries[index - 1].at as number;
      const step = ((entries[next].at as number) - from) / (next - index + 1);
      for (let fill = index; fill < next; fill++) {
        entries[fill].at = from + step * (fill - index + 1);
      }
    }
    expect(SPRING_STOPS).toHaveLength(entries.length);
    for (const [index, [at, value]] of SPRING_STOPS.entries()) {
      expect(at).toBeCloseTo(entries[index].at as number, 4);
      expect(value).toBe(entries[index].value);
    }
  });

  it('defines one scrim, darker and unblurred under Increase Contrast and Reduce Transparency', () => {
    expect(base.get('--fl-scrim')).toBe(brand.scrim.fill);
    expect(base.get('--fl-scrim-blur')).toBe(brand.scrim.blur);
    const fallback = blockAfter(css, '@media (prefers-contrast: more), (prefers-reduced-transparency: reduce)');
    expect(fallback).toContain('--fl-scrim: rgb(0 0 0 / 67%);');
    expect(fallback).toContain('--fl-scrim-blur: none;');
    expect(baseline).toMatch(/\.frameleaf \.fl-scrim,[^{]*{[^}]*background: var\(--fl-scrim\);/);
  });

  it('puts the tokens on the document root without restyling it', () => {
    // Portalled surfaces (toasts, kit modals) and the kit mapping in app.css read the root tokens.
    expect(css).toMatch(/:root\.dark,\s*\.fl-media-viewer,\s*\.frameleaf\[data-theme='dark'\] {/);
    expect(css).toMatch(/:root:not\(\.dark\),\s*\.frameleaf\[data-theme='light'\] {/);
    expect(css).toMatch(/:root,\s*\.fl-media-viewer,\s*\.frameleaf {/);
    const withoutComments = css.replaceAll(/\/\*[\S\s]*?\*\//g, '');
    for (const [, selector, body] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selector.includes(':root')) {
        continue;
      }
      // A rule that reaches the root declares custom properties and color-scheme, nothing else.
      const declared = body
        .split(';')
        .map((declaration) => declaration.trim().split(':', 1)[0].trim())
        .filter(Boolean);
      for (const property of declared) {
        expect(property.startsWith('--fl-') || property === 'color-scheme', `${property} on ${selector.trim()}`).toBe(
          true,
        );
      }
    }
  });

  it('gives the legacy kit and Tailwind the brand from app.css', () => {
    // Tailwind gray and neutral are the Frameleaf neutral ramp.
    for (const ramp of ['gray', 'neutral']) {
      for (const [step, value] of Object.entries(brand.neutral)) {
        expect(appCss, `--color-${ramp}-${step}`).toContain(`--color-${ramp}-${step}: ${value};`);
      }
    }
    // The ramp's ends are the theme surfaces, and its text steps stay readable on them.
    expect(brand.neutral['50']).toBe(brand.color.light.canvas);
    expect(brand.neutral['100']).toBe(brand.color.light.raised);
    expect(brand.neutral['200']).toBe(brand.color.light.border);
    expect(brand.neutral['600']).toBe(brand.color.light.muted);
    expect(brand.neutral['400']).toBe(brand.color.dark.muted);
    expect(brand.neutral['700']).toBe(brand.color.dark.border);
    expect(brand.neutral['800']).toBe(brand.color.dark.raised);
    expect(brand.neutral['900']).toBe(brand.color.dark.panel);
    expect(brand.neutral['950']).toBe(brand.color.dark.canvas);
    expect(contrast(brand.neutral['500'], '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(brand.neutral['500'], brand.neutral['100'])).toBeGreaterThanOrEqual(4);
    expect(contrast(brand.neutral['400'], brand.neutral['800'])).toBeGreaterThanOrEqual(4.5);

    // The legacy colour utilities are RGB triplets of the same tokens.
    const triplet = (color: string) =>
      [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)).join(' ');
    for (const [name, value] of [
      ['--immich-primary', brand.color.light.accent],
      ['--immich-bg', brand.color.light.panel],
      ['--immich-fg', brand.color.light.text],
      ['--immich-gray', brand.color.light.canvas],
      ['--immich-dark-primary', brand.color.dark.accent],
      ['--immich-dark-bg', brand.color.dark.canvas],
      ['--immich-dark-fg', brand.color.dark.text],
      ['--immich-dark-gray', brand.color.dark.raised],
    ]) {
      expect(appCss, name).toContain(`${name}: ${triplet(value)};`);
    }

    // The kit's primary, status and neutral variables point at the tokens in both themes.
    const kit = { light: blockAfter(appCss, ':root,\n.light {'), dark: blockAfter(appCss, '\n.dark {') };
    for (const theme of ['light', 'dark'] as const) {
      expect(kit[theme]).toContain('--immich-ui-primary-500: var(--fl-accent);');
      expect(kit[theme]).toContain('--immich-ui-danger-500: var(--fl-danger);');
      expect(kit[theme]).toContain('--immich-ui-warning-500: var(--fl-warning);');
      expect(kit[theme]).toContain('--immich-ui-info-500: var(--fl-blue);');
      expect(kit[theme]).toContain('--immich-ui-dark: var(--fl-text);');
      expect(kit[theme]).toContain('--immich-ui-default-border: var(--fl-border);');
      for (const step of [50, 100, 200, 300, 400, 600, 700, 800, 900, 950]) {
        expect(kit[theme], `primary-${step} (${theme})`).toMatch(
          new RegExp(String.raw`--immich-ui-primary-${step}: color-mix\(in srgb, var\(--fl-accent\) \d+%, `),
        );
      }
      // A filled kit button is `bg-<status> text-light`: `light` must be readable on every fill.
      const light = /--immich-ui-light: var\(--fl-(\w+)\);/.exec(kit[theme])?.[1] as 'panel' | 'canvas';
      expect(light).toBe(theme === 'light' ? 'panel' : 'canvas');
      for (const fill of ['accent', 'danger', 'warning', 'blue'] as const) {
        expect(
          contrast(brand.color[theme][light], brand.color[theme][fill]),
          `kit text on ${fill} (${theme})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    // No trace of the earlier indigo.
    expect(appCss).not.toContain('66 80 175');
    expect(appCss).not.toContain('172 203 250');
    // The app font is the Frameleaf stack, not the earlier bundled face.
    expect(appCss).toMatch(/--font-sans: -apple-system, BlinkMacSystemFont, system-ui, Inter, 'Segoe UI', sans-serif;/);
  });

  it('defines the motion vocabulary as classes with exits and a Reduce Motion crossfade', () => {
    const withoutComments = baseline.replaceAll(/\/\*[\S\s]*?\*\//g, '');
    for (const [name, duration] of [
      ['pop', '--fl-duration-pop'],
      ['sheet', '--fl-duration-sheet'],
      ['dock', '--fl-duration-dock'],
    ]) {
      // Entrance: a fade plus the pattern's move on the spring.
      expect(withoutComments).toMatch(
        new RegExp(
          String.raw`\.frameleaf\.fl-${name}\) {[^}]*animation:\s*fl-fade-in var\(--fl-duration-\w+\) var\(--fl-ease\) both,\s*fl-${name}-in var\(${duration}\) var\(--fl-spring\) both;`,
        ),
      );
      // Exit: the pattern's own, shorter duration, never on the spring.
      const exit = new RegExp(String.raw`\.frameleaf\.fl-${name}\.fl-leaving\) {\s*animation: ([^;]+);`).exec(
        withoutComments,
      )?.[1];
      expect(exit, `${name} exit`).toContain(`var(--fl-duration-${name}-out)`);
      expect(exit, `${name} exit`).not.toContain('--fl-spring');
    }
    expect(withoutComments).toMatch(
      /\.frameleaf\.fl-reveal\) {\s*animation: fl-fade-in var\(--fl-motion\) var\(--fl-ease\) both;\s*animation-delay: calc\(min\(var\(--i, 0\), 8\) \* var\(--fl-stagger\)\);/,
    );
    for (const keyframes of [
      'fl-fade-in',
      'fl-fade-out',
      'fl-pop-in',
      'fl-sheet-in',
      'fl-sheet-out',
      'fl-dock-in',
      'fl-dock-out',
      'fl-skeleton-pulse',
      'fl-spin',
    ]) {
      expect(withoutComments, keyframes).toContain(`@keyframes ${keyframes} {`);
    }
    // No literal durations or bare easings in the baseline's motion.
    const motion = [...withoutComments.matchAll(/(?:animation|transition)(?:-duration)?:\s*([^;]+);/g)].map(
      ([, value]) => value,
    );
    expect(motion.length).toBeGreaterThan(8);
    for (const value of motion) {
      expect(value, value).not.toMatch(/\b\d+m?s\b(?!\s*!important)|\bease(-in|-out|-in-out)?\b(?!\))/);
    }
    // Under Reduce Motion every pattern is one crossfade, important inside the layer so it outranks
    // the unlayered clamp, and the continuous indicators hold still.
    const reduced = blockAfter(withoutComments, '@media (prefers-reduced-motion: reduce)');
    expect(reduced).toMatch(
      /\.frameleaf\.fl-reveal\s*\) {\s*animation: fl-fade-in var\(--fl-duration-reduced\) var\(--fl-ease\) both !important;/,
    );
    expect(reduced).toMatch(
      /\.fl-leaving\) {\s*animation: fl-fade-out var\(--fl-duration-reduced\) var\(--fl-ease\) both !important;/,
    );
    expect(reduced).toMatch(/\.frameleaf\.fl-spinner\s*\) {\s*animation: none !important;/);
  });

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
    // The prototype's corners (apple-style.css).
    expect(base.get('--fl-radius-control')).toBe('9px');
    expect(base.get('--fl-radius-control-compact')).toBe('7px');
    expect(base.get('--fl-radius-card')).toBe('12px');
    expect(base.get('--fl-radius-capsule')).toBe('16px');
    expect(base.get('--fl-radius-dialog')).toBe('22px');
    expect(base.get('--fl-radius-pill')).toBe('999px');
    expect(base.get('--fl-radius-sheet')).toBe('var(--fl-radius-dialog)');
    expect(`${tokens.radius.sheet}px`).toBe(base.get('--fl-radius-dialog'));
  });

  it('ports the September 24 spring, snappy and duration motion tokens', () => {
    // apple-style.css:11-40: a linear() spring that overshoots once and settles on 1.
    const spring = base.get('--fl-spring') ?? '';
    expect(spring).toMatch(/^linear\(\s*0,[\S\s]*,\s*1\s*\)$/);
    const stops = [...spring.matchAll(/(\d+(?:\.\d+)?)(?:\s+[\d.]+%)?\s*[,)]/g)].map(([, value]) => Number(value));
    expect(Math.max(...stops)).toBeGreaterThan(1);
    expect(stops.at(-1)).toBe(1);
    expect(base.get('--fl-snappy')).toBe(tokens.motion.snappy);
    expect(base.get('--fl-duration')).toBe(`${tokens.motion.durationMs}ms`);
  });

  it('ports the frosted material with solid fallbacks for Increase Contrast and Reduce Transparency', () => {
    expect(base.get('--fl-material')).toBe('color-mix(in srgb, var(--fl-panel) 72%, transparent)');
    expect(base.get('--fl-material-edge')).toBe('color-mix(in srgb, var(--fl-text) 12%, transparent)');
    expect(base.get('--fl-material-blur')).toBe(tokens.material.blur);

    const fallback = blockAfter(css, '@media (prefers-contrast: more), (prefers-reduced-transparency: reduce)');
    expect(fallback).toContain('.frameleaf {');
    expect(fallback).toContain('--fl-material: var(--fl-panel);');
    expect(fallback).toContain('--fl-material-edge: var(--fl-border);');
    expect(fallback).toContain('--fl-material-blur: none;');

    for (const theme of ['dark', 'light'] as const) {
      // Over the brightest and darkest photograph the blur can show, and on the solid fallback,
      // every foreground allowed on material stays readable. --fl-muted and --fl-accent are not
      // allowed there; the on-material pair replaces them.
      const fills = {
        'material over black': composite(hex(theme, 'panel'), '#000000', 0.72),
        'material over white': composite(hex(theme, 'panel'), '#ffffff', 0.72),
        'solid fallback': hex(theme, 'panel'),
      };
      for (const foreground of ['text', 'on-material-muted', 'on-material-accent']) {
        for (const [fill, color] of Object.entries(fills)) {
          expect(contrast(hex(theme, foreground), color), `${foreground} on ${fill} (${theme})`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
      // The fallback is the opaque panel, so every foreground keeps the surface contract.
      for (const foreground of foregrounds) {
        expect(contrast(hex(theme, foreground), hex(theme, 'panel'))).toBeGreaterThanOrEqual(4.5);
      }
    }
    // The rule is written down where the tokens are.
    expect(css).toContain('only these tokens and');
  });

  it('uses the Display P3 accent on wide-gamut screens without losing contrast', () => {
    const wide = blockAfter(css, '@media (color-gamut: p3)');
    for (const theme of ['dark', 'light'] as const) {
      const rule = blockAfter(wide, `.frameleaf[data-theme='${theme}']`);
      const accent = /--fl-accent:\s*([^;]+);/.exec(rule)?.[1];
      expect(accent).toBe(tokens.accentP3[theme]);
      const accentLuminance = p3Luminance(accent as string);
      for (const surface of surfaces) {
        expect(
          ratio(accentLuminance, luminance(hex(theme, surface))),
          `P3 accent on ${surface} (${theme})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        ratio(accentLuminance, luminance(hex(theme, 'accent-text'))),
        `accent-text on the P3 accent (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('reserves the indigo AI colour and keeps its tile readable', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(themes[theme].get('--fl-ai')).toBe(tokens.ai.color);
    }
  });

  it('draws every people photo as a squircle mask, the same shape in every engine', () => {
    // Global (app.css), because people photos also render outside a .frameleaf scope.
    expect(appCss).toMatch(/:root\s*{\s*--fl-squircle: url\("data:image\/svg\+xml,[^"]+"\);\s*}/);
    const rule = blockAfter(appCss, '.fl-squircle {');
    expect(rule).toContain('mask: var(--fl-squircle) center / 100% 100% no-repeat;');
    expect(rule).toContain('-webkit-mask: var(--fl-squircle) center / 100% 100% no-repeat;');
    // Nothing inside keeps its own circle.
    expect(appCss).toMatch(/\.fl-squircle :where\(img, figure\) {\s*border-radius: 0 !important;/);
  });

  it('sets continuous corners on component surfaces through one global class', () => {
    // Global, not .frameleaf-scoped: search result chips and the Tags and Folders panes render
    // outside a .frameleaf root. The components keep only their grown radius (sheet-chrome.spec.ts).
    const withoutComments = appCss.replaceAll(/\/\*[\S\s]*?\*\//g, '');
    const corners = blockAfter(withoutComments, '@supports (corner-shape: squircle)');
    expect(corners).toMatch(/:where\(\.fl-continuous-corners\) {\s*corner-shape: squircle;\s*}/);
    expect(baseline).not.toContain('fl-continuous-corners');
  });

  it('starts the font stack with SF Pro and falls back to bundled Inter', () => {
    const stack = base.get('--fl-family-ui');
    expect(stack?.replaceAll("'", '').replaceAll(', ', ',')).toBe(tokens.font.ui.replaceAll(', ', ','));
    expect(base.get('--fl-family-mono')).toBe(brand.font.mono);
    // The scope sets its own face from the body step of the type scale.
    expect(css).toMatch(/\.fl-media-viewer,\s*\.frameleaf {[^}]*font: var\(--fl-type-body\);/);
    expect(stack?.indexOf('-apple-system')).toBe(0);
    expect(stack?.indexOf('Inter')).toBeGreaterThan(stack?.indexOf('system-ui') ?? Infinity);
  });

  it('exposes safe-area insets for edge-to-edge devices', () => {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(base.get(`--fl-safe-${side}`)).toBe(`env(safe-area-inset-${side}, 0px)`);
    }
  });

  it('balances titles, uses tabular numbers, continuous corners and a springy press', () => {
    const withoutComments = baseline.replaceAll(/\/\*[\S\s]*?\*\//g, '');
    expect(withoutComments).toMatch(/:where\(\.frameleaf h1, \.frameleaf h2, \.frameleaf h3\) {\s*text-wrap: balance;/);
    // A heading's tracking follows its step of the type scale: it tightens as it grows.
    expect(withoutComments).toMatch(/:where\(\.frameleaf h1\) {[^}]*letter-spacing: var\(--fl-tracking-display\);/);
    expect(withoutComments).toMatch(/:where\(\.frameleaf h2\) {[^}]*letter-spacing: var\(--fl-tracking-headline\);/);
    const tracking = (step: string) => Number((base.get(`--fl-tracking-${step}`) ?? '').replace('em', ''));
    expect(tracking('hero')).toBeLessThan(tracking('display'));
    expect(tracking('display')).toBeLessThan(tracking('title'));
    expect(tracking('title')).toBeLessThan(tracking('headline'));
    // One transition list: the spring press and the colour/border changes of `.button` together.
    const transitions = [...withoutComments.matchAll(/transition:\s*([^;]+);/g)].map(([, value]) => value);
    const buttonTransition = transitions.find((value) => value.includes('var(--fl-spring)')) ?? '';
    for (const property of ['transform', 'background-color', 'border-color', 'color', 'box-shadow']) {
      expect(buttonTransition).toMatch(new RegExp(String.raw`(^|\s)${property} `));
    }
    expect(transitions.filter((value) => value.includes('transform'))).toHaveLength(1);
    // Drag handles never scale.
    expect(withoutComments).toMatch(/button:active:not\(:disabled, \.fl-no-press\)/);
    expect(withoutComments).toContain('font-variant-numeric: var(--fl-numeric);');
    expect(base.get('--fl-numeric')).toBe(brand.numerals.counts);
    const corners = blockAfter(withoutComments, '@supports (corner-shape: squircle)');
    expect(corners).toContain('corner-shape: squircle;');
    expect(corners).toContain('calc(var(--fl-radius-sheet) * 1.8)');
    expect(withoutComments).toMatch(
      /\.button:active:not\(:disabled, \.fl-no-press\)\s*\) {\s*transform: scale\(0\.96\);/,
    );
    const reduced = blockAfter(withoutComments, '@media (prefers-reduced-motion: reduce)');
    expect(reduced).toMatch(/transform: none;/);
    // The materials other packets reuse, solid under the tokens.css fallback.
    expect(withoutComments).toMatch(/\.frameleaf \.fl-material,[^{]*{[^}]*backdrop-filter: var\(--fl-material-blur\);/);
  });

  it('honours reduced motion and keeps native touch targets', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/transition-duration: 0\.01ms !important/);
    expect(css).toMatch(/min-height: 44px/);
    expect(css).toMatch(/@media \(pointer: coarse\)[\S\s]*min-height: 48px/);
  });

  it('stops CSS motion outside .frameleaf roots too (FL-139)', () => {
    const reduced = appCss.slice(appCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after {[^}]*transition-duration: 0\.01ms !important;/);
    expect(reduced).toMatch(/\*::after {[^}]*animation-duration: 0\.01ms !important;/);
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
    // Keyframes have no selectors of their own to scope; everything else is checked.
    const withoutComments = baseline
      .replaceAll(/\/\*[\S\s]*?\*\//g, '')
      .replaceAll(/@keyframes [\w-]+ {(?:[^{}]*{[^{}]*})*\s*}/g, '');
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

  it('layers the prototype baseline below Tailwind and @frameleaf/ui utilities', () => {
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

  it('leaves @frameleaf/ui form controls to their own ring', () => {
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
    // The hook the exclusion relies on: @frameleaf/ui draws its field ring with the ring-1 utility.
    const immichStyles = readFileSync('node_modules/@frameleaf/ui/dist/styles.js', 'utf8');
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
      expect(hover).toBe(brand.accent.hover[theme]);

      // Pressed goes the other way from hover in the dark theme and further the same way in the light.
      const pressed = themes[theme].get('--fl-accent-pressed');
      expect(pressed).toBe(brand.accent.pressed[theme]);
      const [, pressedOther, pressedShare] =
        /^color-mix\(in srgb, var\(--fl-accent\), (black|var\(--fl-text\)) (\d+)%\)$/.exec(pressed ?? '') ?? [];
      expect(pressedOther, `unexpected --fl-accent-pressed in the ${theme} theme`).toBeDefined();
      const pressedFill = mix(
        hex(theme, 'accent'),
        pressedOther === 'black' ? '#000000' : hex(theme, 'text'),
        Number(pressedShare) / 100,
      );
      expect(
        contrast(hex(theme, 'accent-text'), pressedFill),
        `accent-text on pressed (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    // The prototype's own lightening mix stays in the dark theme.
    expect(themes.dark.get('--fl-accent-hover')).toBe('color-mix(in srgb, var(--fl-accent), white 10%)');
  });

  it('never leaks the prototype stylesheet into production', () => {
    // Every rule stays under the .frameleaf scope; no bare element or html/body rules, so
    // mounting Theme.svelte cannot restyle the surrounding application. The document root is named
    // only beside a .frameleaf selector, in rules that declare custom properties alone (checked in
    // 'puts the tokens on the document root without restyling it').
    const withoutComments = css.replaceAll(/\/\*[\S\s]*?\*\//g, '').replaceAll(/@import[^;]+;/g, '');
    const selectors = [...withoutComments.matchAll(/([^{}]+)\{/g)]
      .map(([, selector]) => selector.trim())
      .filter((selector) => selector.length > 0 && !selector.startsWith('@'));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector, 'unscoped rule').toContain('.frameleaf');
      expect(selector, 'bare element rule').not.toMatch(/(^|,)\s*(html|body|\*)\b/);
    }
  });
});

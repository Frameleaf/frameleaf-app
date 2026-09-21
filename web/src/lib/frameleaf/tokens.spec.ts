import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import tokens from '../../../../design/frameleaf/tokens.json';

const css = readFileSync('src/lib/frameleaf/tokens.css', 'utf8');

const luminance = (hex: string) => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  return channels.reduce(
    (sum, value, index) =>
      sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index],
    0,
  );
};

describe('Frameleaf theme contract', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`matches approved ${theme} colors and readable foreground contrast`, () => {
      const section = css.split(`[data-theme='${theme}']`)[1].split('}')[0];
      for (const [name, value] of Object.entries(tokens[theme])) expect(section).toContain(`--fl-${name}: ${value}`);
      for (const foreground of ['text', 'muted', 'accent'] as const) {
        for (const surface of ['canvas', 'panel', 'raised'] as const) {
          const pair = [luminance(tokens[theme][foreground]), luminance(tokens[theme][surface])].sort((a, b) => a - b);
          expect((pair[1] + 0.05) / (pair[0] + 0.05)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});

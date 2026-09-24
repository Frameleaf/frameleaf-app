import { readFileSync } from 'node:fs';
import tokens from '../../../../design/frameleaf/tokens.json';
import { FRAMELEAF_THEME_COLORS, themeColor } from './theme-color';

describe('theme-color', () => {
  it('uses each theme canvas from the design tokens', () => {
    expect(themeColor('dark')).toBe(tokens.dark.canvas);
    expect(themeColor('light')).toBe(tokens.light.canvas);
    expect(FRAMELEAF_THEME_COLORS).toEqual({ dark: '#101416', light: '#f4f6f7' });
  });

  it('follows the app theme in the root layout instead of the OS colour scheme', () => {
    const layout = readFileSync('src/routes/+layout.svelte', 'utf8');
    expect(layout).not.toMatch(/name="theme-color"[^>]*media=/);
    expect(layout).toMatch(/<meta name="theme-color" content=\{themeColor\(/);
  });
});

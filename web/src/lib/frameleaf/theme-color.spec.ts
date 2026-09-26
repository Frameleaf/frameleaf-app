import { readFileSync } from 'node:fs';
import tokens from '../../../../design/frameleaf/tokens.json';
import { applyThemeColor, FRAMELEAF_THEME_COLORS, themeColor } from './theme-color';

describe('theme-color', () => {
  afterEach(() => {
    for (const meta of document.head.querySelectorAll('meta[name="theme-color"]')) {
      meta.remove();
    }
  });

  it('uses each theme canvas from the design tokens', () => {
    expect(themeColor('dark')).toBe(tokens.dark.canvas);
    expect(themeColor('light')).toBe(tokens.light.canvas);
    expect(FRAMELEAF_THEME_COLORS).toEqual({ dark: '#101416', light: '#f4f6f7' });
  });

  it('updates the existing theme-color meta, or adds one', () => {
    applyThemeColor('light');
    const metas = document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0].content).toBe('#f4f6f7');
    applyThemeColor('dark');
    expect(document.head.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(metas[0].content).toBe('#101416');
  });

  it('ships a static dark default that the pre-paint script switches for the light theme', () => {
    const html = readFileSync('src/app.html', 'utf8');
    expect(html).toContain('<meta name="theme-color" content="#101416" />');
    expect(html).toContain(`?.setAttribute('content', '#f4f6f7')`);
    expect(html).not.toMatch(/name="theme-color"[^>]*media=/);
  });

  it('follows the app theme in the root layout instead of the OS colour scheme', () => {
    const layout = readFileSync('src/routes/+layout.svelte', 'utf8');
    expect(layout).not.toMatch(/name="theme-color"/);
    expect(layout).toMatch(/\$effect\(\(\) => applyThemeColor\(themeManager\.value === Theme\.Dark/);
  });
});

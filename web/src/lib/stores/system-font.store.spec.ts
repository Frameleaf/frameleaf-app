import { get } from 'svelte/store';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { systemFont } from '$lib/stores/system-font.store';

describe('Use system font (FL-983)', () => {
  afterEach(() => systemFont.set(false));

  it('is off by default', () => {
    expect(get(systemFont)).toBe(false);
    expect(document.documentElement.dataset.font).toBeUndefined();
  });

  it('marks the page while on and clears it when off', () => {
    systemFont.set(true);
    expect(document.documentElement.dataset.font).toBe('system');
    systemFont.set(false);
    expect(document.documentElement.dataset.font).toBeUndefined();
  });

  it('is read before first paint from the same key, and overrides both font tokens', () => {
    const html = readFileSync('src/app.html', 'utf8');
    expect(html).toContain("localStorage.getItem('frameleaf-system-font') === 'true'");
    expect(html.indexOf('frameleaf-system-font')).toBeLessThan(html.indexOf('%sveltekit.head%'));
    const tokens = readFileSync('src/app.css', 'utf8');
    const rule = tokens.slice(tokens.indexOf(":root[data-font='system'],"));
    expect(rule).toContain(":root[data-font='system'] .frameleaf");
    expect(rule).toContain('--font-sans:');
    expect(rule).toContain('--fl-family-ui:');
  });
});

import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Logo from './Logo.svelte';

describe('Frameleaf Logo (FL-135)', () => {
  it('renders the compact symbol with an accessible name by default', () => {
    const { container } = render(Logo, { variant: 'icon' });
    const img = container.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('Frameleaf');
    expect(img?.getAttribute('src')).toContain('frameleaf-symbol.svg');
  });

  it('hides the mark from the accessibility tree when decorative', () => {
    const { container } = render(Logo, { variant: 'icon', decorative: true });
    const img = container.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the authorized dark-background lockup for the inline variant in dark theme', () => {
    const { container } = render(Logo, { variant: 'inline', theme: 'dark' });
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toContain('frameleaf-logo-dark.svg');
    expect(img?.getAttribute('alt')).toBe('Frameleaf');
  });

  it('never places a white/near-white wordmark on a light surface: light theme falls back to the symbol plus text', () => {
    const { container, getByText } = render(Logo, { variant: 'inline', theme: 'light' });
    // No image sourced from the dark-background or white wordmark lockups.
    const images = [...container.querySelectorAll('img')];
    for (const img of images) {
      const src = img.getAttribute('src') ?? '';
      expect(src).not.toContain('logo-dark');
      expect(src).not.toContain('logo-white');
    }
    // The symbol (safe on any background) is present but decorative...
    const symbolImg = images.find((img) => (img.getAttribute('src') ?? '').includes('frameleaf-symbol.svg'));
    expect(symbolImg?.getAttribute('alt')).toBe('');
    // ...and the product name is carried by real, theme-colored text instead.
    expect(getByText('Frameleaf')).toBeTruthy();
  });
});

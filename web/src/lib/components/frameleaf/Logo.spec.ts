import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import logoDarkUrl from '../../assets/frameleaf/frameleaf-logo-dark.svg?url';
import symbolUrl from '../../assets/frameleaf/frameleaf-symbol.svg?url';
import Logo from './Logo.svelte';

// Vite inlines an asset under its size limit as a data URI, so the brand-kit originals are compared
// by the URL their own import resolves to rather than by file name.

describe('Frameleaf Logo (FL-135)', () => {
  it('renders the compact symbol with an accessible name by default', () => {
    const { container } = render(Logo, { variant: 'icon' });
    const img = container.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('Frameleaf');
    expect(img?.getAttribute('src')).toBe(symbolUrl);
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
    expect(img?.getAttribute('src')).toBe(logoDarkUrl);
    expect(img?.getAttribute('alt')).toBe('Frameleaf');
  });

  it('never places a white/near-white wordmark on a light surface: light theme falls back to the symbol plus text', () => {
    const { container, getByText } = render(Logo, { variant: 'inline', theme: 'light' });
    // No image sourced from the dark-background or white wordmark lockups.
    const images = [...container.querySelectorAll('img')];
    for (const img of images) {
      const src = img.getAttribute('src') ?? '';
      expect(src).not.toBe(logoDarkUrl);
      expect(src).not.toContain('logo-dark');
      expect(src).not.toContain('logo-white');
    }
    // The symbol (safe on any background) is present but decorative...
    const symbolImg = images.find((img) => img.getAttribute('src') === symbolUrl);
    expect(symbolImg?.getAttribute('alt')).toBe('');
    // ...and the product name is carried by real, theme-colored text instead.
    expect(getByText('Frameleaf')).toBeTruthy();
  });
});

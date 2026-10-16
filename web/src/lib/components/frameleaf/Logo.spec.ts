import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import logoDarkUrl from '../../assets/frameleaf/frameleaf-logo-dark.svg?url';
import logoOnLightUrl from '../../assets/frameleaf/frameleaf-logo-on-light.svg?url';
import symbolUrl from '../../assets/frameleaf/frameleaf-symbol.svg?url';
import Logo from './Logo.svelte';

// Vite inlines an asset under its size limit as a data URI, so the brand artwork is compared by the
// URL its own import resolves to rather than by file name.

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

  it("renders the brand kit's own dark logo for the inline variant in dark theme, with no plate", () => {
    const { container } = render(Logo, { variant: 'inline', theme: 'dark' });
    const images = [...container.querySelectorAll('img')];
    expect(images.map((img) => img.getAttribute('src'))).toEqual([logoDarkUrl]);
    expect(images[0].getAttribute('alt')).toBe('Frameleaf');
    expect(images[0].parentElement).toBe(container);
  });

  it('swaps to the light version (dark-ink "Frame") on a light surface, one image with no plate', () => {
    const { container } = render(Logo, { variant: 'inline', theme: 'light' });
    const images = [...container.querySelectorAll('img')];
    expect(images.map((img) => img.getAttribute('src'))).toEqual([logoOnLightUrl]);
    expect(images[0].getAttribute('alt')).toBe('Frameleaf');
    // The lockup stands by itself: nothing wraps it in a plate.
    expect(images[0].parentElement).toBe(container);
  });
});

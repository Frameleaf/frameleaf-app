import { describe, expect, it } from 'vitest';
import { docsLink } from './help-links.svelte';

describe('docsLink (FL-135)', () => {
  it('joins the configured documentation address and a page', () => {
    expect(docsLink('https://docs.frameleaf.example/', '/administration/oauth')).toBe(
      'https://docs.frameleaf.example/administration/oauth',
    );
    expect(docsLink('https://docs.frameleaf.example', 'features/reverse-geocoding')).toBe(
      'https://docs.frameleaf.example/features/reverse-geocoding',
    );
  });
});

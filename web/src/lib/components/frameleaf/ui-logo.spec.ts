import { Logo, logoManager, Modal, SupporterBadge, Theme, ThemePreference, themeManager } from '@frameleaf/ui';
import { cleanup, render } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import symbolUrl from '../../assets/frameleaf/frameleaf-symbol.svg?url';

describe('shared UI logo defaults', () => {
  let previousTheme: ThemePreference;

  beforeEach(() => {
    previousTheme = themeManager.preference;
    logoManager.resetLogos();
    themeManager.setPreference(ThemePreference.Light);
  });

  afterEach(() => {
    cleanup();
    logoManager.resetLogos();
    themeManager.setPreference(previousTheme);
  });

  it('renders an accessible app mark before any layout initialization', () => {
    const { getByRole } = render(Logo, { variant: 'icon' });
    expect(getByRole('img', { name: 'Frameleaf logo' })).toHaveAttribute('src', symbolUrl);
  });

  it.each(['inline', 'stacked'] as const)('uses the dark wordmark for %s', (variant) => {
    themeManager.setPreference(ThemePreference.Dark);
    const { getByRole } = render(Logo, { variant });
    expect(getByRole('img')).toHaveAttribute('src', expect.stringMatching(/\/frameleaf-logo-dark\.svg$/));
  });

  it.each(['inline', 'stacked'] as const)('uses the symbol on light surfaces for %s', (variant) => {
    const { getByRole } = render(Logo, { variant });
    expect(getByRole('img')).toHaveAttribute('src', symbolUrl);
  });

  it('updates mounted marks for custom logos and restores app defaults on reset', async () => {
    const { getByRole } = render(Logo, { variant: 'inline' });
    const custom = {
      stacked: { light: '/stacked-light.svg', dark: '/stacked-dark.svg' },
      unstacked: { light: '/inline-light.svg', dark: '/inline-dark.svg' },
      icon: '/icon.svg',
    };
    logoManager.setLogo(custom);
    await tick();
    expect(getByRole('img')).toHaveAttribute('src', '/inline-light.svg');
    expect(logoManager.getLogo('stacked', Theme.Dark)).toBe('/stacked-dark.svg');
    expect(logoManager.getLogo('logo', Theme.Dark)).toBe('/icon.svg');
    logoManager.resetLogos();
    await tick();
    expect(getByRole('img')).toHaveAttribute('src', symbolUrl);
  });

  it('uses app defaults in a supporter badge', () => {
    const { getByRole } = render(SupporterBadge, { text: 'Supporter' });
    expect(getByRole('img', { name: 'Frameleaf logo' })).toHaveAttribute('src', symbolUrl);
  });

  it('uses app defaults in a dialog header', async () => {
    const { findByRole } = render(Modal, {
      title: 'Brand dialog',
      icon: true,
      children: createRawSnippet(() => ({ render: () => '<p>Brand dialog content</p>' })),
    });
    expect(await findByRole('img', { name: 'Frameleaf logo' })).toHaveAttribute('src', symbolUrl);
  });
});

import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { get } from 'svelte/store';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { locale } from '$lib/stores/preferences.store';
import en from '../../../../../i18n/en.json';
import AppSettings from './AppSettings.svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

describe('AppSettings (CC-50)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  it('uses Frameleaf switches and selects, and hides the custom locale behind the browser locale', async () => {
    locale.set('default');
    render(AppSettings);

    expect(screen.getByRole('switch', { name: en.theme_selection })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: en.language })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: en.custom_locale })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('switch', { name: en.use_browser_locale }));
    expect(get(locale)).not.toBe('default');
    expect(screen.getByRole('combobox', { name: en.custom_locale })).toBeInTheDocument();
  });
});

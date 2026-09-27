import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { get } from 'svelte/store';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  alwaysLoadOriginalFile,
  alwaysLoadOriginalVideo,
  autoPlayVideo,
  locale,
  loopVideo,
  playVideoThumbnailOnHover,
  showDeleteModal,
} from '$lib/stores/preferences.store';
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

  // FL-71: every device setting of the source App settings page (upstream AppSettings.svelte) keeps
  // a switch on this device's page, and the switch writes this browser's setting.
  it.each([
    ['display_original_photos', alwaysLoadOriginalFile],
    ['play_original_video', alwaysLoadOriginalVideo],
    ['video_hover_setting', playVideoThumbnailOnHover],
    ['setting_video_viewer_auto_play_title', autoPlayVideo],
    ['loop_videos', loopVideo],
    ['permanent_deletion_warning', showDeleteModal],
  ] as const)('keeps the %s device setting as a switch that writes this browser', async (key, store) => {
    render(AppSettings);
    const before = get(store);
    await fireEvent.click(screen.getByRole('switch', { name: en[key] }));
    expect(get(store)).toBe(!before);
    store.set(before);
  });
});

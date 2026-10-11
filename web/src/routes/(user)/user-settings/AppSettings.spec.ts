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

const albums = vi.hoisted(() => ({
  draft: { 'albums.defaultAssetOrder': 'desc' },
  baseline: { 'albums.defaultAssetOrder': 'desc' },
  dirty: false,
  stale: false,
  loading: false,
  saving: false,
  error: null,
  notice: null,
  set: vi.fn(),
  follow: vi.fn(),
  cancel: vi.fn(),
  save: vi.fn(),
  loadLatest: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), beforeNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('$lib/frameleaf/own-preferences-draft', () => ({ createOwnPreferencesDraft: () => albums }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { preferences: {}, user: {} } }));

describe('AppSettings: Look & playback (FL-368)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  it('groups the page under four headings', () => {
    render(AppSettings);

    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Appearance',
      'Browsing',
      'Photos and videos',
      'Safety',
    ]);
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Light or dark' })).toBeInTheDocument();
  });

  it('makes the date format one choice, with the region only once a region is asked for', async () => {
    locale.set('default');
    render(AppSettings);

    const dates = screen.getByRole('group', { name: 'Dates and numbers' });
    expect(screen.getByRole('button', { name: 'Match this device', pressed: true })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Region' })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Choose a region' }));
    expect(get(locale)).not.toBe('default');
    expect(screen.getByRole('combobox', { name: 'Region' })).toBeInTheDocument();
    expect(dates).toBeInTheDocument();
    locale.set('default');
  });

  it('keeps "Show albums" as an account preference that waits for the Save bar', async () => {
    render(AppSettings);

    await fireEvent.click(screen.getByRole('button', { name: 'Oldest first' }));
    expect(albums.set).toHaveBeenCalledWith('albums.defaultAssetOrder', 'asc');
  });

  // FL-71: every device setting of the source App settings page keeps a switch on this device's
  // page, and the switch writes this browser's setting.
  it.each([
    ['Show full-quality photos', alwaysLoadOriginalFile],
    ['Play the original video file', alwaysLoadOriginalVideo],
    ['Play a video when the pointer rests on it', playVideoThumbnailOnHover],
    ['Start videos by themselves', autoPlayVideo],
    ['Repeat videos', loopVideo],
    ['Ask before deleting forever', showDeleteModal],
  ] as const)('keeps "%s" as a switch that writes this browser', async (name, store) => {
    render(AppSettings);
    const before = get(store);
    await fireEvent.click(screen.getByRole('switch', { name }));
    expect(get(store)).toBe(!before);
    store.set(before);
  });
});

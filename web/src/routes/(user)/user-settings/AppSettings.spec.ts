import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { get } from 'svelte/store';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
import {
  alwaysLoadOriginalFile,
  alwaysLoadOriginalVideo,
  autoPlayVideo,
  libraryStartLayout,
  locale,
  loopVideo,
  playVideoThumbnailOnHover,
  showDeleteModal,
} from '$lib/stores/preferences.store';
import { reduceMotion } from '$lib/stores/reduce-motion.store';
import en from '../../../../../i18n/en.json';
import AppSettings from './AppSettings.svelte';

const albums = vi.hoisted(() => ({
  draft: { 'albums.defaultAssetOrder': 'desc', 'search.includeArchived': false },
  baseline: { 'albums.defaultAssetOrder': 'desc', 'search.includeArchived': false },
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
    expect(within(dates).getByRole('button', { name: 'Match this device', pressed: true })).toBeInTheDocument();
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
    ['Use less movement', reduceMotion],
  ] as const)('keeps "%s" as a switch that writes this browser', async (name, store) => {
    render(AppSettings);
    const before = get(store);
    await fireEvent.click(screen.getByRole('switch', { name }));
    expect(get(store)).toBe(!before);
    store.set(before);
  });

  it('ACCOUNT-P3: adds the four rows, with "Dates and numbers" and "Use less movement" under Appearance', async () => {
    render(AppSettings);

    const appearance = screen.getByRole('heading', { name: 'Appearance' }).closest('section')!;
    expect(within(appearance).getByRole('group', { name: 'Dates and numbers' })).toBeInTheDocument();
    expect(within(appearance).getByRole('switch', { name: 'Use less movement' })).toBeInTheDocument();

    // "Use less movement" also tells the page's CSS, on the root element
    await fireEvent.click(screen.getByRole('switch', { name: 'Use less movement' }));
    expect(document.documentElement).toHaveAttribute('data-reduce-motion');
    reduceMotion.set(false);
    expect(document.documentElement).not.toHaveAttribute('data-reduce-motion');

    await fireEvent.click(
      within(screen.getByRole('group', { name: 'Open the library in' })).getByRole('button', { name: 'Work' }),
    );
    expect(get(libraryStartLayout)).toBe('work');
    libraryStartLayout.set(null);

    const names = screen.getByRole('switch', { name: 'Show file names in Work view' });
    const before = libraryGridPreferences.showFileNames;
    await fireEvent.click(names);
    expect(libraryGridPreferences.showFileNames).toBe(!before);
    libraryGridPreferences.showFileNames = before;

    // an account preference: it waits for the Save bar
    await fireEvent.click(screen.getByRole('switch', { name: 'Show archived photos in search' }));
    expect(albums.set).toHaveBeenCalledWith('search.includeArchived', true);
  });
});

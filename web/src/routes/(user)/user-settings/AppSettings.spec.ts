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
  draft: { 'albums.defaultAssetOrder': 'desc', 'search.includeArchived': false, 'trash.reuploadUntil': '' } as Record<
    string,
    unknown
  >,
  baseline: { 'albums.defaultAssetOrder': 'desc', 'search.includeArchived': false, 'trash.reuploadUntil': '' },
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

  it('FL-556: lets uploads bring back deleted photos for 24 hours, as an account preference', async () => {
    const before = Date.now();
    const { unmount } = render(AppSettings);
    const toggle = screen.getByRole('switch', { name: 'Let uploads bring back deleted photos' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/For 24 hours, uploading a photo that is in your Trash/)).toBeInTheDocument();

    await fireEvent.click(toggle);
    const [key, until] = albums.set.mock.calls.at(-1)!;
    expect(key).toBe('trash.reuploadUntil');
    expect(Date.parse(until as string) - before).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(Date.parse(until as string) - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    unmount();

    // On: the switch shows it and when it ends; turning it off clears it.
    albums.draft['trash.reuploadUntil'] = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    render(AppSettings);
    const on = screen.getByRole('switch', { name: 'Let uploads bring back deleted photos' });
    expect(on).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/^On until .+ Turns itself off after that\.$/)).toBeInTheDocument();
    await fireEvent.click(on);
    expect(albums.set).toHaveBeenLastCalledWith('trash.reuploadUntil', '');

    // A window that has passed reads as off.
    albums.draft['trash.reuploadUntil'] = new Date(Date.now() - 1).toISOString();
    expect(screen.getByRole('switch', { name: 'Let uploads bring back deleted photos' })).toBeInTheDocument();
    albums.draft['trash.reuploadUntil'] = '';
  });
});

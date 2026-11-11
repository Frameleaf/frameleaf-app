import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages, locale as i18nLocale } from 'svelte-i18n';
import { get } from 'svelte/store';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { libraryView } from '$lib/frameleaf/library-view.svelte';
import { saveNotificationLanguage } from '$lib/frameleaf/notification-language';
import {
  alwaysLoadOriginalFile,
  alwaysLoadOriginalVideo,
  autoPlayVideo,
  lang,
  libraryStartLayout,
  locale,
  loopVideo,
  playVideoThumbnailOnHover,
  showDeleteModal,
} from '$lib/stores/preferences.store';
import { reduceMotion } from '$lib/stores/reduce-motion.store';
import { handleError } from '$lib/utils/handle-error';
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
vi.mock('$lib/frameleaf/notification-language', () => ({ saveNotificationLanguage: vi.fn() }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('$lib/frameleaf/own-preferences-draft', () => ({ createOwnPreferencesDraft: () => albums }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { preferences: {}, user: {} } }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { assistant: true } },
}));

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

  it('waits for the notification locale save before switching language and blocks overlapping choices', async () => {
    const previousLanguage = get(lang);
    const previousLocale = get(i18nLocale);
    lang.set('en');
    addMessages('fr', en);
    let resolve!: () => void;
    vi.mocked(saveNotificationLanguage).mockImplementationOnce(() => new Promise<void>((done) => (resolve = done)));
    const { unmount } = render(AppSettings);
    const picker = screen.getByRole('combobox', { name: 'Language' });
    try {
      await fireEvent.change(picker, { target: { value: 'fr' } });
      expect(saveNotificationLanguage).toHaveBeenLastCalledWith('fr');
      expect(picker).toBeDisabled();
      expect(get(lang)).toBe('en');
      expect(get(i18nLocale)).toBe(previousLocale);
      resolve();
      await waitFor(() => expect(get(lang)).toBe('fr'));
      await waitFor(() => expect(picker).not.toBeDisabled());
      expect(get(i18nLocale)).toBe('fr');
    } finally {
      unmount();
      lang.set(previousLanguage);
      await i18nLocale.set(previousLocale);
    }
  });

  it('keeps the previous language and picker choice when the notification save fails', async () => {
    const previousLanguage = get(lang);
    const previousLocale = get(i18nLocale);
    lang.set('en');
    const error = new Error('offline');
    vi.mocked(saveNotificationLanguage).mockRejectedValueOnce(error);
    const { unmount } = render(AppSettings);
    const picker = screen.getByRole('combobox', { name: 'Language' });
    try {
      await fireEvent.change(picker, { target: { value: 'fr' } });
      await waitFor(() => expect(handleError).toHaveBeenCalledWith(error, expect.any(String)));
      expect(get(lang)).toBe('en');
      expect(get(i18nLocale)).toBe(previousLocale);
      expect(picker).not.toBeDisabled();
      expect(picker).toHaveValue('en');
    } finally {
      unmount();
      lang.set(previousLanguage);
      await i18nLocale.set(previousLocale);
    }
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
    // FL-1398: the same choice as the Library View menu's "File name" in Work, kept with the account
    expect(names).not.toBeChecked();
    await fireEvent.click(names);
    expect(libraryView.value.workNames).toBe(true);
    libraryView.set({ workNames: false });

    // an account preference: it waits for the Save bar
    await fireEvent.click(screen.getByRole('switch', { name: 'Show archived photos in search' }));
    expect(albums.set).toHaveBeenCalledWith('search.includeArchived', true);
  });

  it('FL-918: keeps "Use classic search" as an account preference', async () => {
    render(AppSettings);
    const toggle = screen.getByRole('switch', { name: 'Use classic search' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/instead of asking Frameleaf Assistant/)).toBeInTheDocument();
    await fireEvent.click(toggle);
    expect(albums.set).toHaveBeenLastCalledWith('search.classic', true);
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

it.each([
  ['nb_NO', 'nb-NO'],
  ['pt_BR', 'pt-BR'],
  ['dev', 'en'],
])('normalizes stored %s when localizing region names', (stored, displayLocale) => {
  const previousLanguage = get(lang);
  const previousLocale = get(locale);
  addMessages('dev', en);
  lang.set(stored);
  locale.set('en-US');
  const { unmount } = render(AppSettings);
  try {
    const label = new Intl.DisplayNames([displayLocale], { type: 'language' }).of('en-US');
    expect(within(screen.getByRole('combobox', { name: 'Region' })).getByRole('option', { name: label })).toHaveValue(
      'en-US',
    );
    if (stored === 'nb_NO') {
      expect(screen.getByRole('combobox', { name: 'Language' })).toHaveValue('nb-NO');
    }
  } finally {
    unmount();
    lang.set(previousLanguage);
    locale.set(previousLocale);
  }
});

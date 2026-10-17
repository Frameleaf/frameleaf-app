import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import DownloadSettings from './DownloadSettings.svelte';

// D5: decimal GB; LEGACY_GIB is how a preset was saved before
const GB = 1000 ** 3;
const LEGACY_GIB = 1024 ** 3;
const downloads = vi.hoisted(() => ({
  draft: {} as Record<string, unknown>,
  baseline: {} as Record<string, unknown>,
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
vi.mock('$lib/frameleaf/own-preferences-draft', () => ({ createOwnPreferencesDraft: () => downloads }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { preferences: {}, user: {} } }));

const values = (archiveSize: number) => ({
  'download.includeEmbeddedVideos': false,
  'download.includeSidecar': true,
  'download.archiveSize': archiveSize,
});

describe('DownloadSettings (ACCOUNT-P5)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    downloads.draft = values(4 * GB);
    downloads.baseline = values(4 * GB);
  });

  it('puts "What a download contains" first, with a details file and no original-or-edited choice', async () => {
    render(DownloadSettings);

    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'What a download contains',
      'Big downloads',
    ]);
    // Each photo downloads as it is shown (owner, 2026-10-16), so there is nothing to choose.
    expect(screen.queryByRole('group', { name: 'Download' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'My edited version' })).toBeNull();

    const details = screen.getByRole('switch', { name: 'Add a details file' });
    expect(details).toBeChecked();
    await fireEvent.click(details);
    expect(downloads.set).toHaveBeenCalledWith('download.includeSidecar', false);
  });

  it('offers "Custom" with a size in GB, and shows a size saved outside the presets as Custom', async () => {
    render(DownloadSettings);

    const split = screen.getByRole('group', { name: 'Split big downloads into files of' });
    expect(screen.queryByRole('spinbutton', { name: 'File size' })).toBeNull();
    await fireEvent.click(within(split).getByRole('button', { name: 'Custom' }));
    // the prototype's first custom size
    expect(downloads.set).toHaveBeenCalledWith('download.archiveSize', 6 * GB);
  });

  it.each([
    ['decimal', 4 * GB],
    ['pre-D5 binary', 4 * LEGACY_GIB],
  ])('shows a %s 4 GB as the 4 GB preset, and saves a picked preset in decimal GB', async (_form, stored) => {
    downloads.draft = values(stored);
    downloads.baseline = values(stored);
    render(DownloadSettings);

    const split = screen.getByRole('group', { name: 'Split big downloads into files of' });
    expect(within(split).getByRole('button', { name: '4 GB (recommended)', pressed: true })).toBeInTheDocument();
    expect(within(split).getByRole('button', { name: 'Custom', pressed: false })).toBeInTheDocument();
    await fireEvent.click(within(split).getByRole('button', { name: '10 GB' }));
    expect(downloads.set).toHaveBeenCalledWith('download.archiveSize', 10 * GB);
  });

  it('keeps a saved size outside the presets as Custom, with its size in the field', async () => {
    downloads.draft = values(7 * GB);
    downloads.baseline = values(7 * GB);
    render(DownloadSettings);

    const split = screen.getByRole('group', { name: 'Split big downloads into files of' });
    expect(within(split).getByRole('button', { name: 'Custom', pressed: true })).toBeInTheDocument();
    const size = screen.getByRole('spinbutton', { name: 'File size' });
    expect(size).toHaveValue(7);
    await fireEvent.input(size, { target: { value: '12' } });
    expect(downloads.set).toHaveBeenCalledWith('download.archiveSize', 12 * GB);
    expect(screen.getByText('A 25 GB album would arrive as 4 files.')).toBeInTheDocument();
  });
});

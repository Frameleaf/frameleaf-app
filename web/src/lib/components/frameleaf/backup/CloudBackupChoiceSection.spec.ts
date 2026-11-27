import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import CloudBackupChoiceSection from '$lib/components/frameleaf/backup/CloudBackupChoiceSection.svelte';
import en from '../../../../../../i18n/en.json';

const EVERYTHING = {
  mode: 'everything',
  albumIds: [],
  collectionIds: [],
  personIds: [],
  tagIds: [],
  folders: [],
  favorites: false,
  dateRanges: [],
  totalOriginals: 3400,
  selectedOriginals: 3400,
};

describe('Backup › What Cloud Backup keeps (FL-362)', () => {
  beforeAll(() => addMessages('dev', en));

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getOwnCloudBackupSelection.mockResolvedValue(EVERYTHING as never);
    sdkMock.getAllAlbums.mockResolvedValue([
      { id: 'album-1', albumName: 'Our wedding', kind: 'album' },
      { id: 'collection-1', albumName: 'Family', kind: 'collection' },
    ] as never);
    sdkMock.getPeoplePicker.mockResolvedValue({ people: [{ id: 'person-1', name: 'Emma' }] } as never);
    sdkMock.getAllTags.mockResolvedValue([{ id: 'tag-1', value: 'Travel' }] as never);
    sdkMock.getUniqueOriginalPaths.mockResolvedValue(['/library/me/Trips'] as never);
  });

  it('keeps everything by default and says how much that is', async () => {
    render(CloudBackupChoiceSection);
    expect(await screen.findByRole('heading', { name: en.frameleaf_backup_keeps_title })).toBeInTheDocument();
    expect(
      await screen.findByText('All 3,400 of your photos and videos, and everything you add later.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Everything/ })).toHaveAttribute('aria-pressed', 'true');
    // the pickers appear only once the person narrows what is kept
    expect(screen.queryByRole('button', { name: 'Choose albums' })).toBeNull();
  });

  it('narrows to what the person chooses, says the union back and warns when nothing is chosen', async () => {
    sdkMock.setOwnCloudBackupSelection.mockResolvedValue({
      ...EVERYTHING,
      mode: 'chosen',
      selectedOriginals: 0,
    } as never);
    render(CloudBackupChoiceSection);
    await fireEvent.click(await screen.findByRole('button', { name: /Only what I choose/ }));

    expect(sdkMock.setOwnCloudBackupSelection).toHaveBeenCalledWith({
      cloudBackupSelectionUpdateDto: expect.objectContaining({ mode: 'chosen' }),
    });
    expect(await screen.findByText(en.frameleaf_backup_keeps_union)).toBeInTheDocument();
    expect(await screen.findByText(en.frameleaf_backup_keeps_nothing_title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose albums' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose people' })).toBeInTheDocument();
  });

  it('saves favorites at once and shows the new count', async () => {
    sdkMock.getOwnCloudBackupSelection.mockResolvedValue({
      ...EVERYTHING,
      mode: 'chosen',
      selectedOriginals: 0,
    } as never);
    sdkMock.setOwnCloudBackupSelection.mockResolvedValue({
      ...EVERYTHING,
      mode: 'chosen',
      favorites: true,
      selectedOriginals: 1204,
    } as never);
    render(CloudBackupChoiceSection);
    await fireEvent.click(await screen.findByRole('switch', { name: en.frameleaf_backup_keeps_favorites_switch }));

    expect(sdkMock.setOwnCloudBackupSelection).toHaveBeenCalledWith({
      cloudBackupSelectionUpdateDto: expect.objectContaining({ mode: 'chosen', favorites: true }),
    });
    expect(await screen.findByText('About 1,204 of your 3,400 photos and videos')).toBeInTheDocument();
  });

  // FL-529: the end date is the person's today, not UTC's, since capture dates are compared locally.
  it('starts a Between period on the local date', async () => {
    const zone = process.env.TZ;
    process.env.TZ = 'Australia/Sydney';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T22:00:00.000Z'));
    try {
      const chosen = { ...EVERYTHING, mode: 'chosen', selectedOriginals: 0 };
      sdkMock.getOwnCloudBackupSelection.mockResolvedValue(chosen as never);
      sdkMock.setOwnCloudBackupSelection.mockResolvedValue(chosen as never);
      render(CloudBackupChoiceSection);
      await fireEvent.change(await screen.findByRole('combobox', { name: en.frameleaf_backup_keeps_period_label }), {
        target: { value: 'between' },
      });

      expect(sdkMock.setOwnCloudBackupSelection).toHaveBeenCalledWith({
        cloudBackupSelectionUpdateDto: expect.objectContaining({
          dateRanges: [{ kind: 'between', from: '2025-10-22', to: '2026-10-22' }],
        }),
      });
    } finally {
      vi.useRealTimers();
      process.env.TZ = zone;
    }
  });

  // FL-1803: the people to choose from were the first 500 only
  it('offers every person to choose from, past the first page of the list', async () => {
    const everyone = Array.from({ length: 1500 }, (_, index) => ({
      id: `person-${index}`,
      name: `Person ${String(index).padStart(4, '0')}`,
      updatedAt: '2026-11-26T00:00:00.000Z',
      assetCount: 1,
    }));
    sdkMock.getPeoplePicker.mockImplementation(({ page = 1, size = 500 } = {}) =>
      Promise.resolve({
        people: everyone.slice((page - 1) * size, page * size),
        hasNextPage: page * size < everyone.length,
      }),
    );
    sdkMock.getOwnCloudBackupSelection.mockResolvedValue({
      ...EVERYTHING,
      mode: 'chosen',
      selectedOriginals: 0,
    } as never);
    render(CloudBackupChoiceSection);
    await fireEvent.click(await screen.findByRole('button', { name: 'Choose people' }));

    expect(await screen.findByRole('checkbox', { name: 'Person 1499' })).toBeInTheDocument();
    expect(sdkMock.getPeoplePicker.mock.calls.map(([options]) => options)).toEqual([
      { withHidden: false, page: 1, size: 1000 },
      { withHidden: false, page: 2, size: 1000 },
    ]);
  });

  it('chooses albums from the person’s own albums only, not their collections', async () => {
    sdkMock.getOwnCloudBackupSelection.mockResolvedValue({
      ...EVERYTHING,
      mode: 'chosen',
      selectedOriginals: 0,
    } as never);
    sdkMock.setOwnCloudBackupSelection.mockResolvedValue({
      ...EVERYTHING,
      mode: 'chosen',
      albumIds: ['album-1'],
      selectedOriginals: 12,
    } as never);
    render(CloudBackupChoiceSection);
    await fireEvent.click(await screen.findByRole('button', { name: 'Choose albums' }));
    const wedding = await screen.findByRole('checkbox', { name: 'Our wedding' });
    expect(screen.queryByRole('checkbox', { name: 'Family' })).toBeNull();
    await fireEvent.click(wedding);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_backup_keeps_pick_save }));

    await waitFor(() =>
      expect(sdkMock.setOwnCloudBackupSelection).toHaveBeenCalledWith({
        cloudBackupSelectionUpdateDto: expect.objectContaining({ albumIds: ['album-1'] }),
      }),
    );
    expect(await screen.findByText('Our wedding')).toBeInTheDocument();
  });

  it('offers to read the choice again when it cannot be read', async () => {
    sdkMock.getOwnCloudBackupSelection.mockRejectedValue(new Error('offline'));
    render(CloudBackupChoiceSection);
    expect(await screen.findByText(en.frameleaf_backup_keeps_load_failed)).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AlbumSuggestions from './AlbumSuggestions.svelte';

vi.mock('@frameleaf/ui', async () => {
  const actual = await vi.importActual<typeof import('@frameleaf/ui')>('@frameleaf/ui');
  return { ...actual, toastManager: { primary: vi.fn(), danger: vi.fn() } };
});

const suggestions = {
  autoAdd: false,
  tripStart: '2026-08-11',
  tripEnd: '2026-08-16',
  places: ['Lake Louise', 'Banff'],
  fromTrip: [
    {
      assetId: 'trip-1',
      fileName: 'IMG_4821.HEIC',
      likely: true,
      reasons: [
        { kind: 'during-trip', date: '2026-08-14' },
        { kind: 'place', place: 'Lake Louise' },
        { kind: 'something-new' },
      ],
    },
  ],
  needDate: [
    {
      assetId: 'fb-1',
      fileName: 'FB_IMG_1788540812000.jpg',
      source: 'facebook',
      fileDate: '2026-09-04',
      savedAt: '2026-09-04T16:53:32.000Z',
      precision: 'moment',
      dateTimeOriginal: '2026-08-13T20:41:00-06:00',
      reasons: [
        { kind: 'near-identical', assetId: 'a3', fileName: 'Campfire evening.jpg', date: '2026-08-13' },
        { kind: 'same-outfit', names: ['Emma'], assetId: 'a4', fileName: 'Moraine Lake.jpg', date: '2026-08-14' },
      ],
    },
  ],
};

/** FL-1092 / FL-1093 (prototype MagicAlbum.jsx): suggest trip photos and dates, change nothing unasked. */
describe('AlbumSuggestions', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });

  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getAlbumSuggestions.mockResolvedValue(structuredClone(suggestions));
    sdkMock.addAssetsToAlbum.mockResolvedValue([
      { id: 'trip-1', success: true },
      { id: 'fb-1', success: true },
    ]);
  });

  it('shows nothing when there is nothing to suggest', async () => {
    sdkMock.getAlbumSuggestions.mockResolvedValue({ ...suggestions, fromTrip: [], needDate: [] });
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged: vi.fn() });
    await waitFor(() => expect(sdkMock.getAlbumSuggestions).toHaveBeenCalledWith({ id: 'album' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('adds the chosen photos and changes a date only when asked', async () => {
    const onChanged = vi.fn();
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged });
    expect(await screen.findByText("2 more photos look like they're from this trip.")).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Review' }));

    expect(screen.getByText('Lake Louise')).toBeTruthy();
    expect(screen.getByText(/14, 2026, during the trip/)).toBeTruthy();
    expect(screen.queryByText('something-new')).toBeNull();

    await fireEvent.click(screen.getByRole('tab', { name: 'Need a date · 1' }));
    expect(screen.getByText('Saved from Facebook')).toBeTruthy();
    expect(screen.getByText(/Nearly identical to Campfire evening.jpg/)).toBeTruthy();
    // FL-1094
    expect(screen.getByText(/Emma is wearing the same clothes as in photos from .*14/)).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Add 2 photos' }));
    await waitFor(() =>
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledWith({ id: 'album', bulkIdsDto: { ids: ['trip-1', 'fb-1'] } }),
    );
    expect(sdkMock.updateAsset).not.toHaveBeenCalled();
    expect(sdkMock.setAlbumSuggestionAutoAdd).not.toHaveBeenCalled();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('changes the suggested date when that is ticked', async () => {
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await fireEvent.click(screen.getByRole('tab', { name: 'Need a date · 1' }));
    await fireEvent.click(screen.getByLabelText(/Change the date to/));
    await fireEvent.click(screen.getByRole('button', { name: 'Add 2 photos, fix 1 date' }));
    await waitFor(() =>
      expect(sdkMock.updateAsset).toHaveBeenCalledWith({
        id: 'fb-1',
        updateAssetDto: { dateTimeOriginal: '2026-08-13T20:41:00-06:00' },
      }),
    );
  });

  it('keeps photos that could not be added, to try again', async () => {
    const { toastManager } = await import('@frameleaf/ui');
    sdkMock.addAssetsToAlbum.mockResolvedValue([
      { id: 'trip-1', success: true },
      { id: 'fb-1', success: false, error: 'no_permission' as never },
    ]);
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Add 2 photos' }));
    // Said in the review itself, not a toast (prototype `.ma-alert`).
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "1 photo couldn't be added. It's still here to try again.",
    );
    expect(toastManager.danger).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps the way to stop adding new photos when nothing is waiting', async () => {
    sdkMock.getAlbumSuggestions.mockResolvedValue({ ...suggestions, autoAdd: true, fromTrip: [], needDate: [] });
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(sdkMock.setAlbumSuggestionAutoAdd).toHaveBeenCalledWith({
        id: 'album',
        albumSuggestionAutoAddDto: { enabled: false },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    const { toastManager } = await import('@frameleaf/ui');
    expect(toastManager.primary).toHaveBeenCalledWith("New photos from this trip won't be added any more.");
  });

  it('says in the notice when turning off fails, and offers to try again', async () => {
    sdkMock.getAlbumSuggestions.mockResolvedValue({ ...suggestions, autoAdd: true, fromTrip: [], needDate: [] });
    sdkMock.setAlbumSuggestionAutoAdd.mockRejectedValueOnce(new Error('offline'));
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't turn off adding new photos.");
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('names the photo when it cannot be removed from the suggestions', async () => {
    sdkMock.dismissAlbumSuggestions.mockRejectedValueOnce(new Error('offline'));
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Not from this trip: IMG_4821.HEIC' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't remove IMG_4821.HEIC from the suggestions. Try again.",
    );
    expect(screen.getByText('IMG_4821.HEIC')).toBeTruthy();
  });

  it('names a save, not an add, when only a date change fails, and offers to try again', async () => {
    sdkMock.getAlbumSuggestions.mockResolvedValue({ ...suggestions, fromTrip: [] });
    sdkMock.updateAsset.mockRejectedValueOnce(new Error('offline'));
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await fireEvent.click(screen.getByLabelText(/Change the date to/));
    // The date change fails before the add starts, so it is a save that failed.
    await fireEvent.click(screen.getByRole('button', { name: 'Add 1 photo, fix 1 date' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't save the changes.");
    await fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sdkMock.updateAsset).toHaveBeenCalledTimes(2));
    expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledTimes(1);
  });

  it('reads the album and suggestions again when an add fails, since it may have been saved', async () => {
    sdkMock.addAssetsToAlbum.mockRejectedValueOnce(new Error('timeout'));
    const onChanged = vi.fn();
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged });
    await fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Add 2 photos' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't finish adding the photos.");
    await waitFor(() => expect(sdkMock.getAlbumSuggestions).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps the suggestions to try again when reading them again also fails', async () => {
    sdkMock.addAssetsToAlbum.mockRejectedValueOnce(new Error('timeout'));
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    sdkMock.getAlbumSuggestions.mockRejectedValueOnce(new Error('offline'));
    await fireEvent.click(screen.getByRole('button', { name: 'Add 2 photos' }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(sdkMock.getAlbumSuggestions).toHaveBeenCalledTimes(2));
    expect(screen.getByText('IMG_4821.HEIC')).toBeTruthy();
    await fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledTimes(2));
  });

  it('labels the button for dates alone, and moves between tabs with the arrow keys', async () => {
    sdkMock.getAlbumSuggestions.mockResolvedValue({ ...suggestions, fromTrip: [] });
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const dates = screen.getByRole('tab', { name: 'Need a date · 1' });
    expect(dates).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', dates.id);
    expect(dates).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id);
    await fireEvent.click(screen.getByLabelText(/Add to Summer/));
    await fireEvent.click(screen.getByLabelText(/Change the date to/));
    expect(screen.getByRole('button', { name: 'Fix 1 date' })).toBeTruthy();
    expect(screen.getByText(/Date it has now/)).toBeTruthy();

    await fireEvent.keyDown(dates, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'From the trip · 0' })).toHaveAttribute('aria-selected', 'true');
    await fireEvent.keyDown(screen.getByRole('tab', { name: 'From the trip · 0' }), { key: 'ArrowLeft' });
    expect(dates).toHaveAttribute('aria-selected', 'true');
  });

  it('remembers a photo that is not from the trip', async () => {
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const tile = screen.getByText('IMG_4821.HEIC').closest('li')!;
    await fireEvent.click(within(tile).getByRole('button', { name: 'Not from this trip: IMG_4821.HEIC' }));
    await waitFor(() =>
      expect(sdkMock.dismissAlbumSuggestions).toHaveBeenCalledWith({ id: 'album', bulkIdsDto: { ids: ['trip-1'] } }),
    );
    expect(screen.getByText('No more photos from the trip.')).toBeTruthy();
  });
});

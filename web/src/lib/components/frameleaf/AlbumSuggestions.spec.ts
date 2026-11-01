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
      reasons: [{ kind: 'near-identical', assetId: 'a3', fileName: 'Campfire evening.jpg', date: '2026-08-13' }],
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

  it('remembers a photo that is not from the trip', async () => {
    render(AlbumSuggestions, { albumId: 'album', albumName: 'Summer', onChanged: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const tile = screen.getByText('IMG_4821.HEIC').closest('li')!;
    await fireEvent.click(within(tile).getByRole('button', { name: 'Not from this trip' }));
    await waitFor(() =>
      expect(sdkMock.dismissAlbumSuggestions).toHaveBeenCalledWith({ id: 'album', bulkIdsDto: { ids: ['trip-1'] } }),
    );
    expect(screen.getByText('No more photos from the trip.')).toBeTruthy();
  });
});

import { VideoMomentMatch, type AssetResponseDto, type VideoMomentSearchVideoDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { videoSeek } from '$lib/frameleaf/video-seek.svelte';
import VideoMomentResults from './VideoMomentResults.svelte';

const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('$lib/utils/navigation', async (original) => ({ ...(await original<object>()), ...navigation }));

const LAKE = '00000000-0000-4000-8000-0000000000a1';
const DRIVE = '00000000-0000-4000-8000-0000000000a2';

/** One video of the server's answer (FL-1439: the server groups and counts). */
const found = (assetId: string, momentCount: number, firstMs: number): VideoMomentSearchVideoDto => ({
  assetId,
  momentCount,
  firstMs,
  first: {
    assetId,
    timestampMs: firstMs,
    frameId: null,
    momentId: null,
    caption: null,
    match: VideoMomentMatch.Visual,
    score: 0.5,
  },
});
const video = (id: string, localDateTime: string, city?: string) =>
  ({ id, localDateTime, exifInfo: { city } }) as AssetResponseDto;

describe('VideoMomentResults (FL-1393)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    videoSeek.pending = null;
    sdkMock.getAssetInfo.mockResolvedValue(video(DRIVE, '2019-07-04T10:00:00.000Z', 'Banff'));
  });

  it('shows one tile per video, with how many moments match and the time of the first', async () => {
    sdkMock.searchVideoMoments.mockResolvedValue({ hits: [], videos: [found(LAKE, 2, 42_000), found(DRIVE, 1, 9000)] });
    render(VideoMomentResults, { query: 'lake', assets: [video(LAKE, '2019-08-12T09:00:00.000Z', 'Lake Louise')] });

    const strip = await screen.findByRole('region', { name: 'Moments in your videos' });
    expect(within(strip).getByRole('heading', { level: 2 })).toHaveTextContent(/Moments in your videos\s*2 videos/);
    const tiles = within(strip).getAllByRole('button');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toHaveTextContent('2 moments');
    expect(tiles[0]).toHaveTextContent('0:42');
    expect(tiles[0]).toHaveTextContent('Aug 12, 2019 · Lake Louise');
    expect(tiles[0]).toHaveAccessibleName('2 moments, Aug 12, 2019 · Lake Louise. Opens at 0:42.');
    // A video that is not among the results on the page is looked up for its date and place.
    await waitFor(() => expect(tiles[1]).toHaveTextContent('Jul 4, 2019 · Banff'));
    expect(tiles[1]).toHaveTextContent('1 moment');
    expect(sdkMock.getAssetInfo).toHaveBeenCalledExactlyOnceWith({ id: DRIVE });
  });

  it('opens the video at its first matching moment', async () => {
    sdkMock.searchVideoMoments.mockResolvedValue({ hits: [], videos: [found(LAKE, 2, 12_000)] });
    render(VideoMomentResults, { query: 'lake', assets: [video(LAKE, '2019-08-12T09:00:00.000Z')] });

    await fireEvent.click(await screen.findByRole('button', { name: /Opens at 0:12/ }));

    expect(videoSeek.pending).toEqual({ assetId: LAKE, seconds: 12 });
    expect(navigation.navigate).toHaveBeenCalledWith({ targetRoute: 'current', assetId: LAKE });
  });

  it('shows no strip when no video matches, or when moment search fails', async () => {
    sdkMock.searchVideoMoments.mockResolvedValueOnce({ hits: [], videos: [] });
    const view = render(VideoMomentResults, { query: 'lake' });
    await waitFor(() => expect(sdkMock.searchVideoMoments).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('search-moments')).toBeNull();
    view.unmount();

    sdkMock.searchVideoMoments.mockRejectedValueOnce(new Error('offline'));
    render(VideoMomentResults, { query: 'lake' });
    await waitFor(() => expect(sdkMock.searchVideoMoments).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('search-moments')).toBeNull();
  });
});

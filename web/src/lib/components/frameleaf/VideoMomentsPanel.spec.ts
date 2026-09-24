import {
  AssetTypeEnum,
  VideoMomentIndexState,
  VideoMomentSource,
  type AssetResponseDto,
  type VideoMomentFrameDto,
  type VideoMomentsResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { videoSeek } from '$lib/frameleaf/video-seek.svelte';
import en from '../../../../../i18n/en.json';
import VideoMomentsPanel from './VideoMomentsPanel.svelte';

const ASSET_ID = '00000000-0000-4000-8000-0000000000c1';

const asset = { id: ASSET_ID, type: AssetTypeEnum.Video } as AssetResponseDto;

const frame = (index: number, timestampMs: number, overrides: Partial<VideoMomentFrameDto> = {}) => ({
  id: `frame-${index}`,
  frameIndex: index,
  timestampMs,
  rank: index + 1,
  score: 1 - index / 10,
  isCover: false,
  indexed: true,
  width: 640,
  height: 360,
  ...overrides,
});

const moments = (coverIndex: number | null): VideoMomentsResponseDto => {
  const frames = [frame(0, 2000), frame(1, 12_000), frame(2, 64_000)].map((item) => ({
    ...item,
    isCover: coverIndex === null ? item.rank === 1 : item.frameIndex === coverIndex,
  }));
  return {
    assetId: ASSET_ID,
    captionModel: null,
    captionedAt: null,
    coverFrameId: coverIndex === null ? 'frame-0' : `frame-${coverIndex}`,
    coverTimestampMs: coverIndex === null ? null : frames[coverIndex].timestampMs,
    embeddingModel: 'clip',
    extractorVersion: '1',
    frames,
    framesExtractedAt: '2026-09-20T10:00:00.000Z',
    indexedAt: '2026-09-20T10:00:00.000Z',
    moments: [
      {
        id: 'moment-1',
        timestampMs: 95_000,
        endMs: null,
        frameId: null,
        caption: 'Candles blown out',
        transcript: null,
        source: VideoMomentSource.Manual,
        staleReason: null,
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
      },
    ],
    staleReason: null,
    state: VideoMomentIndexState.Ready,
  };
};

beforeEach(() => {
  addMessages('dev', en);
  vi.resetAllMocks();
  videoSeek.pending = null;
  sdkMock.getBaseUrl.mockReturnValue('/api');
  sdkMock.getVideoMoments.mockResolvedValue(moments(null));
});

describe('VideoMomentsPanel', () => {
  it('makes a chosen frame the cover and shows it as the cover', async () => {
    sdkMock.setVideoMomentCover.mockResolvedValue(moments(1));
    render(VideoMomentsPanel, { asset, isOwner: true });

    const choices = await screen.findAllByRole('button', { name: 'Use as cover' });
    expect(choices).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Cover' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Use the best frame' })).not.toBeInTheDocument();

    // Frames render best first and the best (0:02) is the cover, so the first choice is 0:12.
    await fireEvent.click(choices[0]);

    expect(sdkMock.setVideoMomentCover).toHaveBeenCalledWith({
      id: ASSET_ID,
      videoMomentCoverDto: { timestampMs: 12_000 },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cover' }).closest('li')).toHaveTextContent('0:12'));
    expect(screen.getByText('Cover frame at 0:12')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Use as cover' })).toHaveLength(2);
  });

  it('returns the cover to the best frame', async () => {
    sdkMock.getVideoMoments.mockResolvedValue(moments(1));
    sdkMock.setVideoMomentCover.mockResolvedValue(moments(null));
    render(VideoMomentsPanel, { asset, isOwner: true });

    await fireEvent.click(await screen.findByRole('button', { name: 'Use the best frame' }));

    expect(sdkMock.setVideoMomentCover).toHaveBeenCalledWith({
      id: ASSET_ID,
      videoMomentCoverDto: { timestampMs: null },
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use the best frame' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Cover' }).closest('li')).toHaveTextContent('0:02');
  });

  it('does not offer cover choices to someone who does not own the video', async () => {
    render(VideoMomentsPanel, { asset, isOwner: false });

    expect(await screen.findByRole('button', { name: 'Play from 0:12' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use as cover' })).not.toBeInTheDocument();
    expect(sdkMock.setVideoMomentCover).not.toHaveBeenCalled();
  });

  it('starts the video at a frame’s moment when the frame is chosen', async () => {
    render(VideoMomentsPanel, { asset, isOwner: false });

    await fireEvent.click(await screen.findByRole('button', { name: 'Play from 1:04' }));

    expect(videoSeek.pending).toEqual({ assetId: ASSET_ID, seconds: 64 });
    expect(videoSeek.take(ASSET_ID)).toBe(64);
    expect(videoSeek.take(ASSET_ID)).toBeNull();
  });

  it('starts the video at a listed moment when its time is chosen', async () => {
    render(VideoMomentsPanel, { asset, isOwner: true });

    expect(await screen.findByText('Candles blown out')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Play from 1:35' }));

    expect(videoSeek.pending).toEqual({ assetId: ASSET_ID, seconds: 95 });
  });
});

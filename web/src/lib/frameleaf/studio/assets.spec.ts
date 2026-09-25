import { AssetTypeEnum, AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils', () => ({
  getAssetMediaUrl: ({ id, size }: { id: string; size?: string }) => `/api/assets/${id}/thumbnail?size=${size}`,
  getAssetPlaybackUrl: ({ id }: { id: string }) => `/api/assets/${id}/video/playback`,
}));

const { isStudioEligibleAsset, toStudioAsset, toStudioAssets } = await import('./assets');

const asset = (overrides: Partial<AssetResponseDto> = {}): AssetResponseDto =>
  ({
    id: 'asset-1',
    type: AssetTypeEnum.Image,
    originalFileName: 'summit.jpg',
    duration: null,
    thumbhash: 'hash',
    isOffline: false,
    isTrashed: false,
    visibility: AssetVisibility.Timeline,
    ...overrides,
  }) as AssetResponseDto;

describe('studio asset projection', () => {
  it('hands the engine URLs rather than anything it could call the API with', () => {
    const projected = toStudioAsset(
      asset({ type: AssetTypeEnum.Video, duration: 12_500, width: 1920, height: 1080, originalMimeType: 'video/mp4' }),
    );

    expect(projected).toEqual({
      id: 'asset-1',
      kind: 'video',
      name: 'summit.jpg',
      // FL-93: the DTO is in milliseconds, the timeline is in exact rational seconds.
      duration: { num: 25, den: 2 },
      thumbnailUrl: '/api/assets/asset-1/thumbnail?size=thumbnail',
      previewUrl: '/api/assets/asset-1/thumbnail?size=preview',
      playbackUrl: '/api/assets/asset-1/video/playback',
      isOffline: false,
      // What the library already knows about the pixels, so the editor does not have to guess.
      width: 1920,
      height: 1080,
      mimeType: 'video/mp4',
    });
    expect(Object.keys(projected)).not.toContain('originalPath');
  });

  it('gives a still no duration and no playback source', () => {
    const projected = toStudioAsset(asset());

    expect(projected.duration).toBeNull();
    expect(projected.playbackUrl).toBeNull();
  });

  // FL-93
  it('converts every duration exactly, including the ones a float cannot hold', () => {
    expect(toStudioAsset(asset({ type: AssetTypeEnum.Video, duration: 1 })).duration).toEqual({
      num: 1,
      den: 1000,
    });
    // One hour: 3600000 ms is exactly 3600 s, with no denominator left over.
    expect(toStudioAsset(asset({ type: AssetTypeEnum.Video, duration: 3_600_000 })).duration).toEqual({
      num: 3600,
      den: 1,
    });
    expect(toStudioAsset(asset({ type: AssetTypeEnum.Video, duration: 0 })).duration).toEqual({
      num: 0,
      den: 1,
    });
    // 33367 ms is not a round number of seconds; it stays exact rather than becoming 33.367.
    expect(toStudioAsset(asset({ type: AssetTypeEnum.Video, duration: 33_367 })).duration).toEqual({
      num: 33_367,
      den: 1000,
    });
  });

  it('never lets a Locked asset cross the boundary', () => {
    expect(isStudioEligibleAsset(asset({ visibility: AssetVisibility.Locked }))).toBe(false);
  });

  it('excludes trashed media and types a timeline cannot hold', () => {
    expect(isStudioEligibleAsset(asset({ isTrashed: true }))).toBe(false);
    expect(isStudioEligibleAsset(asset({ type: AssetTypeEnum.Audio }))).toBe(false);
    expect(isStudioEligibleAsset(asset({ type: AssetTypeEnum.Other }))).toBe(false);
    expect(isStudioEligibleAsset(asset({ visibility: AssetVisibility.Archive }))).toBe(true);
  });

  it('passes an offline original through flagged rather than hiding it', () => {
    expect(toStudioAsset(asset({ isOffline: true })).isOffline).toBe(true);
  });

  it('preserves the caller order while filtering', () => {
    const projected = toStudioAssets([
      asset({ id: 'c' }),
      asset({ id: 'locked', visibility: AssetVisibility.Locked }),
      asset({ id: 'a' }),
    ]);

    expect(projected.map((item) => item.id)).toEqual(['c', 'a']);
  });
});

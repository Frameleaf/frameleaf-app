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
    const projected = toStudioAsset(asset({ type: AssetTypeEnum.Video, duration: 12_500 }));

    expect(projected).toEqual({
      id: 'asset-1',
      kind: 'video',
      name: 'summit.jpg',
      // The DTO is in milliseconds; a timeline works in seconds.
      durationSeconds: 12.5,
      thumbnailUrl: '/api/assets/asset-1/thumbnail?size=thumbnail',
      previewUrl: '/api/assets/asset-1/thumbnail?size=preview',
      playbackUrl: '/api/assets/asset-1/video/playback',
      isOffline: false,
    });
    expect(Object.keys(projected)).not.toContain('originalPath');
  });

  it('gives a still no duration and no playback source', () => {
    const projected = toStudioAsset(asset());

    expect(projected.durationSeconds).toBeNull();
    expect(projected.playbackUrl).toBeNull();
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

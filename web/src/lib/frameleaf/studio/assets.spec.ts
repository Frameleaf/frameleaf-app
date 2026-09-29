import {
  AssetRestorationMode,
  AssetRestorationSourceType,
  AssetTypeEnum,
  AssetVisibility,
  StudioRestoredVersionUnavailable,
  type AssetResponseDto,
  type StudioRestoredVersionDto,
} from '@immich/sdk';
import { describe, expect, it, vi } from 'vitest';
import { sessionAccess } from '$lib/frameleaf/session-access.svelte';

vi.mock('$lib/frameleaf/restoration', () => ({
  restorationFileUrl: (assetId: string, restorationId: string, kind: string) =>
    `/api/assets/${assetId}/restorations/${restorationId}/file?kind=${kind}`,
}));
vi.mock('$lib/utils', () => ({
  getAssetMediaUrl: ({ id, size }: { id: string; size?: string }) => `/api/assets/${id}/thumbnail?size=${size}`,
  getAssetPlaybackUrl: ({ id }: { id: string }) => `/api/assets/${id}/video/playback`,
  getStudioHdrVideoUrl: (id: string) => `/api/assets/${id}/video/studio-hdr`,
}));

const {
  isStudioEligibleAsset,
  restorationIdOfMedia,
  restoredVersionIdsIn,
  toStudioAsset,
  toStudioAssets,
  toStudioRestoredAsset,
  withHdrSources,
} = await import('./assets');

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

  it('never lets a Locked asset cross the boundary while the session is locked', () => {
    expect(isStudioEligibleAsset(asset({ visibility: AssetVisibility.Locked }))).toBe(false);
  });

  it("offers the owner's revealed marks and detections in an unlocked session (FL-195)", () => {
    sessionAccess.isElevated = true;
    try {
      expect(isStudioEligibleAsset(asset({ visibility: AssetVisibility.Locked }))).toBe(true);
    } finally {
      sessionAccess.isElevated = false;
    }
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

  it('marks the HDR originals the server reported, so the project becomes HDR (FL-97)', () => {
    const projected = toStudioAssets([asset({ id: 'sdr' }), asset({ id: 'hdr', type: AssetTypeEnum.Video })]);
    const marked = withHdrSources(projected, ['hdr', 'not-in-bin']);

    expect(marked.map((item) => [item.id, item.hdr])).toEqual([
      ['sdr', undefined],
      ['hdr', true],
    ]);
    expect(withHdrSources(projected, undefined)).toEqual(projected);
  });

  it('hands the engine the HDR intermediate of an HDR original once the server has one (FL-97)', () => {
    const projected = toStudioAssets([
      asset({ id: 'hdr', type: AssetTypeEnum.Video }),
      asset({ id: 'pending', type: AssetTypeEnum.Video }),
    ]);
    const marked = withHdrSources(projected, ['hdr', 'pending'], ['hdr', 'sdr-never']);

    expect(marked[0].hdrSourceUrl).toMatch(/\/assets\/hdr\/video\/studio-hdr/);
    expect(marked[1]).toMatchObject({ hdr: true });
    expect(marked[1].hdrSourceUrl).toBeUndefined();
  });
});

describe('restored versions in the bin (FL-115)', () => {
  const restorationId = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001';
  const version = (overrides: Partial<StudioRestoredVersionDto> = {}): StudioRestoredVersionDto => ({
    restorationId,
    assetId: 'asset-1',
    mediaId: `restored-${restorationId}`,
    available: true,
    unavailable: null,
    sourceType: AssetRestorationSourceType.Video,
    mode: AssetRestorationMode.Faithful,
    upscale: 2,
    smoothMotionFactor: null,
    width: 3840,
    height: 2160,
    durationSeconds: 12.5,
    originalFileName: 'summit.mp4',
    restoredAt: '2026-09-27T10:00:00.000Z',
    expiresAt: null,
    ...overrides,
  });

  it('is its own bin entry: its media id names the restoration, and it plays the restored file', () => {
    expect(toStudioRestoredAsset(version(), 'summit.mp4 (restored)')).toEqual({
      id: `restored-${restorationId}`,
      kind: 'video',
      name: 'summit.mp4 (restored)',
      duration: { num: 25, den: 2 },
      thumbnailUrl: '/api/assets/asset-1/thumbnail?size=thumbnail',
      previewUrl: '/api/assets/asset-1/thumbnail?size=preview',
      playbackUrl: `/api/assets/asset-1/restorations/${restorationId}/file?kind=result`,
      isOffline: false,
      width: 3840,
      height: 2160,
      mimeType: 'video/mp4',
    });
  });

  it('shows a restored photo from its restored preview', () => {
    const photo = toStudioRestoredAsset(
      version({ sourceType: AssetRestorationSourceType.Image, durationSeconds: null }),
      'scan.jpg (restored)',
    );
    expect(photo).toMatchObject({
      kind: 'image',
      duration: null,
      playbackUrl: null,
      previewUrl: `/api/assets/asset-1/restorations/${restorationId}/file?kind=result_preview`,
    });
  });

  it('marks a discarded or expired version unusable rather than falling back to the original', () => {
    const gone = toStudioRestoredAsset(
      version({ available: false, unavailable: StudioRestoredVersionUnavailable.Discarded }),
      'x',
    );
    expect(gone.isOffline).toBe(true);
    expect(gone.id).toBe(`restored-${restorationId}`);
  });

  it('reads the restored versions a stored project places, and nothing else', () => {
    const other = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002';
    const graph = {
      tracks: [
        { items: [{ mediaId: `restored-${restorationId}` }, { mediaId: 'asset-1' }, { assetId: 'restored-bad' }] },
        { items: [{ restorationId: other }, { restorationId: 'not-a-uuid' }] },
      ],
    };
    expect(new Set(restoredVersionIdsIn(graph))).toEqual(new Set([restorationId, other]));
    expect(restoredVersionIdsIn(null)).toEqual([]);
    expect(restorationIdOfMedia('asset-1')).toBeNull();
    expect(restorationIdOfMedia(`restored-${restorationId}`)).toBe(restorationId);
  });
});

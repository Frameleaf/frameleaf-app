import { AssetVisibility, MediaKind } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { isDiscoveryFilter } from '$lib/components/discovery/query';
import { buildExploreMediaKinds } from '$lib/frameleaf/explore';
import { knownMediaKinds, mediaKindSearchHref, slowMotionRate, slowMotionRateAt } from '$lib/frameleaf/media-kinds';

describe('media kinds (FL-1284)', () => {
  it('keeps only the kinds this build can label, in the camera app order', () => {
    expect(knownMediaKinds({ exifInfo: { mediaKinds: ['selfie', 'something-new', 'slow-motion'] } as never })).toEqual([
      MediaKind.SlowMotion,
      MediaKind.Selfie,
    ]);
    expect(knownMediaKinds({ exifInfo: undefined })).toEqual([]);
  });

  it('slows a slow-motion clip to its filmed speed between the opening and closing moments', () => {
    expect(slowMotionRate(240)).toBe(0.125);
    expect(slowMotionRate(120)).toBe(0.25);
    expect(slowMotionRate(1000)).toBe(0.0625);
    expect(slowMotionRate(30)).toBe(1);
    expect(slowMotionRate(null)).toBe(1);

    expect(slowMotionRateAt(0.5, 10, 240)).toBe(1);
    expect(slowMotionRateAt(5, 10, 240)).toBe(0.125);
    expect(slowMotionRateAt(9.5, 10, 240)).toBe(1);
    expect(slowMotionRateAt(5, NaN, 240)).toBe(1);
  });

  it('opens a search the discovery query accepts, narrowed to the Timeline like the count', () => {
    const href = mediaKindSearchHref(MediaKind.Panorama);
    const query = JSON.parse(new URL(href, 'https://x').searchParams.get('query')!);
    expect(query.filter).toEqual({ mediaKinds: { any: ['panorama'] }, visibility: { eq: AssetVisibility.Timeline } });
    expect(isDiscoveryFilter(query.filter)).toBe(true);
    expect(isDiscoveryFilter({ mediaKinds: { any: ['not-a-kind'] } })).toBe(false);
  });

  it('builds Explore cards for the kinds the library has, in order, with covers', () => {
    const cards = buildExploreMediaKinds(
      [
        { value: 'selfie', count: 4, coverAssetId: 'a' },
        { value: 'panorama', count: 2, coverAssetId: null },
        { value: 'unknown-kind', count: 9, coverAssetId: 'b' },
      ],
      (entry) => entry.labelKey,
    );
    expect(cards.map(({ id, count, coverAssetId, label }) => ({ id, count, coverAssetId, label }))).toEqual([
      { id: 'panorama', count: 2, coverAssetId: null, label: 'frameleaf_media_kind_panorama' },
      { id: 'selfie', count: 4, coverAssetId: 'a', label: 'frameleaf_media_kind_selfie' },
    ]);
  });
});

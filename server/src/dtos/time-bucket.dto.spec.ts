import {
  TIMELINE_FILTER_MAX_LENGTH,
  TimeBucketAssetDto,
  TimeBucketDto,
  TimelineHighlightsDto,
  TimelineOrderedDto,
} from 'src/dtos/time-bucket.dto.js';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';

describe('timeline bounding boxes', () => {
  it.each([',,,', ',0,1,1', '0,,1,1', '0,0,,1', '0,0,1,', '0, ,1,1'])(
    'refuses missing coordinate components in %s',
    (bbox) => {
      expect(TimeBucketDto.schema.safeParse({ bbox }).success).toBe(false);
      expect(TimeBucketAssetDto.schema.safeParse({ bbox, timeBucket: '2024-01-01' }).success).toBe(false);
      expect(TimelineOrderedDto.schema.safeParse({ bbox, sort: 'filename' }).success).toBe(false);
      expect(TimelineHighlightsDto.schema.safeParse({ bbox }).success).toBe(false);
    },
  );

  it.each([
    ['0,0,0,0', { west: 0, south: 0, east: 0, north: 0 }],
    [' -1 , 0 , 1 , 2 ', { west: -1, south: 0, east: 1, north: 2 }],
    ['170,-10,-170,10', { west: 170, south: -10, east: -170, north: 10 }],
  ] as const)('retains explicit coordinates in %s', (bbox, expected) => {
    expect(TimeBucketDto.schema.parse({ bbox }).bbox).toEqual(expected);
  });
});

describe('Best Photos on the timeline (LIB-P3)', () => {
  it('reads bestPhotos from the query string on the buckets, a bucket and the ordered page', () => {
    expect(TimeBucketDto.schema.parse({ bestPhotos: 'true' }).bestPhotos).toBe(true);
    expect(TimeBucketDto.schema.parse({ bestPhotos: 'false' }).bestPhotos).toBe(false);
    expect(TimeBucketDto.schema.parse({}).bestPhotos).toBeUndefined();
    expect(
      TimeBucketAssetDto.schema.parse({ timeBucket: '2024-01-01T00:00:00.000Z', bestPhotos: 'true' }).bestPhotos,
    ).toBe(true);
    expect(TimelineOrderedDto.schema.parse({ bestPhotos: 'true', sort: 'quality' })).toEqual(
      expect.objectContaining({ bestPhotos: true, sort: 'quality', skip: 0, take: 500 }),
    );
  });

  it('rejects anything but true or false, and an unknown sort', () => {
    expect(TimeBucketDto.schema.safeParse({ bestPhotos: 'yes' }).success).toBe(false);
    expect(TimelineOrderedDto.schema.safeParse({ sort: 'score' }).success).toBe(false);
  });
});

describe('tag filters without the tags inside (DISCOVERY-P4)', () => {
  it('reads withChildTags from the query string and leaves it unset by default', () => {
    const tagId = '00000000-0000-4000-8000-000000000001';
    expect(TimeBucketDto.schema.parse({ tagId, withChildTags: 'false' }).withChildTags).toBe(false);
    expect(TimeBucketDto.schema.parse({ tagId, withChildTags: 'true' }).withChildTags).toBe(true);
    expect(TimeBucketDto.schema.parse({ tagId }).withChildTags).toBeUndefined();
  });
});

describe('the search filter on the timeline (FL-425)', () => {
  const personIds = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  const filter = {
    make: { eq: 'Canon' },
    personIds: { all: personIds },
    takenAt: { gte: '2024-01-01T00:00:00.000Z' },
    or: [{ city: { eq: 'Banff' } }, { rating: { gte: 4 } }],
  };

  it('reads a JSON-encoded SearchFilter from the query string on every timeline route', () => {
    const expected = { ...filter, takenAt: { gte: new Date('2024-01-01T00:00:00.000Z') } };
    const query = { filter: JSON.stringify(filter), imageEnrichment: 'missing-image-description' };
    expect(TimeBucketDto.schema.parse(query)).toEqual({
      filter: expected,
      imageEnrichment: 'missing-image-description',
    });
    expect(TimeBucketAssetDto.schema.parse({ ...query, timeBucket: '2024-01-01' }).filter).toEqual(expected);
    expect(TimelineOrderedDto.schema.parse({ ...query, sort: 'rating' }).filter).toEqual(expected);
    expect(TimelineHighlightsDto.schema.parse(query).filter).toEqual(expected);
    expect(TimeBucketDto.schema.parse({})).toEqual({});
  });

  it('refuses malformed JSON, a condition search does not know, and an oversized filter', () => {
    for (const value of [
      '{"make":',
      '"Canon"',
      JSON.stringify({ camera: { eq: 'Canon' } }),
      JSON.stringify({ personIds: { all: ['not-a-uuid'] } }),
      JSON.stringify({ or: [] }),
      JSON.stringify({ make: { eq: 'x'.repeat(TIMELINE_FILTER_MAX_LENGTH) } }),
    ]) {
      expect(TimeBucketDto.schema.safeParse({ filter: value }).success).toBe(false);
    }
    expect(TimeBucketDto.schema.safeParse({ imageEnrichment: 'blurry' }).success).toBe(false);
  });
});

describe('Locked-folder filters', () => {
  it.each(['frameleaf-locked-folder', 'immich-locked-folder'])(
    'normalizes %s to the canonical reason',
    (lockReason) => {
      expect(TimeBucketDto.schema.parse({ visibility: AssetVisibility.Locked, lockReason }).lockReason).toBe(
        AssetLockReason.FrameleafLockedFolder,
      );
    },
  );

  it('still rejects unknown lock reasons', () => {
    expect(TimeBucketDto.schema.safeParse({ visibility: AssetVisibility.Locked, lockReason: 'unknown' }).success).toBe(
      false,
    );
  });
});

describe('bounded calendar pages', () => {
  const timeBucket = '2024-01-01';
  const anchor = '00000000-0000-4000-8000-000000000001';

  it('requires a bounded asset lookup when specifying a flat sort', () => {
    for (const sort of ['filename', 'rating', 'quality']) {
      expect(TimeBucketDto.schema.parse({ pageSize: 500, locateAssetId: anchor, sort })).toHaveProperty('sort', sort);
      expect(TimeBucketDto.schema.safeParse({ pageSize: 500, sort }).success).toBe(false);
    }
  });

  it('validates page summaries and direct asset lookup', () => {
    expect(TimeBucketDto.schema.parse({ pageSize: '500', locateAssetId: anchor })).toEqual({
      pageSize: 500,
      locateAssetId: anchor,
    });
    for (const query of [
      { pageSize: 0 },
      { pageSize: 1001 },
      { pageSize: 2.5 },
      { locateAssetId: anchor },
      { pageSize: 500, locateAssetId: 'invalid' },
    ]) {
      expect(TimeBucketDto.schema.safeParse(query).success).toBe(false);
    }
  });

  it('retains the legacy request and accepts a bounded page with an opaque asset anchor', () => {
    expect(TimeBucketAssetDto.schema.parse({ timeBucket })).toEqual({ timeBucket });
    expect(TimeBucketAssetDto.schema.parse({ timeBucket, take: '500', after: anchor })).toEqual({
      timeBucket,
      take: 500,
      after: anchor,
    });
    expect(TimeBucketAssetDto.schema.parse({ timeBucket, take: '1000', before: anchor })).toEqual({
      timeBucket,
      take: 1000,
      before: anchor,
    });
  });

  it.each([0, -1, 1001, 1.5, 'NaN', 'Infinity'])('rejects unbounded or invalid page size %s', (take) => {
    expect(TimeBucketAssetDto.schema.safeParse({ timeBucket, take }).success).toBe(false);
  });

  it('rejects malformed anchors, ambiguous directions and anchors without a bounded page', () => {
    for (const page of [
      { take: 500, after: 'not-an-id' },
      { take: 500, before: 'not-an-id' },
      { take: 500, after: anchor, before: anchor },
      { after: anchor },
      { before: anchor },
      { membershipAlbumId: anchor },
      { take: 500, membershipAlbumId: 'invalid' },
      { firstAssetId: anchor, lastAssetId: anchor },
      { take: 500, firstAssetId: 'invalid' },
    ]) {
      expect(TimeBucketAssetDto.schema.safeParse({ timeBucket, ...page }).success).toBe(false);
    }
  });
});

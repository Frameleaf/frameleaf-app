import {
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

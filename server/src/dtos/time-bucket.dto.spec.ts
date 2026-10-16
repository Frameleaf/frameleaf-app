import { TimeBucketAssetDto, TimeBucketDto, TimelineOrderedDto } from 'src/dtos/time-bucket.dto.js';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';

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

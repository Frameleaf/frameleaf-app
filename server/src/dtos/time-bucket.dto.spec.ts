import { TimeBucketDto } from 'src/dtos/time-bucket.dto.js';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';

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

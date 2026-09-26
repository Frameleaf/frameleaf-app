import { AssetLockReason, StudioExportScope } from 'src/enum.js';
import {
  satisfiesDerivativePrivacy,
  strongestLockReason,
  unionDerivativePrivacy,
} from 'src/utils/derivative-privacy.js';

const OWNER = 'owner';
const source = (overrides: Partial<Parameters<typeof unionDerivativePrivacy>[1][number]> = {}) => ({
  assetId: 'a',
  ownerId: OWNER,
  lockReason: null,
  sensitive: false,
  ...overrides,
});

describe('unionDerivativePrivacy', () => {
  it('leaves a result of unrestricted own sources unrestricted, in the library', () => {
    const privacy = unionDerivativePrivacy(OWNER, [source(), source({ assetId: 'b' })], { nsfwHiding: true });
    expect(privacy).toEqual(
      expect.objectContaining({ lockReason: null, sensitive: false, scope: StudioExportScope.Library, sourceCount: 2 }),
    );
  });

  it('locks the result when any source is Locked, not only the first clip', () => {
    const privacy = unionDerivativePrivacy(
      OWNER,
      [source(), source({ assetId: 'b' }), source({ assetId: 'c', lockReason: AssetLockReason.Marked })],
      { nsfwHiding: false },
    );
    expect(privacy.lockReason).toBe(AssetLockReason.Marked);
    expect(privacy.lockedSourceCount).toBe(1);
  });

  it('keeps the strongest lock reason among the sources', () => {
    const privacy = unionDerivativePrivacy(
      OWNER,
      [
        source({ lockReason: AssetLockReason.Detected }),
        source({ assetId: 'b', lockReason: AssetLockReason.ImmichLockedFolder }),
        source({ assetId: 'c', lockReason: AssetLockReason.Marked }),
      ],
      { nsfwHiding: false },
    );
    expect(privacy.lockReason).toBe(AssetLockReason.ImmichLockedFolder);
  });

  it('makes the result sensitive when any source is, and locks it as detected only while detections are hidden', () => {
    const sources = [source(), source({ assetId: 'b', sensitive: true })];
    expect(unionDerivativePrivacy(OWNER, sources, { nsfwHiding: false })).toEqual(
      expect.objectContaining({ sensitive: true, lockReason: null }),
    );
    expect(unionDerivativePrivacy(OWNER, sources, { nsfwHiding: true })).toEqual(
      expect.objectContaining({ sensitive: true, lockReason: AssetLockReason.Detected }),
    );
  });

  it('keeps a result made with somebody else’s media out of the library', () => {
    const privacy = unionDerivativePrivacy(OWNER, [source(), source({ assetId: 'b', ownerId: 'partner' })], {
      nsfwHiding: false,
    });
    expect(privacy.scope).toBe(StudioExportScope.Project);
    expect(privacy.includesSharedSources).toBe(true);
  });

  it('treats a project with no library sources as the owner’s, unrestricted', () => {
    expect(unionDerivativePrivacy(OWNER, [], { nsfwHiding: true })).toEqual(
      expect.objectContaining({ lockReason: null, sensitive: false, scope: StudioExportScope.Library, sourceCount: 0 }),
    );
  });
});

describe('strongestLockReason', () => {
  it('ignores nulls and returns null for none', () => {
    expect(strongestLockReason([null, null])).toBeNull();
    expect(strongestLockReason([null, AssetLockReason.Detected])).toBe(AssetLockReason.Detected);
  });
});

describe('satisfiesDerivativePrivacy', () => {
  it('accepts an existing asset only when it is restricted at least as much', () => {
    const required = { lockReason: AssetLockReason.Marked, sensitive: true };
    expect(satisfiesDerivativePrivacy({ lockReason: AssetLockReason.Marked, sensitive: true }, required)).toBe(true);
    expect(
      satisfiesDerivativePrivacy({ lockReason: AssetLockReason.ImmichLockedFolder, sensitive: true }, required),
    ).toBe(true);
    expect(satisfiesDerivativePrivacy({ lockReason: AssetLockReason.Detected, sensitive: true }, required)).toBe(false);
    expect(satisfiesDerivativePrivacy({ lockReason: null, sensitive: true }, required)).toBe(false);
    expect(satisfiesDerivativePrivacy({ lockReason: AssetLockReason.Marked, sensitive: false }, required)).toBe(false);
    expect(
      satisfiesDerivativePrivacy({ lockReason: null, sensitive: false }, { lockReason: null, sensitive: false }),
    ).toBe(true);
  });
});

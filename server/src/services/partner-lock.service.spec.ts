import { AssetLockReason, UserMetadataKey } from 'src/enum.js';
import { PartnerLockService } from 'src/services/partner-lock.service.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const A = newUuid();
const B = newUuid();
const SOURCE = newUuid();
const TARGET = newUuid();
const input = { sourceAssetId: SOURCE, targetAssetId: TARGET, sourceOwnerId: A, targetOwnerId: B };

describe(PartnerLockService.name, () => {
  let sut: PartnerLockService;
  let mocks: ServiceMocks;
  let locks: Array<{ assetId: string; reason: AssetLockReason; lockedAt: Date }>;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PartnerLockService));
    locks = [];
    mocks.asset.getLockReasons.mockImplementation((ids) =>
      Promise.resolve(locks.filter(({ assetId }) => ids.includes(assetId))),
    );
    mocks.asset.lock.mockImplementation((ids) => Promise.resolve(ids));
    mocks.asset.unlock.mockResolvedValue([]);
    mocks.asset.getHiddenContentAssetIds.mockResolvedValue(new Set());
    mocks.user.getMetadata.mockResolvedValue([]);
    mocks.user.hasPinCode.mockResolvedValue(true);
    mocks.user.upsertMetadata.mockResolvedValue();
  });

  it("locks the copy of a partner's locked item with the same reason, behind the recipient's own PIN", async () => {
    locks = [{ assetId: SOURCE, reason: AssetLockReason.Detected, lockedAt: new Date() }];

    await expect(sut.mirrorLockedState(input)).resolves.toBe('locked');

    expect(mocks.asset.lock).toHaveBeenCalledWith([TARGET], AssetLockReason.Detected, null);
    // the recipient has a PIN: no notice
    expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
  });

  it('flags the one-time notice when the recipient has no PIN', async () => {
    locks = [{ assetId: SOURCE, reason: AssetLockReason.Marked, lockedAt: new Date() }];
    mocks.user.hasPinCode.mockResolvedValue(false);

    await sut.mirrorLockedState(input);

    expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(B, {
      key: UserMetadataKey.PartnerLockedNotice,
      value: { flaggedAt: expect.any(String), dismissedAt: null },
    });
  });

  it("locks the copy of an item the partner's Locked rules hide", async () => {
    mocks.user.getMetadata.mockResolvedValue([
      {
        key: UserMetadataKey.Preferences,
        value: { privacy: { suppression: { tagIds: ['private-tag'], personIds: [], petIds: [] } } },
      },
    ] as never);
    mocks.asset.getHiddenContentAssetIds.mockResolvedValue(new Set([SOURCE]));

    await expect(sut.mirrorLockedState(input)).resolves.toBe('locked');

    expect(mocks.asset.getHiddenContentAssetIds).toHaveBeenCalledWith([SOURCE], {
      hiddenContent: expect.objectContaining({ userId: A, tagIds: ['private-tag'], includeNsfw: false }),
    });
    expect(mocks.asset.lock).toHaveBeenCalledWith([TARGET], AssetLockReason.Marked, null);
  });

  it('unlocks a followed copy once the partner unlocks the source', async () => {
    locks = [{ assetId: TARGET, reason: AssetLockReason.Marked, lockedAt: new Date() }];

    await expect(sut.mirrorLockedState(input)).resolves.toBe('unlocked');

    expect(mocks.asset.unlock).toHaveBeenCalledWith([TARGET]);
    expect(mocks.asset.lock).not.toHaveBeenCalled();
  });

  it('leaves a copy alone when both agree', async () => {
    await expect(sut.mirrorLockedState(input)).resolves.toBe('unchanged');
    locks = [
      { assetId: SOURCE, reason: AssetLockReason.Marked, lockedAt: new Date() },
      { assetId: TARGET, reason: AssetLockReason.Marked, lockedAt: new Date() },
    ];
    await expect(sut.mirrorLockedState(input)).resolves.toBe('unchanged');
    expect(mocks.asset.lock).not.toHaveBeenCalled();
    expect(mocks.asset.unlock).not.toHaveBeenCalled();
  });
});

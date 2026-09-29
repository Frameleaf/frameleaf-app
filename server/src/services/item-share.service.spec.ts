import { BadRequestException } from '@nestjs/common';
import { AssetVisibility, NotificationType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import {
  ITEM_SHARE_HIDDEN,
  ITEM_SHARE_LOCKED,
  ItemShareService,
  SHARED_WITH_YOU_PATH,
} from 'src/services/item-share.service.js';
import { linkLivePhotoAssets } from 'src/utils/asset.util.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/**
 * FL-83 (AL-30b, owner decision 2026-09-27): sharing individual items with a person in this library.
 */
describe(ItemShareService.name, () => {
  let sut: ItemShareService;
  let mocks: ServiceMocks;

  const owner = UserFactory.create({ name: 'Taylor' });
  const jamie = UserFactory.create({ name: 'Jamie' });
  const auth = AuthFactory.create(owner);
  const row = (assetId: string, sharedWithId = jamie.id) => ({
    id: newUuid(),
    assetId,
    ownerId: owner.id,
    sharedWithId,
    createdAt: new Date('2026-09-27T12:00:00Z'),
  });

  const users = (...list: (typeof owner)[]) =>
    mocks.user.get.mockImplementation((id: string) => Promise.resolve(list.find((user) => user.id === id) as never));

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ItemShareService));
    mocks.asset.getLockedAssetIds.mockResolvedValue(new Set());
    mocks.asset.getHiddenContentAssetIds.mockResolvedValue(new Set());
    mocks.itemShare.getForAssets.mockResolvedValue([]);
    mocks.itemShare.withTransaction.mockImplementation((callback) =>
      callback(
        mocks.itemShare as unknown as ItemShareRepository,
        mocks.user as unknown as UserRepository,
        mocks.asset as unknown as AssetRepository,
        mocks.access as unknown as AccessRepository,
      ),
    );
    users(owner, jamie);
  });

  describe('share', () => {
    it('shares the owner’s items, notifies each new recipient once and returns the link', async () => {
      const [a, b] = [newUuid(), newUuid()];
      mocks.systemMetadata.get.mockResolvedValue({ server: { externalDomain: 'https://photos.family.example' } });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([a, b]));
      mocks.itemShare.add.mockResolvedValue([row(a), row(b)]);
      mocks.itemShare.getForAssets.mockResolvedValue([row(a), row(b)]);

      const result = await sut.share(auth, { assetIds: [a, b], userIds: [jamie.id] });

      expect(mocks.itemShare.add).toHaveBeenCalledWith(owner.id, [a, b], [jamie.id]);
      expect(result).toMatchObject({
        added: 2,
        removed: 0,
        link: `https://photos.family.example${SHARED_WITH_YOU_PATH}`,
      });
      expect(result.shares.map(({ sharedWith }) => sharedWith.id)).toEqual([jamie.id, jamie.id]);
      expect(mocks.event.emit).toHaveBeenCalledTimes(1);
      expect(mocks.event.emit).toHaveBeenCalledWith('ItemShare', {
        ownerId: owner.id,
        userId: jamie.id,
        senderName: 'Taylor',
        count: 2,
        link: `https://photos.family.example${SHARED_WITH_YOU_PATH}`,
      });
    });

    it('does not notify again for items that were already shared', async () => {
      const a = newUuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([a]));
      mocks.itemShare.add.mockResolvedValue([]);

      await expect(sut.share(auth, { assetIds: [a], userIds: [jamie.id] })).resolves.toMatchObject({ added: 0 });
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('keeps a completed share successful and notifies later recipients when one notification fails', async () => {
      const assetId = newUuid();
      const sam = UserFactory.create({ name: 'Sam' });
      users(owner, jamie, sam);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.itemShare.add.mockResolvedValue([row(assetId), row(assetId, sam.id)]);
      mocks.itemShare.getForAssets.mockResolvedValue([row(assetId), row(assetId, sam.id)]);
      mocks.event.emit.mockRejectedValueOnce(new Error('notification unavailable'));

      await expect(sut.share(auth, { assetIds: [assetId], userIds: [jamie.id, sam.id] })).resolves.toMatchObject({
        added: 2,
      });
      expect(mocks.event.emit).toHaveBeenCalledTimes(2);
      expect(mocks.event.emit).toHaveBeenLastCalledWith(
        'ItemShare',
        expect.objectContaining({ userId: sam.id, count: 1 }),
      );
    });

    it('gives no link when the server has no address to hand out', async () => {
      const a = newUuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([a]));
      mocks.itemShare.add.mockResolvedValue([row(a)]);

      await expect(sut.share(auth, { assetIds: [a], userIds: [jamie.id] })).resolves.toMatchObject({ link: null });
    });

    it('does not persist a share when its link cannot be resolved', async () => {
      const assetId = newUuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      vi.spyOn(sut, 'shareLink').mockRejectedValueOnce(new Error('address lookup unavailable'));

      await expect(sut.share(auth, { assetIds: [assetId], userIds: [jamie.id] })).rejects.toThrow(
        'address lookup unavailable',
      );
      expect(mocks.itemShare.add).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('refuses items that are not the caller’s own, even ones they can see', async () => {
      const [mine, theirs] = [newUuid(), newUuid()];
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([mine]));

      await expect(sut.share(auth, { assetIds: [mine, theirs], userIds: [jamie.id] })).rejects.toThrow(
        BadRequestException,
      );
      expect(mocks.itemShare.add).not.toHaveBeenCalled();
    });

    it('refuses a locked item, and one hidden by the owner’s Locked rules, as a whole', async () => {
      const [a, b] = [newUuid(), newUuid()];
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([a, b]));
      mocks.asset.getLockedAssetIds.mockResolvedValue(new Set([b]));

      await expect(sut.share(auth, { assetIds: [a, b], userIds: [jamie.id] })).rejects.toThrow(ITEM_SHARE_LOCKED);

      mocks.asset.getLockedAssetIds.mockResolvedValue(new Set());
      mocks.asset.getHiddenContentAssetIds.mockResolvedValue(new Set([a]));
      const suppressed = { ...auth, suppressedContent: { userId: owner.id } as never };
      await expect(sut.share(suppressed, { assetIds: [a, b], userIds: [jamie.id] })).rejects.toThrow(ITEM_SHARE_LOCKED);
      expect(mocks.itemShare.add).not.toHaveBeenCalled();
    });

    it('refuses a Hidden item even in an elevated owner session', async () => {
      const [visible, hidden] = [newUuid(), newUuid()];
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([visible, hidden]));
      mocks.asset.getByIds.mockResolvedValue([
        AssetFactory.create({ id: visible, visibility: AssetVisibility.Timeline }),
        AssetFactory.create({ id: hidden, visibility: AssetVisibility.Hidden }),
      ] as never);

      await expect(
        sut.share(AuthFactory.from(owner).session({ hasElevatedPermission: true }).build(), {
          assetIds: [visible, hidden],
          userIds: [jamie.id],
        }),
      ).rejects.toThrow(ITEM_SHARE_HIDDEN);
      expect(mocks.itemShare.add).not.toHaveBeenCalled();
    });

    it('refuses sharing with yourself or with someone who has no account here', async () => {
      const a = newUuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([a]));

      await expect(sut.share(auth, { assetIds: [a], userIds: [owner.id] })).rejects.toThrow('yourself');
      await expect(sut.share(auth, { assetIds: [a], userIds: [newUuid()] })).rejects.toThrow(BadRequestException);
      expect(mocks.itemShare.add).not.toHaveBeenCalled();
    });
  });

  it('removes newly locked shares from every recipient’s open page', async () => {
    const a = newUuid();
    const b = newUuid();
    mocks.itemShare.getRecipients.mockResolvedValue([
      { assetId: a, sharedWithId: jamie.id },
      { assetId: b, sharedWithId: jamie.id },
      { assetId: a, sharedWithId: owner.id },
    ]);

    await sut.onAssetLocked({ assetIds: [a, b] });

    expect(mocks.itemShare.getRecipients).toHaveBeenCalledWith([a, b]);
    expect(mocks.websocket.clientSend.mock.calls).toEqual([
      ['on_asset_hidden', jamie.id, a],
      ['on_asset_hidden', jamie.id, b],
      ['on_asset_hidden', owner.id, a],
    ]);
  });

  it('removes a newly Hidden shared item from recipients’ open pages', async () => {
    const assetId = newUuid();
    mocks.itemShare.getRecipients.mockResolvedValue([{ assetId, sharedWithId: jamie.id }]);

    await sut.onAssetHide({ assetId, userId: owner.id });

    expect(mocks.itemShare.getRecipients).toHaveBeenCalledWith([assetId]);
    expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_hidden', jamie.id, assetId);
  });

  it('notifies later recipients when sending to one recipient fails', async () => {
    const assetId = newUuid();
    const otherRecipientId = newUuid();
    mocks.itemShare.getRecipients.mockResolvedValue([
      { assetId, sharedWithId: jamie.id },
      { assetId, sharedWithId: otherRecipientId },
    ]);
    mocks.websocket.clientSend.mockImplementationOnce(() => {
      throw new Error('send unavailable');
    });

    await expect(sut.onAssetHide({ assetId, userId: owner.id })).resolves.toBeUndefined();

    expect(mocks.websocket.clientSend.mock.calls).toEqual([
      ['on_asset_hidden', jamie.id, assetId],
      ['on_asset_hidden', otherRecipientId, assetId],
    ]);
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('send unavailable'));
  });

  it('does not fail a completed Live Photo relink when recipient lookup fails', async () => {
    const motionAssetId = newUuid();
    mocks.itemShare.getRecipients.mockRejectedValueOnce(new Error('lookup unavailable'));
    const emit = vi.fn((_: string, event: { assetId: string; userId: string }) => sut.onAssetHide(event));

    await expect(
      linkLivePhotoAssets({ asset: mocks.asset, album: mocks.album, event: { emit } } as never, {
        photoAssetId: newUuid(),
        motionAssetId,
        motionOwnerId: owner.id,
      }),
    ).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledWith('AssetHide', { assetId: motionAssetId, userId: owner.id });
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('lookup unavailable'));
  });

  describe('unshare', () => {
    it('does not revoke a share when its link cannot be resolved', async () => {
      const assetId = newUuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      vi.spyOn(sut, 'shareLink').mockRejectedValueOnce(new Error('address lookup unavailable'));

      await expect(sut.unshare(auth, { assetIds: [assetId], userIds: [jamie.id] })).rejects.toThrow(
        'address lookup unavailable',
      );
      expect(mocks.itemShare.remove).not.toHaveBeenCalled();
      expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
    });

    it('revokes the shares and tells the recipient’s open pages to drop the items', async () => {
      const a = newUuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([a]));
      mocks.itemShare.remove.mockResolvedValue([row(a)]);

      await expect(sut.unshare(auth, { assetIds: [a], userIds: [jamie.id] })).resolves.toMatchObject({
        added: 0,
        removed: 1,
        shares: [],
      });
      expect(mocks.itemShare.remove).toHaveBeenCalledWith(owner.id, [a], [jamie.id]);
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_hidden', jamie.id, a);
    });

    it('keeps a completed revocation successful and notifies later recipients when a send fails', async () => {
      const assetId = newUuid();
      const otherRecipientId = newUuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.itemShare.remove.mockResolvedValue([row(assetId), row(assetId, otherRecipientId)]);
      mocks.websocket.clientSend.mockImplementationOnce(() => {
        throw new Error('send unavailable');
      });

      await expect(
        sut.unshare(auth, { assetIds: [assetId], userIds: [jamie.id, otherRecipientId] }),
      ).resolves.toMatchObject({ removed: 2, shares: [] });
      expect(mocks.websocket.clientSend.mock.calls).toEqual([
        ['on_asset_hidden', jamie.id, assetId],
        ['on_asset_hidden', otherRecipientId, assetId],
      ]);
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('send unavailable'));
    });

    it('only revokes the caller’s own items', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.unshare(auth, { assetIds: [newUuid()], userIds: [jamie.id] })).rejects.toThrow(
        BadRequestException,
      );
      expect(mocks.itemShare.remove).not.toHaveBeenCalled();
    });
  });

  describe('getReceived', () => {
    it('lists what was shared with the recipient, with who shared it, and never a locked or Hidden item', async () => {
      const [visible, locked, trashed, hidden] = [
        AssetFactory.create({ ownerId: owner.id }),
        AssetFactory.create({ ownerId: owner.id }),
        AssetFactory.create({ ownerId: owner.id, deletedAt: new Date() }),
        AssetFactory.create({ ownerId: owner.id, visibility: AssetVisibility.Hidden }),
      ];
      const recipient = AuthFactory.create(jamie);
      mocks.itemShare.getReceived.mockResolvedValue([
        { ...row(visible.id), createdAt: new Date('2026-09-27T12:00:00Z') },
        row(locked.id),
        row(trashed.id),
        row(hidden.id),
      ]);
      mocks.asset.getByIds.mockResolvedValue([
        { ...visible, isLocked: false },
        { ...locked, isLocked: true },
        { ...trashed, isLocked: false },
        { ...hidden, isLocked: false },
      ] as never);

      const { items, link } = await sut.getReceived(recipient);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sharedAt: '2026-09-27T12:00:00.000Z',
        owner: { id: owner.id, name: 'Taylor' },
        asset: { id: visible.id },
      });
      expect(link).toBeNull();
      expect(mocks.itemShare.getReceived).toHaveBeenCalledWith(jamie.id);
    });

    it('applies the recipient’s own hidden content', async () => {
      const [a, b] = [AssetFactory.create({ ownerId: owner.id }), AssetFactory.create({ ownerId: owner.id })];
      mocks.itemShare.getReceived.mockResolvedValue([row(a.id), row(b.id)]);
      mocks.asset.getHiddenContentAssetIds.mockResolvedValue(new Set([b.id]));
      mocks.asset.getByIds.mockResolvedValue([{ ...a, isLocked: false }] as never);

      const { items } = await sut.getReceived({ ...AuthFactory.create(jamie), hideNsfwAssets: true });

      expect(mocks.asset.getByIds).toHaveBeenCalledWith([a.id]);
      expect(items.map(({ asset }) => asset.id)).toEqual([a.id]);
    });
  });

  it('uses the notification type album invitations use, with its own kind', () => {
    expect(NotificationType.ItemShare).toBe('ItemShare');
  });
});

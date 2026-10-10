import { ConflictException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AssetLockReason, AssetVisibility, Permission, UserMetadataKey } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { ITEM_SHARE_HIDDEN, ITEM_SHARE_LOCKED, ItemShareService } from 'src/services/item-share.service.js';
import { checkAccess } from 'src/utils/access.js';
import { lockAssetRowsInOrder } from 'src/utils/locked-stacks.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-83 (AL-30b): items shared with a person in this library. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(ItemShareRepository), access: ctx.get(AccessRepository) };
};

const lock = (assetId: string) =>
  db
    .insertInto('asset_lock')
    .values({ assetId, reason: AssetLockReason.Marked, lockedBy: null })
    .onConflict((oc) => oc.column('assetId').doNothing())
    .execute();

const unlock = (assetId: string) => db.deleteFrom('asset_lock').where('assetId', '=', assetId).execute();

it('installs feature tables in the real canonical baseline', async () => {
  await expectCanonicalTables(db, ['asset_user_share']);
});

it('creates each share once, lists it for the owner and the recipient, and revokes it', async () => {
  const { ctx, sut } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: jamie } = await ctx.newUser();
  const { asset: a } = await ctx.newAsset({ ownerId: owner.id });
  const { asset: b } = await ctx.newAsset({ ownerId: owner.id });

  const added = await sut.add(owner.id, [a.id, b.id], [jamie.id]);
  expect(added.map(({ assetId }) => assetId).toSorted()).toEqual([a.id, b.id].toSorted());
  // sharing again keeps the first rows
  await expect(sut.add(owner.id, [a.id], [jamie.id])).resolves.toEqual([]);

  await expect(sut.getForAssets(owner.id, [a.id, b.id])).resolves.toHaveLength(2);
  await expect(sut.getReceived(jamie.id)).resolves.toHaveLength(2);
  // another owner's listing never includes these
  await expect(sut.getForAssets(jamie.id, [a.id, b.id])).resolves.toEqual([]);

  const removed = await sut.remove(owner.id, [a.id], [jamie.id]);
  expect(removed.map(({ assetId }) => assetId)).toEqual([a.id]);
  const received = await sut.getReceived(jamie.id);
  expect(received.map(({ assetId }) => assetId)).toEqual([b.id]);
});

it.each([
  ['share', 'shares'],
  ['share', 'recipient'],
  ['unshare', 'shares'],
  ['unshare', 'recipient'],
] as const)('rolls back %s when the response %s read fails, then retries with every share', async (operation, read) => {
  const { ctx, sut } = newMediumService(ItemShareService, {
    database: db,
    real: [AccessRepository, AssetRepository, ItemShareRepository, UserRepository],
    mock: [EventRepository, LoggingRepository, WebsocketRepository],
  });
  const shares = ctx.get(ItemShareRepository);
  const { user: owner } = await ctx.newUser();
  const { user: jamie } = await ctx.newUser();
  const { user: existing } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.id });
  await shares.add(owner.id, [asset.id], [existing.id]);
  if (operation === 'unshare') {
    await shares.add(owner.id, [asset.id], [jamie.id]);
  }
  const before = await shares.getForAssets(owner.id, [asset.id]);
  const auth = factory.auth({ user: owner });
  const dto = { assetIds: [asset.id], userIds: [jamie.id] };
  vi.spyOn(sut, 'shareLink').mockResolvedValue(null);
  ctx.getMock(EventRepository).emit.mockResolvedValue();

  const failure = new Error('response read unavailable');
  const getUser = UserRepository.prototype.get;
  const failingRead =
    read === 'shares'
      ? vi.spyOn(ItemShareRepository.prototype, 'getForAssets').mockRejectedValueOnce(failure)
      : vi.spyOn(UserRepository.prototype, 'get').mockImplementation(function (this: UserRepository, id, options) {
          return id === existing.id ? Promise.reject(failure) : getUser.call(this, id, options);
        });
  try {
    await expect(sut[operation](auth, dto)).rejects.toThrow('response read unavailable');
  } finally {
    failingRead.mockRestore();
  }
  expect(await shares.getForAssets(owner.id, [asset.id])).toEqual(before);
  expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalled();
  expect(ctx.getMock(WebsocketRepository).clientSend).not.toHaveBeenCalled();

  const response = await sut[operation](auth, dto);
  expect(response.added).toBe(operation === 'share' ? 1 : 0);
  expect(response.removed).toBe(operation === 'unshare' ? 1 : 0);
  expect(response.shares.map(({ sharedWith }) => sharedWith.id).toSorted()).toEqual(
    (operation === 'share' ? [existing.id, jamie.id] : [existing.id]).toSorted(),
  );
  expect(await shares.getForAssets(owner.id, [asset.id])).toHaveLength(response.shares.length);
});

it('gives the recipient access to exactly the shared items, and nobody else', async () => {
  const { ctx, sut, access } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: jamie } = await ctx.newUser();
  const { user: sam } = await ctx.newUser();
  const { asset: shared } = await ctx.newAsset({ ownerId: owner.id });
  const { asset: other } = await ctx.newAsset({ ownerId: owner.id });
  await sut.add(owner.id, [shared.id], [jamie.id]);

  await expect(access.asset.checkItemShareAccess(jamie.id, new Set([shared.id, other.id]))).resolves.toEqual(
    new Set([shared.id]),
  );
  await expect(access.asset.checkItemShareAccess(sam.id, new Set([shared.id]))).resolves.toEqual(new Set());

  await sut.remove(owner.id, [shared.id], [jamie.id]);
  await expect(access.asset.checkItemShareAccess(jamie.id, new Set([shared.id]))).resolves.toEqual(new Set());
});

it.each(['locked', 'hidden'] as const)(
  'refuses the entire share while an item becomes %s, releasing partial locks for the privacy writer',
  async (state) => {
    const { ctx, sut } = newMediumService(ItemShareService, {
      database: db,
      real: [AccessRepository, AssetRepository, ItemShareRepository, UserRepository],
      mock: [EventRepository, LoggingRepository, WebsocketRepository],
    });
    const shares = ctx.get(ItemShareRepository);
    const assets = ctx.get(AssetRepository);
    const { user: owner } = await ctx.newUser();
    const { user: recipient } = await ctx.newUser();
    const { asset: a } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: b } = await ctx.newAsset({ ownerId: owner.id });
    const [visible, changing] = [a, b].toSorted((a, b) => a.id.localeCompare(b.id));
    const auth = factory.auth({ user: owner, session: { hasElevatedPermission: true } });
    vi.spyOn(sut, 'shareLink').mockResolvedValue(null);
    ctx.getMock(EventRepository).emit.mockResolvedValue();

    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const writer = db.transaction().execute(async (tx) => {
      await lockAssetRowsInOrder(tx, [changing.id]);
      held.resolve();
      await release.promise;
      if (state === 'locked') {
        await assets.lock([changing.id], AssetLockReason.Marked, owner.id, tx);
      } else {
        await tx
          .updateTable('asset')
          .set({ visibility: AssetVisibility.Hidden })
          .where('id', '=', changing.id)
          .execute();
      }
      // Source -> result propagation can touch a smaller UUID after holding its source row.
      await tx.updateTable('asset').set({ updatedAt: new Date() }).where('id', '=', visible.id).execute();
    });
    void writer.catch(held.reject);
    await held.promise;
    const dto = { assetIds: [visible.id, changing.id], userIds: [recipient.id] };
    const refusal = vi.fn();
    const sharing = sut.share(auth, dto).catch(refusal);
    const settled = Promise.allSettled([writer, sharing]);
    try {
      await vi.waitFor(() => expect(refusal).toHaveBeenCalledWith(expect.any(ConflictException)), { timeout: 5000 });
    } finally {
      release.resolve();
      await settled;
    }
    expect(await settled).toMatchObject([{ status: 'fulfilled' }, { status: 'fulfilled' }]);
    await expect(sut.share(auth, dto)).rejects.toThrow(state === 'locked' ? ITEM_SHARE_LOCKED : ITEM_SHARE_HIDDEN);
    expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalled();
    expect(await shares.getForAssets(owner.id, [visible.id, changing.id])).toEqual([]);

    await assets.unlock([changing.id]);
    await db.updateTable('asset').set({ visibility: AssetVisibility.Timeline }).where('id', '=', changing.id).execute();
    expect(await shares.getReceived(recipient.id)).toEqual([]);
  },
  10_000,
);

it('hides a shared item while it is locked, and shows it again once unlocked', async () => {
  const { ctx, sut, access } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: jamie } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.id });
  await sut.add(owner.id, [asset.id], [jamie.id]);

  await lock(asset.id);
  // The lock push must still find recipients even though recipient reads now hide the item.
  await expect(sut.getRecipients([asset.id])).resolves.toEqual([{ assetId: asset.id, sharedWithId: jamie.id }]);
  await expect(sut.getRecipients([])).resolves.toEqual([]);
  await expect(sut.getReceived(jamie.id)).resolves.toEqual([]);
  await expect(access.asset.checkItemShareAccess(jamie.id, new Set([asset.id]))).resolves.toEqual(new Set());

  await unlock(asset.id);
  await expect(sut.getReceived(jamie.id)).resolves.toHaveLength(1);
  await expect(access.asset.checkItemShareAccess(jamie.id, new Set([asset.id]))).resolves.toEqual(new Set([asset.id]));
});

it('excludes Hidden shares from recipient reads while keeping a visible Live Photo’s motion accessible', async () => {
  const { ctx, sut, access } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: jamie } = await ctx.newUser();
  const { asset: hidden } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Hidden });
  const { asset: changing } = await ctx.newAsset({ ownerId: owner.id });
  const { asset: motion } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Hidden });
  const { asset: still } = await ctx.newAsset({ ownerId: owner.id, livePhotoVideoId: motion.id });
  await sut.add(owner.id, [hidden.id, changing.id, still.id], [jamie.id]);

  expect((await sut.getReceived(jamie.id)).map(({ assetId }) => assetId).toSorted()).toEqual(
    [changing.id, still.id].toSorted(),
  );
  await expect(
    access.asset.checkItemShareAccess(jamie.id, new Set([hidden.id, changing.id, still.id, motion.id])),
  ).resolves.toEqual(new Set([changing.id, still.id, motion.id]));

  await db.updateTable('asset').set({ visibility: AssetVisibility.Hidden }).where('id', '=', changing.id).execute();
  expect((await sut.getReceived(jamie.id)).map(({ assetId }) => assetId)).toEqual([still.id]);
  await expect(
    access.asset.checkItemShareAccess(jamie.id, new Set([hidden.id, changing.id, still.id, motion.id])),
  ).resolves.toEqual(new Set([still.id, motion.id]));
});

it.each(['locked', 'trashed', 'foreign'] as const)(
  'refuses a shared Live Photo’s %s motion file for metadata, thumbnails and downloads',
  async (state) => {
    const { ctx, sut, access } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: jamie } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { asset: motion } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Hidden });
    const { asset: still } = await ctx.newAsset({ ownerId: owner.id, livePhotoVideoId: motion.id });
    await sut.add(owner.id, [still.id], [jamie.id]);
    const auth = factory.auth({ user: jamie });
    const permissions = [Permission.AssetRead, Permission.AssetView, Permission.AssetDownload];
    for (const permission of permissions) {
      await expect(checkAccess(access, { auth, permission, ids: [still.id, motion.id] })).resolves.toEqual(
        new Set([still.id, motion.id]),
      );
    }

    if (state === 'locked') {
      await lock(motion.id);
    } else {
      await db
        .updateTable('asset')
        .set(state === 'trashed' ? { deletedAt: new Date() } : { ownerId: other.id })
        .where('id', '=', motion.id)
        .execute();
    }

    for (const permission of permissions) {
      await expect(checkAccess(access, { auth, permission, ids: [still.id, motion.id] })).resolves.toEqual(
        new Set([still.id]),
      );
      await expect(checkAccess(access, { auth, permission, ids: [motion.id] })).resolves.toEqual(new Set());
    }
    expect((await sut.getReceived(jamie.id)).map(({ assetId }) => assetId)).toEqual([still.id]);

    await unlock(motion.id);
    await db.updateTable('asset').set({ deletedAt: null, ownerId: owner.id }).where('id', '=', motion.id).execute();
    for (const permission of permissions) {
      await expect(checkAccess(access, { auth, permission, ids: [motion.id] })).resolves.toEqual(new Set([motion.id]));
    }
  },
);

it('leaves out trashed items and items whose owner is deleted', async () => {
  const { ctx, sut, access } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: gone } = await ctx.newUser();
  const { user: jamie } = await ctx.newUser();
  const { asset: trashed } = await ctx.newAsset({ ownerId: owner.id });
  const { asset: orphan } = await ctx.newAsset({ ownerId: gone.id });
  await sut.add(owner.id, [trashed.id], [jamie.id]);
  await sut.add(gone.id, [orphan.id], [jamie.id]);

  await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', trashed.id).execute();
  await db.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', gone.id).execute();

  await expect(sut.getReceived(jamie.id)).resolves.toEqual([]);
  await expect(access.asset.checkItemShareAccess(jamie.id, new Set([trashed.id, orphan.id]))).resolves.toEqual(
    new Set(),
  );
});

it('rechecks the owner’s Locked rules after sharing for both listing and direct access', async () => {
  const { ctx, sut, access } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const { user: jamie } = await ctx.newUser();
  const { asset: hidden } = await ctx.newAsset({ ownerId: owner.id });
  const { asset: visible } = await ctx.newAsset({ ownerId: other.id });
  const { tag } = await ctx.newTag({ userId: owner.id, value: 'Private' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [hidden.id, visible.id] });
  await sut.add(owner.id, [hidden.id], [jamie.id]);
  await sut.add(other.id, [visible.id], [jamie.id]);
  await expect(sut.getReceived(jamie.id)).resolves.toHaveLength(2);

  await db
    .insertInto('user_metadata')
    .values({
      userId: owner.id,
      key: UserMetadataKey.Preferences,
      value: { privacy: { suppression: { tagIds: [tag.id], scope: 'visible' } } },
    })
    .onConflict((oc) =>
      oc.columns(['userId', 'key']).doUpdateSet({
        value: { privacy: { suppression: { tagIds: [tag.id], scope: 'visible' } } },
      }),
    )
    .execute();

  expect((await sut.getReceived(jamie.id)).map(({ assetId }) => assetId)).toEqual([visible.id]);
  await expect(access.asset.checkItemShareAccess(jamie.id, new Set([hidden.id, visible.id]))).resolves.toEqual(
    new Set([visible.id]),
  );
  // A live photo share must not bypass an owner's rule on its motion part either.
  const { asset: still } = await ctx.newAsset({ ownerId: owner.id, livePhotoVideoId: hidden.id });
  await sut.add(owner.id, [still.id], [jamie.id]);
  await expect(access.asset.checkItemShareAccess(jamie.id, new Set([still.id, hidden.id]))).resolves.toEqual(
    new Set([still.id]),
  );

  await db
    .deleteFrom('user_metadata')
    .where('userId', '=', owner.id)
    .where('key', '=', UserMetadataKey.Preferences)
    .execute();
  await expect(sut.getReceived(jamie.id)).resolves.toHaveLength(3);
});

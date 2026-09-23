import { Kysely } from 'kysely';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PreservationRepository } from 'src/repositories/preservation.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Preservation packages against PostgreSQL (FL-74): exports select only the owner's own media,
 * Locked media only when asked from an unlocked session, never more than one package holds, and an
 * ordinary session's reads leave Locked items out of every list and count (owner decision,
 * September 22, 2026) — including items locked in the library after they were packaged, and
 * restoration items whose matched original is Locked there.
 */

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: new PreservationRepository(defaultDatabase) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const lock = (assetId: string) =>
  defaultDatabase
    .insertInto('asset_lock')
    .values({ assetId, reason: AssetLockReason.Marked, lockedBy: null })
    .execute();

const packageInput = (ownerId: string) => ({
  ownerId,
  origin: 'export',
  name: 'Everything',
  format: 'directory',
  includeLocked: false,
  includeMetadata: true,
  scope: { description: 'Whole library' },
});

const itemAssetIds = async (packageId: string) => {
  const rows = await defaultDatabase
    .selectFrom('preservation_item')
    .select(['assetId', 'locked'])
    .where('packageId', '=', packageId)
    .execute();
  return Object.fromEntries(rows.map((row) => [row.assetId!, row.locked]));
};

describe(PreservationRepository.name, () => {
  describe('createExport', () => {
    it('freezes only the owner’s own active media, with the video half of a Live Photo', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: owner.id, inTimeline: true });
      const { asset: motion } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Hidden });
      const { asset: still } = await ctx.newAsset({ ownerId: owner.id, livePhotoVideoId: motion.id });
      const { asset: archived } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Archive });
      const { asset: trashed } = await ctx.newAsset({ ownerId: owner.id, deletedAt: new Date() });
      const { asset: partners } = await ctx.newAsset({ ownerId: partner.id });
      const { asset: locked } = await ctx.newAsset({ ownerId: owner.id });
      await lock(locked.id);

      const created = await sut.createExport(
        packageInput(owner.id),
        (id) => `/exports/${id}`,
        { filter: {} },
        false,
        100,
      );

      expect(created).not.toBeNull();
      const items = await itemAssetIds(created!.package.id);
      expect(items[still.id]).toBe(false);
      expect(items[motion.id]).toBe(false);
      expect(items[archived.id]).toBe(false);
      expect(items).not.toHaveProperty(trashed.id);
      expect(items).not.toHaveProperty(partners.id);
      expect(items).not.toHaveProperty(locked.id);
      expect(created!.items).toBe(Object.keys(items).length);
      expect(created!.package.path).toBe(`/exports/${created!.package.id}`);
    });

    it('never takes another account’s media by id', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset: mine } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: theirs } = await ctx.newAsset({ ownerId: other.id });

      const created = await sut.createExport(
        packageInput(owner.id),
        (id) => `/exports/${id}`,
        { assetIds: [mine.id, theirs.id] },
        false,
        100,
      );

      expect(Object.keys(await itemAssetIds(created!.package.id))).toEqual([mine.id]);
    });

    it('includes Locked media only when asked to, and records it Locked', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { asset: locked } = await ctx.newAsset({ ownerId: owner.id });
      await lock(locked.id);

      const created = await sut.createExport(
        { ...packageInput(owner.id), includeLocked: true },
        (id) => `/exports/${id}`,
        { assetIds: [locked.id] },
        true,
        100,
      );

      expect(await itemAssetIds(created!.package.id)).toEqual({ [locked.id]: true });
    });

    it('writes nothing for a selection larger than one package', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      for (let i = 0; i < 3; i++) {
        await ctx.newAsset({ ownerId: owner.id });
      }

      const created = await sut.createExport(
        packageInput(owner.id),
        (id) => `/exports/${id}`,
        { filter: {} },
        false,
        2,
      );

      expect(created).toBeNull();
      expect(await sut.listPackages(owner.id)).toEqual([]);
    });
  });

  describe('owner scoping', () => {
    it('reads another account’s package or restoration as absent', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: owner.id });
      const created = await sut.createExport(
        packageInput(owner.id),
        (id) => `/exports/${id}`,
        { assetIds: [asset.id] },
        false,
        100,
      );
      const restore = await sut.createRestore({
        ownerId: owner.id,
        packageId: created!.package.id,
        name: 'Everything',
        status: 'reviewing',
        options: {},
      });

      expect(await sut.getPackage(created!.package.id, other.id)).toBeUndefined();
      expect(await sut.getRestore(restore.id, other.id)).toBeUndefined();
      expect(await sut.listPackages(other.id)).toEqual([]);
      expect(await sut.listRestores(other.id)).toEqual([]);
      expect((await sut.getPackage(created!.package.id, owner.id))?.id).toBe(created!.package.id);
    });
  });

  describe('Locked items and an ordinary session', () => {
    it('leaves items written Locked, or locked since, out of every list and count', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { asset: open } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: lockedBefore } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: lockedAfter } = await ctx.newAsset({ ownerId: owner.id });
      await lock(lockedBefore.id);
      const created = await sut.createExport(
        { ...packageInput(owner.id), includeLocked: true },
        (id) => `/exports/${id}`,
        { assetIds: [open.id, lockedBefore.id, lockedAfter.id] },
        true,
        100,
      );
      const packageId = created!.package.id;
      await lock(lockedAfter.id);

      const everything = await sut.listItems(packageId, { take: 10, skip: 0 });
      expect(everything.total).toBe(3);
      const ordinary = await sut.listItems(packageId, { take: 10, skip: 0, excludeLocked: true });
      expect(ordinary.total).toBe(1);
      expect(ordinary.items.map((item) => item.assetId)).toEqual([open.id]);

      expect((await sut.countItems([packageId])).get(packageId)).toMatchObject({ states: { pending: 3 }, locked: 2 });
      expect((await sut.countItems([packageId], { excludeLocked: true })).get(packageId)).toMatchObject({
        states: { pending: 1 },
        locked: 0,
      });
      expect(await sut.hasLockedItems(packageId)).toBe(false);
    });

    it('leaves out restoration items Locked in the package or matched to an original Locked in the library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { asset: matched } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: lockedInLibrary } = await ctx.newAsset({ ownerId: owner.id });
      await lock(lockedInLibrary.id);
      const restore = await sut.createRestore({
        ownerId: owner.id,
        packageId: null,
        name: 'From elsewhere',
        status: 'ready',
        options: {},
      });
      const entry = (sourceAssetId: string) => ({ sourceAssetId, originalFileName: 'a.jpg' });
      const ids = [newUuid(), newUuid(), newUuid()];
      await sut.addRestoreItems(restore.id, [
        { sourceAssetId: ids[0], locked: false, entry: entry(ids[0]) },
        { sourceAssetId: ids[1], locked: true, entry: entry(ids[1]) },
        { sourceAssetId: ids[2], locked: false, entry: entry(ids[2]) },
      ]);
      const rows = await defaultDatabase
        .selectFrom('preservation_restore_item')
        .select(['id', 'sourceAssetId'])
        .where('restoreId', '=', restore.id)
        .execute();
      const idOf = (sourceAssetId: string) => rows.find((row) => row.sourceAssetId === sourceAssetId)!.id;
      await sut.updateRestoreItem(idOf(ids[0]), { state: 'ready', match: 'existing', assetId: matched.id });
      await sut.updateRestoreItem(idOf(ids[2]), { state: 'ready', match: 'existing', assetId: lockedInLibrary.id });

      const ordinary = await sut.listRestoreItems(restore.id, { take: 10, skip: 0, excludeLocked: true });
      expect(ordinary.total).toBe(1);
      expect(ordinary.items.map((item) => item.sourceAssetId)).toEqual([ids[0]]);
      expect((await sut.listRestoreItems(restore.id, { take: 10, skip: 0 })).total).toBe(3);

      expect(await sut.countRestoreItems(restore.id, { excludeLocked: true })).toMatchObject({ total: 1, locked: 0 });
      expect(await sut.countRestoreItems(restore.id)).toMatchObject({ total: 3, locked: 2 });

      const locked = await sut.lockedRestoreItemIds(restore.id, [idOf(ids[0]), idOf(ids[1]), idOf(ids[2])]);
      expect(locked.toSorted()).toEqual([idOf(ids[1]), idOf(ids[2])].toSorted());
    });
  });
});

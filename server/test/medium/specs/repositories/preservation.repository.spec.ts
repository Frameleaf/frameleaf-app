import { Kysely, sql } from 'kysely';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PreservationRepository } from 'src/repositories/preservation.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { PreservationEntrySchema } from 'src/utils/preservation.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Preservation packages against PostgreSQL (FL-74): exports select only the owner's own media,
 * Locked media only when asked from an unlocked session, never more than one package holds, and an
 * ordinary session's reads leave Locked items out of every list and count (owner decision,
 * September 22, 2026) — including items locked in the library after they were packaged, and
 * restoration items whose matched original is Locked there. A search scope matching recognized text
 * finds only the owner's own items, and a Locked item's text only for an export that includes Locked
 * items; a retry of failed restoration items keeps every choice the owner made.
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

const recognize = (assetId: string, text: string) =>
  defaultDatabase.insertInto('ocr_search').values({ assetId, text }).execute();

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

  describe('a search scope over recognized text (FL-74)', () => {
    it('matches only the owner’s own items, and Locked ones only for an export that includes them', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: owner.id, inTimeline: true });
      const { asset: visible } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: locked } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: unrelated } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: partners } = await ctx.newAsset({ ownerId: partner.id });
      await lock(locked.id);
      await recognize(visible.id, 'Invoice 2041 Harbour Street');
      await recognize(locked.id, 'Invoice 2041 Harbour Street');
      await recognize(unrelated.id, 'Birthday card');
      await recognize(partners.id, 'Invoice 2041 Harbour Street');
      const selection = { filter: { ocr: { matches: 'Harbour Street' } } };

      // The service tells an ordinary session only `items`; `lockedItems` is for an unlocked one.
      expect(await sut.previewSelection(owner.id, selection)).toMatchObject({ items: 1, lockedItems: 1 });

      const ordinary = await sut.createExport(packageInput(owner.id), (id) => `/exports/${id}`, selection, false, 100);
      expect(await itemAssetIds(ordinary!.package.id)).toEqual({ [visible.id]: false });

      const withLocked = await sut.createExport(
        { ...packageInput(owner.id), includeLocked: true },
        (id) => `/exports/${id}`,
        selection,
        true,
        100,
      );
      expect(await itemAssetIds(withLocked!.package.id)).toEqual({ [visible.id]: false, [locked.id]: true });

      // The partner's matching photo is theirs to preserve, not the owner's.
      const theirs = await sut.createExport(packageInput(partner.id), (id) => `/exports/${id}`, selection, false, 100);
      expect(await itemAssetIds(theirs!.package.id)).toEqual({ [partners.id]: false });
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
    it('counts unavailable originals apart from Locked items left out on purpose (FL-74)', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const assets = await Promise.all([1, 2, 3].map(() => ctx.newAsset({ ownerId: owner.id })));
      const created = await sut.createExport(
        packageInput(owner.id),
        (id) => `/exports/${id}`,
        { assetIds: assets.map(({ asset }) => asset.id) },
        false,
        100,
      );
      const packageId = created!.package.id;
      const { items } = await sut.listItems(packageId, { take: 10, skip: 0 });
      await sut.finishItem(items[0].id, { state: 'skipped', reasonKey: 'asset_unavailable' });
      await sut.finishItem(items[1].id, { state: 'skipped', reasonKey: 'locked_excluded', locked: true });

      expect((await sut.countItems([packageId])).get(packageId)).toMatchObject({
        states: { pending: 1, skipped: 2 },
        unavailable: 1,
      });
    });

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
  describe('retrying a restoration (FL-74)', () => {
    it('gives failed items their attempts back and keeps every choice the owner made', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { asset: matched } = await ctx.newAsset({ ownerId: owner.id });
      const restore = await sut.createRestore({
        ownerId: owner.id,
        packageId: null,
        name: 'Italy 2024',
        status: 'restoring',
        options: { conflictDefault: 'keep', restoreEditRecipes: true },
      });
      const ids = [newUuid(), newUuid(), newUuid()];
      await sut.addRestoreItems(
        restore.id,
        ids.map((sourceAssetId) => ({
          sourceAssetId,
          locked: false,
          entry: { sourceAssetId, originalFileName: 'a.jpg' },
        })),
      );
      const rows = await defaultDatabase
        .selectFrom('preservation_restore_item')
        .select(['id', 'sourceAssetId'])
        .where('restoreId', '=', restore.id)
        .execute();
      const idOf = (sourceAssetId: string) => rows.find((row) => row.sourceAssetId === sourceAssetId)!.id;
      const [failed, applied, notMatched] = ids.map((id) => idOf(id));

      // Choices made during the review, then an interrupted run: one item failed twice, one was
      // restored, and one failed before it was ever matched against the library.
      await sut.setDecisions(restore.id, [
        { id: failed, decisions: { description: 'replace', date: 'keep' } },
        { id: applied, decisions: { location: 'replace' } },
      ]);
      await sut.updateRestoreItem(failed, { state: 'failed', match: 'existing', assetId: matched.id, attempt: true });
      await sut.updateRestoreItem(failed, { attempt: true, error: 'The server restarted' });
      await sut.updateRestoreItem(applied, {
        state: 'restored',
        match: 'existing',
        appliedAt: new Date(),
        attempt: true,
      });
      await sut.updateRestoreItem(notMatched, { state: 'failed', attempt: true });

      expect(await sut.resetFailedRestoreItems(restore.id)).toBe(1);

      const read = async (id: string) =>
        defaultDatabase
          .selectFrom('preservation_restore_item')
          .select(['state', 'attempts', 'decisions', 'appliedAt'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
      expect(await read(failed)).toMatchObject({
        state: 'failed',
        attempts: 0,
        decisions: { description: 'replace', date: 'keep' },
      });
      // An item already restored is not touched again, choices included.
      expect(await read(applied)).toMatchObject({
        state: 'restored',
        attempts: 1,
        decisions: { location: 'replace' },
        appliedAt: expect.any(Date),
      });
      // One that never reached the library goes back through the review, not the retry.
      expect(await read(notMatched)).toMatchObject({ state: 'failed', attempts: 1 });
      expect((await sut.getRestore(restore.id, owner.id))?.options).toEqual({
        conflictDefault: 'keep',
        restoreEditRecipes: true,
      });
    });
  });

  describe('jsonb columns', () => {
    const typeOf = async (table: string, column: string, id: string) => {
      const { rows } = await sql<{ type: string }>`
        select jsonb_typeof(${sql.ref(column)}) as type from ${sql.table(table)} where id = ${id}::uuid
      `.execute(defaultDatabase);
      return rows[0]?.type;
    };

    it('stores documents as JSON objects and arrays, not strings, and reads them back', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: owner.id });
      const created = await sut.createExport(
        packageInput(owner.id),
        (id) => `/exports/${id}`,
        { assetIds: [asset.id] },
        false,
        100,
      );
      const packageId = created!.package.id;
      const [item] = (await sut.listItems(packageId, { take: 10, skip: 0 })).items;
      const entry = {
        sourceAssetId: asset.id,
        originalFileName: 'lake.jpg',
        type: 'IMAGE',
        locked: false,
        original: { path: `originals/${asset.id}.jpg`, sha1: 'a'.repeat(40), sha256: 'b'.repeat(64), bytes: 1234 },
        metadata: null,
      };
      await sut.finishItem(item.id, { state: 'copied', entry });
      await sut.updatePackage(packageId, { manifest: { packageId, files: {} }, verification: { status: 'verified' } });

      expect(await typeOf('preservation_item', 'entry', item.id)).toBe('object');
      expect(await typeOf('preservation_package', 'manifest', packageId)).toBe('object');
      expect(await typeOf('preservation_package', 'verification', packageId)).toBe('object');
      const [listed] = await sut.listedItems(packageId, null, 10);
      expect(PreservationEntrySchema.parse(listed.entry)).toEqual(entry);
      expect((await sut.countItems([packageId])).get(packageId)).toMatchObject({ states: { copied: 1 }, bytes: 1234 });

      const restore = await sut.createRestore({
        ownerId: owner.id,
        packageId,
        name: 'Everything',
        status: 'reviewing',
        options: { restoreEditRecipes: false, conflictDefault: 'replace' },
      });
      await sut.updateRestore(restore.id, { summary: { albums: 2 } });
      expect(await typeOf('preservation_restore', 'options', restore.id)).toBe('object');
      expect(await typeOf('preservation_restore', 'summary', restore.id)).toBe('object');
      expect((await sut.getRestore(restore.id, owner.id))?.options).toEqual({
        restoreEditRecipes: false,
        conflictDefault: 'replace',
      });

      await sut.addRestoreItems(restore.id, [{ sourceAssetId: asset.id, locked: false, entry }]);
      const [restoreItem] = (await sut.listRestoreItems(restore.id, { take: 10, skip: 0 })).items;
      await sut.updateRestoreItem(restoreItem.id, {
        sidecar: { sourceAssetId: asset.id },
        conflicts: [{ field: 'description', archived: 'a', current: 'b' }],
        findings: ['library_values_kept'],
      });
      await sut.setDecisions(restore.id, [{ id: restoreItem.id, decisions: { description: 'replace' } }]);
      for (const column of ['entry', 'sidecar', 'decisions']) {
        expect(await typeOf('preservation_restore_item', column, restoreItem.id)).toBe('object');
      }
      for (const column of ['conflicts', 'findings']) {
        expect(await typeOf('preservation_restore_item', column, restoreItem.id)).toBe('array');
      }
      expect(await sut.countRestoreItems(restore.id)).toMatchObject({ conflicts: 1, findings: 1 });
      const [read] = (await sut.listRestoreItems(restore.id, { take: 10, skip: 0, filter: 'conflicts' })).items;
      expect(read.decisions).toEqual({ description: 'replace' });
      expect(read.findings).toEqual(['library_values_kept']);
    });
  });
});

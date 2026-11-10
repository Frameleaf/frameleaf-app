import { Kysely, Transaction, sql } from 'kysely';
import { AssetLockReason, UserMetadataKey } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PreservationRepository } from 'src/repositories/preservation.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;

beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setTagRules = (userId: string, tagIds: string[]) => {
  const value = { privacy: { suppression: { tagIds } } };
  return db
    .insertInto('user_metadata')
    .values({ userId, key: UserMetadataKey.Preferences, value } as never)
    .onConflict((oc) => oc.columns(['userId', 'key']).doUpdateSet({ value } as never))
    .execute();
};

const readItem = (id: string) =>
  db.selectFrom('preservation_restore_item').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

const visibleAsset = (id: string) =>
  db
    .selectFrom('asset')
    .leftJoin('asset_lock', 'asset_lock.assetId', 'asset.id')
    .select(['asset.id', 'asset_lock.assetId as lockedAssetId'])
    .where('asset.id', '=', id)
    .executeTakeFirst();

const publisher = (assets: AssetRepository, ownerId: string) => {
  const input = mediumFactory.assetInsert({ ownerId });
  const create = vi.fn((tx: Transaction<DB>, locked: boolean) =>
    assets.create(input, locked ? { reason: AssetLockReason.Marked, lockedBy: null } : undefined, tx),
  );
  return { assetId: input.id, create };
};

/** The package and work snapshot predate any current Locked rule. */
const restoration = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const assets = ctx.get(AssetRepository);
  const sut = new PreservationRepository(db);
  const { user: owner } = await ctx.newUser();
  const { asset: source } = await ctx.newAsset({ ownerId: owner.id });
  const { tag } = await ctx.newTag({ userId: owner.id, value: 'Private source' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [source.id] });
  const exported = await sut.createExport(
    {
      ownerId: owner.id,
      origin: 'export',
      name: 'Public at export',
      format: 'directory',
      includeLocked: false,
      includeMetadata: false,
      scope: {},
    },
    (id) => `/exports/${id}`,
    { assetIds: [source.id] },
    false,
    100,
  );
  const packageId = exported!.package.id;
  const { items: exportedItems } = await sut.listItems(packageId, { take: 10, skip: 0 });
  await sut.finishItem(exportedItems[0].id, {
    state: 'copied',
    entry: { sourceAssetId: source.id, locked: false },
  });
  const restore = await sut.createRestore({
    ownerId: owner.id,
    packageId,
    name: 'Publish copy',
    status: 'ready',
    options: {},
  });
  await sut.addRestoreItems(restore.id, [
    { sourceAssetId: source.id, locked: false, entry: { sourceAssetId: source.id, locked: false } },
  ]);
  const { items } = await sut.listRestoreItems(restore.id, { take: 10, skip: 0 });
  await sut.updateRestoreItem(items[0].id, { state: 'creating', match: 'new', creatingAt: new Date() });
  const [staleWork] = await sut.restoreWork(restore.id, null, 10, 3);
  expect(staleWork.locked).toBe(false);
  return { ctx, assets, sut, owner, source, tag, packageId, restoreId: restore.id, itemId: items[0].id, staleWork };
};

describe('restoration publishes media and retained privacy together (FL-1344)', () => {
  it('reads a source rule enabled after the worker read its unlocked work item', async () => {
    const { assets, sut, owner, source, tag, restoreId, itemId, staleWork } = await restoration();
    await setTagRules(owner.id, [tag.id]);
    expect(staleWork.locked).toBe(false);
    expect((await readItem(itemId)).locked).toBe(false);
    const { assetId, create } = publisher(assets, owner.id);

    const result = await sut.publishRestoreAsset(restoreId, itemId, owner.id, false, create);

    expect(result.id).toBe(assetId);
    expect(create).toHaveBeenCalledWith(expect.anything(), true);
    expect(await visibleAsset(assetId)).toEqual({ id: assetId, lockedAssetId: assetId });
    expect(await readItem(itemId)).toMatchObject({ assetId, match: 'new', locked: true, appliedAt: null });
    // The original remains rule-controlled; publishing the copy does not lock the source permanently.
    expect(await visibleAsset(source.id)).toEqual({ id: source.id, lockedAssetId: null });
  });

  it('retains privacy after deletion removes the source and its rule associations', async () => {
    const { assets, sut, owner, source, tag, restoreId, itemId, staleWork } = await restoration();
    await setTagRules(owner.id, [tag.id]);
    await assets.remove({ id: source.id });
    await setTagRules(owner.id, []);
    expect(staleWork.locked).toBe(false);
    await expect(visibleAsset(source.id)).resolves.toBeUndefined();
    const { assetId, create } = publisher(assets, owner.id);

    await sut.publishRestoreAsset(restoreId, itemId, owner.id, false, create);

    expect(create).toHaveBeenCalledWith(expect.anything(), true);
    expect(await visibleAsset(assetId)).toEqual({ id: assetId, lockedAssetId: assetId });
    expect(await readItem(itemId)).toMatchObject({ assetId, match: 'new', locked: true });
  });

  it('refreshes retained privacy after waiting for another transaction to release the restore item', async () => {
    const { assets, sut, owner, packageId, restoreId, itemId } = await restoration();
    const { assetId, create } = publisher(assets, owner.id);
    const release = Promise.withResolvers<void>();
    const retaining = Promise.withResolvers<number>();
    const retained = db.transaction().execute(async (tx) => {
      await tx.selectFrom('preservation_restore_item').select('id').where('id', '=', itemId).forUpdate().execute();
      await tx.updateTable('preservation_item').set({ locked: true }).where('packageId', '=', packageId).execute();
      const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx);
      retaining.resolve(rows[0].pid);
      await release.promise;
    });
    void retained.catch(retaining.reject);
    let publication: ReturnType<PreservationRepository['publishRestoreAsset']> | undefined;
    try {
      const blockerPid = await retaining.promise;
      publication = sut.publishRestoreAsset(restoreId, itemId, owner.id, false, create);
      void publication.catch(() => {});
      await expect
        .poll(
          async () => {
            const { rows } = await sql`
              select 1 from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and pg_blocking_pids(pid) @> array[${blockerPid}]::integer[]
            `.execute(db);
            return rows.length > 0;
          },
          { timeout: 3000 },
        )
        .toBe(true);
      expect(create).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([retained, publication]);
    }

    await retained;
    await publication;
    expect(create).toHaveBeenCalledWith(expect.anything(), true);
    expect(await visibleAsset(assetId)).toEqual({ id: assetId, lockedAssetId: assetId });
    expect(await readItem(itemId)).toMatchObject({ assetId, locked: true });
  });

  it.each([false, true])(
    'preserves the archive Locked flag %s for a currently public source',
    async (archiveLocked) => {
      const { assets, sut, owner, restoreId, itemId } = await restoration();
      const { assetId, create } = publisher(assets, owner.id);

      await sut.publishRestoreAsset(restoreId, itemId, owner.id, archiveLocked, create);

      expect(create).toHaveBeenCalledWith(expect.anything(), archiveLocked);
      expect(await visibleAsset(assetId)).toEqual({ id: assetId, lockedAssetId: archiveLocked ? assetId : null });
      expect(await readItem(itemId)).toMatchObject({ assetId, match: 'new', locked: archiveLocked });
    },
  );

  it('does not turn a matched destination’s current rule into a permanent lock on a public copy', async () => {
    const { ctx, assets, sut, owner, restoreId, itemId } = await restoration();
    const { asset: destination } = await ctx.newAsset({ ownerId: owner.id });
    const { tag } = await ctx.newTag({ userId: owner.id, value: 'Private destination' });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [destination.id] });
    await setTagRules(owner.id, [tag.id]);
    await sut.updateRestoreItem(itemId, { assetId: destination.id, match: 'existing' });
    expect(await sut.lockedRestoreItemIds(restoreId, [itemId])).toEqual([itemId]);
    expect(await sut.retainedRestoreItemIds(restoreId, [itemId])).toEqual([]);
    const { assetId, create } = publisher(assets, owner.id);

    await sut.publishRestoreAsset(restoreId, itemId, owner.id, false, create);

    expect(create).toHaveBeenCalledWith(expect.anything(), false);
    expect(await visibleAsset(assetId)).toEqual({ id: assetId, lockedAssetId: null });
    expect(await readItem(itemId)).toMatchObject({ assetId, match: 'new', locked: false });
  });

  it('rolls back the new asset, its lock and the item binding if file publication fails', async () => {
    const { assets, sut, owner, tag, restoreId, itemId } = await restoration();
    await setTagRules(owner.id, [tag.id]);
    const before = await readItem(itemId);
    const { assetId, create } = publisher(assets, owner.id);
    const failure = new Error('Publication failed after inserting the asset');

    await expect(
      sut.publishRestoreAsset(restoreId, itemId, owner.id, false, async (tx, locked) => {
        await create(tx, locked);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(create).toHaveBeenCalledWith(expect.anything(), true);
    await expect(visibleAsset(assetId)).resolves.toBeUndefined();
    expect(await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', assetId).execute()).toEqual([]);
    expect(await readItem(itemId)).toEqual(before);
  });

  it.each(['another owner', 'another restore', 'not creating', 'already applied'] as const)(
    'refuses %s before invoking the asset callback',
    async (condition) => {
      const { ctx, assets, sut, owner, restoreId, itemId } = await restoration();
      let actorId = owner.id;
      let requestedRestoreId = restoreId;
      switch (condition) {
        case 'another owner': {
          actorId = (await ctx.newUser()).user.id;
          break;
        }
        case 'another restore': {
          requestedRestoreId = newUuid();
          break;
        }
        case 'not creating': {
          await sut.updateRestoreItem(itemId, { state: 'ready' });
          break;
        }
        case 'already applied': {
          await sut.updateRestoreItem(itemId, { appliedAt: new Date() });
          break;
        }
        // No default
      }
      const before = await readItem(itemId);
      const { assetId, create } = publisher(assets, owner.id);

      await expect(sut.publishRestoreAsset(requestedRestoreId, itemId, actorId, false, create)).rejects.toMatchObject({
        code: 'restore_item_changed',
      });

      expect(create).not.toHaveBeenCalled();
      await expect(visibleAsset(assetId)).resolves.toBeUndefined();
      expect(await readItem(itemId)).toEqual(before);
    },
  );

  it('exposes no new asset before commit and exposes its lock and restore binding with it', async () => {
    const { assets, sut, owner, tag, restoreId, itemId } = await restoration();
    await setTagRules(owner.id, [tag.id]);
    const { assetId, create } = publisher(assets, owner.id);
    const inserted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const publication = sut.publishRestoreAsset(restoreId, itemId, owner.id, false, async (tx, locked) => {
      const asset = await create(tx, locked);
      inserted.resolve();
      await release.promise;
      return asset;
    });

    try {
      await Promise.race([
        inserted.promise,
        publication.then(() => {
          throw new Error('Publication committed before its callback barrier was released');
        }),
      ]);
      // These reads use other pool connections while the publication transaction is held open.
      await expect(visibleAsset(assetId)).resolves.toBeUndefined();
      expect(await readItem(itemId)).toMatchObject({ assetId: null, locked: false, match: 'new' });
    } finally {
      release.resolve();
      await publication;
    }

    expect(create).toHaveBeenCalledWith(expect.anything(), true);
    expect(await visibleAsset(assetId)).toEqual({ id: assetId, lockedAssetId: assetId });
    expect(await readItem(itemId)).toMatchObject({ assetId, locked: true, match: 'new' });
  });
});

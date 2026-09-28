import { Kysely, sql } from 'kysely';
import { AssetLockReason } from 'src/enum.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as migration from 'src/fork-schema/migrations/0000000000206-AssetUserShares.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-83 (AL-30b): items shared with a person in this library. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
  await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
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

const isTable = (entry: { identity: string }) => entry.identity.startsWith('immich_fork.asset_user_share');

it('matches the private catalog and rolls back without modifying the official catalog', async () => {
  const before = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
    expect(before[kind].filter((entry) => isTable(entry))).toEqual(manifest[kind].filter((entry) => isTable(entry)));
  }
  await migration.down(db);
  await migration.up(db);
  const after = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
    expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
      before[kind].filter((entry) => entry.identity.startsWith('public.')),
    );
  }
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

it('hides a shared item while it is locked, and shows it again once unlocked', async () => {
  const { ctx, sut, access } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: jamie } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.id });
  await sut.add(owner.id, [asset.id], [jamie.id]);

  await lock(asset.id);
  await expect(sut.getReceived(jamie.id)).resolves.toEqual([]);
  await expect(access.asset.checkItemShareAccess(jamie.id, new Set([asset.id]))).resolves.toEqual(new Set());

  await unlock(asset.id);
  await expect(sut.getReceived(jamie.id)).resolves.toHaveLength(1);
  await expect(access.asset.checkItemShareAccess(jamie.id, new Set([asset.id]))).resolves.toEqual(new Set([asset.id]));
});

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

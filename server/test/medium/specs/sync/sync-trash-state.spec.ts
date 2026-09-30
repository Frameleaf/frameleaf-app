import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetLockReason, AssetStatus, AssetVisibility, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
const types = [SyncRequestType.AssetTrashStatesV1];
const events = (rows: any[]) => rows.filter((row) => row.type !== SyncEntityType.SyncCompleteV1);
const setup = async () => {
  const ctx = new SyncTestContext(db);
  const { auth, user } = await ctx.newSyncAuthUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, status: AssetStatus.Trashed, deletedAt: new Date() });
  return { ctx, auth, user, asset, repo: ctx.get(SyncRepository).tag };
};

it('streams only narrow current trash state, updates it, and removes restored state with retryable ACK', async () => {
  const { ctx, auth, asset } = await setup();
  const first = events(await ctx.syncStream(auth, types));
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    type: SyncEntityType.AssetTrashStateV1,
    data: { assetId: asset.id, status: AssetStatus.Trashed, isOffline: false },
  });
  expect(Object.keys(first[0].data).sort()).toEqual(['assetId', 'deletedAt', 'isOffline', 'status']);
  await ctx.syncAckAll(auth, first);
  await ctx.assertSyncIsComplete(auth, types);
  await db.updateTable('asset').set({ isOffline: true }).where('id', '=', asset.id).execute();
  const updated = events(await ctx.syncStream(auth, types));
  expect(updated[0].data.isOffline).toBe(true);
  expect(updated[0].ack).not.toBe(first[0].ack);
  await ctx.syncAckAll(auth, updated);
  await ctx.get(TrashRepository).restoreAll([asset.id]);
  const removed = events(await ctx.syncStream(auth, types));
  expect(removed).toEqual([
    expect.objectContaining({ type: SyncEntityType.AssetTrashStateDeleteV1, data: { assetId: asset.id } }),
  ]);
  expect(events(await ctx.syncStream(auth, types))).toEqual(removed);
  await ctx.syncAckAll(auth, removed);
  await ctx.assertSyncIsComplete(auth, types);
});

it('retains a sent hard-delete tombstone without a target foreign key', async () => {
  const { ctx, auth, asset } = await setup();
  const first = events(await ctx.syncStream(auth, types));
  await ctx.syncAckAll(auth, first);
  await db.deleteFrom('asset').where('id', '=', asset.id).execute();
  const removed = events(await ctx.syncStream(auth, types));
  expect(removed[0]).toMatchObject({ type: SyncEntityType.AssetTrashStateDeleteV1, data: { assetId: asset.id } });
  await ctx.syncAckAll(auth, removed);
  await ctx.assertSyncIsComplete(auth, types);
});

it('silently drops never-delivered restored or newly hidden states', async () => {
  const { ctx, auth, asset, repo } = await setup();
  const queued = await repo.reconcile(auth, 'trash');
  await db.updateTable('asset').set({ visibility: AssetVisibility.Hidden }).where('id', '=', asset.id).execute();
  expect(await repo.prepare(auth, 'trash', queued[0].eventId)).toBeUndefined();
  expect(await repo.reconcile(auth, 'trash')).toEqual([]);
  await ctx.assertSyncIsComplete(auth, types);
});

it.each(['lock', 'nsfw', 'hidden'] as const)('revokes and regrants warm state after %s changes', async (cause) => {
  const { ctx, auth, asset } = await setup();
  const reader = { ...auth, hideNsfwAssets: true };
  const first = events(await ctx.syncStream(reader, types));
  await ctx.syncAckAll(reader, first);
  if (cause === 'lock')
    await db
      .insertInto('asset_lock')
      .values({ assetId: asset.id, reason: AssetLockReason.Marked, lockedBy: null, previousVisibility: null })
      .execute();
  else
    await db
      .updateTable('asset')
      .set(cause === 'nsfw' ? { is_nsfw: true } : { visibility: AssetVisibility.Hidden })
      .where('id', '=', asset.id)
      .execute();
  const revoked = events(await ctx.syncStream(reader, types));
  expect(revoked[0]).toMatchObject({ type: SyncEntityType.AssetTrashStateDeleteV1, data: { assetId: asset.id } });
  await ctx.syncAckAll(reader, revoked);
  if (cause === 'lock') await db.deleteFrom('asset_lock').where('assetId', '=', asset.id).execute();
  else
    await db
      .updateTable('asset')
      .set(cause === 'nsfw' ? { is_nsfw: false } : { visibility: AssetVisibility.Timeline })
      .where('id', '=', asset.id)
      .execute();
  const regrant = events(await ctx.syncStream(reader, types));
  expect(regrant[0].data.assetId).toBe(asset.id);
  expect(regrant[0].ack).not.toBe(first[0].ack);
});

it('tracks suppression without changing asset updateIDs and rechecks before prepare', async () => {
  const { ctx, auth, asset, repo } = await setup();
  const { tag } = await ctx.newTag({ userId: auth.user.id, value: 'Private' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
  const first = events(await ctx.syncStream(auth, types));
  await ctx.syncAckAll(auth, first);
  const hidden = {
    ...auth,
    hiddenContent: {
      userId: auth.user.id,
      tagIds: [tag.id],
      personIds: [],
      petIds: [],
      scope: 'owned' as const,
      includeNsfw: false,
    },
  };
  const source = await db.selectFrom('asset').select('updateId').where('id', '=', asset.id).executeTakeFirstOrThrow();
  const revoked = events(await ctx.syncStream(hidden, types));
  expect(revoked[0].type).toBe(SyncEntityType.AssetTrashStateDeleteV1);
  await ctx.syncAckAll(hidden, revoked);
  const queued = await repo.reconcile(auth, 'trash');
  expect(await repo.prepare(hidden, 'trash', queued[0].eventId)).toBeUndefined();
  expect(await db.selectFrom('asset').select('updateId').where('id', '=', asset.id).executeTakeFirstOrThrow()).toEqual(
    source,
  );
});

it('uses the same count scope including offline missing originals and elevated owner Locks', async () => {
  const { ctx, auth, user, asset } = await setup();
  await ctx.newAsset({ ownerId: user.id, status: AssetStatus.Active, deletedAt: new Date(), isOffline: true });
  await ctx.newAsset({ ownerId: user.id, status: AssetStatus.Deleted, deletedAt: new Date() });
  await ctx.newAsset({
    ownerId: user.id,
    status: AssetStatus.Trashed,
    deletedAt: new Date(),
    visibility: AssetVisibility.Hidden,
  });
  await db
    .insertInto('asset_lock')
    .values({ assetId: asset.id, reason: AssetLockReason.Marked, lockedBy: null, previousVisibility: null })
    .execute();
  for (const reader of [auth, { ...auth, session: { ...auth.session!, hasElevatedPermission: true } }]) {
    const scope = { lockedOwnerId: reader.session!.hasElevatedPermission ? user.id : undefined };
    const rows = await ctx.get(TrashRepository).getSyncStates(user.id, scope);
    const summary = await ctx.get(TrashRepository).getSummary(user.id, scope);
    expect(rows).toHaveLength(summary.count);
    expect(rows.filter((r) => r.data.isOffline)).toHaveLength(summary.offline);
    expect(rows.some((r) => r.assetId === asset.id)).toBe(!!reader.session!.hasElevatedPermission);
  }
});

it('never grants foreign trash through partner/album/admin/elevated or shared-link scope', async () => {
  const { ctx, auth, user, asset } = await setup();
  const other = await ctx.newSyncAuthUser();
  await ctx.newPartner({ sharedById: user.id, sharedWithId: other.user.id });
  const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
  await ctx.newAlbumUser({ albumId: album.id, userId: other.user.id });
  expect(
    events(
      await ctx.syncStream(
        {
          ...other.auth,
          user: { ...other.auth.user, isAdmin: true },
          session: { ...other.auth.session!, hasElevatedPermission: true },
        },
        types,
      ),
    ),
  ).toEqual([]);
  expect(events(await ctx.syncStream({ ...auth, sharedLink: { id: randomUUID() } as never }, types))).toEqual([]);
});

it('refuses unsent, wrong-action and stale ACKs and changed-source generations', async () => {
  const { ctx, auth, asset, repo } = await setup();
  const queued = await repo.reconcile(auth, 'trash');
  await repo.acknowledge(auth.session!.id, { type: SyncEntityType.AssetTrashStateV1, updateId: queued[0].eventId });
  expect((await repo.reconcile(auth, 'trash'))[0].acknowledged).toBe(false);
  await db.updateTable('asset').set({ isOffline: true }).where('id', '=', asset.id).execute();
  expect(await repo.prepare(auth, 'trash', queued[0].eventId)).toBeUndefined();
  const fresh = await repo.reconcile(auth, 'trash');
  const sent = await repo.prepare(auth, 'trash', fresh[0].eventId);
  await repo.acknowledge(auth.session!.id, { type: SyncEntityType.AssetTrashStateDeleteV1, updateId: sent!.eventId });
  expect((await repo.reconcile(auth, 'trash'))[0].acknowledged).toBe(false);
  await ctx.get(TrashRepository).restoreAll([asset.id]);
  await repo.reconcile(auth, 'trash');
  await db
    .updateTable('asset')
    .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
    .where('id', '=', asset.id)
    .execute();
  const regrant = await repo.reconcile(auth, 'trash');
  await repo.acknowledge(auth.session!.id, { type: SyncEntityType.AssetTrashStateV1, updateId: sent!.eventId });
  expect(regrant[0]).toMatchObject({ delivered: false, acknowledged: false, deliveryOrder: null });
  expect((await repo.reconcile(auth, 'trash'))[0].eventId).toBe(regrant[0].eventId);
});

it('orders raw microseconds and UUID ties newest first and resumes despite reversed event UUIDs', async () => {
  const { ctx, auth, user, asset, repo } = await setup();
  const ids = [asset.id];
  for (let i = 0; i < 2; i++)
    ids.push((await ctx.newAsset({ ownerId: user.id, status: AssetStatus.Trashed, deletedAt: new Date() })).asset.id);
  await db
    .updateTable('asset')
    .set({ deletedAt: sql`'2026-01-01T00:00:00.000001Z'::timestamptz` })
    .where('id', 'in', ids)
    .execute();
  await db
    .updateTable('asset')
    .set({ deletedAt: sql`'2026-01-01T00:00:00.000002Z'::timestamptz` })
    .where('id', '=', ids[0])
    .execute();
  const pending = await repo.reconcile(auth, 'trash');
  expect(pending.map((r) => r.entityId)).toEqual([ids[0], ...ids.slice(1).sort().toReversed()]);
  for (let i = 0; i < pending.length; i++)
    await db
      .updateTable('session_tag_sync_state')
      .set({ eventId: `00000000-0000-7000-8000-00000000000${pending.length - i}` })
      .where('sessionId', '=', auth.session!.id)
      .where('kind', '=', 'trash')
      .where('key', '=', pending[i].key)
      .execute();
  const reversed = await repo.reconcile(auth, 'trash');
  const first = await repo.prepare(auth, 'trash', reversed[0].eventId);
  await repo.acknowledge(auth.session!.id, { type: first!.type, updateId: first!.eventId });
  const remaining = events(await ctx.syncStream(auth, types));
  expect(remaining.map((r) => r.data.assetId)).toEqual(pending.slice(1).map((r) => r.entityId));
  await ctx.syncAckAll(auth, remaining);
  await ctx.assertSyncIsComplete(auth, types);
});

import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetLockReason, AssetVisibility, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
const types = [SyncRequestType.DuplicateGroupsV1];
const events = (rows: any[]) => rows.filter((row) => row.type !== SyncEntityType.SyncCompleteV1);
const group = async (ctx: SyncTestContext, ownerId: string, groupId = randomUUID(), count = 2) => {
  const assetIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const { asset } = await ctx.newAsset({ ownerId, duplicateId: groupId });
    await ctx.newExif({ assetId: asset.id, make: 'Fixture' });
    assetIds.push(asset.id);
  }
  return { groupId, assetIds: assetIds.sort((a, b) => a.localeCompare(b)) };
};
const setup = async (count = 2) => {
  const ctx = new SyncTestContext(db);
  const { auth, user } = await ctx.newSyncAuthUser();
  const data = await group(ctx, user.id, undefined, count);
  return { ctx, auth, user, data, repo: ctx.get(SyncRepository).tag };
};

it('creates, updates membership, deletes and ACKs only the allowlisted owner payload', async () => {
  const { ctx, auth, user, data } = await setup();
  const first = events(await ctx.syncStream(auth, types));
  expect(first).toEqual([expect.objectContaining({ type: SyncEntityType.DuplicateGroupV1, data })]);
  expect(Object.keys(first[0].data).sort()).toEqual(['assetIds', 'groupId']);
  await ctx.syncAckAll(auth, first);
  await ctx.assertSyncIsComplete(auth, types);
  const added = await group(ctx, user.id, data.groupId, 1);
  const updated = events(await ctx.syncStream(auth, types));
  expect(updated[0].data.assetIds).toEqual([...data.assetIds, ...added.assetIds].sort((a, b) => a.localeCompare(b)));
  expect(updated[0].ack).not.toBe(first[0].ack);
  await ctx.syncAckAll(auth, updated);
  await new DuplicateRepository(db).delete(user.id, data.groupId);
  const removed = events(await ctx.syncStream(auth, types));
  expect(removed).toEqual([
    expect.objectContaining({ type: SyncEntityType.DuplicateGroupDeleteV1, data: { groupId: data.groupId } }),
  ]);
  expect(events(await ctx.syncStream(auth, types))).toEqual(removed);
  await ctx.syncAckAll(auth, removed);
  await ctx.assertSyncIsComplete(auth, types);
});

it.each(['nsfw', 'trash', 'hidden', 'lock', 'stack'] as const)(
  'shrinks then revokes and regrants on %s without relying on surviving updateIDs',
  async (cause) => {
    const { ctx, auth, data } = await setup(3);
    const first = events(await ctx.syncStream(auth, types));
    await ctx.syncAckAll(auth, first);
    const untouched = await db
      .selectFrom('asset')
      .select('updateId')
      .where('id', '=', data.assetIds[2])
      .executeTakeFirstOrThrow();
    const change = async (id: string, revoke: boolean) => {
      if (cause === 'lock') {
        if (revoke)
          await db
            .insertInto('asset_lock')
            .values({ assetId: id, reason: AssetLockReason.Marked, lockedBy: null, previousVisibility: null })
            .execute();
        else await db.deleteFrom('asset_lock').where('assetId', '=', id).execute();
      } else if (cause === 'stack') {
        if (revoke) {
          const { stack } = await ctx.newStack({ ownerId: auth.user.id }, [id]);
          await db.updateTable('asset').set({ stackId: stack.id }).where('id', '=', id).execute();
        } else await db.updateTable('asset').set({ stackId: null }).where('id', '=', id).execute();
      } else
        await db
          .updateTable('asset')
          .set(
            cause === 'nsfw'
              ? { is_nsfw: revoke }
              : cause === 'trash'
                ? { deletedAt: revoke ? new Date() : null }
                : { visibility: revoke ? AssetVisibility.Hidden : AssetVisibility.Timeline },
          )
          .where('id', '=', id)
          .execute();
    };
    const reader = { ...auth, hideNsfwAssets: true };
    await change(data.assetIds[0], true);
    const reduced = events(await ctx.syncStream(reader, types));
    expect(reduced[0].data).toEqual({ groupId: data.groupId, assetIds: data.assetIds.slice(1) });
    await ctx.syncAckAll(reader, reduced);
    await change(data.assetIds[1], true);
    const revoked = events(await ctx.syncStream(reader, types));
    expect(revoked[0]).toMatchObject({ type: SyncEntityType.DuplicateGroupDeleteV1, data: { groupId: data.groupId } });
    await ctx.syncAckAll(reader, revoked);
    await change(data.assetIds[0], false);
    await change(data.assetIds[1], false);
    const regrant = events(await ctx.syncStream(reader, types));
    expect(regrant[0].data).toEqual(data);
    expect(regrant[0].ack).not.toBe(first[0].ack);
    expect(
      (await db.selectFrom('asset').select('updateId').where('id', '=', data.assetIds[2]).executeTakeFirstOrThrow())
        .updateId,
    ).toBe(untouched.updateId);
  },
);

it('matches getAll eligibility including EXIF existence and never invokes singleton cleanup', async () => {
  const { ctx, auth, user, data } = await setup();
  const { asset } = await ctx.newAsset({ ownerId: user.id, duplicateId: data.groupId });
  const repo = new DuplicateRepository(db);
  expect(await repo.getSyncGroups(user.id)).toEqual([data]);
  expect((await repo.getAll(user.id))[0].assets.map((a) => a.id).sort((a, b) => a.localeCompare(b))).toEqual(
    data.assetIds,
  );
  const singleton = await group(ctx, user.id, undefined, 1);
  await ctx.syncStream(auth, types);
  expect(
    (
      await db
        .selectFrom('asset')
        .select('duplicateId')
        .where('id', '=', singleton.assetIds[0])
        .executeTakeFirstOrThrow()
    ).duplicateId,
  ).toBe(singleton.groupId);
  expect(
    (await db.selectFrom('asset').select('duplicateId').where('id', '=', asset.id).executeTakeFirstOrThrow())
      .duplicateId,
  ).toBe(data.groupId);
});

it('keeps owner scope even for shared-album/partner/admin access or a colliding group UUID', async () => {
  const { ctx, auth, user, data } = await setup();
  const other = await ctx.newSyncAuthUser();
  await ctx.newPartner({ sharedById: user.id, sharedWithId: other.user.id });
  await ctx.get(ItemShareRepository).add(user.id, data.assetIds, [other.user.id]);
  const { album } = await ctx.newAlbum({ ownerId: user.id }, data.assetIds);
  await ctx.newAlbumUser({ albumId: album.id, userId: other.user.id });
  expect(events(await ctx.syncStream(other.auth, types))).toEqual([]);
  const own = await group(ctx, other.user.id, data.groupId);
  expect(
    events(await ctx.syncStream({ ...other.auth, user: { ...other.auth.user, isAdmin: true } }, types))[0].data,
  ).toEqual(own);
  const sharedLinkAuth = { ...auth, sharedLink: { id: randomUUID() } as never };
  expect(events(await ctx.syncStream(sharedLinkAuth, types))).toEqual([]);
});

it('requeries suppression and elevated owner Locks without leaking initial hidden groups', async () => {
  const { ctx, auth, data, repo } = await setup();
  const { tag } = await ctx.newTag({ userId: auth.user.id, value: 'Hidden' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: data.assetIds });
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
  expect(await repo.reconcile(hidden, 'duplicate')).toEqual([]);
  await db
    .insertInto('asset_lock')
    .values(
      data.assetIds.map((assetId) => ({
        assetId,
        reason: AssetLockReason.Marked,
        lockedBy: null,
        previousVisibility: null,
      })),
    )
    .execute();
  expect(events(await ctx.syncStream(auth, types))).toEqual([]);
  const elevated = { ...auth, session: { ...auth.session!, hasElevatedPermission: true } };
  expect(events(await ctx.syncStream(elevated, types))[0].data).toEqual(data);
  expect(events(await ctx.syncStream(auth, types))[0]).toMatchObject({ type: SyncEntityType.DuplicateGroupDeleteV1 });
});

it('revokes and regrants a warm suppressed tag group without any asset source update', async () => {
  const { ctx, auth, data, repo } = await setup();
  const { tag } = await ctx.newTag({ userId: auth.user.id, value: 'Suppressed' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: data.assetIds });
  const first = events(await ctx.syncStream(auth, types));
  await ctx.syncAckAll(auth, first);
  const source = await db
    .selectFrom('asset')
    .select(['id', 'updateId'])
    .where('id', 'in', data.assetIds)
    .orderBy('id')
    .execute();
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
  const revoked = events(await ctx.syncStream(hidden, types));
  expect(revoked[0]).toMatchObject({ type: SyncEntityType.DuplicateGroupDeleteV1, data: { groupId: data.groupId } });
  expect(events(await ctx.syncStream(hidden, types))).toEqual(revoked);
  await ctx.syncAckAll(hidden, revoked);
  const regrant = events(await ctx.syncStream(auth, types));
  expect(regrant[0].data).toEqual(data);
  expect(regrant[0].ack).not.toBe(first[0].ack);
  expect(
    await db.selectFrom('asset').select(['id', 'updateId']).where('id', 'in', data.assetIds).orderBy('id').execute(),
  ).toEqual(source);
  const pending = await repo.reconcile(auth, 'duplicate');
  expect(await repo.prepare(hidden, 'duplicate', pending[0].eventId)).toBeUndefined();
});

it('refuses stale prepared membership/privacy, unsent ACK and stale regrant ACK', async () => {
  const { ctx, auth, user, data, repo } = await setup();
  const queued = await repo.reconcile(auth, 'duplicate');
  await repo.acknowledge(auth.session!.id, { type: SyncEntityType.DuplicateGroupV1, updateId: queued[0].eventId });
  expect((await repo.reconcile(auth, 'duplicate'))[0].acknowledged).toBe(false);
  await group(ctx, user.id, data.groupId, 1);
  expect(await repo.prepare(auth, 'duplicate', queued[0].eventId)).toBeUndefined();
  const fresh = await repo.reconcile(auth, 'duplicate');
  const sent = await repo.prepare(auth, 'duplicate', fresh[0].eventId);
  await db.updateTable('asset').set({ duplicateId: null }).where('duplicateId', '=', data.groupId).execute();
  expect(await repo.prepare(auth, 'duplicate', fresh[0].eventId)).toBeUndefined();
  const revoked = await repo.reconcile(auth, 'duplicate');
  await db.updateTable('asset').set({ duplicateId: data.groupId }).where('id', 'in', data.assetIds).execute();
  expect(await repo.prepare(auth, 'duplicate', revoked[0].eventId)).toBeUndefined();
  const regrant = await repo.reconcile(auth, 'duplicate');
  await repo.acknowledge(auth.session!.id, { type: sent!.type, updateId: sent!.eventId });
  expect(regrant[0]).toMatchObject({ delivered: false, acknowledged: false, deliveryOrder: null });
  expect((await repo.reconcile(auth, 'duplicate'))[0].eventId).toBe(regrant[0].eventId);
});

it('drops never-delivered removed groups but retains physical deletion tombstones for sent groups', async () => {
  const { ctx, auth, user, data, repo } = await setup();
  const unseen = await group(ctx, user.id);
  const pending = await repo.reconcile(auth, 'duplicate');
  const sent = pending.find((row) => row.entityId === data.groupId)!;
  await repo.prepare(auth, 'duplicate', sent.eventId);
  await db
    .deleteFrom('asset')
    .where('id', 'in', [...unseen.assetIds, ...data.assetIds])
    .execute();
  const deleted = await repo.reconcile(auth, 'duplicate');
  expect(deleted).toHaveLength(1);
  expect(deleted[0].entityId).toBe(data.groupId);
  expect((await repo.prepare(auth, 'duplicate', deleted[0].eventId))!.data).toEqual({ groupId: data.groupId });
});

it('orders newest first with microsecond/UUID ties, partial resume and reversed-event last ACK', async () => {
  const { ctx, auth, user, repo } = await setup();
  const groups = await new DuplicateRepository(db).getSyncGroups(user.id);
  for (let i = 0; i < 3; i++) groups.push(await group(ctx, user.id));
  await db
    .updateTable('asset')
    .set({ localDateTime: sql`'2026-01-01T00:00:00.000001'::timestamp` })
    .where('ownerId', '=', user.id)
    .execute();
  await db
    .updateTable('asset')
    .set({ localDateTime: sql`'2026-01-01T00:00:00.000002'::timestamp` })
    .where('id', '=', groups[0].assetIds[0])
    .execute();
  const pending = await repo.reconcile(auth, 'duplicate');
  expect(pending.map((row) => row.entityId)).toEqual([
    groups[0].groupId,
    ...groups
      .slice(1)
      .map((row) => row.groupId)
      .sort((a, b) => a.localeCompare(b))
      .toReversed(),
  ]);
  for (let i = 0; i < pending.length; i++)
    await db
      .updateTable('session_tag_sync_state')
      .set({ eventId: `00000000-0000-7000-8000-00000000000${pending.length - i}` })
      .where('sessionId', '=', auth.session!.id)
      .where('kind', '=', 'duplicate')
      .where('key', '=', pending[i].key)
      .execute();
  const reversed = await repo.reconcile(auth, 'duplicate');
  const first = await repo.prepare(auth, 'duplicate', reversed[0].eventId);
  expect((await repo.reconcile(auth, 'duplicate'))[0].eventId).toBe(first!.eventId);
  await repo.acknowledge(auth.session!.id, { type: first!.type, updateId: first!.eventId });
  const remaining = events(await ctx.syncStream(auth, types));
  expect(remaining.map((row) => row.data.groupId)).toEqual(pending.slice(1).map((row) => row.entityId));
  await ctx.syncAckAll(auth, remaining);
  await ctx.assertSyncIsComplete(auth, types);
});

it('serializes concurrent delivery and stale-ACK/source change generations', async () => {
  const { ctx, auth, user, data, repo } = await setup();
  await group(ctx, user.id);
  const queued = await repo.reconcile(auth, 'duplicate');
  const prepared = await Promise.all(queued.map((row) => repo.prepare(auth, 'duplicate', row.eventId)));
  const stored = await db
    .selectFrom('session_tag_sync_state')
    .select(['eventId', 'deliveryOrder'])
    .where('sessionId', '=', auth.session!.id)
    .where('kind', '=', 'duplicate')
    .orderBy('deliveryOrder', 'asc')
    .execute();
  expect(stored.map((row) => row.deliveryOrder)).toEqual([1, 2]);
  await repo.acknowledge(auth.session!.id, { type: SyncEntityType.DuplicateGroupV1, updateId: stored[1].eventId });
  expect(await repo.reconcile(auth, 'duplicate')).toEqual([]);
  const old = prepared.find((row) => row!.data.groupId === data.groupId)!;
  await group(ctx, user.id, data.groupId, 1);
  await Promise.all([
    repo.reconcile(auth, 'duplicate'),
    repo.acknowledge(auth.session!.id, { type: old!.type, updateId: old!.eventId }),
  ]);
  const changed = await repo.reconcile(auth, 'duplicate');
  expect(changed).toHaveLength(1);
  expect(changed[0]).toMatchObject({ delivered: false, acknowledged: false, deliveryOrder: null });
  expect(changed[0].eventId).not.toBe(old!.eventId);
});

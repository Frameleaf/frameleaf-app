import { Kysely } from 'kysely';
import { AssetLockReason, MemoryType, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { SyncCheckpointRepository } from 'src/repositories/sync-checkpoint.repository.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { MEMORY_SYNC_ACK_VERSION } from 'src/repositories/tag-sync.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const types = [SyncRequestType.MemoriesV1, SyncRequestType.MemoryToAssetsV1];
const events = (response: Awaited<ReturnType<SyncTestContext['syncStream']>>) =>
  response.filter(({ type }) => type !== SyncEntityType.SyncCompleteV1);

beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});

const setup = async () => {
  const ctx = new SyncTestContext(db);
  const { auth, user } = await ctx.newSyncAuthUser();
  const { asset: ordinary } = await ctx.newAsset({ ownerId: user.id });
  const { asset: source } = await ctx.newAsset({ ownerId: user.id });
  const { memory } = await ctx.newMemory({
    ownerId: user.id,
    type: MemoryType.EventStory,
    data: { title: 'Private trip with Alice', place: 'Private place', count: 2 },
  });
  await ctx.newMemoryAsset({ memoryId: memory.id, assetId: ordinary.id });
  await ctx.newMemoryAsset({ memoryId: memory.id, assetId: source.id });
  const lock = () =>
    db.insertInto('asset_lock').values({ assetId: source.id, reason: AssetLockReason.Marked }).execute();
  const unlock = () => db.deleteFrom('asset_lock').where('assetId', '=', source.id).execute();
  return { ctx, auth, memory, ordinary, source, lock, unlock };
};

it('hides an entire mixed memory and backfills it on source unlock, then replays only removals on lock', async () => {
  const { ctx, auth, memory, source, lock, unlock } = await setup();
  await lock();
  expect(await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', source.id).execute()).toHaveLength(
    1,
  );
  await ctx.assertSyncIsComplete(auth, types);

  await unlock();
  const granted = await ctx.syncStream(auth, types);
  expect(events(granted)).toHaveLength(3);
  expect(events(granted)[0]).toMatchObject({
    type: SyncEntityType.MemoryV1,
    data: { id: memory.id, data: memory.data },
  });
  expect(events(granted).every(({ ack }) => ack.endsWith(`|${MEMORY_SYNC_ACK_VERSION}`))).toBe(true);
  await ctx.syncAckAll(auth, granted);
  await ctx.assertSyncIsComplete(auth, types);

  await lock();
  const revoked = await ctx.syncStream(auth, types);
  expect(events(revoked)).toHaveLength(3);
  expect(events(revoked)[0]).toMatchObject({ type: SyncEntityType.MemoryDeleteV1, data: { memoryId: memory.id } });
  expect(
    events(revoked)
      .slice(1)
      .every(({ type }) => type === SyncEntityType.MemoryToAssetDeleteV1),
  ).toBe(true);
  expect(JSON.stringify(revoked)).not.toContain('Private');
  expect(events(await ctx.syncStream(auth, types))).toEqual(events(revoked));
  await ctx.syncAckAll(auth, revoked);
  await ctx.assertSyncIsComplete(auth, types);

  await unlock();
  const regranted = await ctx.syncStream(auth, types);
  expect(events(regranted)).toHaveLength(3);
  expect(events(regranted)[0].ack).not.toBe(events(granted)[0].ack);
  await ctx.syncAckAll(auth, granted); // Stale generation cannot acknowledge the regrant.
  expect(events(await ctx.syncStream(auth, types))).toEqual(events(regranted));
  await ctx.syncAckAll(auth, regranted);
  await ctx.assertSyncIsComplete(auth, types);
});

it('reconciles PIN elevation and loss without changing source cursors, and scopes the owner', async () => {
  const { ctx, auth, memory, lock } = await setup();
  await lock();
  const elevated = { ...auth, session: { ...auth.session!, hasElevatedPermission: true } };
  await ctx.assertSyncIsComplete(auth, types);
  const granted = await ctx.syncStream(elevated, types);
  expect(events(granted)).toHaveLength(3);
  await ctx.syncAckAll(elevated, granted);
  await ctx.assertSyncIsComplete(elevated, types);

  const { auth: unrelated } = await ctx.newSyncAuthUser();
  await ctx.assertSyncIsComplete(
    { ...unrelated, session: { ...unrelated.session!, hasElevatedPermission: true } },
    types,
  );
  const revoked = await ctx.syncStream(auth, types);
  expect(events(revoked)[0]).toMatchObject({ type: SyncEntityType.MemoryDeleteV1, data: { memoryId: memory.id } });
  expect(events(revoked)).toHaveLength(3);
  await ctx.syncAckAll(auth, revoked);
  await ctx.assertSyncIsComplete(auth, types);
  expect(events(await ctx.syncStream(elevated, types))).toHaveLength(3);
});

it('revalidates queued metadata and associations before delivery without leaking never-sent deletes', async () => {
  const { ctx, auth, lock } = await setup();
  const journal = ctx.get(SyncRepository).tag;
  const memories = await journal.reconcile(auth, 'memory');
  const assets = await journal.reconcile(auth, 'memoryAsset');
  await lock();
  expect(await journal.prepare(auth, 'memory', memories[0].eventId)).toBeUndefined();
  expect(await journal.prepare(auth, 'memoryAsset', assets[0].eventId)).toBeUndefined();
  await ctx.assertSyncIsComplete(auth, types);
});

it.each([
  SyncEntityType.MemoryV1,
  SyncEntityType.MemoryDeleteV1,
  SyncEntityType.MemoryToAssetV1,
  SyncEntityType.MemoryToAssetDeleteV1,
])('resets a legacy %s cursor and backfills only authorized rows', async (type) => {
  const { ctx, auth, memory, lock } = await setup();
  await lock();
  const { updateId } = await db
    .selectFrom('memory')
    .select('updateId')
    .where('id', '=', memory.id)
    .executeTakeFirstOrThrow();
  const checkpoints = ctx.get(SyncCheckpointRepository);
  await checkpoints.upsertAll([{ sessionId: auth.session!.id, type, ack: `${type}|${updateId}` }]);
  expect(await ctx.syncStream(auth, types)).toEqual([expect.objectContaining({ type: SyncEntityType.SyncResetV1 })]);
  expect(events(await ctx.syncStream(auth, types, true))).toEqual([]);
  await ctx.assertSyncIsComplete(auth, types);
});

it('ignores stale legacy ACKs after reset and backfills old memory sources after unlocking', async () => {
  const { ctx, auth, memory, lock, unlock } = await setup();
  await lock();
  const reset = await ctx.syncStream(auth, types, true);
  expect(events(reset)).toEqual([]);
  const { updateId } = await db
    .selectFrom('memory')
    .select('updateId')
    .where('id', '=', memory.id)
    .executeTakeFirstOrThrow();
  await ctx.sut.setAcks(auth, { acks: [`${SyncEntityType.MemoryV1}|${updateId}`] });
  await ctx.assertSyncIsComplete(auth, types);
  await unlock();
  expect(events(await ctx.syncStream(auth, types))).toHaveLength(3);
});

it('deletes previously delivered metadata and associations after hard deletion, but sends nothing to a fresh session', async () => {
  const { ctx, auth, memory } = await setup();
  const granted = await ctx.syncStream(auth, types);
  await ctx.syncAckAll(auth, granted);
  await ctx.get(MemoryRepository).delete(memory.id);
  const deleted = await ctx.syncStream(auth, types);
  expect(events(deleted)).toHaveLength(3);
  expect(events(deleted)[0]).toMatchObject({ type: SyncEntityType.MemoryDeleteV1, data: { memoryId: memory.id } });
  expect(
    events(deleted)
      .slice(1)
      .every(({ type }) => type === SyncEntityType.MemoryToAssetDeleteV1),
  ).toBe(true);
  await ctx.syncAckAll(auth, deleted);
  await ctx.assertSyncIsComplete(auth, types);
  const { session } = await ctx.newSession({ userId: auth.user.id });
  await ctx.assertSyncIsComplete({ ...auth, session }, types);
});

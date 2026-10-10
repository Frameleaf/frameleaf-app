import { Kysely } from 'kysely';
import { AssetLockReason, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
const setup = async () => {
  const ctx = new SyncTestContext(db);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  const { tag, result } = await ctx.newTag({ userId: user.id, value: 'visible' });
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
  return { ctx, auth, user, session, tag, asset, result, repo: ctx.get(SyncRepository).tag };
};
const types = [SyncRequestType.TagsV1, SyncRequestType.AssetTagsV1];
const entities = (rows: any[]) => rows.filter((row) => row.type !== SyncEntityType.SyncCompleteV1);

it('creates, updates, deletes and acknowledges both additive types', async () => {
  const { ctx, auth, tag, asset } = await setup();
  const first = await ctx.syncStream(auth, types);
  expect(entities(first).map((row) => row.type)).toEqual([SyncEntityType.TagV1, SyncEntityType.AssetTagV1]);
  expect(entities(first)[0].data).toMatchObject({ id: tag.id, value: 'visible' });
  await ctx.syncAckAll(auth, first);
  await ctx.assertSyncIsComplete(auth, types);
  await ctx.get(TagRepository).update(tag.id, { color: '#abcdef' });
  const updated = await ctx.syncStream(auth, types);
  expect(entities(updated)).toEqual([
    expect.objectContaining({ type: SyncEntityType.TagV1, data: expect.objectContaining({ color: '#abcdef' }) }),
  ]);
  await ctx.syncAckAll(auth, updated);
  await db.deleteFrom('tag_asset').where('tagId', '=', tag.id).where('assetId', '=', asset.id).execute();
  const removed = await ctx.syncStream(auth, types);
  expect(entities(removed)).toEqual([
    expect.objectContaining({ type: SyncEntityType.AssetTagDeleteV1, data: { tagId: tag.id, assetId: asset.id } }),
  ]);
  await ctx.syncAckAll(auth, removed);
  await ctx.get(TagRepository).delete(tag.id);
  const deleted = await ctx.syncStream(auth, types);
  expect(entities(deleted)).toEqual([
    expect.objectContaining({ type: SyncEntityType.TagDeleteV1, data: { tagId: tag.id } }),
  ]);
  await ctx.syncAckAll(auth, deleted);
  await ctx.assertSyncIsComplete(auth, types);
  expect(await db.selectFrom('tag_audit').selectAll().where('tagId', '=', tag.id).execute()).toHaveLength(1);
  expect(await db.selectFrom('tag_asset_audit').selectAll().where('tagId', '=', tag.id).execute()).toHaveLength(1);
});

it.each([false, true])(
  'revokes visible membership before/after ack=%s and retries until acknowledged',
  async (acknowledged) => {
    const { ctx, auth, tag } = await setup();
    const first = await ctx.syncStream(auth, types);
    if (acknowledged) await ctx.syncAckAll(auth, first);
    const suppressed = {
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
    const revoke = await ctx.syncStream(suppressed, types);
    expect(entities(revoke).map((row) => row.type)).toEqual([
      SyncEntityType.TagDeleteV1,
      SyncEntityType.AssetTagDeleteV1,
    ]);
    expect(entities(await ctx.syncStream(suppressed, types))).toEqual(entities(revoke));
    await ctx.syncAckAll(suppressed, revoke);
    await ctx.assertSyncIsComplete(suppressed, types);
    const regrant = await ctx.syncStream(auth, types);
    expect(entities(regrant).map((row) => row.type)).toEqual([SyncEntityType.TagV1, SyncEntityType.AssetTagV1]);
    expect(entities(await ctx.syncStream(auth, types))).toEqual(entities(regrant));
    // A late delete ACK cannot remove the fresh regrant generation.
    await ctx.syncAckAll(auth, revoke);
    expect(entities(await ctx.syncStream(auth, types))).toEqual(entities(regrant));
    await ctx.syncAckAll(auth, regrant);
    await ctx.assertSyncIsComplete(auth, types);
  },
);

it('never exposes initially suppressed tag or association identifiers', async () => {
  const { ctx, auth, tag } = await setup();
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
  const initial = await ctx.syncStream(hidden, types);
  expect(entities(initial)).toEqual([]);
  expect(JSON.stringify(initial)).not.toContain(tag.id);
});

it('does not revoke a row queued but never prepared for delivery', async () => {
  const { auth, tag, repo, session } = await setup();
  await repo.reconcile(auth, 'tag');
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
  expect(await repo.reconcile(hidden, 'tag')).toEqual([]);
  expect(
    await db.selectFrom('session_tag_sync_state').selectAll().where('sessionId', '=', session.id).execute(),
  ).toEqual([]);
});

it('rechecks privacy after reconciliation and before payload preparation', async () => {
  const { auth, tag, repo } = await setup();
  const [queued] = await repo.reconcile(auth, 'tag');
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
  expect(await repo.prepare(hidden, 'tag', queued.eventId)).toBeUndefined();
  expect(await repo.reconcile(hidden, 'tag')).toEqual([]);
});

it('revokes actual Locked-only tags/associations and regrants unchanged source keys after unlock', async () => {
  const { ctx, auth, asset } = await setup();
  const first = await ctx.syncStream(auth, types);
  await ctx.syncAckAll(auth, first);
  await ctx.get(AssetRepository).lock([asset.id], AssetLockReason.Marked, auth.user.id);
  const denied = await ctx.syncStream(auth, types);
  expect(entities(denied).map((row) => row.type)).toEqual([
    SyncEntityType.TagDeleteV1,
    SyncEntityType.AssetTagDeleteV1,
  ]);
  await ctx.syncAckAll(auth, denied);
  const unlocked = { ...auth, session: { ...auth.session!, hasElevatedPermission: true } };
  expect(entities(await ctx.syncStream(unlocked, types)).map((row) => row.type)).toEqual([
    SyncEntityType.TagV1,
    SyncEntityType.AssetTagV1,
  ]);
});

it('initial Locked-only targets do not expose tag/association identifiers', async () => {
  const { ctx, auth, asset } = await setup();
  await ctx.get(AssetRepository).lock([asset.id], AssetLockReason.Marked, auth.user.id);
  expect(entities(await ctx.syncStream(auth, types))).toEqual([]);
  expect(
    await db.selectFrom('session_tag_sync_state').selectAll().where('sessionId', '=', auth.session!.id).execute(),
  ).toEqual([]);
});

it('owner-only streams exclude partner, shared recipient and administrator without ownership', async () => {
  const { ctx, tag, asset, user } = await setup();
  for (const isAdmin of [false, true]) {
    const other = await ctx.newSyncAuthUser();
    await ctx.newPartner({ sharedById: user.id, sharedWithId: other.user.id });
    await ctx.get(ItemShareRepository).add(user.id, [asset.id], [other.user.id]);
    const viewer = { ...other.auth, user: { ...other.auth.user, isAdmin } };
    const response = await ctx.syncStream(viewer, types);
    expect(entities(response)).toEqual([]);
    expect(JSON.stringify(response)).not.toContain(tag.id);
    expect(JSON.stringify(response)).not.toContain(asset.id);
  }
});

it('keeps stale/concurrent acknowledgement from confirming a later regrant', async () => {
  const { ctx, auth, tag, repo } = await setup();
  const initial = await ctx.syncStream(auth, types);
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
  await ctx.syncStream(hidden, types);
  const [regrant] = await repo.reconcile(auth, 'tag');
  await Promise.all([ctx.syncAckAll(auth, initial), repo.reconcile(auth, 'tag')]);
  expect(await repo.prepare(auth, 'tag', regrant.eventId)).toMatchObject({ type: SyncEntityType.TagV1 });
  expect((await repo.reconcile(auth, 'tag')).map((row) => row.eventId)).toContain(regrant.eventId);
});

it('resumes after the first delivered event without acknowledging an unseen queued row', async () => {
  const { ctx, auth, user, repo } = await setup();
  await ctx.newTag({ userId: user.id, value: 'second' });
  const pending = await repo.reconcile(auth, 'tag');
  expect(pending).toHaveLength(2);
  const first = await repo.prepare(auth, 'tag', pending[0].eventId);
  await repo.acknowledge(auth.session!.id, { type: first!.type, updateId: first!.eventId });
  const resumed = await repo.reconcile(auth, 'tag');
  expect(resumed.map((row) => row.eventId)).toEqual([pending[1].eventId]);
  expect(await repo.prepare(auth, 'tag', resumed[0].eventId)).toMatchObject({ type: SyncEntityType.TagV1 });
});

it('rejects an ACK for a queued event before any payload may have been sent', async () => {
  const { auth, repo } = await setup();
  const [pending] = await repo.reconcile(auth, 'tag');
  await repo.acknowledge(auth.session!.id, { type: SyncEntityType.TagV1, updateId: pending.eventId });
  expect((await repo.reconcile(auth, 'tag')).map((row) => row.eventId)).toContain(pending.eventId);
});

it('retains pending association revoke after the target asset is physically deleted', async () => {
  const { ctx, auth, asset } = await setup();
  const first = await ctx.syncStream(auth, types);
  await ctx.syncAckAll(auth, first);
  await db.deleteFrom('asset').where('id', '=', asset.id).execute();
  const deleted = await ctx.syncStream(auth, types);
  expect(entities(deleted).some((row) => row.type === SyncEntityType.AssetTagDeleteV1)).toBe(true);
  expect(entities(await ctx.syncStream(auth, types))).toEqual(entities(deleted));
});

it('revokes sensitive tags and associations on current classification and regrants unchanged sources', async () => {
  const { ctx, auth, tag, asset } = await setup();
  const hidden = { ...auth, hideNsfwAssets: true };
  await ctx.syncAckAll(hidden, await ctx.syncStream(hidden, types));
  await db.updateTable('asset').set({ is_nsfw: true }).where('id', '=', asset.id).execute();
  const revoke = await ctx.syncStream(hidden, types);
  expect(entities(revoke).map((row) => row.type)).toEqual([
    SyncEntityType.TagDeleteV1,
    SyncEntityType.AssetTagDeleteV1,
  ]);
  await ctx.syncAckAll(hidden, revoke);
  expect(entities(await ctx.syncStream(hidden, types))).toEqual([]);
  await db.updateTable('asset').set({ is_nsfw: false }).where('id', '=', asset.id).execute();
  const granted = entities(await ctx.syncStream(hidden, types));
  expect(granted.map((row) => row.type)).toEqual([SyncEntityType.TagV1, SyncEntityType.AssetTagV1]);
  expect(granted[0].data.id).toBe(tag.id);
});

it('emits an association update with a fresh source and delivery ID', async () => {
  const { ctx, auth, tag, asset } = await setup();
  const first = await ctx.syncStream(auth, types);
  await ctx.syncAckAll(auth, first);
  const previous = await db
    .selectFrom('tag_asset')
    .select('updateId')
    .where('tagId', '=', tag.id)
    .where('assetId', '=', asset.id)
    .executeTakeFirstOrThrow();
  await db
    .updateTable('tag_asset')
    .set({ tagId: tag.id })
    .where('tagId', '=', tag.id)
    .where('assetId', '=', asset.id)
    .execute();
  const current = await db
    .selectFrom('tag_asset')
    .select('updateId')
    .where('tagId', '=', tag.id)
    .where('assetId', '=', asset.id)
    .executeTakeFirstOrThrow();
  expect(current.updateId).not.toBe(previous.updateId);
  const updated = entities(await ctx.syncStream(auth, types));
  expect(updated).toEqual([
    expect.objectContaining({ type: SyncEntityType.AssetTagV1, data: { tagId: tag.id, assetId: asset.id } }),
  ]);
  expect(updated[0].ack).not.toBe(entities(first)[1].ack);
});

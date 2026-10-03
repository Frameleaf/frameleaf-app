import { Kysely } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumUserRole, AssetLockReason, AssetVisibility, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
const albumTypes = [SyncRequestType.AlbumAssetAccessV1];
const partnerTypes = [SyncRequestType.PartnerAssetAccessV1];
const events = (rows: any[]) => rows.filter((row) => row.type !== SyncEntityType.SyncCompleteV1);
const setup = async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { user: owner } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.id, originalFileName: 'private.jpg' });
  const { album } = await ctx.newAlbum({ ownerId: owner.id });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
  await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Viewer });
  await ctx.newPartner({ sharedById: owner.id, sharedWithId: auth.user.id });
  return { ctx, auth, owner, asset, album, repo: ctx.get(SyncRepository).tag };
};
const lock = (id: string) =>
  db
    .insertInto('asset_lock')
    .values({ assetId: id, reason: AssetLockReason.Marked, lockedBy: null, previousVisibility: null })
    .execute();
const unlock = (id: string) => db.deleteFrom('asset_lock').where('assetId', '=', id).execute();
const warm = async (ctx: SyncTestContext, auth: AuthDto, types = albumTypes) => {
  const rows = events(await ctx.syncStream(auth, types));
  await ctx.syncAckAll(auth, rows);
  return rows;
};

it('delivers current full album assets, updates, retries and ACKs scoped deletes on Lock then regrants on unlock', async () => {
  const { ctx, auth, asset, album } = await setup();
  const legacy = await ctx.syncStream(auth, [SyncRequestType.AlbumAssetsV2]);
  await ctx.syncAckAll(auth, legacy);
  const first = await warm(ctx, auth);
  expect(first[0]).toMatchObject({
    type: SyncEntityType.AlbumAssetAccessV1,
    data: { albumId: album.id, asset: { id: asset.id, originalFileName: 'private.jpg' } },
  });
  expect(Object.keys(first[0].data.asset)).not.toContain('updateId');
  await db.updateTable('asset').set({ originalFileName: 'current.jpg' }).where('id', '=', asset.id).execute();
  const updated = await warm(ctx, auth);
  expect(updated[0].data.asset.originalFileName).toBe('current.jpg');
  await lock(asset.id);
  const removed = events(await ctx.syncStream(auth, albumTypes));
  expect(removed).toEqual([
    expect.objectContaining({
      type: SyncEntityType.AlbumAssetAccessDeleteV1,
      data: { albumId: album.id, assetId: asset.id },
    }),
  ]);
  expect(events(await ctx.syncStream(auth, albumTypes))).toEqual(removed);
  await ctx.syncAckAll(auth, removed);
  await ctx.assertSyncIsComplete(auth, albumTypes);
  await unlock(asset.id);
  const grant = events(await ctx.syncStream(auth, albumTypes));
  expect(grant[0].data.asset).toMatchObject({
    id: asset.id,
    originalFileName: 'current.jpg',
    visibility: AssetVisibility.Timeline,
  });
  expect(grant[0].ack).not.toBe(updated[0].ack);
  await ctx.syncAckAll(auth, grant);
  await ctx.assertSyncIsComplete(auth, albumTypes);
});

it('only an elevated media owner gets Locked album records and elevation loss revokes them', async () => {
  const { ctx, auth, asset, album } = await setup();
  await db.updateTable('asset').set({ ownerId: auth.user.id }).where('id', '=', asset.id).execute();
  await lock(asset.id);
  await ctx.assertSyncIsComplete(auth, albumTypes);
  const elevated = { ...auth, session: { ...auth.session!, hasElevatedPermission: true } };
  const own = await warm(ctx, elevated);
  expect(own[0].data.asset.visibility).toBe(AssetVisibility.Locked);
  const removed = events(await ctx.syncStream(auth, albumTypes));
  expect(removed[0]).toMatchObject({
    type: SyncEntityType.AlbumAssetAccessDeleteV1,
    data: { albumId: album.id, assetId: asset.id },
  });
});

it.each(['albumAsset'] as const)('does not disclose queued unsent %s records after revocation', async (kind) => {
  const { auth, asset, owner, repo } = await setup();
  const pending = await repo.reconcile(auth, kind);
  if (kind === 'albumAsset') await lock(asset.id);
  else
    await db
      .deleteFrom('partner')
      .where('sharedById', '=', owner.id)
      .where('sharedWithId', '=', auth.user.id)
      .execute();
  expect(await repo.prepare(auth, kind, pending[0].eventId)).toBeUndefined();
  expect(await repo.reconcile(auth, kind)).toEqual([]);
  expect(
    await db
      .selectFrom('session_tag_sync_state')
      .selectAll()
      .where('sessionId', '=', auth.session!.id)
      .where('kind', '=', kind)
      .execute(),
  ).toEqual([]);
});

it.each(['albumAsset'] as const)('refuses changed %s preparation and stale/unsent ACKs', async (kind) => {
  const { ctx, auth, asset, repo } = await setup();
  const type = kind === 'albumAsset' ? SyncEntityType.AlbumAssetAccessV1 : SyncEntityType.PartnerAssetAccessV1;
  const types = kind === 'albumAsset' ? albumTypes : partnerTypes;
  const old = await repo.reconcile(auth, kind);
  await repo.acknowledge(auth.session!.id, { type, updateId: old[0].eventId });
  await db.updateTable('asset').set({ originalFileName: 'changed.jpg' }).where('id', '=', asset.id).execute();
  expect(await repo.prepare(auth, kind, old[0].eventId)).toBeUndefined();
  const current = events(await ctx.syncStream(auth, types));
  expect(current[0].data.asset.originalFileName).toBe('changed.jpg');
  await repo.acknowledge(auth.session!.id, { type, updateId: old[0].eventId });
  expect(events(await ctx.syncStream(auth, types))).toEqual(current);
  await ctx.syncAckAll(auth, current);
  await ctx.assertSyncIsComplete(auth, types);
});

it.each(['albumAsset'] as const)(
  'replaces an unacknowledged %s delete on regrant and rejects its stale ACK',
  async (kind) => {
    const { ctx, auth, asset, owner } = await setup();
    const types = kind === 'albumAsset' ? albumTypes : partnerTypes;
    await warm(ctx, auth, types);
    if (kind === 'albumAsset') await lock(asset.id);
    else
      await db
        .deleteFrom('partner')
        .where('sharedById', '=', owner.id)
        .where('sharedWithId', '=', auth.user.id)
        .execute();
    const removed = events(await ctx.syncStream(auth, types));
    if (kind === 'albumAsset') await unlock(asset.id);
    else await ctx.newPartner({ sharedById: owner.id, sharedWithId: auth.user.id });
    const grant = events(await ctx.syncStream(auth, types));
    await ctx.syncAckAll(auth, removed);
    expect(events(await ctx.syncStream(auth, types))).toEqual(grant);
    await ctx.syncAckAll(auth, grant);
    await ctx.assertSyncIsComplete(auth, types);
  },
);

it('streams newest first and a last delivered ACK cannot skip an unsent older compound key', async () => {
  const { ctx, auth, owner, asset, repo } = await setup();
  await db
    .updateTable('asset')
    .set({ fileCreatedAt: new Date('2020-01-01') })
    .where('id', '=', asset.id)
    .execute();
  const { asset: newer } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: new Date('2026-01-01') });
  const { album } = await ctx.newAlbum({ ownerId: owner.id });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: newer.id });
  await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id });
  const pending = await repo.reconcile(auth, 'albumAsset');
  expect(pending[0].assetId).toBe(newer.id);
  const first = await repo.prepare(auth, 'albumAsset', pending[0].eventId);
  await repo.acknowledge(auth.session!.id, { type: first!.type, updateId: first!.eventId });
  const remaining = events(await ctx.syncStream(auth, albumTypes));
  expect(remaining.map((row) => row.data.asset.id)).toEqual([asset.id]);
  await ctx.syncAckAll(auth, remaining);
  await ctx.assertSyncIsComplete(auth, albumTypes);
});

it('denies unrelated users, admin nonowners, shared links and never-sent Locked album identifiers', async () => {
  const { ctx, asset } = await setup();
  const { auth } = await ctx.newSyncAuthUser();
  await ctx.assertSyncIsComplete({ ...auth, user: { ...auth.user, isAdmin: true } }, [...albumTypes, ...partnerTypes]);
  await lock(asset.id);
  await ctx.assertSyncIsComplete({ ...auth, sharedLink: {} as never }, [...albumTypes, ...partnerTypes]);
});

it.each(['trash', 'delete', 'owner-delete'] as const)(
  // FL-326: the partner source sends nothing any more (spec §4.8)
  'revokes the delivered album source on %s without descriptive fields',
  async (cause) => {
    const { ctx, auth, asset, owner, album } = await setup();
    await warm(ctx, auth, [...albumTypes, ...partnerTypes]);
    if (cause === 'delete') await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    else if (cause === 'owner-delete')
      await db.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', owner.id).execute();
    else await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();
    const removed = events(await ctx.syncStream(auth, [...albumTypes, ...partnerTypes]));
    expect(removed).toEqual([
      expect.objectContaining({
        type: SyncEntityType.AlbumAssetAccessDeleteV1,
        data: { albumId: album.id, assetId: asset.id },
      }),
    ]);
    await ctx.syncAckAll(auth, removed);
    await ctx.assertSyncIsComplete(auth, [...albumTypes, ...partnerTypes]);
  },
);

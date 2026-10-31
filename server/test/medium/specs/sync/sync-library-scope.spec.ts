import { Kysely } from 'kysely';
import { AlbumUserRole, LibraryScope, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

it.each([
  [SyncRequestType.AssetsV2, SyncEntityType.AssetV2, SyncEntityType.AssetDeleteV1],
  [SyncRequestType.AssetsV3, SyncEntityType.AssetV3, SyncEntityType.AssetDeleteV2],
] as const)(
  '%s defaults to personal and removes scoped-out cached assets across retry and return',
  async (request, upsert, remove) => {
    const ctx = new SyncTestContext(db);
    const { auth } = await ctx.newSyncAuthUser();
    const { asset: personal } = await ctx.newAsset({ ownerId: auth.user.id });
    const { asset: design } = await ctx.newAsset({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
    const { asset: both } = await ctx.newAsset({ ownerId: auth.user.id, libraryScope: LibraryScope.Both });
    const first = await ctx.syncStream(auth, [request]);
    expect(
      first
        .filter((row) => row.type === upsert)
        .map((row) => String(row.data.id))
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([personal.id, both.id].sort());
    expect(first.some((row) => row.type === upsert && row.data.id === design.id)).toBe(false);
    await ctx.syncAckAll(auth, first);
    await db.updateTable('asset').set({ libraryScope: LibraryScope.Design }).where('id', '=', personal.id).execute();
    const changed = await ctx.syncStream(auth, [request]);
    expect(changed.filter((row) => row.type === remove)).toEqual([
      expect.objectContaining({ data: { assetId: personal.id } }),
    ]);
    expect(changed.some((row) => row.type === upsert && row.data.id === personal.id)).toBe(false);
    const retry = await ctx.syncStream(auth, [request]);
    expect(retry.filter((row) => row.type === remove)).toEqual(changed.filter((row) => row.type === remove));
    await ctx.syncAckAll(auth, retry);
    await db.updateTable('asset').set({ libraryScope: LibraryScope.Both }).where('id', '=', personal.id).execute();
    const restored = await ctx.syncStream(auth, [request]);
    expect(restored.filter((row) => row.type === upsert)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ id: personal.id }) }),
    ]);
    expect(restored.some((row) => row.type === remove)).toBe(false);
    await ctx.syncAckAll(auth, restored);
    await ctx.assertSyncIsComplete(auth, [request]);
    expect(await db.selectFrom('asset_audit').selectAll().where('assetId', '=', personal.id).execute()).toEqual([]);
  },
);

it('withholds design EXIF and resends unchanged metadata when an asset returns to personal', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
  await ctx.newExif({ assetId: asset.id, make: 'Canon' });
  const { asset: design } = await ctx.newAsset({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
  await ctx.newExif({ assetId: design.id, make: 'Design reference' });
  const types = [SyncRequestType.AssetsV2, SyncRequestType.AssetExifsV1];
  const first = await ctx.syncStream(auth, types);
  expect(first.filter((row) => row.type === SyncEntityType.AssetExifV1).map((row) => row.data.assetId)).toEqual([
    asset.id,
  ]);
  await ctx.syncAckAll(auth, first);
  await db.updateTable('asset').set({ libraryScope: LibraryScope.Design }).where('id', '=', asset.id).execute();
  const removed = await ctx.syncStream(auth, types);
  await ctx.syncAckAll(auth, removed);
  await db.updateTable('asset').set({ libraryScope: LibraryScope.Personal }).where('id', '=', asset.id).execute();
  const restored = await ctx.syncStream(auth, types);
  expect(restored.filter((row) => row.type === SyncEntityType.AssetExifV1)).toEqual([
    expect.objectContaining({ data: expect.objectContaining({ assetId: asset.id, make: 'Canon' }) }),
  ]);
});

it.each([
  [SyncRequestType.AlbumsV2, SyncEntityType.AlbumV2, SyncEntityType.AlbumDeleteV1],
  [SyncRequestType.AlbumsV3, SyncEntityType.AlbumV3, SyncEntityType.AlbumDeleteV2],
] as const)(
  '%s excludes owned design albums, preserves explicit incoming shares and handles scope changes',
  async (request, upsert, remove) => {
    const ctx = new SyncTestContext(db);
    const { auth } = await ctx.newSyncAuthUser();
    const { user: other } = await ctx.newUser();
    const { album: personal } = await ctx.newAlbum({ ownerId: auth.user.id });
    const { album: design } = await ctx.newAlbum({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
    const { album: shared } = await ctx.newAlbum({ ownerId: other.id, libraryScope: LibraryScope.Design });
    await ctx.newAlbumUser({ albumId: shared.id, userId: auth.user.id, role: AlbumUserRole.Viewer });
    const first = await ctx.syncStream(auth, [request]);
    expect(
      first
        .filter((row) => row.type === upsert)
        .map((row) => String(row.data.id))
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([personal.id, shared.id].sort());
    await ctx.syncAckAll(auth, first);
    await db.updateTable('album').set({ libraryScope: LibraryScope.Design }).where('id', '=', personal.id).execute();
    const removed = await ctx.syncStream(auth, [request]);
    expect(removed.filter((row) => row.type === remove)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ albumId: personal.id }) }),
    ]);
    expect(removed.some((row) => row.type === upsert && row.data.id === design.id)).toBe(false);
    await ctx.syncAckAll(auth, removed);
    await db.updateTable('album').set({ libraryScope: LibraryScope.Both }).where('id', '=', personal.id).execute();
    const returned = await ctx.syncStream(auth, [request]);
    expect(returned.filter((row) => row.type === upsert).map((row) => row.data.id)).toEqual([personal.id]);
  },
);

it('does not leak owned design album contents through auxiliary streams and restores memberships on return', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { album } = await ctx.newAlbum({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
  const { asset } = await ctx.newAsset({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
  await ctx.newExif({ assetId: asset.id, make: 'Designer reference' });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
  const types = [
    SyncRequestType.AlbumsV2,
    SyncRequestType.AlbumToAssetsV1,
    SyncRequestType.AlbumAssetsV2,
    SyncRequestType.AlbumAssetExifsV1,
    SyncRequestType.AlbumUsersV1,
  ];
  // Advance every stream beyond these rows before testing removal and re-entry.
  await db.updateTable('album').set({ libraryScope: LibraryScope.Personal }).where('id', '=', album.id).execute();
  await ctx.syncAckAll(auth, await ctx.syncStream(auth, types));
  await db.updateTable('album').set({ libraryScope: LibraryScope.Design }).where('id', '=', album.id).execute();
  const first = await ctx.syncStream(auth, types);
  expect(
    first.filter((row) =>
      new Set<SyncEntityType>([
        SyncEntityType.AlbumV2,
        SyncEntityType.AlbumAssetCreateV2,
        SyncEntityType.AlbumToAssetV1,
        SyncEntityType.AlbumUserV1,
      ]).has(row.type),
    ).length,
  ).toBe(0);
  await ctx.syncAckAll(auth, first);
  await db.updateTable('album').set({ libraryScope: LibraryScope.Both }).where('id', '=', album.id).execute();
  const returned = await ctx.syncStream(auth, types);
  expect(returned.some((row) => row.type === SyncEntityType.AlbumToAssetV1 && row.data.assetId === asset.id)).toBe(
    true,
  );
  expect(returned.some((row) => row.type === SyncEntityType.AlbumAssetCreateV2 && row.data.id === asset.id)).toBe(true);
});

it('removes scoped-out memory memberships and replays them when media returns', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
  const { memory } = await ctx.newMemory({ ownerId: auth.user.id });
  await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });
  const types = [SyncRequestType.MemoriesV1, SyncRequestType.MemoryToAssetsV1];
  const first = await ctx.syncStream(auth, types);
  await ctx.syncAckAll(auth, first);
  await db.updateTable('asset').set({ libraryScope: LibraryScope.Design }).where('id', '=', asset.id).execute();
  const removed = await ctx.syncStream(auth, types);
  expect(
    removed.some((row) => row.type === SyncEntityType.MemoryToAssetDeleteV1 && row.data.assetId === asset.id),
  ).toBe(true);
  expect(removed.some((row) => row.type === SyncEntityType.MemoryDeleteV1 && row.data.memoryId === memory.id)).toBe(
    true,
  );
  await ctx.syncAckAll(auth, removed);
  await db.updateTable('asset').set({ libraryScope: LibraryScope.Both }).where('id', '=', asset.id).execute();
  const returned = await ctx.syncStream(auth, types);
  expect(returned.some((row) => row.type === SyncEntityType.MemoryToAssetV1 && row.data.assetId === asset.id)).toBe(
    true,
  );
  expect(returned.some((row) => row.type === SyncEntityType.MemoryV1 && row.data.id === memory.id)).toBe(true);
});

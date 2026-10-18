import { Kysely } from 'kysely';
import { AlbumUserRole, AssetLockReason, SyncEntityType, SyncRequestType, UserMetadataKey } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB, wait } from 'test/utils.js';

/**
 * FL-447 (owner rule, October 17, 2026): items hidden by their owner's Locked rules reach partners only.
 * A member's device that already synced such an item from a shared album is told it was withdrawn
 * once the owner makes the rule (or tags the item into one), and gets it back once the rule lifts:
 * per item on AlbumAssetAccessV1, through a reset on the cursor album streams.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

const legacyTypes = [SyncRequestType.AlbumToAssetsV1, SyncRequestType.AlbumAssetsV2, SyncRequestType.AlbumAssetExifsV1];
const accessTypes = [SyncRequestType.AlbumAssetAccessV1];
const events = (rows: any[]) => rows.filter((row) => row.type !== SyncEntityType.SyncCompleteV1);
const reset = [{ type: SyncEntityType.SyncResetV1, data: {}, ack: 'SyncResetV1|reset' }];

const setLockedRules = (userId: string, suppression: { tagIds?: string[] }) => {
  const value = { privacy: { suppression } };
  return db
    .insertInto('user_metadata')
    .values({ userId, key: UserMetadataKey.Preferences, value } as never)
    .onConflict((oc) => oc.columns(['userId', 'key']).doUpdateSet({ value } as never))
    .execute();
};

/** An owner's album shared with the device's user: one plain item and one the owner tagged "Private". */
const setup = async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { user: owner } = await ctx.newUser();
  const { asset: plain } = await ctx.newAsset({ ownerId: owner.id });
  const { asset: tagged } = await ctx.newAsset({ ownerId: owner.id });
  const { album } = await ctx.newAlbum({ ownerId: owner.id });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: plain.id });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: tagged.id });
  await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Viewer });
  const { tag } = await ctx.newTag({ userId: owner.id, value: 'Private' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [tagged.id] });
  return { ctx, auth, owner, album, plain, tagged, tag };
};

const albumAssetIds = (rows: any[]) =>
  new Set(rows.filter((row) => row.type === SyncEntityType.AlbumToAssetV1).map((row) => row.data.assetId));

describe('withheld album items (FL-447)', () => {
  it("withdraws an item the device already synced once it matches its owner's rule, and returns it once the rule lifts", async () => {
    const { ctx, auth, owner, album, plain, tagged, tag } = await setup();

    const first = await ctx.syncStream(auth, legacyTypes);
    expect(albumAssetIds(first)).toEqual(new Set([plain.id, tagged.id]));
    await ctx.syncAckAll(auth, first);
    await ctx.assertSyncIsComplete(auth, legacyTypes);

    await setLockedRules(owner.id, { tagIds: [tag.id] });
    await wait(2);
    const withdrawn = await ctx.syncStream(auth, legacyTypes);
    expect(withdrawn).toEqual(reset);
    await ctx.syncAckAll(auth, withdrawn);

    // the device syncs again from scratch, without the withheld item
    const again = await ctx.syncStream(auth, legacyTypes);
    expect(albumAssetIds(again)).toEqual(new Set([plain.id]));
    expect(again).not.toContainEqual(expect.objectContaining({ data: expect.objectContaining({ id: tagged.id }) }));
    await ctx.syncAckAll(auth, again);
    await ctx.assertSyncIsComplete(auth, legacyTypes);

    await setLockedRules(owner.id, {});
    await wait(2);
    const returned = await ctx.syncStream(auth, legacyTypes);
    expect(returned).toEqual(reset);
    await ctx.syncAckAll(auth, returned);
    const restored = await ctx.syncStream(auth, legacyTypes);
    expect(albumAssetIds(restored)).toEqual(new Set([plain.id, tagged.id]));
    expect(restored).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ albumId: album.id, assetId: tagged.id }) }),
    );
  });

  it('withdraws an item tagged into an existing rule after the device synced it', async () => {
    const { ctx, auth, owner, plain, tag } = await setup();
    await setLockedRules(owner.id, { tagIds: [tag.id] });

    const first = await ctx.syncStream(auth, legacyTypes);
    expect(albumAssetIds(first)).toEqual(new Set([plain.id]));
    await ctx.syncAckAll(auth, first);
    await ctx.assertSyncIsComplete(auth, legacyTypes);

    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [plain.id] });
    await wait(2);
    await expect(ctx.syncStream(auth, legacyTypes)).resolves.toEqual(reset);
  });

  it('does not reset for an item, already withheld, added to the album or a newly shared album', async () => {
    const { ctx, auth, owner, tag } = await setup();
    await setLockedRules(owner.id, { tagIds: [tag.id] });

    const first = await ctx.syncStream(auth, legacyTypes);
    await ctx.syncAckAll(auth, first);
    await ctx.assertSyncIsComplete(auth, legacyTypes);

    const { asset: hidden } = await ctx.newAsset({ ownerId: owner.id });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [hidden.id] });
    const { album: other } = await ctx.newAlbum({ ownerId: owner.id });
    await ctx.newAlbumAsset({ albumId: other.id, assetId: hidden.id });
    await ctx.newAlbumUser({ albumId: other.id, userId: auth.user.id, role: AlbumUserRole.Viewer });
    await wait(2);

    const next = await ctx.syncStream(auth, legacyTypes);
    expect(next).not.toContainEqual(expect.objectContaining({ type: SyncEntityType.SyncResetV1 }));
    expect(albumAssetIds(next).has(hidden.id)).toBe(false);
  });

  it('withdraws a locked item the device already synced and returns it once unlocked', async () => {
    const { ctx, auth, plain, tagged } = await setup();
    const first = await ctx.syncStream(auth, legacyTypes);
    await ctx.syncAckAll(auth, first);
    await ctx.assertSyncIsComplete(auth, legacyTypes);

    await db
      .insertInto('asset_lock')
      .values({ assetId: plain.id, reason: AssetLockReason.Marked, lockedBy: null, previousVisibility: null })
      .execute();
    await wait(2);
    const withdrawn = await ctx.syncStream(auth, legacyTypes);
    expect(withdrawn).toEqual(reset);
    await ctx.syncAckAll(auth, withdrawn);
    const again = await ctx.syncStream(auth, legacyTypes);
    expect(albumAssetIds(again)).toEqual(new Set([tagged.id]));
    await ctx.syncAckAll(auth, again);

    await db.deleteFrom('asset_lock').where('assetId', '=', plain.id).execute();
    await wait(2);
    await expect(ctx.syncStream(auth, legacyTypes)).resolves.toEqual(reset);
  });

  it('never resets the owner, whose own items follow their own session', async () => {
    const ctx = new SyncTestContext(db);
    const { auth } = await ctx.newSyncAuthUser();
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    const { album } = await ctx.newAlbum({ ownerId: auth.user.id });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
    const { tag } = await ctx.newTag({ userId: auth.user.id, value: 'Mine' });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });

    const first = await ctx.syncStream(auth, [SyncRequestType.AlbumToAssetsV1]);
    await ctx.syncAckAll(auth, first);
    await setLockedRules(auth.user.id, { tagIds: [tag.id] });
    await wait(2);

    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumToAssetsV1]);
  });

  it('sends a per-item delete and regrant on AlbumAssetAccessV1', async () => {
    const { ctx, auth, owner, album, tagged, tag } = await setup();

    const first = events(await ctx.syncStream(auth, accessTypes));
    expect(first.map((row) => row.data.asset.id)).toContain(tagged.id);
    await ctx.syncAckAll(auth, first);

    await setLockedRules(owner.id, { tagIds: [tag.id] });
    const removed = events(await ctx.syncStream(auth, accessTypes));
    expect(removed).toEqual([
      expect.objectContaining({
        type: SyncEntityType.AlbumAssetAccessDeleteV1,
        data: { albumId: album.id, assetId: tagged.id },
      }),
    ]);
    await ctx.syncAckAll(auth, removed);
    await ctx.assertSyncIsComplete(auth, accessTypes);

    await setLockedRules(owner.id, {});
    const granted = events(await ctx.syncStream(auth, accessTypes));
    expect(granted).toEqual([
      expect.objectContaining({
        type: SyncEntityType.AlbumAssetAccessV1,
        data: expect.objectContaining({ albumId: album.id, asset: expect.objectContaining({ id: tagged.id }) }),
      }),
    ]);
  });
});

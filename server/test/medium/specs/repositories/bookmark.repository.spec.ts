import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AlbumUserRole, AssetLockReason, LibraryScope, UserMetadataKey } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetSourceRepository } from 'src/repositories/asset-source.repository.js';
import { BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { BookmarkService } from 'src/services/bookmark.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const setup = () => newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }).ctx;

describe('shared bookmark and source persistence', () => {
  it('does not use a bookmark to reveal a Locked preview and survives deletion of the preview original', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const repo = new BookmarkRepository(db);
    const bookmark = await repo.create(user.id, {
      url: 'https://example.org',
      title: 'Reference',
      libraryScope: LibraryScope.Design,
      previewAssetId: asset.id,
    });
    await db
      .insertInto('asset_lock')
      .values({ assetId: asset.id, reason: AssetLockReason.Marked, lockedBy: user.id })
      .execute();
    const service = new BookmarkService(repo, new AccessRepository(db));
    expect((await service.get({ user }, bookmark.id)).previewAssetId).toBeNull();
    expect(
      (await service.get({ user, session: { id: 'test', hasElevatedPermission: true } }, bookmark.id)).previewAssetId,
    ).toBe(asset.id);
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    expect((await repo.getOwned({ user }, bookmark.id))?.previewAssetId).toBeNull();
  });

  it('never reveals another owner’s suppressed bookmark through an elevated album viewer', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const viewer = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    await db
      .insertInto('album_user')
      .values({ albumId: album.id, userId: viewer.user.id, role: AlbumUserRole.Viewer })
      .execute();
    const tag = await new TagRepository(db, LoggingRepository.create()).create({ userId: user.id, value: 'Private' });
    const repo = new BookmarkRepository(db);
    const bookmark = await repo.create(user.id, {
      url: 'https://example.org',
      title: 'Private',
      libraryScope: LibraryScope.Design,
    });
    await repo.setTags({ user }, bookmark.id, [tag.id]);
    await repo.addToAlbum({ user }, album.id, [bookmark.id]);
    await db
      .insertInto('user_metadata')
      .values({
        userId: user.id,
        key: UserMetadataKey.Preferences,
        value: { privacy: { suppression: { tagIds: [tag.id] } } },
      })
      .onConflict((oc) =>
        oc.columns(['userId', 'key']).doUpdateSet({ value: { privacy: { suppression: { tagIds: [tag.id] } } } }),
      )
      .execute();
    const elevatedViewer = { user: viewer.user, session: { id: 'viewer-test', hasElevatedPermission: true } };
    expect(await repo.getForAlbum(elevatedViewer, album.id)).toEqual([]);
    expect((await repo.getAlbumCounts(elevatedViewer, album.id)).bookmarkCount).toBe(0);
    expect(
      await repo.getForAlbum({ user, session: { id: 'owner-test', hasElevatedPermission: true } }, album.id),
    ).toHaveLength(1);
  });
  it('preserves bookmark memberships when existing tags are merged', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const tags = new TagRepository(db, LoggingRepository.create());
    const source = await tags.create({ userId: user.id, value: 'Source' });
    const target = await tags.create({ userId: user.id, value: 'Target' });
    const repo = new BookmarkRepository(db);
    const bookmark = await repo.create(user.id, {
      url: 'https://example.org',
      title: 'Tagged',
      libraryScope: LibraryScope.Design,
    });
    await repo.setTags({ user }, bookmark.id, [source.id]);
    await db.transaction().execute((tx) => tags.merge(tx, source.id, target.id));
    expect(await db.selectFrom('bookmark_tag').selectAll().where('bookmarkId', '=', bookmark.id).execute()).toEqual([
      { bookmarkId: bookmark.id, tagId: target.id },
    ]);
  });
  it('uses one bookmark in two existing albums and preserves it when either album disappears', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const a = await ctx.newAlbum({ ownerId: user.id });
    const b = await ctx.newAlbum({ ownerId: user.id });
    const repo = new BookmarkRepository(db);
    const bookmark = await repo.create(user.id, {
      url: 'https://example.org',
      title: 'Reference',
      libraryScope: LibraryScope.Design,
    });
    await db
      .insertInto('album_bookmark')
      .values([a, b].map(({ album }) => ({ albumId: album.id, bookmarkId: bookmark.id })))
      .execute();
    await db.deleteFrom('album').where('id', '=', a.album.id).execute();
    expect(await db.selectFrom('bookmark').selectAll().where('id', '=', bookmark.id).execute()).toHaveLength(1);
    expect(
      await db.selectFrom('album_bookmark').selectAll().where('bookmarkId', '=', bookmark.id).execute(),
    ).toHaveLength(1);
    await db.deleteFrom('album_bookmark').where('albumId', '=', b.album.id).execute();
    expect(await db.selectFrom('bookmark').selectAll().where('id', '=', bookmark.id).execute()).toHaveLength(1);
  });

  it('does not expose locked, foreign, or trashed records through ordinary owner reads', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const other = await ctx.newUser();
    const repo = new BookmarkRepository(db);
    const bookmark = await repo.create(user.id, {
      url: 'https://example.org',
      title: 'Private',
      libraryScope: LibraryScope.Design,
      isLocked: true,
    });
    const auth = { user };
    expect(await repo.getOwned(auth, bookmark.id)).toBeUndefined();
    expect(
      await repo.getOwned({ user: other.user, session: { id: 'test', hasElevatedPermission: true } }, bookmark.id),
    ).toBeUndefined();
    const elevated = { user, session: { id: 'test', hasElevatedPermission: true } };
    expect(await repo.getOwned(elevated, bookmark.id)).toBeDefined();
    await repo.setTrashed(elevated, bookmark.id, true);
    expect(await repo.getOwned(elevated, bookmark.id)).toBeUndefined();
    await repo.setTrashed(elevated, bookmark.id, false);
    expect((await repo.getOwned(elevated, bookmark.id))?.id).toBe(bookmark.id);
  });

  it('retains distinct captures and serializes concurrent retries to one source', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const sources = new AssetSourceRepository(db);
    const input = {
      assetId: asset.id,
      captureId: randomUUID(),
      pageUrl: 'https://example.org',
      title: 'Reference',
      capturedAt: new Date().toISOString(),
    };
    const rows = await Promise.all(
      Array.from({ length: 5 }, () => db.transaction().execute((tx) => sources.upsertCapture(tx, input))),
    );
    expect(new Set(rows.map(({ id }) => id)).size).toBe(1);
    await db.transaction().execute((tx) => sources.upsertCapture(tx, { ...input, captureId: randomUUID() }));
    expect(await sources.getAll(asset.id)).toHaveLength(2);
    const other = await ctx.newAsset({ ownerId: user.id });
    await expect(
      db.transaction().execute((tx) => sources.upsertCapture(tx, { ...input, assetId: other.asset.id })),
    ).rejects.toThrow('Capture ID already used');
  });

  it('reuses owner tag IDs, rejects foreign tags atomically and hides suppressed descendants', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const other = await ctx.newUser();
    const repo = new BookmarkRepository(db);
    const bookmark = await repo.create(user.id, {
      url: 'https://example.org',
      title: 'Tagged',
      libraryScope: LibraryScope.Design,
    });
    const tag = await db
      .insertInto('tag')
      .values({ userId: user.id, value: 'Reference' })
      .returningAll()
      .executeTakeFirstOrThrow();
    const foreign = await db
      .insertInto('tag')
      .values({ userId: other.user.id, value: 'Other' })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('tag_closure')
      .values({ id_ancestor: tag.id, id_descendant: tag.id })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await repo.setTags({ user }, bookmark.id, [tag.id, tag.id]);
    expect(await repo.getTagIds({ user }, bookmark.id)).toEqual([tag.id]);
    expect(await repo.getTagIds({ user: other.user }, bookmark.id)).toEqual([]);
    await expect(repo.setTags({ user }, bookmark.id, [foreign.id])).rejects.toThrow('Tag not found');
    expect(await db.selectFrom('bookmark_tag').selectAll().where('bookmarkId', '=', bookmark.id).execute()).toEqual([
      { bookmarkId: bookmark.id, tagId: tag.id },
    ]);
    expect(
      await repo.getOwned(
        {
          user,
          hiddenContent: {
            userId: user.id,
            tagIds: [tag.id],
            personIds: [],
            petIds: [],
            includeNsfw: false,
            scope: 'owned',
          },
        },
        bookmark.id,
      ),
    ).toBeUndefined();
  });

  it('cleans private records on account deletion and never deletes a preview original when a bookmark is removed', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const bookmark = await new BookmarkRepository(db).create(user.id, {
      url: 'https://example.org',
      title: 'Reference',
      libraryScope: LibraryScope.Design,
      previewAssetId: asset.id,
    });
    await db.deleteFrom('bookmark').where('id', '=', bookmark.id).execute();
    expect(await db.selectFrom('asset').select('id').where('id', '=', asset.id).execute()).toHaveLength(1);
    await new BookmarkRepository(db).create(user.id, {
      url: 'https://example.org',
      title: 'Other',
      libraryScope: LibraryScope.Design,
    });
    await db.transaction().execute((tx) =>
      new AssetSourceRepository(db).upsertCapture(tx, {
        assetId: asset.id,
        captureId: randomUUID(),
        pageUrl: 'https://example.org',
        title: 'Reference',
        capturedAt: new Date().toISOString(),
      }),
    );
    await db.deleteFrom('user').where('id', '=', user.id).execute();
    expect(await db.selectFrom('bookmark').selectAll().where('ownerId', '=', user.id).execute()).toEqual([]);
    expect(await db.selectFrom('asset_source').selectAll().where('assetId', '=', asset.id).execute()).toEqual([]);
  });

  it('allows editors to add their own bookmark and immediately loses reads after membership revocation', async () => {
    const ctx = setup();
    const owner = await ctx.newUser();
    const editor = await ctx.newUser();
    const viewer = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: owner.user.id });
    await db
      .insertInto('album_user')
      .values([
        { albumId: album.id, userId: editor.user.id, role: AlbumUserRole.Editor },
        { albumId: album.id, userId: viewer.user.id, role: AlbumUserRole.Viewer },
      ])
      .execute();
    const repo = new BookmarkRepository(db);
    const bookmark = await repo.create(editor.user.id, {
      url: 'https://example.org',
      title: 'Shared',
      libraryScope: LibraryScope.Design,
    });
    expect(await repo.addToAlbum({ user: viewer.user }, album.id, [bookmark.id])).toEqual([
      { id: bookmark.id, success: false, error: 'no_permission' },
    ]);
    expect(await repo.addToAlbum({ user: editor.user }, album.id, [bookmark.id])).toEqual([
      { id: bookmark.id, success: true },
    ]);
    expect(await repo.getForAlbum({ user: viewer.user }, album.id)).toHaveLength(1);
    expect(await repo.removeFromAlbum({ user: viewer.user }, album.id, [bookmark.id])).toEqual([
      { id: bookmark.id, success: false, error: 'no_permission' },
    ]);
    expect(await repo.removeFromAlbum({ user: owner.user }, album.id, [bookmark.id])).toEqual([
      { id: bookmark.id, success: true },
    ]);
    expect(await repo.getOwned({ user: editor.user }, bookmark.id)).toBeDefined();
    await repo.addToAlbum({ user: editor.user }, album.id, [bookmark.id]);
    await db.deleteFrom('album_user').where('albumId', '=', album.id).where('userId', '=', viewer.user.id).execute();
    expect(await repo.getForAlbum({ user: viewer.user }, album.id)).toEqual([]);
    await db.updateTable('bookmark').set({ isLocked: true }).where('id', '=', bookmark.id).execute();
    expect(await repo.getForAlbum({ user: owner.user }, album.id)).toEqual([]);
  });

  it('counts each kind independently using the same media privacy filters as album pages', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
    const repo = new BookmarkRepository(db);
    const bookmark = await repo.create(user.id, {
      url: 'https://example.org',
      title: 'Reference',
      libraryScope: LibraryScope.Design,
    });
    await repo.addToAlbum({ user }, album.id, [bookmark.id]);
    expect((await repo.getAlbumAssets({ user }, album.id)).map(({ id }) => id)).toEqual([asset.id]);
    expect(await repo.getAlbumCounts({ user }, album.id)).toEqual({ assetCount: 1, bookmarkCount: 1, itemCount: 2 });
    await db.updateTable('bookmark').set({ isLocked: true }).where('id', '=', bookmark.id).execute();
    expect(await repo.getAlbumCounts({ user }, album.id)).toEqual({ assetCount: 1, bookmarkCount: 0, itemCount: 1 });
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();
    expect(await repo.getAlbumCounts({ user }, album.id)).toEqual({ assetCount: 0, bookmarkCount: 0, itemCount: 0 });
  });
});

import { UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { LibraryItemSearchDto } from 'src/dtos/library-search.dto.js';
import { AlbumUserRole, AssetStatus, LibraryScope, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { ApiKeyService } from 'src/services/api-key.service.js';
import { AuthService } from 'src/services/auth.service.js';
import { BaseService } from 'src/services/base.service.js';
import { BookmarkService } from 'src/services/bookmark.service.js';
import { TrashService } from 'src/services/trash.service.js';
import { TrashReviewAction } from 'src/utils/trash-review.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

/**
 * Boards items end to end (FL-634): trash, restore and delete keep what the user organised, and a
 * revoked browser-extension key stops at once.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }).ctx;
const trashService = () => {
  const { sut, ctx } = newMediumService(TrashService, {
    database: db,
    real: [AccessRepository, ConfigRepository, SystemMetadataRepository, TrashRepository],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  return sut;
};
const scope = (id: string) => ({ userIds: [id], lockedOwnerId: '', viewingUserId: id });
const ALL = { assets: true, bookmarks: true };
const boards = (extra: Record<string, unknown> = {}) =>
  LibraryItemSearchDto.schema.parse({ filter: { libraryScope: 'design' }, ...extra });
const found = async (user: { id: string }, request = boards()) =>
  (await new BookmarkRepository(db).searchLibrary({ user } as never, request, scope(user.id), ALL)).candidates
    .map(({ id }) => id)
    .toSorted();

describe('Boards items through trash, restore and delete', () => {
  it('drops a trashed Design file from Boards search and restores it with its collections, tags, rating and note', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    await ctx.newExif({ assetId: asset.id, rating: 4, description: 'Use for the spring mailer' });
    const { album } = await ctx.newAlbum({ ownerId: user.id, libraryScope: LibraryScope.Design }, [asset.id]);
    const { tag } = await ctx.newTag({ userId: user.id, value: 'Packaging' });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
    const inCollection = boards({ filter: { libraryScope: 'design', albumIds: { any: [album.id] } } });
    const byNote = boards({ query: 'spring mailer' });
    expect(await found(user, inCollection)).toEqual([asset.id]);

    const sut = trashService();
    const review = await sut.review(auth, { action: TrashReviewAction.Trash, ids: [asset.id] });
    await expect(
      sut.apply(auth, { action: TrashReviewAction.Trash, ids: [asset.id], token: review.token }),
    ).resolves.toEqual({ count: 1 });
    expect(await found(user)).toEqual([]);
    expect(await found(user, inCollection)).toEqual([]);
    expect(await found(user, byNote)).toEqual([]);

    await expect(sut.restoreAssets(auth, { ids: [asset.id] })).resolves.toEqual({ count: 1 });
    expect(await found(user)).toEqual([asset.id]);
    expect(await found(user, inCollection)).toEqual([asset.id]);
    expect(await found(user, byNote)).toEqual([asset.id]);
    await expect(
      db
        .selectFrom('asset')
        .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .select(['asset.status', 'asset.deletedAt', 'asset_exif.rating', 'asset_exif.description'])
        .where('asset.id', '=', asset.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: AssetStatus.Active,
      deletedAt: null,
      rating: 4,
      description: 'Use for the spring mailer',
    });
    await expect(db.selectFrom('tag_asset').select('tagId').where('assetId', '=', asset.id).execute()).resolves.toEqual(
      [{ tagId: tag.id }],
    );
  });

  it('drops a trashed saved link from Boards search and restores it with its collections, tags, rating and note', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const repo = new BookmarkRepository(db);
    const service = new BookmarkService(repo, new AccessRepository(db));
    const { album } = await ctx.newAlbum({ ownerId: user.id, libraryScope: LibraryScope.Design });
    const tag = await new TagRepository(db, LoggingRepository.create()).create({ userId: user.id, value: 'Type' });
    const link = await repo.create(user.id, {
      url: 'https://example.org/specimen',
      title: 'Type specimen',
      note: 'Licence before use',
      libraryScope: LibraryScope.Design,
    });
    await repo.addToAlbum(auth, album.id, [link.id]);
    await service.setTags(auth, link.id, [tag.id]);
    await service.update(auth, link.id, { rating: 5 });
    const inCollection = boards({ filter: { libraryScope: 'design', albumIds: { any: [album.id] } } });
    const byNote = boards({ query: 'Licence before use' });
    expect(await found(user, inCollection)).toEqual([link.id]);

    await service.trash(auth, link.id);
    expect(await found(user)).toEqual([]);
    expect(await found(user, inCollection)).toEqual([]);
    expect(await found(user, byNote)).toEqual([]);
    await expect(service.get(auth, link.id)).rejects.toThrow();

    await service.restore(auth, link.id);
    expect(await found(user)).toEqual([link.id]);
    expect(await found(user, inCollection)).toEqual([link.id]);
    expect(await found(user, byNote)).toEqual([link.id]);
    await expect(service.get(auth, link.id)).resolves.toMatchObject({
      note: 'Licence before use',
      rating: 5,
      deletedAt: null,
    });
    await expect(service.getTags(auth, link.id)).resolves.toEqual({ ids: [tag.id] });
    expect((await service.getForAlbum(auth, album.id)).map(({ id }) => id)).toEqual([link.id]);
  });

  it('keeps a deleted collection’s files and links in the library and moves its collections up a level', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const albums = ctx.get(AlbumRepository);
    const repo = new BookmarkRepository(db);
    const { album: parent } = await ctx.newAlbum({ ownerId: user.id, libraryScope: LibraryScope.Design });
    const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    const { album: doomed } = await ctx.newAlbum({ ownerId: user.id, libraryScope: LibraryScope.Design }, [asset.id]);
    const { album: child } = await ctx.newAlbum({ ownerId: user.id, libraryScope: LibraryScope.Design });
    await albums.reparent(doomed.id, parent.id);
    await albums.reparent(child.id, doomed.id);
    const link = await repo.create(user.id, {
      url: 'https://example.org/moodboard',
      title: 'Moodboard',
      libraryScope: LibraryScope.Design,
    });
    await repo.addToAlbum(auth, doomed.id, [link.id]);
    await repo.addToAlbum(auth, child.id, [link.id]);

    await albums.delete(doomed.id);

    expect(await found(user)).toEqual([asset.id, link.id].toSorted());
    await expect(
      db.selectFrom('asset').select(['status', 'deletedAt']).where('id', '=', asset.id).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: AssetStatus.Active, deletedAt: null });
    await expect(
      db.selectFrom('bookmark').select('deletedAt').where('id', '=', link.id).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deletedAt: null });
    await expect(
      db.selectFrom('album').select('parentId').where('id', '=', child.id).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ parentId: parent.id });
    // the collection that moved up keeps what was filed in it
    expect(await found(user, boards({ filter: { libraryScope: 'design', albumIds: { any: [child.id] } } }))).toEqual([
      link.id,
    ]);
  });

  it('leaves the picture intact when a saved link whose picture is its preview is deleted', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const repo = new BookmarkRepository(db);
    const service = new BookmarkService(repo, new AccessRepository(db));
    const { asset: picture } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    const link = await repo.create(user.id, {
      url: 'https://example.org/board',
      title: 'Board',
      previewAssetId: picture.id,
      libraryScope: LibraryScope.Design,
    });

    await service.trash(auth, link.id);

    await expect(
      db.selectFrom('asset').select(['status', 'deletedAt']).where('id', '=', picture.id).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: AssetStatus.Active, deletedAt: null });
    await service.restore(auth, link.id);
    await expect(service.get(auth, link.id)).resolves.toMatchObject({ previewAssetId: picture.id });
  });

  it('does not leak another owner’s link notes through a saved search or a shared collection after a restore', async () => {
    const ctx = setup();
    const owner = await ctx.newUser();
    const viewer = await ctx.newUser();
    const ownerAuth = factory.auth({ user: owner.user });
    const viewerAuth = factory.auth({ user: viewer.user });
    const repo = new BookmarkRepository(db);
    const service = new BookmarkService(repo, new AccessRepository(db));
    const { album } = await ctx.newAlbum({ ownerId: owner.user.id, libraryScope: LibraryScope.Design });
    await ctx.newAlbumUser({ albumId: album.id, userId: viewer.user.id, role: AlbumUserRole.Viewer });
    const link = await repo.create(owner.user.id, {
      url: 'https://example.org/reference',
      title: 'Public reference',
      note: 'private-project',
      libraryScope: LibraryScope.Design,
    });
    await repo.addToAlbum(ownerAuth, album.id, [link.id]);
    await service.update(ownerAuth, link.id, { rating: 3 });
    await service.trash(ownerAuth, link.id);
    await service.restore(ownerAuth, link.id);

    // a smart collection is a saved Boards search: run it as each account
    const smart = (query: string) =>
      boards({ query, filter: { libraryScope: 'design', albumIds: { any: [album.id] } } });
    expect(await found(owner.user, smart('private-project'))).toEqual([link.id]);
    expect(await found(viewer.user, smart('private-project'))).toEqual([]);
    expect(await found(viewer.user, smart('Public reference'))).toEqual([link.id]);
    expect(await found(viewer.user, boards({ query: 'private-project' }))).toEqual([]);

    const [shared] = await service.getForAlbum(viewerAuth, album.id);
    expect(shared).toMatchObject({ id: link.id, note: null, rating: null });
    const [listed] = await service.getForSearch(viewerAuth, smart('Public reference'), [link.id]);
    expect(listed).toMatchObject({ id: link.id, note: null, rating: null });
    await expect(service.get(viewerAuth, link.id)).rejects.toThrow();
    await expect(service.get(ownerAuth, link.id)).resolves.toMatchObject({ note: 'private-project', rating: 3 });
  });
});

describe('revoking the browser-extension key', () => {
  it('makes capture and catalog calls fail with 401 at once', async () => {
    const authCtx = newMediumService(AuthService, {
      database: db,
      real: [
        AccessRepository,
        ApiKeyRepository,
        ConfigRepository,
        CryptoRepository,
        SystemMetadataRepository,
        UserRepository,
      ],
      mock: [LoggingRepository, EventRepository],
    });
    const keys = newMediumService(ApiKeyService, {
      database: db,
      real: [ApiKeyRepository, CryptoRepository, SystemMetadataRepository],
      mock: [LoggingRepository],
    }).sut;
    const { user } = await authCtx.ctx.newUser();
    const auth = factory.auth({ user });
    const { secret, apiKey } = await keys.create(auth, {
      name: 'Frameleaf browser extension',
      permissions: [Permission.CaptureCreate, Permission.CaptureCatalogRead],
    });
    const call = (permission: Permission) =>
      authCtx.sut.authenticate({
        headers: { 'x-api-key': secret },
        queryParams: {},
        metadata: { adminRoute: false, sharedLinkRoute: false, uri: '/api/capture', permission },
      });
    await expect(call(Permission.CaptureCatalogRead)).resolves.toMatchObject({ user: { id: user.id } });
    await expect(call(Permission.CaptureCreate)).resolves.toMatchObject({ apiKey: { id: apiKey.id } });

    await keys.delete(auth, apiKey.id);

    for (const permission of [Permission.CaptureCatalogRead, Permission.CaptureCreate]) {
      const failure = await call(permission).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(UnauthorizedException);
      expect((failure as UnauthorizedException).getStatus()).toBe(401);
    }
  });
});

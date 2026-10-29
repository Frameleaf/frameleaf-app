import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { CaptureCommitDto } from 'src/dtos/capture.dto.js';
import { AlbumUserRole, LibraryScope, Permission } from 'src/enum.js';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { CaptureRepository } from 'src/repositories/capture.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const setup = async () => {
  const ctx = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }).ctx;
  const { user } = await ctx.newUser();
  const owner = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: owner.user.id, libraryScope: LibraryScope.Design });
  await db
    .insertInto('album_user')
    .values({ albumId: album.id, userId: user.id, role: AlbumUserRole.Editor })
    .execute();
  const key = await db
    .insertInto('api_key')
    .values({
      userId: user.id,
      name: 'Capture',
      key: randomBytes(32),
      permissions: [Permission.CaptureCreate, Permission.CaptureCatalogRead],
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const tag = await new TagRepository(db, LoggingRepository.create()).create({ userId: user.id, value: 'Reference' });
  const auth = { user, apiKey: { id: key.id, permissions: key.permissions } };
  const dto = CaptureCommitDto.schema.parse({
    captureId: randomUUID(),
    albumId: album.id,
    tagIds: [tag.id],
    bookmark: { url: 'https://example.org', title: 'Reference' },
    note: 'Private',
    source: { pageUrl: 'https://example.org', title: 'Page title', capturedAt: new Date().toISOString() },
  });
  return { ctx, auth, dto, album, tag, repo: new CaptureRepository(db) };
};

describe('durable capture transactions', () => {
  it('serializes cancellation against bookmark publication and never recreates a cancelled UUID', async () => {
    for (const cancelFirst of [true, false]) {
      const { auth, dto, repo } = await setup();
      const operations = cancelFirst
        ? [() => repo.cancel(auth, dto), () => repo.commitBookmark(auth, dto)]
        : [() => repo.commitBookmark(auth, dto), () => repo.cancel(auth, dto)];
      const outcomes = await Promise.allSettled(operations.map((operation) => operation()));
      const rows = await db
        .selectFrom('capture_receipt')
        .selectAll()
        .where('ownerId', '=', auth.user.id)
        .where('captureId', '=', dto.captureId)
        .execute();
      expect(rows).toHaveLength(1);
      const bookmarks = await db.selectFrom('bookmark').select('id').where('ownerId', '=', auth.user.id).execute();
      if (rows[0].status === 'cancelled') {
        expect(bookmarks).toHaveLength(0);
        expect(outcomes.some((result) => result.status === 'rejected')).toBe(true);
        await expect(repo.commitBookmark(auth, dto)).rejects.toThrow('cancelled');
        expect((await repo.cancel(auth, dto)).status).toBe('cancelled');
      } else {
        expect(rows[0].status).toBe('created');
        expect(bookmarks).toEqual([{ id: rows[0].itemId }]);
        expect(outcomes.every((result) => result.status === 'fulfilled')).toBe(true);
        expect((await repo.cancel(auth, dto)).itemId).toBe(rows[0].itemId);
      }
    }
  });
  it('lets the original actor cancel after destination loss but never lets another key replace the outcome', async () => {
    const { auth, dto, repo } = await setup();
    await db.deleteFrom('album_user').where('albumId', '=', dto.albumId).where('userId', '=', auth.user.id).execute();
    const cancelled = await repo.cancel(auth, dto);
    expect(cancelled).toMatchObject({ status: 'cancelled', itemId: dto.captureId });
    const key = await db
      .insertInto('api_key')
      .values({
        userId: auth.user.id,
        name: 'Other capture key',
        key: randomBytes(32),
        permissions: [Permission.CaptureCreate],
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await expect(repo.cancel({ ...auth, apiKey: { id: key.id, permissions: key.permissions } }, dto)).rejects.toThrow(
      'Capture unavailable',
    );
    await expect(repo.cancel(auth, { ...dto, note: 'Changed' })).rejects.toThrow('Capture payload changed');
    expect(await db.selectFrom('bookmark').select('id').where('ownerId', '=', auth.user.id).execute()).toEqual([]);
  });
  it('does not reveal a tag carried only by a Locked bookmark in the shared tag directory', async () => {
    const { auth, dto, repo, tag } = await setup();
    const receipt = await repo.commitBookmark(auth, dto);
    await db.updateTable('bookmark').set({ isLocked: true }).where('id', '=', receipt.itemId).execute();
    const tags = new TagRepository(db, LoggingRepository.create());
    expect((await tags.getAll(auth.user.id, { hideLocked: true })).map(({ id }) => id)).not.toContain(tag.id);
    expect((await tags.getAll(auth.user.id, { hideLocked: false })).map(({ id }) => id)).toContain(tag.id);
  });
  it('hides a bookmark-only tag when another attached tag is suppressed, within the configured owner scope', async () => {
    const { auth, dto, repo, tag } = await setup();
    const receipt = await repo.commitBookmark(auth, dto);
    const tags = new TagRepository(db, LoggingRepository.create());
    const hidden = await tags.create({ userId: auth.user.id, value: 'Hidden' });
    await db.insertInto('bookmark_tag').values({ bookmarkId: receipt.itemId, tagId: hidden.id }).execute();
    const hiddenContent = {
      userId: auth.user.id,
      tagIds: [hidden.id],
      personIds: [],
      petIds: [],
      includeNsfw: false,
      scope: 'owned' as const,
    };
    expect((await tags.getAll(auth.user.id, { hiddenContent })).map(({ id }) => id)).not.toContain(tag.id);
    expect(
      (await tags.getAll(auth.user.id, { hiddenContent: { ...hiddenContent, userId: randomUUID() } })).map(
        ({ id }) => id,
      ),
    ).toContain(tag.id);
  });
  it('catalog exposes only writable designer albums and removes inaccessible parent identifiers', async () => {
    const { ctx, auth, repo, album } = await setup();
    await ctx.newAlbum({ ownerId: auth.user.id, libraryScope: LibraryScope.Personal });
    const { album: parent } = await ctx.newAlbum({ ownerId: auth.user.id, libraryScope: LibraryScope.Personal });
    const { album: child } = await ctx.newAlbum({
      ownerId: auth.user.id,
      libraryScope: LibraryScope.Both,
      parentId: parent.id,
    });
    const other = await ctx.newUser();
    const { album: readOnly } = await ctx.newAlbum({ ownerId: other.user.id, libraryScope: LibraryScope.Design });
    await db
      .insertInto('album_user')
      .values({ albumId: readOnly.id, userId: auth.user.id, role: AlbumUserRole.Viewer })
      .execute();
    expect((await repo.catalog(auth)).albums).toEqual(
      expect.arrayContaining([
        { id: album.id, albumName: album.albumName, parentId: null },
        { id: child.id, albumName: child.albumName, parentId: null },
      ]),
    );
    expect((await repo.catalog(auth)).albums).toHaveLength(2);
  });
  it('commits the real resumable publication result, quota, source, tags and album membership together', async () => {
    const { ctx, auth, dto, repo, album, tag } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
    const template = await db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow();
    const checksum = randomBytes(32);
    const uploads = new AssetUploadResourceRepository(db);
    const publish = async (captureId: string) => {
      const file = CaptureCommitDto.schema.parse({
        ...dto,
        captureId,
        bookmark: undefined,
        uploadResourceId: captureId,
        sha256: checksum.toString('hex'),
      });
      await uploads.create(captureId, auth.user.id, {
        metadata: {
          publication: 'capture',
          captureId,
          captureActor: `key:${auth.apiKey.id}`,
          libraryScope: LibraryScope.Design,
          filename: 'capture.png',
          fileCreatedAt: new Date(),
          fileModifiedAt: new Date(),
        },
        checksum,
        size: 4,
        contentType: 'image/png',
      });
      const path = `/synthetic/${captureId}.png`;
      await db
        .updateTable('asset_upload_resource')
        .set({
          state: 'verified',
          offset: 4,
          finalPath: path,
          verifiedChecksum: checksum,
          legacyChecksum: randomBytes(20),
        })
        .where('id', '=', captureId)
        .execute();
      return uploads.locked(captureId, auth.user.id, (tx, resource) =>
        repo.commitFile(tx, auth, file, async () => {
          const published = await uploads.publish(tx, resource, {
            asset: { ...template, id: captureId, checksum, originalPath: path },
            lock: undefined,
          });
          if (!published.resultAssetId || !published.resultStatus) throw new Error('Missing publication');
          return { id: published.resultAssetId, status: published.resultStatus };
        }),
      );
    };
    const first = await publish(dto.captureId);
    const second = await publish(randomUUID());
    expect(first.status).toBe('created');
    expect(second).toEqual(expect.objectContaining({ status: 'duplicate', itemId: first.itemId }));
    expect(await db.selectFrom('asset_source').selectAll().where('assetId', '=', first.itemId).execute()).toHaveLength(
      2,
    );
    expect(await db.selectFrom('album_asset').selectAll().where('albumId', '=', album.id).execute()).toEqual([
      expect.objectContaining({ assetId: first.itemId }),
    ]);
    expect(
      await db.selectFrom('tag_asset').select(['tagId', 'assetId']).where('assetId', '=', first.itemId).execute(),
    ).toEqual([{ tagId: tag.id, assetId: first.itemId }]);
    expect(
      (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', auth.user.id).executeTakeFirstOrThrow())
        .quotaUsageInBytes,
    ).toBe(4);
    expect((await uploads.get(dto.captureId, auth.user.id)).state).toBe('published');
  });
  it('recovers one known upload UUID after concurrent or lost creation responses and rejects changed bytes', async () => {
    const { auth, dto } = await setup();
    const uploads = new AssetUploadResourceRepository(db);
    const input = {
      metadata: {
        publication: 'capture' as const,
        captureId: dto.captureId,
        captureActor: `key:${auth.apiKey.id}`,
        libraryScope: LibraryScope.Design,
        filename: 'capture.png',
        fileCreatedAt: new Date(),
        fileModifiedAt: new Date(),
      },
      checksum: randomBytes(32),
      size: 4,
      contentType: 'image/png',
    };
    const rows = await Promise.all(Array.from({ length: 5 }, () => uploads.create(dto.captureId, auth.user.id, input)));
    expect(new Set(rows.map(({ id }) => id)).size).toBe(1);
    expect(
      await db.selectFrom('asset_upload_resource').select('id').where('id', '=', dto.captureId).execute(),
    ).toHaveLength(1);
    await expect(uploads.create(dto.captureId, auth.user.id, { ...input, checksum: randomBytes(32) })).rejects.toThrow(
      'Capture upload changed',
    );
    await expect(
      uploads.create(dto.captureId, auth.user.id, {
        ...input,
        metadata: { ...input.metadata, captureActor: 'key:another-key' },
      }),
    ).rejects.toThrow('Capture unavailable');
  });
  it('commits one bookmark, private source, tag and album membership across concurrent retries', async () => {
    const { auth, dto, repo, tag, album } = await setup();
    const receipts = await Promise.all(Array.from({ length: 5 }, () => repo.commitBookmark(auth, dto)));
    expect(new Set(receipts.map(({ itemId }) => itemId)).size).toBe(1);
    const id = receipts[0].itemId;
    expect(
      await db.selectFrom('capture_receipt').selectAll().where('ownerId', '=', auth.user.id).execute(),
    ).toHaveLength(1);
    expect(await db.selectFrom('bookmark_tag').selectAll().where('bookmarkId', '=', id).execute()).toEqual([
      { bookmarkId: id, tagId: tag.id },
    ]);
    expect(await db.selectFrom('album_bookmark').selectAll().where('bookmarkId', '=', id).execute()).toEqual([
      expect.objectContaining({ albumId: album.id }),
    ]);
    expect((await db.selectFrom('bookmark').selectAll().where('id', '=', id).executeTakeFirstOrThrow()).source).toEqual(
      { ...dto.source, captureId: dto.captureId, note: dto.note },
    );
    await expect(repo.commitBookmark(auth, { ...dto, note: 'Changed' })).rejects.toThrow('Capture payload changed');
  });

  it('rejects a revoked key and an album editor whose role was removed after admission', async () => {
    const { auth, dto, repo, album } = await setup();
    await db
      .updateTable('album_user')
      .set({ role: AlbumUserRole.Viewer })
      .where('albumId', '=', album.id)
      .where('userId', '=', auth.user.id)
      .execute();
    await expect(repo.commitBookmark(auth, dto)).rejects.toThrow('Capture destination unavailable');
    await db.deleteFrom('api_key').where('id', '=', auth.apiKey.id).execute();
    await expect(repo.commitBookmark(auth, dto)).rejects.toThrow('Capture unavailable');
    expect(await db.selectFrom('capture_receipt').selectAll().where('ownerId', '=', auth.user.id).execute()).toEqual(
      [],
    );
    expect(await db.selectFrom('bookmark').selectAll().where('ownerId', '=', auth.user.id).execute()).toEqual([]);
  });

  it('rolls a new asset back when source storage fails before any saved receipt', async () => {
    const { ctx, auth, dto, repo, album } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
    const template = await db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow();
    const id = randomUUID();
    const fileDto = { ...dto, bookmark: undefined, uploadResourceId: dto.captureId, sha256: 'a'.repeat(64) };
    await expect(
      db.transaction().execute(async (tx) => {
        await sql`CREATE FUNCTION pg_temp.reject_capture_source() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''source write failed''; END;'`.execute(
          tx,
        );
        await sql`CREATE TRIGGER capture_test_reject BEFORE INSERT ON asset_source FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_capture_source()`.execute(
          tx,
        );
        return repo.commitFile(tx, auth, fileDto, async () => {
          await tx
            .insertInto('asset')
            .values({ ...template, id, checksum: randomBytes(32), originalPath: '/synthetic/capture.png' })
            .execute();
          return { id, status: 'created' };
        });
      }),
    ).rejects.toThrow('source write failed');
    expect(await db.selectFrom('asset').select('id').where('id', '=', id).execute()).toEqual([]);
    expect(await db.selectFrom('album_asset').selectAll().where('albumId', '=', album.id).execute()).toEqual([]);
    expect(await db.selectFrom('capture_receipt').selectAll().where('ownerId', '=', auth.user.id).execute()).toEqual(
      [],
    );
  });

  it('does not acknowledge a personal duplicate or return its source and ID', async () => {
    const { ctx, auth, dto, repo } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id, libraryScope: LibraryScope.Personal });
    await expect(
      db
        .transaction()
        .execute((tx) =>
          repo.commitFile(
            tx,
            auth,
            { ...dto, bookmark: undefined, uploadResourceId: dto.captureId, sha256: 'a'.repeat(64) },
            () => Promise.resolve({ id: asset.id, status: 'duplicate' }),
          ),
        ),
    ).rejects.toThrow('Capture unavailable');
    expect(await db.selectFrom('capture_receipt').selectAll().where('ownerId', '=', auth.user.id).execute()).toEqual(
      [],
    );
    expect(await db.selectFrom('asset_source').selectAll().where('assetId', '=', asset.id).execute()).toEqual([]);
  });
});

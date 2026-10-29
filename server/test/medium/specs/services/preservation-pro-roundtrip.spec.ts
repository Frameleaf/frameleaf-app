import { Kysely } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AlbumKind, LibraryScope, UserMetadataKey } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafUserLicenseRepository } from 'src/repositories/frameleaf-user-license.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { PreservationFileRepository } from 'src/repositories/preservation-files.repository.js';
import { PreservationRepository } from 'src/repositories/preservation.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { PreservationWorkerService } from 'src/services/preservation-worker.service.js';
import { StackService } from 'src/services/stack.service.js';
import {
  PreservationAlbumsSchema,
  PreservationBookmarksSchema,
  PreservationEntrySchema,
  PreservationManifestSchema,
  PreservationSidecarSchema,
  PreservationTagsSchema,
} from 'src/utils/preservation.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

it('round-trips Design originals, nested memberships, tag paths and sources through real package files and upload', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-preservation-pro-'));
  StorageCore.setMediaLocation(folder);
  try {
    const options = {
      database: db,
      real: [
        ClassificationRepository,
        MapRepository,
        PartnerRepository,
        SmartAlbumRepository,
        ConfigRepository,
        SystemMetadataRepository,
        PhysicalFileRepository,
        AssetChecksumRepository,
        AccessRepository,
        AlbumRepository,
        AssetRepository,
        SharedLinkRepository,
        UserRepository,
        StorageRepository,
        CryptoRepository,
        TagRepository,
        FrameleafUserLicenseRepository,
      ],
      mock: [EventRepository, LoggingRepository, JobRepository],
    };
    const { sut: media, ctx } = newMediumService(AssetMediaService, options);
    ctx.getMock(EventRepository).emit.mockResolvedValue();
    ctx.getMock(JobRepository).queue.mockResolvedValue();
    const repo = new PreservationRepository(db);
    const files = new PreservationFileRepository();
    const assets = newMediumService(AssetService, options);
    const albumsService = newMediumService(AlbumService, options);
    const stacks = newMediumService(StackService, options);
    for (const context of [assets.ctx, albumsService.ctx, stacks.ctx]) {
      context.getMock(EventRepository).emit.mockResolvedValue();
      context.getMock(JobRepository).queue.mockResolvedValue();
    }
    const worker = new PreservationWorkerService(
      ctx.getMock(LoggingRepository),
      new MediaOperationRepository(db),
      repo,
      files,
      new UserRepository(db),
      new AlbumRepository(db),
      ctx.get(TagRepository),
      media,
      assets.sut,
      albumsService.sut,
      stacks.sut,
    );
    const { user: owner } = await ctx.newUser();
    const { user: target } = await ctx.newUser();
    const bytes = Buffer.from('Synthetic original for preservation, no customer media');
    const original = join(folder, 'original.jpg');
    await writeFile(original, bytes);
    const { asset } = await ctx.newAsset({
      ownerId: owner.id,
      originalPath: original,
      originalFileName: 'original.jpg',
      checksum: createHash('sha1').update(bytes).digest(),
      libraryScope: LibraryScope.Design,
    });
    const { album: root } = await ctx.newAlbum(
      { ownerId: owner.id, albumName: 'Client', libraryScope: LibraryScope.Design },
      [asset.id],
    );
    const { album: middle } = await ctx.newAlbum({
      ownerId: owner.id,
      albumName: 'Campaign',
      kind: AlbumKind.Collection,
      parentId: root.id,
      libraryScope: LibraryScope.Design,
    });
    const { album: leaf } = await ctx.newAlbum(
      { ownerId: owner.id, albumName: 'References', parentId: middle.id, libraryScope: LibraryScope.Design },
      [asset.id],
    );
    const { tag: parent } = await ctx.newTag({ userId: owner.id, value: 'Material' });
    const { tag } = await ctx.newTag({ userId: owner.id, value: 'Material/Paper', parentId: parent.id });
    await ctx.newTagAsset({ assetIds: [asset.id], tagIds: [tag.id] });
    await db
      .insertInto('asset_source')
      .values({
        assetId: asset.id,
        captureId: randomUUID(),
        pageUrl: 'https://example.com/art?token=private',
        title: 'Reference',
        capturedAt: new Date(),
        note: 'My attribution note',
      })
      .execute();
    // FL-653: the Added date an Eagle import set comes back with the item.
    await db
      .updateTable('asset')
      .set({ createdAt: new Date('2024-03-01T12:00:00.000Z') })
      .where('id', '=', asset.id)
      .execute();
    // FL-653: a source an Eagle import brought over keeps saying so after a restore.
    await db
      .insertInto('asset_source')
      .values({
        assetId: asset.id,
        captureId: randomUUID(),
        pageUrl: 'https://eagle.example.com/board',
        title: '',
        capturedAt: new Date(),
        importedFrom: 'eagle',
      })
      .execute();
    const bookmark = await new BookmarkRepository(db).create(owner.id, {
      url: 'https://example.com/watch?v=123',
      title: 'Video reference',
      note: 'Link note',
      libraryScope: LibraryScope.Design,
      previewAssetId: asset.id,
    });
    await db.insertInto('album_bookmark').values({ albumId: leaf.id, bookmarkId: bookmark.id }).execute();
    await db.insertInto('bookmark_tag').values({ tagId: tag.id, bookmarkId: bookmark.id }).execute();
    await new BookmarkRepository(db).create(owner.id, {
      url: 'https://example.com/second',
      title: 'Second',
      libraryScope: LibraryScope.Design,
    });
    const exported = await repo.createExport(
      {
        ownerId: owner.id,
        origin: 'export',
        name: 'Work',
        format: 'directory',
        includeLocked: false,
        includeMetadata: true,
        scope: { description: 'Design' },
      },
      (id) => join(folder, 'package', id),
      { filter: { libraryScope: LibraryScope.Design } },
      false,
      100,
    );
    const item = await db
      .selectFrom('preservation_item')
      .selectAll()
      .where('packageId', '=', exported!.package.id)
      .executeTakeFirstOrThrow();
    const commit = <T>(write: (repository: PreservationRepository) => Promise<T>) => write(repo);
    expect(await worker['exportItem'](exported!.package, item, commit)).toBe('copied');
    await worker['publishPackage'](exported!.package, commit);
    const source = await files.openPackage('directory', exported!.package.path);
    try {
      const manifest = PreservationManifestSchema.parse(
        JSON.parse((await readFile(join(exported!.package.path, 'manifest.json'))).toString()),
      );
      expect(manifest.schemaVersion).toBe(2);
      expect(await repo.hasLockedItems(exported!.package.id)).toBe(false);
      expect(await repo.lockedBookmarkPackageIds([exported!.package.id])).toEqual(new Set());
      await db.updateTable('bookmark').set({ isLocked: true }).where('id', '=', bookmark.id).execute();
      expect(await repo.hasLockedItems(exported!.package.id)).toBe(true);
      expect(await repo.lockedBookmarkPackageIds([exported!.package.id])).toEqual(new Set([exported!.package.id]));
      await db.updateTable('bookmark').set({ isLocked: false }).where('id', '=', bookmark.id).execute();

      await db
        .insertInto('user_metadata')
        .values({
          userId: owner.id,
          key: UserMetadataKey.Preferences,
          value: { privacy: { suppression: { tagIds: [parent.id] } } },
        })
        .onConflict((oc) =>
          oc.columns(['userId', 'key']).doUpdateSet({ value: { privacy: { suppression: { tagIds: [parent.id] } } } }),
        )
        .execute();
      expect(await repo.hasLockedItems(exported!.package.id)).toBe(true);
      expect(await repo.lockedBookmarkPackageIds([exported!.package.id])).toEqual(new Set([exported!.package.id]));
      await db
        .deleteFrom('user_metadata')
        .where('userId', '=', owner.id)
        .where('key', '=', UserMetadataKey.Preferences)
        .execute();
      const bookmarks = PreservationBookmarksSchema.parse(
        JSON.parse((await readFile(join(exported!.package.path, 'bookmarks.json'))).toString()),
      );
      expect(bookmarks).toHaveLength(2);
      expect(bookmarks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: bookmark.id,
            note: 'Link note',
            albumIds: [leaf.id],
            tags: ['Material/Paper'],
            previewAssetId: asset.id,
          }),
        ]),
      );

      const albums = PreservationAlbumsSchema.parse(
        JSON.parse((await readFile(join(exported!.package.path, 'albums.json'))).toString()),
      );
      expect(albums).toHaveLength(3);
      expect(albums.every((album) => album.libraryScope === LibraryScope.Design)).toBe(true);
      const copied = await db
        .selectFrom('preservation_item')
        .selectAll()
        .where('id', '=', item.id)
        .executeTakeFirstOrThrow();
      const entry = PreservationEntrySchema.parse(copied.entry);
      const sidecar = PreservationSidecarSchema.parse(
        JSON.parse((await readFile(join(exported!.package.path, entry.metadata!.path))).toString()),
      );
      const byPage = new Map(sidecar.sources?.map((source) => [source.pageUrl, source]));
      expect(byPage.get('https://example.com/art')).not.toHaveProperty('importedFrom');
      expect(byPage.get('https://eagle.example.com/board')).toMatchObject({ importedFrom: 'eagle' });
      expect(new Date(sidecar.dates.addedAt!).toISOString()).toBe('2024-03-01T12:00:00.000Z');
      const imported = await repo.createPackage({
        ownerId: target.id,
        origin: 'import',
        name: 'Imported work',
        format: 'directory',
        path: exported!.package.path,
        includeLocked: false,
        includeMetadata: true,
        scope: {},
      });
      const mapped = await worker['ensureAlbums'](target.id, manifest.packageId, albums);
      for (let attempt = 0; attempt < 2; attempt++) {
        const restore = await repo.createRestore({
          ownerId: target.id,
          packageId: imported.id,
          packageIdentity: manifest.packageId,
          name: 'Restore',
          options: {},
        });
        await repo.addRestoreItems(restore.id, [{ sourceAssetId: asset.id, locked: false, entry }]);
        const pending = await repo.getRestoreItemBySource(restore.id, asset.id);
        await repo.updateRestoreItem(pending!.id, { state: 'ready', match: 'new', sidecar });
        const ready = await repo.getRestoreItemBySource(restore.id, asset.id);
        const result = await worker['restoreItem'](
          {
            auth: factory.auth({ user: { id: target.id } }),
            ownerId: target.id,
            restore,
            source,
            albums: mapped,
            people: new Map(),
            restoreEditRecipes: true,
            conflictDefault: 'keep',
          },
          ready!,
        );
        const status = await repo.getRestoreItemBySource(restore.id, asset.id);
        expect(result, `${status?.reasonKey}: ${status?.error}`).toBe(attempt === 0 ? 'restored' : 'matched');
        const context = {
          auth: factory.auth({ user: { id: target.id } }),
          ownerId: target.id,
          restore,
          source,
          albums: mapped,
          people: new Map<string, string>(),
          restoreEditRecipes: true,
          conflictDefault: 'keep' as const,
        };
        await worker['restoreBookmarks'](context, manifest.packageId, bookmarks.toReversed());
        if (attempt === 0) {
          const saved = await db
            .selectFrom('bookmark')
            .selectAll()
            .where('ownerId', '=', target.id)
            .where('url', '=', bookmark.url)
            .executeTakeFirstOrThrow();
          await db.updateTable('bookmark').set({ note: 'Edited after restore' }).where('id', '=', saved.id).execute();
          await worker['restoreBookmarks']({ ...context, conflictDefault: 'replace' }, manifest.packageId, bookmarks);
        }
      }
      const restored = await db.selectFrom('asset').selectAll().where('ownerId', '=', target.id).execute();
      expect(restored).toHaveLength(1);
      expect(restored[0].libraryScope).toBe(LibraryScope.Design);
      expect(new Date(restored[0].createdAt).toISOString()).toBe('2024-03-01T12:00:00.000Z');
      expect(await readFile(restored[0].originalPath)).toEqual(bytes);
      expect(await readFile(original)).toEqual(bytes);
      const memberships = await db
        .selectFrom('album_asset')
        .select('albumId')
        .where('assetId', '=', restored[0].id)
        .execute();
      expect(memberships).toHaveLength(2);
      expect(memberships.map((row) => row.albumId)).toEqual(
        expect.arrayContaining([mapped.get(root.id), mapped.get(leaf.id)]),
      );
      const restoredAlbums = await db
        .selectFrom('album')
        .select(['id', 'parentId'])
        .where('id', 'in', mapped.values().toArray())
        .execute();
      expect(restoredAlbums).toContainEqual({ id: mapped.get(leaf.id), parentId: mapped.get(middle.id) });
      expect(restoredAlbums).toContainEqual({ id: mapped.get(middle.id), parentId: mapped.get(root.id) });
      const links = await db.selectFrom('bookmark').selectAll().where('ownerId', '=', target.id).execute();
      expect(links).toHaveLength(2);
      const restoredLink = links.find((link) => link.url === bookmark.url)!;
      expect(restoredLink).toMatchObject({
        url: bookmark.url,
        note: 'Edited after restore',
        libraryScope: LibraryScope.Design,
        previewAssetId: restored[0].id,
      });
      expect(
        await db.selectFrom('album_bookmark').select('albumId').where('bookmarkId', '=', restoredLink.id).execute(),
      ).toEqual([{ albumId: mapped.get(leaf.id) }]);
      const restoredTags = await db
        .selectFrom('tag')
        .select(['value', 'parentId'])
        .where('userId', '=', target.id)
        .execute();
      expect(restoredTags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'Material' }),
          expect.objectContaining({ value: 'Material/Paper', parentId: expect.any(String) }),
        ]),
      );
      expect(await repo.getAssetSources(restored[0].id, target.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            note: 'My attribution note',
            pageUrl: 'https://example.com/art',
            importedFrom: null,
          }),
          expect.objectContaining({ pageUrl: 'https://eagle.example.com/board', importedFrom: 'eagle' }),
        ]),
      );
      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith(
        'AssetCreate',
        expect.objectContaining({
          asset: expect.objectContaining({ ownerId: target.id, libraryScope: LibraryScope.Design }),
        }),
      );
    } finally {
      await source.close();
    }
    const linkOnly = await repo.createExport(
      {
        ownerId: owner.id,
        origin: 'export',
        name: 'Links',
        format: 'directory',
        includeLocked: false,
        includeMetadata: true,
        scope: {},
      },
      (id) => join(folder, 'package', id),
      { assetIds: [], bookmarkIds: [bookmark.id] },
      false,
      100,
    );
    expect(linkOnly).toMatchObject({ items: 0, bookmarkItems: 1 });
    await db.updateTable('bookmark').set({ isLocked: true }).where('id', '=', bookmark.id).execute();
    expect(await repo.lockedBookmarkPackageIds([linkOnly!.package.id])).toEqual(new Set([linkOnly!.package.id]));
    await db.updateTable('bookmark').set({ isLocked: false }).where('id', '=', bookmark.id).execute();
    await worker['publishPackage'](linkOnly!.package, commit);
    const linkSource = await files.openPackage('directory', linkOnly!.package.path);
    try {
      const manifest = PreservationManifestSchema.parse(
        JSON.parse((await readFile(join(linkOnly!.package.path, 'manifest.json'))).toString()),
      );
      expect(manifest.counts).toMatchObject({ selected: 0, exported: 0, bookmarks: 1 });
      const albums = PreservationAlbumsSchema.parse(
        JSON.parse((await readFile(join(linkOnly!.package.path, 'albums.json'))).toString()),
      );
      const tags = PreservationTagsSchema.parse(
        JSON.parse((await readFile(join(linkOnly!.package.path, 'tags.json'))).toString()),
      );
      const links = await worker['readBookmarks'](linkSource, manifest, albums, tags);
      expect(links).toEqual([expect.objectContaining({ id: bookmark.id, previewAssetId: null })]);
    } finally {
      await linkSource.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

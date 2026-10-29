import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { AlbumKind, LibraryScope } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { DownloadService } from 'src/services/download.service.js';
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

it('exports owned nested memberships and safe bookmarks, with source metadata only when selected', async () => {
  const ctx = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }).ctx;
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
  const { album: root } = await ctx.newAlbum({
    ownerId: user.id,
    albumName: 'Client',
    kind: AlbumKind.Collection,
    libraryScope: LibraryScope.Design,
  });
  const { album: child } = await ctx.newAlbum(
    { ownerId: user.id, albumName: 'Packaging', parentId: root.id, libraryScope: LibraryScope.Design },
    [asset.id],
  );
  const { tag } = await ctx.newTag({ userId: user.id, value: 'Green' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
  const bookmark = await new BookmarkRepository(db).create(user.id, {
    url: 'https://example.com/watch?v=123',
    title: 'Reference',
    note: 'My note',
    libraryScope: LibraryScope.Design,
  });
  await db.insertInto('album_bookmark').values({ albumId: child.id, bookmarkId: bookmark.id }).execute();
  await db
    .insertInto('asset_source')
    .values({
      assetId: asset.id,
      captureId: randomUUID(),
      pageUrl: 'https://example.com/reference?token=private#fragment',
      title: 'Source',
      capturedAt: new Date(),
      note: 'Private source note',
    })
    .execute();
  const repo = new DownloadRepository(db);
  const files = [{ id: asset.id, file: 'logo.png' }];
  const plain = await repo.getLibraryManifest({ user }, files, [bookmark.id], false);
  expect(plain.assets[0]).toMatchObject({ id: asset.id, file: 'logo.png', albumIds: [child.id], tagIds: [tag.id] });
  expect(plain.assets[0]).not.toHaveProperty('sources');
  expect(plain.albums).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: child.id, parentId: root.id }),
      expect.objectContaining({ id: root.id, parentId: null }),
    ]),
  );
  expect(plain.bookmarks[0]).toMatchObject({
    url: 'https://example.com/watch?v=123',
    note: 'My note',
    albumIds: [child.id],
  });
  const full = await repo.getLibraryManifest({ user }, files, [bookmark.id], true);
  expect(full.assets[0].sources).toEqual([
    expect.objectContaining({ pageUrl: 'https://example.com/reference', note: 'Private source note' }),
  ]);
  const serialized = JSON.stringify(full);
  expect(serialized).not.toContain(asset.originalPath);
  expect(serialized).not.toContain('token=');
  expect(serialized).not.toContain('ownerId');
  const other = await ctx.newUser();
  await expect(repo.getLibraryManifest(other, files, [], true)).rejects.toThrow();
  await expect(repo.getLibraryManifest(other, [], [bookmark.id], true)).rejects.toThrow();
  await db
    .insertInto('asset_exif')
    .values({ assetId: asset.id, description: 'x'.repeat(20_001) })
    .onConflict((oc) => oc.column('assetId').doUpdateSet({ description: 'x'.repeat(20_001) }))
    .execute();
  await expect(repo.getLibraryManifest({ user }, files, [], false)).rejects.toThrow(BadRequestException);
});

it('streams unchanged originals and their portable mapping in a real ZIP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-pro-export-'));
  try {
    const { sut, ctx } = newMediumService(DownloadService, {
      database: db,
      real: [AccessRepository, AssetRepository, DownloadRepository, UserRepository, StorageRepository],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const original = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#698369"/></svg>',
    );
    const path = join(root, 'logo.svg');
    await writeFile(path, original);
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalPath: path,
      originalFileName: 'logo.svg',
      checksum: createHash('sha1').update(original).digest(),
      libraryScope: LibraryScope.Design,
    });
    const exported = await sut.downloadArchive(factory.auth({ user: { id: user.id } }), {
      assetIds: [asset.id],
      includeLibraryMetadata: true,
      includeSidecar: false,
    });
    const archive = join(root, 'export.zip');
    await writeFile(archive, await buffer(exported.stream));
    expect(execFileSync('unzip', ['-p', archive, 'logo.svg'])).toEqual(original);
    const manifest = JSON.parse(execFileSync('unzip', ['-p', archive, 'frameleaf-library.json'], { encoding: 'utf8' }));
    expect(manifest.assets[0]).toMatchObject({
      id: asset.id,
      file: 'logo.svg',
      libraryScope: LibraryScope.Design,
      checksum: { algorithm: 'sha1', value: createHash('sha1').update(original).digest('hex') },
    });
    expect(JSON.stringify(manifest)).not.toContain(root);
    const bookmark = await new BookmarkRepository(db).create(user.id, {
      url: 'https://example.com/inspiration',
      title: 'Reference',
      libraryScope: LibraryScope.Design,
    });
    const links = await sut.downloadArchive(factory.auth({ user: { id: user.id } }), {
      assetIds: [],
      bookmarkIds: [bookmark.id],
      includeLibraryMetadata: true,
      includeSidecar: false,
    });
    const linksArchive = join(root, 'links.zip');
    await writeFile(linksArchive, await buffer(links.stream));
    const linksManifest = JSON.parse(
      execFileSync('unzip', ['-p', linksArchive, 'frameleaf-library.json'], { encoding: 'utf8' }),
    );
    expect(linksManifest.assets).toEqual([]);
    expect(linksManifest.bookmarks).toEqual([expect.objectContaining({ id: bookmark.id, url: bookmark.url })]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

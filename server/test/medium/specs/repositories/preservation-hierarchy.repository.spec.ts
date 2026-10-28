import { Kysely } from 'kysely';
import { AlbumKind, LibraryScope } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PreservationRepository } from 'src/repositories/preservation.repository.js';
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

it('exports all owned ancestors of copied media without unrelated or foreign albums', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const { album: root } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Collection });
  const { album: middle } = await ctx.newAlbum({ ownerId: user.id, parentId: root.id });
  const { album: leaf } = await ctx.newAlbum({ ownerId: user.id, parentId: middle.id }, [asset.id]);
  const { album: unrelated } = await ctx.newAlbum({ ownerId: user.id });
  const { album: foreign } = await ctx.newAlbum({ ownerId: other.id }, [asset.id]);
  const sut = new PreservationRepository(db);
  const created = await sut.createExport(
    {
      ownerId: user.id,
      origin: 'export',
      name: 'Nested',
      format: 'directory',
      includeLocked: false,
      includeMetadata: true,
      scope: { description: 'Selection' },
    },
    (id) => `/synthetic/${id}`,
    { assetIds: [asset.id] },
    false,
    100,
  );
  await db
    .updateTable('preservation_item')
    .set({ state: 'copied' })
    .where('packageId', '=', created!.package.id)
    .execute();
  const albums = await sut.getPackageAlbums(created!.package.id, user.id);
  expect(albums.map(({ id }) => id).sort()).toEqual([root.id, middle.id, leaf.id].sort());
  expect(albums).toContainEqual(expect.objectContaining({ id: leaf.id, parentId: middle.id }));
  expect(albums).toContainEqual(expect.objectContaining({ id: middle.id, parentId: root.id }));
  expect(albums.map(({ id }) => id)).not.toContain(unrelated.id);
  expect(albums.map(({ id }) => id)).not.toContain(foreign.id);
});

it('restores source attribution idempotently and refuses foreign originals', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
  const sut = new PreservationRepository(db);
  const source = {
    captureId: '11111111-1111-4111-8111-111111111111',
    pageUrl: 'https://example.com/reference',
    title: 'Inspiration',
    note: 'My note',
    capturedAt: '2026-01-01T00:00:00.000Z',
  };
  await sut.appendRestoredSources(user.id, asset.id, [source]);
  await sut.appendRestoredSources(user.id, asset.id, [source]);
  expect(await sut.getAssetSources(asset.id, user.id)).toEqual([
    expect.objectContaining({ assetId: asset.id, pageUrl: source.pageUrl, note: source.note }),
  ]);
  expect(await sut.getAssetSources(asset.id, other.id)).toEqual([]);
  await expect(sut.appendRestoredSources(other.id, asset.id, [source])).rejects.toThrow('unavailable');
  const saved = (await sut.getAssetSources(asset.id, user.id))[0];
  await sut.appendRestoredSources(user.id, asset.id, [{ ...source, captureId: saved.captureId }]);
  expect(await sut.getAssetSources(asset.id, user.id)).toHaveLength(1);
});

it('preserves every workspace for whole-library or explicit-id selections and honors a scoped filter', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset: personal } = await ctx.newAsset({ ownerId: user.id });
  const { asset: design } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
  const { asset: both } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Both });
  const sut = new PreservationRepository(db);
  expect((await sut.previewSelection(user.id, { filter: {} })).items).toBe(3);
  expect((await sut.previewSelection(user.id, { assetIds: [design.id] })).items).toBe(1);
  expect((await sut.previewSelection(user.id, { filter: { libraryScope: LibraryScope.Design } })).items).toBe(2);
  const created = await sut.createExport(
    {
      ownerId: user.id,
      origin: 'export',
      name: 'All work',
      format: 'directory',
      includeLocked: false,
      includeMetadata: true,
      scope: { description: 'All work' },
    },
    (id) => `/synthetic/${id}`,
    { filter: {} },
    false,
    100,
  );
  const items = await db
    .selectFrom('preservation_item')
    .select('assetId')
    .where('packageId', '=', created!.package.id)
    .execute();
  expect(items).toHaveLength(3);
  expect(items.map((item) => item.assetId)).toEqual(expect.arrayContaining([personal.id, design.id, both.id]));
});

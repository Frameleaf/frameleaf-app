import { Kysely } from 'kysely';
import { AlbumKind } from 'src/enum.js';
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

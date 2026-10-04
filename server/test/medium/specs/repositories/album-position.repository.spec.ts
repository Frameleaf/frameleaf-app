import { Kysely } from 'kysely';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-52: the fork-owned custom album order. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(AlbumRepository) };
};

it('installs feature tables in the real canonical baseline', async () => {
  await expectCanonicalTables(db, ['album_position']);
});

it('saves one person’s order per group and replaces it when the group is arranged again', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const { album: a } = await ctx.newAlbum({ ownerId: user.id });
  const { album: b } = await ctx.newAlbum({ ownerId: user.id });
  const { album: c } = await ctx.newAlbum({ ownerId: user.id });

  await sut.setPositions(user.id, [c.id, a.id, b.id]);
  await expect(sut.getPositions(user.id)).resolves.toEqual(
    new Map([
      [c.id, 0],
      [a.id, 1],
      [b.id, 2],
    ]),
  );

  await sut.setPositions(user.id, [a.id, c.id]);
  const positions = await sut.getPositions(user.id);
  expect(positions.get(a.id)).toBe(0);
  expect(positions.get(c.id)).toBe(1);

  // Somebody else's directory is untouched.
  await expect(sut.getPositions(other.id)).resolves.toEqual(new Map());
});

it('forgets positions when an album or its owner is deleted (FL-52)', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { user: viewer } = await ctx.newUser();
  const { album: kept } = await ctx.newAlbum({ ownerId: user.id });
  const { album: gone } = await ctx.newAlbum({ ownerId: user.id });
  await sut.setPositions(user.id, [gone.id, kept.id]);
  await sut.setPositions(viewer.id, [gone.id, kept.id]);

  await sut.delete(gone.id);

  await expect(sut.getPositions(user.id)).resolves.toEqual(new Map([[kept.id, 1]]));
  await expect(sut.getPositions(viewer.id)).resolves.toEqual(new Map([[kept.id, 1]]));

  // Deleting the owner's albums with the account also drops the owner's own order rows.
  await sut.deleteAll(user.id);
  await expect(sut.getPositions(user.id)).resolves.toEqual(new Map());
  await expect(sut.getPositions(viewer.id)).resolves.toEqual(new Map());
});

it('deletes an album and its canonical position row', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  await sut.setPositions(user.id, [album.id]);
  await expect(sut.delete(album.id)).resolves.toBeUndefined();
});

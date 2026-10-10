import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres from 'postgres';
import { AlbumUserRole } from 'src/enum.js';
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

it('creates album membership without a cached custom enum-array serializer', async () => {
  const { ctx } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: viewer } = await ctx.newUser();
  const { user: editor } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.id });
  const { rows } = await sql<{ name: string }>`select current_database() as name`.execute(db);
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = `/${rows[0].name}`;
  const client = postgres(url.href, { max: 1 });
  const fallbackDb = new Kysely<DB>({ dialect: new PostgresJSDialect({ postgres: client }) });
  try {
    // Initialize built-in and custom array types, then reproduce only the missing enum serializer.
    const [type] = await client<{ oid: number }[]>`select 'album_user_role_enum[]'::regtype::oid as oid`;
    expect(client.options.serializers[type.oid]).toBeTypeOf('function');
    delete client.options.serializers[type.oid];
    expect(client.options.serializers[type.oid]).toBeUndefined();

    const users = [
      { userId: owner.id, role: AlbumUserRole.Owner },
      { userId: viewer.id, role: AlbumUserRole.Viewer },
      { userId: editor.id, role: AlbumUserRole.Editor },
    ];
    const album = await new AlbumRepository(fallbackDb).create(
      { albumName: 'Uncached enum array' },
      [asset.id],
      users,
      owner.id,
    );
    const membership = await db
      .selectFrom('album_user')
      .select(['userId', 'role'])
      .where('albumId', '=', album.id)
      .execute();
    expect(membership).toHaveLength(3);
    expect(membership).toEqual(expect.arrayContaining(users));
    await expect(
      db.selectFrom('album_asset').select('assetId').where('albumId', '=', album.id).execute(),
    ).resolves.toEqual([{ assetId: asset.id }]);
  } finally {
    await fallbackDb.destroy();
  }
});

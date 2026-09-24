import { Kysely, sql } from 'kysely';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as migration from 'src/fork-schema/migrations/0000000000150-AlbumPositions.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-52: the fork-owned custom album order. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
  await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(AlbumRepository) };
};

const isAlbumPosition = (entry: { identity: string }) => entry.identity.startsWith('immich_fork.album_position');

it('matches the private catalog and rolls back without modifying the official catalog', async () => {
  const before = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
    expect(before[kind].filter((entry) => isAlbumPosition(entry))).toEqual(
      manifest[kind].filter((entry) => isAlbumPosition(entry)),
    );
  }
  await migration.down(db);
  await migration.up(db);
  const after = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
    expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
      before[kind].filter((entry) => entry.identity.startsWith('public.')),
    );
  }
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

it('refuses to write while the fork schema is not writable', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  await sql`UPDATE immich_fork.state SET phase='failed' WHERE id=1`.execute(db);
  try {
    await expect(sut.setPositions(user.id, [album.id])).rejects.toThrow(
      'Album order is unavailable during database handoff',
    );
  } finally {
    await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
  }
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

it('never blocks an album delete while the fork schema is not writable', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  await sut.setPositions(user.id, [album.id]);
  await sql`UPDATE immich_fork.state SET phase='failed' WHERE id=1`.execute(db);
  try {
    await expect(sut.delete(album.id)).resolves.toBeUndefined();
  } finally {
    await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
  }
});

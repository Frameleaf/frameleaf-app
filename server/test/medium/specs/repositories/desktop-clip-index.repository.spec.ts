import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import { AssetType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const spaces = JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-spaces.json'), 'utf8')).spaces;
const space = spaces[0];
const vector = JSON.stringify(Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)));
let db: Kysely<DB>;
let repository: DesktopClipIndexRepository;
let assetId: string;
let frameId: string;
beforeEach(async () => {
  db = await getKyselyDB();
  for (const table of [
    'smart_search',
    'smart_search_description',
    'asset_video_duplicate_frame',
    'video_moment_frame_embedding',
  ])
    await sql`ALTER TABLE ${sql.table(table)} ALTER COLUMN embedding TYPE vector(768)`.execute(db);
  repository = new DesktopClipIndexRepository(db);
  const user = await mediumFactory.userWithClusterGroup(db);
  await new UserRepository(db).create(user);
  const asset = mediumFactory.assetInsert({ ownerId: user.id, type: AssetType.Video });
  await new AssetRepository(db).create(asset);
  assetId = asset.id!;
  const frame = await db
    .insertInto('video_moment_frame')
    .values({ assetId, frameIndex: 0, timestampMs: 0, path: '/synthetic/frame.jpg', score: 1, rank: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  frameId = frame.id;
});
afterEach(async () => {
  await db?.destroy();
});
const write = (table: string, key: string | null, target: Kysely<DB> = db) => {
  if (table === 'video_moment_frame_embedding')
    return sql`INSERT INTO video_moment_frame_embedding ("frameId", embedding, "modelName", "producerModelKey") VALUES (${frameId}::uuid, ${vector}::vector, 'ViT-B-16-SigLIP-384__webli', ${key})`.execute(
      target,
    );
  if (table === 'asset_video_duplicate_frame')
    return sql`INSERT INTO asset_video_duplicate_frame ("assetId", "frameIndex", "timestampMs", path, embedding, "producerModelKey") VALUES (${assetId}::uuid, 0, 0, '/synthetic/duplicate.jpg', ${vector}::vector, ${key})`.execute(
      target,
    );
  return sql`INSERT INTO ${sql.table(table)} ("assetId", embedding, "producerModelKey") VALUES (${assetId}::uuid, ${vector}::vector, ${key})`.execute(
    target,
  );
};

it('admits an empty exact space once and fences incompatible or forged writes in all four stores', async () => {
  const active = await repository.admit(space.spaceKey);
  expect(active.revisionId).toMatch(/^[a-f0-9-]{36}$/);
  expect((await repository.admit(space.spaceKey)).revisionId).toBe(active.revisionId);
  await expect(repository.admit(spaces[1].spaceKey)).rejects.toThrow('desktop_clip_index_changed');
  for (const table of [
    'smart_search',
    'smart_search_description',
    'asset_video_duplicate_frame',
    'video_moment_frame_embedding',
  ]) {
    await expect(write(table, null)).rejects.toThrow();
    await expect(write(table, spaces[1].visualModelKey)).rejects.toThrow();
    await expect(
      write(table, table === 'smart_search_description' ? space.visualModelKey : space.textModelKeys[0]),
    ).rejects.toThrow();
    const key = table === 'smart_search_description' ? space.textModelKeys[0] : space.visualModelKey;
    await write(table, key);
    const { rows } = await sql<{
      marker: string;
    }>`SELECT "producerAdmissionKey" AS marker FROM ${sql.table(table)}`.execute(db);
    expect(rows).toEqual([{ marker: `${table === 'smart_search_description' ? 'text' : 'image'}:${key}` }]);
  }
  await expect(
    sql`UPDATE smart_search SET "producerModelKey" = NULL, "producerAdmissionKey" = ${`image:${space.visualModelKey}`}`.execute(
      db,
    ),
  ).rejects.toThrow();
  await repository.assertCurrent(active);
  await expect(repository.assertCurrent({ ...active, revisionId: randomUUID() })).rejects.toThrow(
    'desktop_clip_index_changed',
  );
});
it('preserves unknown legacy vectors and ordinary writes when admission is refused', async () => {
  await write('smart_search', null);
  await expect(repository.admit(space.spaceKey)).rejects.toThrow('desktop_clip_index_incompatible');
  expect(await repository.getActive()).toBeUndefined();
  expect(await db.selectFrom('smart_search').select(['embedding', 'producerModelKey']).execute()).toEqual([
    { embedding: vector, producerModelKey: null },
  ]);
  await write('smart_search_description', null);
});
it('adopts fully known paired vectors without rewriting them', async () => {
  await write('smart_search', space.visualModelKey);
  await write('smart_search_description', space.textModelKeys[0]);
  const before = await db.selectFrom('smart_search').selectAll().execute();
  await repository.admit(space.spaceKey);
  expect(await db.selectFrom('smart_search').selectAll().execute()).toEqual(before);
});
it('rejects stale repeatable-read legacy publication after admission has committed', async () => {
  const waiting = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const writer = db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (tx) => {
      await sql`SELECT * FROM desktop_clip_index`.execute(tx);
      ready.resolve();
      await waiting.promise;
      await write('smart_search', null, tx);
    });
  await ready.promise;
  try {
    await repository.admit(space.spaceKey);
  } finally {
    waiting.resolve();
  }
  await expect(writer).rejects.toThrow();
  expect(await db.selectFrom('smart_search').selectAll().execute()).toEqual([]);
});
it('refuses unknown spaces, dimension mismatches and tampered active membership', async () => {
  await expect(repository.admit(`clip-space:${'0'.repeat(64)}`)).rejects.toThrow('desktop_clip_space_unavailable');
  await sql`ALTER TABLE smart_search ALTER COLUMN embedding TYPE vector(512)`.execute(db);
  await expect(repository.admit(space.spaceKey)).rejects.toThrow('desktop_clip_index_dimensions');
  await sql`ALTER TABLE smart_search ALTER COLUMN embedding TYPE vector(768)`.execute(db);
  await repository.admit(space.spaceKey);
  await sql`UPDATE desktop_clip_index SET space = ${spaces[1]}::jsonb WHERE scope = 'clip'`.execute(db);
  await expect(repository.getActive()).rejects.toThrow('desktop_clip_index_invalid');
});

it('refuses a different known producer without relabelling or deleting its vectors', async () => {
  await write('smart_search', spaces[1].visualModelKey);
  const before = await db.selectFrom('smart_search').selectAll().execute();
  await expect(repository.admit(space.spaceKey)).rejects.toThrow('desktop_clip_index_incompatible');
  expect(await db.selectFrom('smart_search').selectAll().execute()).toEqual(before);
  expect(await repository.getActive()).toBeUndefined();
});
it('fences an admitted binding after physical vector dimensions change', async () => {
  const active = await repository.admit(space.spaceKey);
  await sql`ALTER TABLE smart_search ALTER COLUMN embedding TYPE vector(512)`.execute(db);
  await expect(repository.assertCurrent(active)).rejects.toThrow('desktop_clip_index_invalid');
});

it('preserves existing vectors and timestamps through an unadmitted downgrade and upgrade', async () => {
  const { up, down } = await import('src/schema/migrations/2100000002979-DesktopClipIndex.js');
  await db.transaction().execute((tx) => down(tx));
  const stores = [
    'smart_search',
    'smart_search_description',
    'asset_video_duplicate_frame',
    'video_moment_frame_embedding',
  ];
  for (const table of stores)
    await write(table, table === 'smart_search_description' ? space.textModelKeys[0] : space.visualModelKey);
  const before = await Promise.all(
    stores.map(async (table) => (await sql`SELECT * FROM ${sql.table(table)}`.execute(db)).rows),
  );
  await db.transaction().execute((tx) => up(tx));
  for (const [i, table] of stores.entries()) {
    const { rows } = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(db);
    expect(rows.map(({ producerAdmissionKey: _key, ...row }) => row)).toEqual(before[i]);
    expect(rows[0].producerAdmissionKey).toBe(
      `${table === 'smart_search_description' ? 'text' : 'image'}:${table === 'smart_search_description' ? space.textModelKeys[0] : space.visualModelKey}`,
    );
  }
  expect(await repository.getActive()).toBeUndefined();
});
it('refuses to discard an admitted index during downgrade', async () => {
  const { down } = await import('src/schema/migrations/2100000002979-DesktopClipIndex.js');
  const active = await repository.admit(space.spaceKey);
  await expect(db.transaction().execute((tx) => down(tx))).rejects.toThrow('Cannot discard an admitted CLIP index');
  expect(await repository.getActive()).toEqual(active);
});

it('refuses destructive dimension changes and index clearing after admission', async () => {
  await repository.admit(space.spaceKey);
  await write('smart_search', space.visualModelKey);
  const database = new DatabaseRepository(db, LoggingRepository.create(), undefined as never);
  await expect(database.setDimensionSize(512)).rejects.toThrow('desktop_clip_index_admitted');
  await expect(database.deleteAllSearchEmbeddings()).rejects.toThrow('desktop_clip_index_admitted');
  expect(await db.selectFrom('smart_search').select('embedding').execute()).toEqual([{ embedding: vector }]);
  await repository.getActive();
});

it('retains explicit legacy reset behavior while the index is unadmitted', async () => {
  await write('smart_search', null);
  const database = new DatabaseRepository(db, LoggingRepository.create(), undefined as never);
  await database.deleteAllSearchEmbeddings();
  expect(await db.selectFrom('smart_search').selectAll().execute()).toEqual([]);
  await database.setDimensionSize(512);
  expect(await database.getDimensionSize('smart_search')).toBe(512);
  expect(await repository.getActive()).toBeUndefined();
});

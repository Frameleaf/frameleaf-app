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
const profiles: { modelKey: string; modelName: string; embeddingDimensions?: number }[] = JSON.parse(
  readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8'),
).profiles;
const modelOf = (item: { visualModelKey: string }) => profiles.find((p) => p.modelKey === item.visualModelKey)!;
/** The same model under another desktop runtime revision: other keys, the same embedding space. */
const sibling = spaces.find(
  (item: typeof space) => item.spaceKey !== space.spaceKey && modelOf(item).modelName === modelOf(space).modelName,
);
/** Another model altogether. */
const foreign = spaces.find((item: typeof space) => modelOf(item).embeddingDimensions === 512);
const vector = JSON.stringify(Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)));
let db: Kysely<DB>;
let repository: DesktopClipIndexRepository;
let assetId: string;
let frameId: string;
beforeEach(async () => {
  db = await getKyselyDB();
  for (const table of ['smart_search', 'smart_search_description', 'video_moment_frame_embedding'])
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
  return sql`INSERT INTO ${sql.table(table)} ("assetId", embedding, "producerModelKey") VALUES (${assetId}::uuid, ${vector}::vector, ${key})`.execute(
    target,
  );
};

it('admits an empty space once and fences writes of any other model, or the wrong encoder, in all three stores', async () => {
  const active = await repository.admit(space.spaceKey);
  expect(active.revisionId).toMatch(/^[a-f0-9-]{36}$/);
  expect((await repository.admit(space.spaceKey)).revisionId).toBe(active.revisionId);
  await expect(repository.admit(foreign.spaceKey)).rejects.toThrow('desktop_clip_index_changed');
  for (const table of ['smart_search', 'smart_search_description', 'video_moment_frame_embedding']) {
    await expect(write(table, foreign.visualModelKey)).rejects.toThrow();
    await expect(write(table, `clip:${'0'.repeat(64)}`)).rejects.toThrow();
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
  // a forged marker never sticks: the store names the producer from the vector's own key
  await sql`UPDATE smart_search SET "producerModelKey" = NULL, "producerAdmissionKey" = ${`image:${space.visualModelKey}`}`.execute(
    db,
  );
  expect(await db.selectFrom('smart_search').select('producerAdmissionKey').execute()).toEqual([
    { producerAdmissionKey: 'legacy' },
  ]);
  await repository.assertCurrent(active);
  await expect(repository.assertCurrent({ ...active, revisionId: randomUUID() })).rejects.toThrow(
    'desktop_clip_index_changed',
  );
});
it('keeps the vectors this server already made when a desktop is first granted smart search', async () => {
  await write('smart_search', null);
  const before = await db.selectFrom('smart_search').select(['embedding', 'producerModelKey']).execute();
  const active = await repository.admit(space.spaceKey);
  expect(await repository.getActive()).toEqual(active);
  expect(await db.selectFrom('smart_search').select(['embedding', 'producerModelKey']).execute()).toEqual(before);
  expect(before).toEqual([{ embedding: vector, producerModelKey: null }]);
  // this server's own AI still writes beside the desktops
  await write('smart_search_description', null);
  await write('video_moment_frame_embedding', space.visualModelKey);
});
it('shares the index between desktop runtime revisions of the same model', async () => {
  const active = await repository.admit(space.spaceKey);
  // a second desktop on another runtime revision: its keys differ, its vectors do not
  expect((await repository.admit(sibling.spaceKey)).revisionId).toBe(active.revisionId);
  await write('smart_search', sibling.visualModelKey);
  await write('smart_search_description', sibling.textModelKeys[0]);
  await write('video_moment_frame_embedding', space.visualModelKey);
  await repository.assertCurrent(active);
  expect(await repository.modelName()).toBe(modelOf(space).modelName);
});
it('lets an index admitted by an earlier release take the other revisions once one is granted', async () => {
  const active = await repository.admit(space.spaceKey);
  // as an earlier release left it: only the first desktop's three encoders, and no place for this server's own
  await sql`DELETE FROM desktop_clip_producer WHERE key NOT IN (${`image:${space.visualModelKey}`},
    ${sql.join(space.textModelKeys.map((key: string) => `text:${key}`))})`.execute(db);
  expect(await repository.getActive()).toEqual(active);
  await expect(write('smart_search', sibling.visualModelKey)).rejects.toThrow();
  expect((await repository.admit(sibling.spaceKey)).revisionId).toBe(active.revisionId);
  await write('smart_search', sibling.visualModelKey);
});
it('adopts fully known paired vectors without rewriting them', async () => {
  await write('smart_search', space.visualModelKey);
  await write('smart_search_description', space.textModelKeys[0]);
  const before = await db.selectFrom('smart_search').selectAll().execute();
  await repository.admit(space.spaceKey);
  expect(await db.selectFrom('smart_search').selectAll().execute()).toEqual(before);
});
it('refuses unknown spaces, dimension mismatches and tampered active membership', async () => {
  await expect(repository.admit(`clip-space:${'0'.repeat(64)}`)).rejects.toThrow('desktop_clip_space_unavailable');
  await sql`ALTER TABLE smart_search ALTER COLUMN embedding TYPE vector(512)`.execute(db);
  await expect(repository.admit(space.spaceKey)).rejects.toThrow('desktop_clip_index_dimensions');
  await sql`ALTER TABLE smart_search ALTER COLUMN embedding TYPE vector(768)`.execute(db);
  await repository.admit(space.spaceKey);
  await sql`UPDATE desktop_clip_index SET space = ${foreign}::jsonb WHERE scope = 'clip'`.execute(db);
  await expect(repository.getActive()).rejects.toThrow('desktop_clip_index_invalid');
});

it('refuses a different known producer without relabelling or deleting its vectors', async () => {
  await write('smart_search', foreign.visualModelKey);
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

it('empties the vectors and returns the index to unadmitted when the search model changes', async () => {
  const database = new DatabaseRepository(db, LoggingRepository.create(), undefined as never);
  const first = await repository.admit(space.spaceKey);
  await write('smart_search', space.visualModelKey);
  await write('smart_search_description', null);
  // a model of the same size: the vectors go, as they do without desktops, and the index with them
  await database.deleteAllSearchEmbeddings();
  expect(await db.selectFrom('smart_search').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('smart_search_description').selectAll().execute()).toEqual([]);
  expect(await repository.getActive()).toBeUndefined();
  await expect(repository.assertCurrent(first)).rejects.toThrow('desktop_clip_index_changed');
  // this server's own AI embeds again under the new model, and the first desktop granted it admits its space
  await write('smart_search', null);
  const second = await repository.admit(sibling.spaceKey);
  expect(second.revisionId).not.toBe(first.revisionId);
  // a model of another size: the same, with the columns resized for it
  await database.setDimensionSize(512);
  expect(await database.getDimensionSize('smart_search')).toBe(512);
  expect(await db.selectFrom('smart_search').selectAll().execute()).toEqual([]);
  expect(await repository.getActive()).toBeUndefined();
  const third = await repository.admit(foreign.spaceKey);
  expect(third.space.spaceKey).toBe(foreign.spaceKey);
  expect(await repository.modelName()).toBe(modelOf(foreign).modelName);
  expect(await db.selectFrom('desktop_clip_index').select('scope').execute()).toEqual([{ scope: 'clip' }]);
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

it('refuses publication prepared before admission without running its writes', async () => {
  const read = await repository.captureRead();
  await repository.admit(space.spaceKey);
  const publish = vi.fn().mockResolvedValue(undefined);
  await expect(read.publish(publish)).rejects.toThrow('desktop_clip_index_changed');
  expect(publish).not.toHaveBeenCalled();
});
it('holds the admission fence through a direct publication commit', async () => {
  const read = await repository.captureRead();
  const { promise: ready, resolve: entered } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const publication = read.publish(async () => {
    entered();
    await gate;
  });
  await ready;
  let admitted = false;
  const admission = repository.admit(space.spaceKey).then(() => {
    admitted = true;
  });
  try {
    await vi.waitFor(async () => {
      const { rows } = await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=912741 AND objid=1 AND NOT granted
      ) AS waiting`.execute(db);
      expect(rows[0].waiting).toBe(true);
    });
    expect(admitted).toBe(false);
  } finally {
    release();
  }
  await publication;
  await admission;
  expect(admitted).toBe(true);
});

it('rolls back a direct guarded mutation and joins an existing publication transaction', async () => {
  const { publicationTransaction } = await import('src/queue/transaction.js');
  const read = await repository.captureRead();
  for (const outer of [false, true]) {
    let existing: unknown;
    const publish = () =>
      read.publish(async () => {
        const tx = publicationTransaction.getStore()!;
        expect(tx).toBeDefined();
        if (outer) expect(tx).toBe(existing);
        await sql`UPDATE asset SET "originalFileName"='guard-rollback' WHERE id=${assetId}::uuid`.execute(tx);
        throw new Error('rollback-fixture');
      });
    await expect(
      outer
        ? db.transaction().execute((tx) => {
            existing = tx;
            return publicationTransaction.run(tx, publish);
          })
        : publish(),
    ).rejects.toThrow('rollback-fixture');
    const asset = await db
      .selectFrom('asset')
      .select('originalFileName')
      .where('id', '=', assetId)
      .executeTakeFirstOrThrow();
    expect(asset.originalFileName).not.toBe('guard-rollback');
  }
});
it('refuses a publication transaction whose snapshot can predate admission', async () => {
  const { publicationTransaction } = await import('src/queue/transaction.js');
  const read = await repository.captureRead();
  const write = vi.fn().mockResolvedValue(undefined);
  await expect(
    db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute((tx) => publicationTransaction.run(tx, () => read.publish(write))),
  ).rejects.toThrow('desktop_clip_publication_isolation');
  expect(write).not.toHaveBeenCalled();
});

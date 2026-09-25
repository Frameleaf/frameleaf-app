import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { MemoryShowLessKind, MemoryType } from 'src/enum.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as curationMigration from 'src/fork-schema/migrations/0000000000187-MemoryCuration.js';
import * as showLessMigration from 'src/fork-schema/migrations/0000000000188-MemoryShowLess.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-62: the owner's memory curation and "show less" rules, fork-owned tables. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
  await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
});

const isOurs = (entry: { identity: string }) =>
  entry.identity.startsWith('immich_fork.memory_curation') || entry.identity.startsWith('immich_fork.memory_show_less');

const setup = () =>
  newMediumService(BaseService, { database: db, real: [MemoryRepository], mock: [LoggingRepository] });

it('matches the private catalog and rolls back without modifying the official catalog', async () => {
  const before = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
    expect(before[kind].filter((entry) => isOurs(entry))).toEqual(
      (manifest as unknown as Record<string, Array<{ identity: string }>>)[kind].filter((entry) => isOurs(entry)),
    );
  }
  expect(before.tables.filter((entry) => isOurs(entry))).toHaveLength(2);

  await showLessMigration.down(db);
  await curationMigration.down(db);
  await curationMigration.up(db);
  await showLessMigration.up(db);
  const after = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
    expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
      before[kind].filter((entry) => entry.identity.startsWith('public.')),
    );
  }
});

it('hides, titles and orders a memory for its owner only, and restores it', async () => {
  const { ctx } = setup();
  const sut = ctx.get(MemoryRepository);
  const { user } = await ctx.newUser();
  const { memory } = await ctx.newMemory({ ownerId: user.id, type: MemoryType.OnThisDay, data: { year: 2020 } });
  const [first, second] = [randomUUID(), randomUUID()];

  await sut.setCuration(user.id, memory.id, { hidden: true, title: 'Beach day', assetOrder: [second, first] });
  await expect(sut.getHiddenMemoryIds(user.id)).resolves.toEqual([memory.id]);
  await expect(sut.getHiddenMemoryIds(randomUUID())).resolves.toEqual([]);

  // only the given field changes
  await sut.setCuration(user.id, memory.id, { hidden: false });
  const curations = await sut.getCurations(user.id, [memory.id]);
  expect(curations.get(memory.id)).toEqual(
    expect.objectContaining({ hiddenAt: null, title: 'Beach day', assetOrder: [second, first] }),
  );
  await expect(sut.getCurations(randomUUID(), [memory.id])).resolves.toEqual(new Map());

  // another owner's write never lands on this row
  await sut.setCuration(randomUUID(), memory.id, { title: 'Not yours' });
  expect((await sut.getCurations(user.id, [memory.id])).get(memory.id)?.title).toBe('Beach day');
});

it('leaves hidden memories and shown-less kinds and dates out of a search', async () => {
  const { ctx } = setup();
  const sut = ctx.get(MemoryRepository);
  const { user } = await ctx.newUser();
  const { memory: hidden } = await ctx.newMemory({ ownerId: user.id, memoryAt: new Date('2020-09-25T00:00:00Z') });
  const { memory: birthday } = await ctx.newMemory({
    ownerId: user.id,
    type: MemoryType.Birthday,
    memoryAt: new Date('2026-03-01T00:00:00Z'),
  });
  const { memory: kept } = await ctx.newMemory({ ownerId: user.id, memoryAt: new Date('2020-01-01T00:00:00Z') });

  const ids = async (options: Parameters<MemoryRepository['search']>[2]) =>
    (await sut.search(user.id, {}, options)).map(({ id }) => id).toSorted();

  await expect(ids({ excludeIds: [hidden.id], excludeTypes: [MemoryType.Birthday] })).resolves.toEqual([kept.id]);
  await expect(ids({ excludeDates: ['09-25'] })).resolves.toEqual([birthday.id, kept.id].toSorted());
  await expect(ids({ onlyIds: [hidden.id] })).resolves.toEqual([hidden.id]);
  await expect(ids({ onlyIds: [] })).resolves.toEqual([]);
});

it('keeps each owner’s show-less rules, refuses unknown kinds and writes nothing while the fork schema is read-only', async () => {
  const { ctx } = setup();
  const sut = ctx.get(MemoryRepository);
  const ada = randomUUID();

  await sut.addShowLess(ada, MemoryShowLessKind.Date, '09-25');
  await sut.addShowLess(ada, MemoryShowLessKind.Date, '09-25');
  await sut.addShowLess(ada, MemoryShowLessKind.Type, MemoryType.EventStory);
  await expect(sut.getShowLess(ada)).resolves.toEqual([
    expect.objectContaining({ kind: 'date', value: '09-25' }),
    expect.objectContaining({ kind: 'type', value: 'event_story' }),
  ]);
  await expect(sut.getShowLess(randomUUID())).resolves.toEqual([]);

  await sut.removeShowLess(ada, MemoryShowLessKind.Date, '09-25');
  await expect(sut.getShowLess(ada)).resolves.toEqual([expect.objectContaining({ kind: 'type' })]);

  await expect(
    sql`INSERT INTO immich_fork.memory_show_less ("userId", kind, value) VALUES (${ada}::uuid, 'album', 'x')`.execute(
      db,
    ),
  ).rejects.toThrow();

  await sql`UPDATE immich_fork.state SET phase='inactive' WHERE id=1`.execute(db);
  try {
    await expect(sut.addShowLess(ada, MemoryShowLessKind.Date, '01-01')).rejects.toThrow();
  } finally {
    await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
  }
});

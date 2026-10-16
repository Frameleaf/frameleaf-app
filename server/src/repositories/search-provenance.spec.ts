import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import type { CompiledQuery } from 'kysely';
import type { QueueExecution } from 'src/queue/types.js';
import type { DB } from 'src/schema/index.js';
import { queueExecution } from 'src/queue/context.js';
import { SearchRepository } from 'src/repositories/search.repository.js';

const queries: CompiledQuery[] = [];
const db = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
  log(event) {
    if (event.level === 'query') queries.push(event.query);
  },
});
const repository = new SearchRepository(db);
const assetId = 'd621bd72-ad35-4199-95ab-76300756a38e';
const modelKey = `clip:${'a'.repeat(64)}`;
beforeEach(() => {
  queries.length = 0;
});
afterAll(() => db.destroy());

it('publishes the bound producer identity with its vector in the same conflict-safe write', async () => {
  await repository.upsert(assetId, { embedding: '[1,2]', modelKey });
  expect(queries).toHaveLength(1);
  expect(queries[0].parameters).toEqual([assetId, '[1,2]', modelKey]);
  expect(queries[0].sql).toContain('"producerModelKey"');
  expect(queries[0].sql).toContain('"producerModelKey" = "excluded"."producerModelKey"');
});
it('clears old provenance when an unbound producer replaces the vector', async () => {
  await repository.upsert(assetId, '[3,4]');
  expect(queries[0].parameters).toEqual([assetId, '[3,4]', null]);
  expect(queries[0].sql).toContain('"producerModelKey" = "excluded"."producerModelKey"');
});
it('rejects malformed bound output before registering or executing publication', async () => {
  for (const value of [
    { embedding: '[1,2]', modelKey: 'unknown' },
    { embedding: '[1,2]', modelKey, extra: true },
    { embedding: 3, modelKey },
  ])
    await expect(repository.upsert(assetId, value as never)).rejects.toThrow();
  expect(queries).toHaveLength(0);
});
it('captures producer identity with the vector before deferred claim adoption', async () => {
  const context = { signal: new AbortController().signal, adoptions: [] } as unknown as QueueExecution;
  const result = { embedding: '[1,2]', modelKey };
  await queueExecution.run(context, () => repository.upsert(assetId, result));
  expect(queries).toHaveLength(0);
  expect(context.adoptions).toHaveLength(1);
  result.modelKey = `clip:${'b'.repeat(64)}`;
  result.embedding = '[9,9]';
  await context.adoptions[0](db as never);
  expect(queries[0].parameters).toEqual([assetId, '[1,2]', modelKey]);
});

it('publishes and clears description producer identity in the same upsert as its vector', async () => {
  await repository.upsertDescriptionEmbedding(assetId, { embedding: '[1,2]', modelKey });
  expect(queries[0].parameters).toEqual([assetId, '[1,2]', modelKey]);
  expect(queries[0].sql).toContain('"producerModelKey" = "excluded"."producerModelKey"');
  await repository.upsertDescriptionEmbedding(assetId, '[3,4]');
  expect(queries[1].parameters).toEqual([assetId, '[3,4]', null]);
});
it('refuses malformed description producer identity before writing a vector', async () => {
  await expect(
    repository.upsertDescriptionEmbedding(assetId, { embedding: '[1,2]', modelKey: 'unknown' }),
  ).rejects.toThrow();
  expect(queries).toHaveLength(0);
});

import { type Kysely, sql } from 'kysely';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const shadowSmartSearch = (tx: Kysely<DB>) =>
  sql`CREATE TEMP TABLE smart_search ("assetId" uuid PRIMARY KEY, embedding vector(768),
    "producerModelKey" character varying CHECK ("producerModelKey" IS NULL OR "producerModelKey" ~ '^clip:[a-f0-9]{64}$'))
    ON COMMIT DROP`.execute(tx);

it('atomically replaces provenance', async () => {
  await db.transaction().execute(async (tx) => {
    // A transaction-local shadow exercises the real repository without fixture asset ownership.
    await shadowSmartSearch(tx);
    const assetId = 'd621bd72-ad35-4199-95ab-76300756a38e';
    const vector = JSON.stringify(Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)));
    const modelKey = `clip:${'a'.repeat(64)}`;
    await sql`INSERT INTO smart_search VALUES (${assetId}::uuid, ${vector}::vector)`.execute(tx);
    const repository = new SearchRepository(tx);
    expect(await repository.getEmbedding(assetId)).toMatchObject({ embedding: vector, producerModelKey: null });
    await repository.upsert(assetId, { embedding: vector, modelKey });
    expect(await repository.getEmbedding(assetId)).toMatchObject({ embedding: vector, producerModelKey: modelKey });

    await sql`SAVEPOINT publication`.execute(tx);
    await publicationTransaction.run(tx, () => new SearchRepository(db).upsert(assetId, vector));
    expect(await repository.getEmbedding(assetId)).toMatchObject({ producerModelKey: null });
    await sql`ROLLBACK TO SAVEPOINT publication`.execute(tx);
    expect(await repository.getEmbedding(assetId)).toMatchObject({ producerModelKey: modelKey });

    await repository.upsert(assetId, vector);
    expect(await repository.getEmbedding(assetId)).toMatchObject({ embedding: vector, producerModelKey: null });
  });
});

// Opt in only with the owned signed CPU candidate, staged public model and synthetic fixture.
it.skipIf(!process.env.FRAMELEAF_TEST_BOUND_ML_URL)(
  'publishes a real bound model response through the NAS consumer and search repository',
  async () => {
    const catalogue = parseDesktopModelCatalogue(
      JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8')),
    );
    const profile = catalogue.profiles.find((p) => p.workload === 'clip' && p.spec.fixtureKind === 'image')!;
    if (profile.embeddingDimensions === undefined) throw new Error('clip_fixture_required');
    expect(createHash('sha256').update(readFileSync(process.env.FRAMELEAF_TEST_BOUND_ML_FIXTURE!)).digest('hex')).toBe(
      profile.spec.fixtureSha256,
    );
    const ml = new MachineLearningRepository(LoggingRepository.create());
    const result = await ml.encodeBoundClip(
      {
        destinationId: 'synthetic-bound-producer',
        kind: MlDestinationKind.Local,
        workload: MlWorkload.Clip,
        endpoint: {
          url: process.env.FRAMELEAF_TEST_BOUND_ML_URL!,
          authToken: process.env.FRAMELEAF_TEST_BOUND_ML_TOKEN,
        },
        record() {},
      },
      { imagePath: process.env.FRAMELEAF_TEST_BOUND_ML_FIXTURE! },
      profile,
    );
    expect(result.modelKey).toBe(profile.modelKey);
    expect(JSON.parse(result.embedding)).toHaveLength(profile.embeddingDimensions);
    await db.transaction().execute(async (tx) => {
      await shadowSmartSearch(tx);
      const repository = new SearchRepository(tx);
      const assetId = 'd621bd72-ad35-4199-95ab-76300756a38e';
      await repository.upsert(assetId, result);
      const persisted = await repository.getEmbedding(assetId);
      expect(persisted).toMatchObject({ assetId, producerModelKey: result.modelKey });
      // pgvector stores float32; decimal formatting need not reproduce the producer's JSON string.
      expect(JSON.parse(persisted!.embedding).map((value: number) => Math.fround(value))).toEqual(
        JSON.parse(result.embedding).map((value: number) => Math.fround(value)),
      );
    });
  },
  60_000,
);

it('binds description embedding provenance to the published vector', async () => {
  await db.transaction().execute(async (tx) => {
    const assetId = 'd621bd72-ad35-4199-95ab-76300756a38e';
    await sql`CREATE TEMP TABLE smart_search_description ("assetId" uuid PRIMARY KEY, embedding vector(2),
      "producerModelKey" character varying CHECK ("producerModelKey" IS NULL OR "producerModelKey" ~ '^clip:[a-f0-9]{64}$'))
      ON COMMIT DROP`.execute(tx);
    await sql`INSERT INTO smart_search_description VALUES (${assetId}::uuid, '[1,0]')`.execute(tx);
    const repository = new SearchRepository(tx);
    const bound = { embedding: '[0,1]', modelKey: `clip:${'a'.repeat(64)}` };
    const publishing = repository.upsertDescriptionEmbedding(assetId, bound);
    bound.modelKey = `clip:${'b'.repeat(64)}`;
    bound.embedding = '[1,0]';
    await publishing;
    const description = () =>
      tx.selectFrom('smart_search_description').selectAll().where('assetId', '=', assetId).executeTakeFirstOrThrow();
    expect(await description()).toMatchObject({ embedding: '[0,1]', producerModelKey: `clip:${'a'.repeat(64)}` });
    await expect(
      repository.upsertDescriptionEmbedding(assetId, { embedding: '[1,0]', modelKey: 'unknown' }),
    ).rejects.toThrow();
    expect(await description()).toMatchObject({ embedding: '[0,1]', producerModelKey: `clip:${'a'.repeat(64)}` });
    await repository.upsertDescriptionEmbedding(assetId, '[0,1]');
    expect(await description()).toMatchObject({ embedding: '[0,1]', producerModelKey: null });
  });
});

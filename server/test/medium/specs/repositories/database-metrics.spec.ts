import { type Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { QueueName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  await database?.destroy();
});

it('exposes aggregate counts and excludes future or held jobs from waiting', async () => {
  const queue = QueueName.ThumbnailGeneration;
  await sql`insert into job_queue(name) values (${queue}) on conflict do nothing`.execute(database);
  await sql`insert into job (id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", state, "availableAt")
    values (gen_random_uuid(), ${queue}, 'Thumbnail', '{"assetId":"private-asset"}', true, false, 1000, 'pending', now()),
      (gen_random_uuid(), ${queue}, 'Thumbnail', '{}', true, false, 1000, 'pending', now() + interval '1 hour'),
      (gen_random_uuid(), ${queue}, 'Thumbnail', '{}', true, false, 1000, 'waiting', 'infinity'),
      (gen_random_uuid(), ${queue}, 'Thumbnail', '{}', true, false, 1000, 'failed', now())`.execute(database);
  const repository = new DatabaseRepository(database, LoggingRepository.create(), new ConfigRepository());
  expect(await repository.getMetricsQueueCounts()).toContainEqual({
    queue,
    counts: { waiting: 1, active: 0, failed: 1 },
  });
  expect(JSON.stringify(await repository.getMetricsQueueCounts())).not.toContain('private-asset');
  await expect(repository.getMetricsAssetCounts()).resolves.toEqual([]);
});

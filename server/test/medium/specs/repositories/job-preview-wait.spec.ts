import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { QueueExecution } from 'src/queue/types.js';
import { JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getKyselyDB } from 'test/utils.js';

describe('a job waiting for a preview', () => {
  let db: Kysely<any>;
  let jobs: JobRepository;

  beforeAll(async () => {
    db = await getKyselyDB();
    jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("stops waiting once its run's thumbnail item for the asset has ended", async () => {
    const runId = randomUUID();
    const [pending, damaged, skipped, absent] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await sql`INSERT INTO job_queue(name) VALUES (${QueueName.ThumbnailGeneration}) ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO job_run(id,kind,selection) VALUES (${runId}::uuid,'fixture','{}'::jsonb)`.execute(db);
    for (const [itemKey, state] of [
      [pending, 'pending'],
      [damaged, 'failed'],
      [skipped, 'completed'],
    ]) {
      await sql`INSERT INTO job_run_item("runId","itemKey",stage,queue,selection,state)
        VALUES (${runId}::uuid,${itemKey},${JobName.AssetGenerateThumbnails},${QueueName.ThumbnailGeneration},'{}'::jsonb,${state})`.execute(
        db,
      );
    }
    const inRun = (assetId: string) =>
      queueExecution.run({ claim: { runId } } as unknown as QueueExecution, () => jobs.previewMayArrive(assetId));

    await expect(inRun(pending)).resolves.toBe(true);
    await expect(inRun(damaged)).resolves.toBe(false);
    await expect(inRun(skipped)).resolves.toBe(false);
    // Nothing in this run makes that preview, and outside a run nothing is known: keep waiting as before.
    await expect(inRun(absent)).resolves.toBe(true);
    await expect(jobs.previewMayArrive(damaged)).resolves.toBe(true);
  });
});

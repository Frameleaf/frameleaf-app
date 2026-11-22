import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { getLibraryQueueDB } from 'test/medium/library-queue-database.js';

/** A Boards download saves its file from inside the import's own job; it is a new arrival, as an upload is. */
describe('media import upload queue', () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await getLibraryQueueDB();
  });
  afterAll(async () => {
    await db.destroy();
  });

  it('processes a downloaded file ahead of the backlog, while its import is still running', async () => {
    const store = new SqlQueueStore(db);
    const workerId = randomUUID();
    await store.initialize([QueueName.BackgroundTask, QueueName.MetadataExtraction], workerId);
    await store.pause(QueueName.BackgroundTask, false);
    await store.pause(QueueName.MetadataExtraction, false);
    const jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    const handler = () => Promise.resolve(JobStatus.Success);
    jobs['handlers'][JobName.MediaImport] = { queueName: QueueName.BackgroundTask, handler } as never;
    jobs['handlers'][JobName.AssetExtractMetadata] = { queueName: QueueName.MetadataExtraction, handler } as never;

    await store.setConcurrency(QueueName.MetadataExtraction, 1);
    // a library-wide backlog queued before the download
    await jobs.queue({ name: JobName.AssetExtractMetadata, data: { id: randomUUID() } });

    await jobs.createRun('media-import', {}, () =>
      jobs.queue({ name: JobName.MediaImport, data: { id: randomUUID() } }),
    );
    const [claim] = await store.claim(QueueName.BackgroundTask, workerId);
    const context = {
      claim,
      signal: new AbortController().signal,
      progress: () => {},
      progressUnits: 0,
      adoptions: [],
      followups: [],
      buffering: false,
    };
    const assetId = randomUUID();
    await queueExecution.run(context, () =>
      jobs.queueUpload(
        { name: JobName.AssetExtractMetadata, data: { id: assetId, source: 'upload' } },
        { ownerId: randomUUID(), origin: 'client', label: null, count: 1 },
      ),
    );

    const claimed = await store.claim(QueueName.MetadataExtraction, workerId);
    expect(claimed.map(({ data }) => data.id)).toEqual([assetId]);
  });
});

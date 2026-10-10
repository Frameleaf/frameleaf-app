import { Kysely } from 'kysely';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';

// Remain alive after the real snapshot freezes; the supervisor confirms SIGKILL before writing stop proof.
process.on('message', (message: { url: string; queue: string; worker: string; ownerId: string }) => {
  void (async () => {
    const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: message.url }));
    try {
      const store = new SqlQueueStore(db);
      await store.initialize([message.queue], message.worker);
      await store.enqueue([
        {
          queue: message.queue,
          name: 'enumerate-hdr',
          data: {},
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 600_000,
        },
      ]);
      const [claim] = await store.claim(message.queue, message.worker);
      const repository = new JobRepository(
        {} as never,
        {} as never,
        {} as never,
        { setContext: () => {} } as never,
        db,
      );
      repository['handlers'][JobName.AssetGenerateThumbnails] = {
        queueName: message.queue as QueueName,
        jobName: JobName.AssetGenerateThumbnails,
        label: 'HDR backfill fixture',
        handler: () => Promise.resolve(JobStatus.Success),
      };
      await queueExecution.run(
        {
          claim,
          signal: new AbortController().signal,
          progress: () => {},
          progressUnits: 0,
          adoptions: [],
          followups: [],
          buffering: false,
        },
        () =>
          repository.queueSelection(
            JobName.AssetGenerateThumbnails,
            new AssetJobRepository(db)
              .selectionForThumbnailJob({ force: false, fullsizeEnabled: false, hdrBackfill: true })
              .where('asset.ownerId', '=', message.ownerId)
              .where('asset.isEdited', '=', false),
          ),
      );
      process.send?.({ claim });
    } catch {
      // Do not emit database credentials or arbitrary database error text across IPC.
      process.send?.({ error: 'HDR backfill fixture could not freeze the selection' });
      await db.destroy();
      process.exitCode = 1;
      process.disconnect?.();
    }
  })();
});

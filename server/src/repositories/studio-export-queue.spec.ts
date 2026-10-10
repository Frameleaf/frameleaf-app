import { ModuleRef } from '@nestjs/core';
import { Kysely, Transaction } from 'kysely';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { QueueExecution } from 'src/queue/types.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

describe('Studio publication queue admission', () => {
  const setup = () => {
    const repository = new JobRepository(
      {} as ModuleRef,
      {} as ConfigRepository,
      {} as EventRepository,
      { setContext: vi.fn() } as unknown as LoggingRepository,
      {} as Kysely<any>,
    );
    const enqueue = vi.fn().mockResolvedValue(undefined);
    repository['store'].enqueue = enqueue;
    repository['handlers'][JobName.AssetExtractMetadata] = {
      jobName: JobName.AssetExtractMetadata,
      queueName: QueueName.MetadataExtraction,
      handler: vi.fn().mockResolvedValue(JobStatus.Success),
      label: 'metadata',
    } as never;
    return { repository, enqueue };
  };

  it('passes the caller transaction and normal metadata retry policy through to admission', async () => {
    const { repository, enqueue } = setup();
    const tx = { isTransaction: true } as Transaction<any>;
    await repository.queueInTransaction(tx, {
      name: JobName.AssetExtractMetadata,
      data: { id: 'asset', source: 'upload' },
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      [
        expect.objectContaining({
          name: JobName.AssetExtractMetadata,
          data: { id: 'asset', source: 'upload' },
          safeToRetry: true,
        }),
      ],
      tx,
    );
  });

  it('rejects use by queue-owned execution so it cannot bypass atomic parent completion', async () => {
    const { repository, enqueue } = setup();
    await expect(
      queueExecution.run({} as QueueExecution, () =>
        repository.queueInTransaction({} as Transaction<any>, {
          name: JobName.AssetExtractMetadata,
          data: { id: 'asset' },
        }),
      ),
    ).rejects.toThrow('completion transaction');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

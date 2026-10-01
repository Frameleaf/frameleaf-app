import { getQueueToken } from '@nestjs/bullmq';
import { ModuleRef } from '@nestjs/core';
import { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { JobName, QueueName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/**
 * FL-291: a server stop against a real BullMQ and Valkey. A job still running when the grace period
 * ends goes back to waiting at once, a short job finishes first, and the next worker picks a handed
 * back job up without waiting for the stalled-job check (30 s, twice).
 */
describe('JobRepository graceful stop (FL-291)', () => {
  let valkey: StartedTestContainer;
  let connection: { host: string; port: number };
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    valkey = await new GenericContainer('docker.io/valkey/valkey:9')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    connection = { host: valkey.getHost(), port: valkey.getMappedPort(6379) };
  }, 120_000);

  afterEach(async () => {
    const pending = cleanups.toReversed();
    cleanups.length = 0;
    for (const cleanup of pending) {
      await cleanup().catch(() => {});
    }
  });

  afterAll(async () => {
    await valkey?.stop();
  });

  /** One microservices process: a JobRepository with its workers started, and its queues. */
  const boot = (prefix: string, run: (job: Job) => Promise<void>) => {
    const queues = new Map<string, Queue>();
    const queue = (name: QueueName) => {
      const token = getQueueToken(name);
      let found = queues.get(token);
      if (!found) {
        found = new Queue(name, { prefix, connection });
        queues.set(token, found);
      }
      return found;
    };
    for (const name of Object.values(QueueName)) {
      queue(name);
    }

    const repository = new JobRepository(
      { get: (token: string) => queues.get(token) } as unknown as ModuleRef,
      { getEnv: () => ({ bull: { config: { prefix, connection } } }) } as unknown as ConfigRepository,
      { emit: (_event: string, _queueName: QueueName, job: Job) => run(job) } as unknown as EventRepository,
      LoggingRepository.create(),
    );
    repository.startWorkers();

    cleanups.push(
      () => repository.stopWorkers(0),
      () => Promise.all(queues.values().map((item) => item.close())),
    );
    return { repository, queue };
  };

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };

  it('hands a long-running job back to waiting, and the next boot runs it straight away', async () => {
    const prefix = `fl291-${randomUUID()}`;
    const started = deferred();
    const transcode = deferred();
    cleanups.push(() => Promise.resolve(transcode.resolve()));
    const first = boot(prefix, () => {
      started.resolve();
      return transcode.promise;
    });
    const video = first.queue(QueueName.VideoConversion);
    const job = await video.add(JobName.AssetEncodeVideo, { id: 'asset-1' }, { removeOnComplete: false });
    await started.promise;
    expect(await video.getJobCounts('active', 'waiting')).toMatchObject({ active: 1, waiting: 0 });

    const stoppedAt = Date.now();
    await first.repository.stopWorkers(500);
    expect(Date.now() - stoppedAt).toBeLessThan(3000);

    expect(await video.getJobCounts('active', 'waiting')).toMatchObject({ active: 0, waiting: 1 });
    expect(await video.getJobState(job.id!)).toBe('waiting');

    const ran = deferred();
    const bootedAt = Date.now();
    boot(prefix, (next) => {
      expect(next.id).toBe(job.id);
      ran.resolve();
      return Promise.resolve();
    });
    await ran.promise;
    // well inside BullMQ's 30 s stalled-job interval
    expect(Date.now() - bootedAt).toBeLessThan(5000);
    await vi.waitFor(async () => expect(await video.getJobState(job.id!)).toBe('completed'), { timeout: 5000 });
  }, 60_000);

  it('lets a short job finish before the workers close', async () => {
    const prefix = `fl291-${randomUUID()}`;
    const started = deferred();
    const first = boot(prefix, async () => {
      started.resolve();
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const thumbnails = first.queue(QueueName.ThumbnailGeneration);
    const job = await thumbnails.add(JobName.AssetGenerateThumbnails, { id: 'asset-2' }, { removeOnComplete: false });
    await started.promise;

    await first.repository.stopWorkers(5000);

    expect(await thumbnails.getJobState(job.id!)).toBe('completed');
    expect(await thumbnails.getJobCounts('active', 'waiting')).toMatchObject({ active: 0, waiting: 0 });
  }, 60_000);

  it('does not hand back a job that is unsafe to run again', async () => {
    const prefix = `fl291-${randomUUID()}`;
    const started = deferred();
    const sending = deferred();
    cleanups.push(() => Promise.resolve(sending.resolve()));
    const first = boot(prefix, () => {
      started.resolve();
      return sending.promise;
    });
    const notifications = first.queue(QueueName.Notification);
    const job = await notifications.add(JobName.SendMail, { to: 'someone' }, { removeOnFail: false });
    await started.promise;

    await first.repository.stopWorkers(200);

    expect(await notifications.getJobState(job.id!)).toBe('failed');
    expect(await notifications.getJobCounts('active', 'waiting')).toMatchObject({ active: 0, waiting: 0 });
  }, 60_000);
});

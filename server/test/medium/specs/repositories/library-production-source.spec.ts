import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobName, JobStatus, MediaOperationKind, MediaOperationStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueExecution } from 'src/queue/types.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { LibraryScanService } from 'src/services/library-scan.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { getLibraryQueueDB } from 'test/medium/library-queue-database.js';
import { SCALE_ITEMS, scaleIt } from 'test/medium/scale.js';
import { MediumTestContext } from 'test/medium.factory.js';

/** Synthetic read-only paths, real service/queue/domain/asset/source SQL. This does not decode media. */
scaleIt('scans %i paths through manual/QueueAll/tick entrypoints with bounded control reads', 1.2, async () => {
  StorageCore.setMediaLocation('/synthetic-managed');
  const db: Kysely<DB> = await getLibraryQueueDB();
  const store = new SqlQueueStore(db);
  const worker = randomUUID();
  const logger = { setContext() {}, log() {}, debug() {}, warn() {}, error() {}, verbose() {} };
  const jobs = new JobRepository({} as never, {} as never, {} as never, logger as never, db);
  const libraries = new LibraryRepository(db);
  const operations = new MediaOperationRepository(db);
  const assets = new AssetRepository(db);
  const queues = [QueueName.Library, QueueName.Sidecar, QueueName.BackgroundTask];
  let maximumWalkPage = 0;
  let activeIterators = 0;
  let maximumActiveIterators = 0;
  let pulse: ReturnType<typeof setInterval> | undefined;
  let pumping: Promise<void> | undefined;
  let progressUnits = 0;
  let reportedUnits = 0;
  let pulseError: unknown;
  const mtime = new Date(1_700_000_000_000);
  const storage = {
    stat(filename: string) {
      return Promise.resolve({ mtime, isDirectory: () => ['/external/one', '/external/two'].includes(filename) });
    },
    realpath(filename: string) {
      return Promise.resolve(filename);
    },
    checkFileExists() {
      return Promise.resolve(true);
    },
    accessError() {
      return Promise.resolve(null);
    },
    async *walkLibrary(options: Parameters<StorageRepository['walkLibrary']>[0]) {
      activeIterators++;
      maximumActiveIterators = Math.max(maximumActiveIterators, activeIterators);
      try {
        for (const root of options.pathsToCrawl) {
          const count = root === '/external/one' ? SCALE_ITEMS - 1 : 1;
          const take = options.take ?? 1000;
          for (let after = 0; after < count; after += take) {
            options.signal?.throwIfAborted();
            const page = Array.from(
              { length: Math.min(take, count - after) },
              (_, index) => `${root}/${after + index}.jpg`,
            );
            maximumWalkPage = Math.max(maximumWalkPage, page.length);
            await Promise.resolve();
            yield page;
          }
        }
      } finally {
        activeIterators--;
      }
    },
  };
  const service = new LibraryScanService(
    logger as never,
    operations,
    libraries,
    assets,
    new AssetJobRepository(db),
    storage as never,
    jobs,
    new UserRepository(db),
    { async emit() {} } as never,
    {
      hashSha1(value: string) {
        return createHash('sha1').update(value).digest();
      },
    } as CryptoRepository,
    {} as never,
  );
  try {
    await store.initialize(queues, worker);
    await store.setConcurrency(QueueName.Library, 2);
    await store.pause(QueueName.Sidecar, true);
    for (const [name, queue] of [
      [JobName.SidecarCheck, QueueName.Sidecar],
      [JobName.LibraryScanRun, QueueName.Library],
      [JobName.LibraryScanQueueAll, QueueName.Library],
      [JobName.LibraryDeleteCheck, QueueName.BackgroundTask],
    ] as const)
      jobs['handlers'][name] = {
        jobName: name,
        queueName: queue,
        label: 'production source fixture',
        handler: () => Promise.resolve(JobStatus.Success),
      };
    const ctx = new MediumTestContext(LibraryService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser({ isAdmin: true });
    const first = await libraries.create({
      ownerId: user.id,
      name: 'Large source',
      importPaths: ['/external/one'],
      exclusionPatterns: [],
    });
    const second = await libraries.create({
      ownerId: user.id,
      name: 'Second source',
      importPaths: ['/external/two'],
      exclusionPatterns: [],
    });
    const requested = await service.queue(first, { ownerId: user.id, trigger: 'manual' });
    expect(requested.created).toBe(true);
    await jobs.queue({ name: JobName.LibraryScanQueueAll, data: {} });
    const claims = await store.claim(QueueName.Library, worker, 2);
    const drainClaim = claims.find((claim) => claim.name === JobName.LibraryScanRun)!;
    const producerClaim = claims.find((claim) => claim.name === JobName.LibraryScanQueueAll)!;
    const context = (claim: typeof drainClaim): QueueExecution => ({
      claim,
      signal: new AbortController().signal,
      progress(units) {
        progressUnits = Math.max(progressUnits, units);
      },
      progressUnits: 0,
      followups: [],
      adoptions: [],
      buffering: true,
    });
    const producer = context(producerClaim);
    expect(await queueExecution.run(producer, () => service.handleQueueScanAll())).toBe(JobStatus.Success);
    expect(await store.complete(producerClaim, producer.followups)).toBe(true);
    const origin = (
      await sql<{ runId: string }>`select "runId" from job where id=${producerClaim.id}::uuid`.execute(db)
    ).rows[0].runId;
    // FL-1265: each scan is its own run, keyed by its operation; the producer's run counts only itself.
    const scanRuns = (
      await sql<{ id: string; enumerationDone: boolean }>`select id, "enumerationDone" from job_run
        where kind = ${MediaOperationKind.LibraryScan} order by id`.execute(db)
    ).rows;
    expect(scanRuns).toHaveLength(2);
    expect(scanRuns.every((run) => !run.enumerationDone)).toBe(true);
    expect(scanRuns.map((run) => run.id)).toContain(requested.operation.id);
    expect(scanRuns.map((run) => run.id)).not.toContain(origin);
    await service.tick(); // a deduplicated wake is control work, never another selected-media run/source
    const executeDrain = async (claim: typeof drainClaim) => {
      progressUnits = 0;
      reportedUnits = 0;
      pulseError = undefined;
      const drainAbort = new AbortController();
      const runContext = { ...context(claim), signal: drainAbort.signal };
      pulse = setInterval(() => {
        if (pumping) return;
        pumping = (async () => {
          await store.heartbeat(worker, [claim]);
          if (progressUnits > reportedUnits) {
            await store.progress(claim, progressUnits);
            reportedUnits = progressUnits;
          }
          expect(await store.deadlines(worker)).toEqual([]);
        })()
          .catch((error: unknown) => {
            pulseError = error;
            drainAbort.abort(error);
          })
          .finally(() => {
            pumping = undefined;
          });
      }, QUEUE_TIMING.heartbeat);
      try {
        expect(await queueExecution.run(runContext, () => service.handleScanRun())).toBe(JobStatus.Success);
      } finally {
        if (pulse) clearInterval(pulse);
        pulse = undefined;
        await pumping;
      }
      if (pulseError) throw pulseError;
      await store.progress(claim, progressUnits);
      expect(await store.complete(claim, runContext.followups)).toBe(true);
    };
    const started = performance.now();
    await executeDrain(drainClaim);
    // Each real wake may claim a different operation; ownership comes from the operation.
    const [secondClaim] = await store.claim(QueueName.Library, worker);
    expect(secondClaim.name).toBe(JobName.LibraryScanRun);
    await executeDrain(secondClaim);
    const completed = (await operations.getForWorker(requested.operation.id))!;
    expect(completed.error).toBeNull();
    expect(completed.status).toBe(MediaOperationStatus.Completed);
    const operationsRead = await operations.getLatestBySubject(MediaOperationKind.LibraryScan, 'libraryId', [
      first.id,
      second.id,
    ]);
    expect(operationsRead).toHaveLength(2);
    expect(operationsRead.every((operation) => operation.status === MediaOperationStatus.Completed)).toBe(true);
    const {
      rows: [counts],
    } = await sql<{ assets: number; runs: number; media: number; open: number; held: number }>`
      select (select count(*)::int from asset where "libraryId"=any(${[first.id, second.id]}::uuid[])) assets,
        (select count(*)::int from job_run where kind = ${MediaOperationKind.LibraryScan}) runs,
        (select count(*)::int from job j join job_run r on r.id = j."runId"
          where r.kind = ${MediaOperationKind.LibraryScan} and j.name = ${JobName.SidecarCheck} and j."rootItemKey" = j."itemKey") media,
        (select count(*)::int from job_run where kind = ${MediaOperationKind.LibraryScan} and not "enumerationDone") open,
        (select count(*)::int from job where queue=${QueueName.Sidecar} and state in ('pending','waiting')) held`.execute(
      db,
    );
    // Every imported photo has its job; the paused Sidecar queue keeps them waiting, not lost.
    expect(counts).toEqual({ assets: SCALE_ITEMS, runs: 2, media: SCALE_ITEMS, open: 0, held: SCALE_ITEMS });
    const summaryStarted = performance.now();
    const runs = await jobs.listRuns(10, 0);
    const maximumControlMs = performance.now() - summaryStarted;
    const scan = runs.find((run) => run.id === requested.operation.id)!;
    expect(scan.total).toBe(SCALE_ITEMS - 1);
    expect(scan.enumerationDone).toBe(true);
    expect(scan.state).toBe('paused');
    expect(maximumWalkPage).toBe(1000);
    expect(maximumActiveIterators).toBe(1);
    expect(activeIterators).toBe(0);
    await store.pause(QueueName.Sidecar, false);
    await store.setConcurrency(QueueName.Sidecar, 5);
    expect(await store.claim(QueueName.Sidecar, worker, 5)).toHaveLength(5);
    console.info(
      'library-service-source-calibration',
      JSON.stringify({
        paths: SCALE_ITEMS,
        sourceHeaders: 2,
        maximumWalkPage,
        maximumActiveIterators,
        maximumControlMs,
        elapsedMs: performance.now() - started,
      }),
    );
  } finally {
    if (pulse) clearInterval(pulse);
    await pumping;
    await service.onShutdown();
    await db.destroy();
  }
});

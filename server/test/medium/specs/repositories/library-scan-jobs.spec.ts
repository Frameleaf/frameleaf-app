import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  DatabaseLock,
  JobName,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  QueueName,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { finishRuns } from 'src/queue/run-summary.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { LibraryService } from 'src/services/library.service.js';
import { getLibraryQueueDB } from 'test/medium/library-queue-database.js';
import { MediumTestContext, mediumFactory } from 'test/medium.factory.js';

/**
 * FL-1265: a library scan's photos are jobs in the scan's run (`runId` = the scan operation). Work
 * starts per committed batch, a failed scan's imported photos are still processed, and the run
 * finishes once the scan has ended and its jobs are done.
 */
describe('library scan jobs', () => {
  let db: Kysely<DB>;
  let store: SqlQueueStore;
  let jobs: JobRepository;
  let workerId: string;

  beforeAll(async () => {
    db = await getLibraryQueueDB();
    store = new SqlQueueStore(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    workerId = randomUUID();
    await store.initialize([QueueName.Library, QueueName.Sidecar], workerId);
    await store.pause(QueueName.Sidecar, false);
    jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    jobs['handlers'][JobName.SidecarCheck] = {
      jobName: JobName.SidecarCheck,
      queueName: QueueName.Sidecar,
      label: 'scan jobs fixture',
      handler: () => Promise.resolve(JobStatus.Success),
    };
  });

  /** A library with a scan operation that has its run. */
  const newScan = async () => {
    const ctx = new MediumTestContext(LibraryService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser({ isAdmin: true });
    const library = await new LibraryRepository(db).create({
      ownerId: user.id,
      name: 'Scan jobs',
      importPaths: [`/scan-jobs/${randomUUID()}`],
      exclusionPatterns: [],
    });
    const operation = await new MediaOperationRepository(db).createUnlessActive(
      {
        ownerId: user.id,
        kind: MediaOperationKind.LibraryScan,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: library.name,
        snapshot: { libraryId: library.id },
        settings: {},
        estimate: null,
        result: {},
      },
      { key: 'libraryId', value: library.id, lock: DatabaseLock.Library },
    );
    if (!('created' in operation)) throw new Error('Scan operation unexpectedly active');
    const identity = { operationId: operation.created.id, libraryId: library.id };
    await jobs.ensureLibraryScanSource(identity, false);
    return { identity, ownerId: user.id };
  };

  /** One scan batch that imports `count` photos; `fail` makes the batch's own work throw after its writes. */
  const commit = (scan: Awaited<ReturnType<typeof newScan>>, count: number, { fail = false, close = false } = {}) =>
    jobs.commitLibraryScanBatch(
      scan.identity,
      count,
      async (tx) => {
        const assets = Array.from({ length: count }, () =>
          mediumFactory.assetInsert({ ownerId: scan.ownerId, libraryId: scan.identity.libraryId, isExternal: true }),
        );
        await tx.insertInto('asset').values(assets).execute();
        if (fail) throw new Error('scan batch crashed');
        return { value: assets.map(({ id }) => id!), assetIds: assets.map(({ id }) => id!), accepted: true };
      },
      close,
    );

  const scanJobs = (operationId: string) =>
    sql<{ itemKey: string; rootItemKey: string; state: string; claimable: boolean }>`select "itemKey", "rootItemKey",
      state, "availableAt" <= now() claimable from job
      where "runId" = ${operationId}::uuid and name = ${JobName.SidecarCheck} order by "itemKey"`
      .execute(db)
      .then(({ rows }) => rows);
  const run = (operationId: string) =>
    sql<{ enumerationDone: boolean; finishedAt: Date | null }>`select "enumerationDone", "finishedAt"
      from job_run where id = ${operationId}::uuid`
      .execute(db)
      .then(({ rows }) => rows[0]);
  const drain = async () => {
    for (;;) {
      const claims = await store.claim(QueueName.Sidecar, workerId, 50);
      if (claims.length === 0) return;
      for (const claim of claims) expect(await store.complete(claim, [])).toBe(true);
    }
  };

  it('commits a batch of photos and their jobs together, or neither', async () => {
    const scan = await newScan();
    expect(await run(scan.identity.operationId)).toEqual({ enumerationDone: false, finishedAt: null });

    await expect(commit(scan, 3, { fail: true })).rejects.toThrow('scan batch crashed');
    const { rows: none } = await sql`select id from asset where "libraryId" = ${scan.identity.libraryId}::uuid`.execute(
      db,
    );
    expect(none).toEqual([]);
    expect(await scanJobs(scan.identity.operationId)).toEqual([]);

    const imported = await commit(scan, 3);
    // Work starts per batch: the jobs can run while the scan is still going.
    expect(await scanJobs(scan.identity.operationId)).toEqual(
      imported.toSorted().map((id) => ({ itemKey: id, rootItemKey: id, state: 'pending', claimable: true })),
    );
    expect(await run(scan.identity.operationId)).toEqual({ enumerationDone: false, finishedAt: null });
  });

  it('still processes the photos a failed scan imported, then finishes its run', async () => {
    const scan = await newScan();
    const imported = await commit(scan, 2);
    await sql`update media_operation set status = 'failed'
      where id = ${scan.identity.operationId}::uuid`.execute(db);
    expect(await jobs.settleTerminalLibrarySources()).toBeGreaterThanOrEqual(1);
    expect(await run(scan.identity.operationId)).toMatchObject({ enumerationDone: true });

    await drain();
    expect((await scanJobs(scan.identity.operationId)).map(({ state }) => state)).toEqual(
      imported.map(() => 'completed'),
    );
    await finishRuns(db, 10);
    expect(await run(scan.identity.operationId)).toEqual({ enumerationDone: true, finishedAt: expect.any(Date) });
  });

  it('keeps the run open until the scan ends, even with every job done', async () => {
    const scan = await newScan();
    await commit(scan, 2);
    await drain();
    await finishRuns(db, 10);
    expect(await run(scan.identity.operationId)).toEqual({ enumerationDone: false, finishedAt: null });

    // The scan's last batch closes it.
    await commit(scan, 1, { close: true });
    expect(await run(scan.identity.operationId)).toMatchObject({ enumerationDone: true, finishedAt: null });
    await finishRuns(db, 10);
    expect(await run(scan.identity.operationId)).toMatchObject({ finishedAt: null }); // its new job is waiting
    await drain();
    await finishRuns(db, 10);
    expect(await run(scan.identity.operationId)).toEqual({ enumerationDone: true, finishedAt: expect.any(Date) });
  });

  it('ends a run the scan settled itself', async () => {
    const scan = await newScan();
    await commit(scan, 1);
    await jobs.settleLibraryScanSource(scan.identity.operationId, () => Promise.resolve());
    expect(await run(scan.identity.operationId)).toMatchObject({ enumerationDone: true });
    await drain();
    await finishRuns(db, 10);
    expect(await run(scan.identity.operationId)).toEqual({ enumerationDone: true, finishedAt: expect.any(Date) });
  });

  it('keeps the run open for a scan put back in the queue (FL-1409)', async () => {
    const scan = await newScan();
    await commit(scan, 1);
    const requeued = (outcome: string) => outcome !== 'retrying';
    await jobs.settleLibraryScanSource(scan.identity.operationId, () => Promise.resolve('retrying'), requeued);
    expect(await run(scan.identity.operationId)).toMatchObject({ enumerationDone: false, finishedAt: null });
    await jobs.settleLibraryScanSource(scan.identity.operationId, () => Promise.resolve('failed'), requeued);
    expect(await run(scan.identity.operationId)).toMatchObject({ enumerationDone: true });
  });

  it('renews the scan job lease with every batch, so a long scan keeps its claim', async () => {
    // The worker heartbeat skips a locked job row; back-to-back batches used to starve it until the lease ran out
    // mid-batch ("Producer lost its claim").
    const scan = await newScan();
    jobs['handlers'][JobName.LibraryScanRun] = { queueName: QueueName.Library } as never;
    await store.pause(QueueName.Library, false);
    await jobs.queue({ name: JobName.LibraryScanRun, data: {} });
    const [claim] = await store.claim(QueueName.Library, workerId);
    await sql`update job set "leaseExpiresAt" = now() + interval '1 second' where id = ${claim.id}::uuid`.execute(db);
    const context = {
      claim,
      signal: new AbortController().signal,
      progress: () => {},
      progressUnits: 0,
      adoptions: [],
      followups: [],
      buffering: false,
    };

    const imported = await queueExecution.run(context, () =>
      jobs.commitLibraryScanBatch(scan.identity, 1, async (tx) => {
        await new Promise((resolve) => setTimeout(resolve, 1500)); // a batch outliving the lease it started with
        const asset = mediumFactory.assetInsert({
          ownerId: scan.ownerId,
          libraryId: scan.identity.libraryId,
          isExternal: true,
        });
        await tx.insertInto('asset').values(asset).execute();
        return { value: [asset.id!], assetIds: [asset.id!], accepted: true };
      }),
    );
    expect(imported).toHaveLength(1);
    expect(await store.complete(claim, [])).toBe(true);
  });
});

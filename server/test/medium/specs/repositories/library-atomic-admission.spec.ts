import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  DatabaseLock,
  JobName,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  QueueName,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import {
  appendLibraryChildSources,
  attachLibraryParticipants,
  libraryRedactionPage,
  redactLibrarySourcePage,
} from 'src/queue/library-admission.js';
import { feedManifest, freezeSelection, getManifestJobOptions, shareSelectionPage } from 'src/queue/manifest.js';
import { pruneQueueHistory } from 'src/queue/retention.js';
import { libraryCanonicalState } from 'src/queue/selection-state.js';
import { SqlQueueStore, resetQueueAfterRestore } from 'src/queue/store.js';
import { QUEUE_BATCH, QUEUE_HIGH_WATER, QueueExecution, QueueIntent } from 'src/queue/types.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { LibraryService } from 'src/services/library.service.js';
import { recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { withExecutionCleanup } from 'src/utils/execution-signal.js';
import { emptyLibraryScanResult, libraryAssetFromFile, libraryPathsFingerprint } from 'src/utils/library-scan.js';
import { explainLibrarySettlement, getLibraryQueueDB } from 'test/medium/library-queue-database.js';
import { SCALE_ITEMS, scaleIt } from 'test/medium/scale.js';
import { MediumTestContext } from 'test/medium.factory.js';

/** Real queue/domain/asset transactions. Synthetic media calibrates ledger admission, not decoding throughput. */
describe('library atomic source admission', () => {
  let db: Kysely<DB>;
  let jobs: JobRepository;
  let store: SqlQueueStore;
  let libraries: LibraryRepository;
  let operations: MediaOperationRepository;
  let library: NonNullable<Awaited<ReturnType<LibraryRepository['get']>>>;
  let operationId: string;
  let domainToken: string;
  let queue: string;
  let worker: string;
  let sequence: number;
  afterEach(async () => {
    await db?.destroy();
  });
  beforeEach(async () => {
    db = await getLibraryQueueDB();
    queue = `library-atomic-${randomUUID()}`;
    worker = randomUUID();
    sequence = 0;
    store = new SqlQueueStore(db);
    await store.initialize([queue], worker);
    jobs = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
    jobs['handlers'][JobName.SidecarCheck] = {
      jobName: JobName.SidecarCheck,
      queueName: queue as QueueName,
      label: 'source fixture',
      handler: () => Promise.resolve(JobStatus.Success),
    };
    const ctx = new MediumTestContext(LibraryService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    libraries = new LibraryRepository(db);
    operations = new MediaOperationRepository(db);
    library = await libraries.create({
      ownerId: user.id,
      name: 'Atomic library',
      importPaths: ['/external/source'],
      exclusionPatterns: [],
    });
    const created = await operations.createUnlessActive(
      {
        ownerId: user.id,
        kind: MediaOperationKind.LibraryScan,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: 'Library fixture',
        snapshot: { libraryId: library.id, trigger: 'manual' },
        settings: {},
        estimate: null,
        result: emptyLibraryScanResult() as unknown as Record<string, unknown>,
      },
      { key: 'libraryId', value: library.id, lock: DatabaseLock.Library },
    );
    if (!('created' in created)) throw new Error('Expected independent operation');
    operationId = created.created.id;
    domainToken = randomUUID();
    await db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Rendering,
        claimToken: domainToken,
        claimExpiresAt: new Date(Date.now() + 300_000),
      })
      .where('id', '=', operationId)
      .execute();
    await jobs.ensureLibraryScanSource({ operationId, libraryId: library.id }, false);
  });
  const header = async () =>
    (
      await sql<{ state: string; capturedAt: Date | null; sourceClosedAt: Date | null; appendSequence: string }>`
    select state, "capturedAt", "sourceClosedAt", "appendSequence" from job_selection where id = ${operationId}::uuid`.execute(
        db,
      )
    ).rows[0];
  const members = async () =>
    (
      await sql<{ count: number }>`select count(*)::int count from job_run_item
    where "selectionId" = ${operationId}::uuid and "runId" = ${operationId}::uuid`.execute(db)
    ).rows[0].count;
  const live = async () =>
    (
      await sql<{ count: number }>`select count(*)::int count from job
    where queue = ${queue} and state in ('pending','waiting','active')`.execute(db)
    ).rows[0].count;
  const accept = (count = 1, close = false) =>
    jobs.commitLibraryScanBatch(
      { operationId, libraryId: library.id },
      count,
      async (tx) => {
        const outcome = await libraries.withScanClaim(
          {
            operationId,
            claimToken: domainToken,
            libraryId: library.id,
            fingerprint: libraryPathsFingerprint(library),
          },
          async (assets) => {
            const ids = await assets.createAll(
              Array.from({ length: count }, () =>
                libraryAssetFromFile(
                  { path: `/external/source/${++sequence}.jpg`, mtime: new Date(1_700_000_000_000) },
                  { ownerId: library.ownerId, libraryId: library.id },
                  (value) => createHash('sha1').update(value).digest(),
                  false,
                ),
              ),
            );
            const written = await operations.setBulkResult(
              operationId,
              domainToken,
              {
                result: { ...emptyLibraryScanResult(), phase: close ? 'done' : 'crawl', added: sequence },
                processedUnits: sequence,
                totalUnits: 0,
                progress: 10,
                leaseMs: 300_000,
              },
              tx,
              true,
            );
            if (!written) throw new Error('Lost domain checkpoint');
            return ids;
          },
          tx,
        );
        return {
          value: outcome,
          assetIds: outcome && 'value' in outcome ? outcome.value : [],
          accepted: !!outcome && 'value' in outcome,
        };
      },
      close,
    );
  const keepFixtureLeases = (claims: Array<{ id: string; token: string }>) => {
    let pending: Promise<void> | undefined, error: unknown;
    const timer = setInterval(() => {
      if (!pending)
        pending = store
          .heartbeat(worker, claims)
          .catch((error_) => {
            error = error_;
          })
          .finally(() => {
            pending = undefined;
          });
    }, 10_000);
    return async () => {
      clearInterval(timer);
      await pending;
      if (error) throw error;
    };
  };
  const feedOnly = (destination: string) => feedManifest(db, destination, (intents, tx) => store.enqueue(intents, tx));
  const drainCopies = async (destination: string, claims: Array<{ id: string; token: string }> = []) => {
    while (await shareSelectionPage(db, { queue: destination })) {
      // Genuine lease renewal after each committed visit, as the coordinator does during work.
      // Heartbeats do not acknowledge copies or advance committed progress.
      if (claims.length > 0) await store.heartbeat(worker, claims);
    }
  };
  const wake = async (name = JobName.LibraryScanRun, producerQueue = queue, options?: QueueIntent['options']) => {
    await store.initialize([producerQueue]);
    await store.enqueue([
      { name, queue: producerQueue, options, data: {}, safeToRetry: false, sensitive: false, deadlineMs: 300_000 },
    ]);
    const [claim] = await store.claim(producerQueue, worker);
    return {
      claim,
      signal: new AbortController().signal,
      progress: vi.fn(),
      progressUnits: 0,
      followups: [],
      adoptions: [],
      buffering: false,
    } satisfies QueueExecution;
  };

  it('attaches a QueueAll origin before producer completion without confusing its run with operation media', async () => {
    const context = await wake(JobName.LibraryScanQueueAll);
    await queueExecution.run(context, () => jobs.ensureLibraryScanSource({ operationId, libraryId: library.id }));
    const {
      rows: [producer],
    } = await sql<{ runId: string }>`select "runId" from job where id = ${context.claim.id}::uuid`.execute(db);
    expect(producer.runId).not.toBe(operationId);
    expect(
      await sql`select 1 from job_run_item where "runId" = ${producer.runId}::uuid and "rootItemKey" is not null`.execute(
        db,
      ),
    ).toMatchObject({ rows: [] });
    expect(await store.complete(context.claim, [])).toBe(true);
    const run = (await store.listRuns(100, 0)).find((row) => row.id === producer.runId)!;
    expect(run).toMatchObject({
      enumerationDone: false,
      finishedAt: null,
      reasons: expect.arrayContaining(['enumerating']),
    });
    expect(await header()).toMatchObject({ state: 'enumerating', capturedAt: null, sourceClosedAt: null });
    expect(await members()).toBe(0);
  });

  it('rolls a newly requested domain scan and source back if its QueueAll lease expires before submission commit', async () => {
    await db
      .updateTable('media_operation')
      .set({ status: MediaOperationStatus.Failed })
      .where('id', '=', operationId)
      .execute();
    const context = await wake(JobName.LibraryScanQueueAll);
    await sql`update job set "leaseExpiresAt" = clock_timestamp() + interval '1 second' where id = ${context.claim.id}::uuid`.execute(
      db,
    );
    await expect(
      queueExecution.run(context, () =>
        jobs.prepareLibraryScanSource(library.id, async (tx) => {
          const outcome = await operations.createUnlessActive(
            {
              ownerId: library.ownerId,
              kind: MediaOperationKind.LibraryScan,
              destination: MediaOperationDestination.Local,
              destinationDetail: null,
              label: 'Submission fence',
              snapshot: { libraryId: library.id, trigger: 'automatic' },
              settings: {},
              estimate: null,
              result: emptyLibraryScanResult() as unknown as Record<string, unknown>,
            },
            { key: 'libraryId', value: library.id, lock: DatabaseLock.Library },
            tx,
          );
          if (!('created' in outcome)) throw new Error('Expected new operation');
          await sql`select pg_sleep(1.2)`.execute(tx);
          return { operationId: outcome.created.id, value: outcome.created };
        }),
      ),
    ).rejects.toThrow(/claim/);
    const { rows } = await sql<{
      count: number;
    }>`select count(*)::int count from media_operation where snapshot->>'libraryId' = ${library.id}`.execute(db);
    expect(rows[0].count).toBe(1);
    expect(
      await sql`select 1 from job_selection where "libraryOperationId" != ${operationId}::uuid and "runId" in
      (select id from media_operation where snapshot->>'libraryId' = ${library.id})`.execute(db),
    ).toMatchObject({ rows: [] });
  });

  it('rolls assets and domain checkpoint back if durable source acceptance fails', async () => {
    const functionName = `reject_library_${randomUUID().replaceAll('-', '')}`;
    await sql`create function ${sql.id(functionName)}() returns trigger language plpgsql as $$ begin raise exception 'injected source failure'; end $$`.execute(
      db,
    );
    await sql`create trigger ${sql.id(functionName)} before insert on job_run_item for each row
      when (new."selectionId" = ${sql.lit(operationId)}::uuid) execute function ${sql.id(functionName)}()`.execute(db);
    try {
      await expect(accept()).rejects.toThrow('injected source failure');
      expect(await new AssetRepository(db).getLibraryAssetCount(library.id)).toBe(0);
      expect(await members()).toBe(0);
      expect(await operations.getForWorker(operationId)).toMatchObject({
        processedUnits: 0,
        result: emptyLibraryScanResult(),
      });
      expect(await header()).toMatchObject({
        state: 'enumerating',
        capturedAt: null,
        sourceClosedAt: null,
        appendSequence: 0,
      });
      expect(await live()).toBe(0);
    } finally {
      await sql`drop trigger ${sql.id(functionName)} on job_run_item`.execute(db);
      await sql`drop function ${sql.id(functionName)}()`.execute(db);
    }
  });

  it.each(['queue-token', 'queue-cancel', 'domain-token', 'domain-cancel', 'domain-pause', 'domain-expiry'])(
    'rejects a page after %s wins the acceptance fence',
    async (change) => {
      const context = await wake();
      switch (change) {
        case 'queue-token': {
          await sql`update job set token = ${randomUUID()}::uuid where id = ${context.claim.id}::uuid`.execute(db);
          break;
        }
        case 'queue-cancel': {
          await sql`update job set "cancelRequestedAt" = now() where id = ${context.claim.id}::uuid`.execute(db);
          break;
        }
        case 'domain-token': {
          await db
            .updateTable('media_operation')
            .set({ claimToken: randomUUID() })
            .where('id', '=', operationId)
            .execute();
          break;
        }
        case 'domain-cancel': {
          await db
            .updateTable('media_operation')
            .set({ cancelRequestedAt: new Date() })
            .where('id', '=', operationId)
            .execute();
          break;
        }
        case 'domain-pause': {
          await db
            .updateTable('media_operation')
            .set({ pauseRequestedAt: new Date() })
            .where('id', '=', operationId)
            .execute();
          break;
        }
        case 'domain-expiry': {
          await db
            .updateTable('media_operation')
            .set({ claimExpiresAt: new Date(0) })
            .where('id', '=', operationId)
            .execute();
          // No default
          break;
        }
      }
      if (change.startsWith('queue'))
        await expect(queueExecution.run(context, () => accept())).rejects.toThrow('queue claim');
      else expect(await queueExecution.run(context, () => accept())).toBeUndefined();
      expect(await new AssetRepository(db).getLibraryAssetCount(library.id)).toBe(0);
      expect(await members()).toBe(0);
      expect(await header()).toMatchObject({ capturedAt: null, sourceClosedAt: null });
      expect((await operations.getForWorker(operationId))!.processedUnits).toBe(0);
    },
  );

  it.each(['queue', 'domain'])(
    'lets a %s cancellation win while source acceptance waits for the catalogue lock',
    async (cancelled) => {
      const context = await wake();
      const locked = Promise.withResolvers<void>();
      const cancel = Promise.withResolvers<void>();
      const hold = db.transaction().execute(async (tx) => {
        await sql`select name from job_queue where name = ${queue} for no key update`.execute(tx);
        locked.resolve();
        await cancel.promise;
        // The winning control uses the connection already holding the catalogue guard.
        // Acceptance occupies the other pool2 connection while awaiting this transaction.
        if (cancelled === 'queue')
          await sql`update job set "cancelRequestedAt"=now() where id=${context.claim.id}::uuid`.execute(tx);
        else
          await tx
            .updateTable('media_operation')
            .set({ cancelRequestedAt: new Date() })
            .where('id', '=', operationId)
            .execute();
      });
      await locked.promise;
      const acceptance = queueExecution.run(context, () => accept());
      const outcome =
        cancelled === 'queue'
          ? expect(acceptance).rejects.toThrow('queue claim')
          : expect(acceptance).resolves.toBeUndefined();
      try {
        cancel.resolve();
        await hold;
        await outcome;
        expect(await new AssetRepository(db).getLibraryAssetCount(library.id)).toBe(0);
        expect(await members()).toBe(0);
        expect((await operations.getForWorker(operationId))!.processedUnits).toBe(0);
      } finally {
        cancel.resolve();
        await hold;
        await acceptance.catch(() => {});
      }
    },
  );

  it('rolls the entire page back when the queue lease expires after domain mutation and checkpoint', async () => {
    const context = await wake();
    await sql`update job set "leaseExpiresAt" = clock_timestamp() + interval '1 second' where id = ${context.claim.id}::uuid`.execute(
      db,
    );
    await expect(
      queueExecution.run(context, () =>
        jobs.commitLibraryScanBatch({ operationId, libraryId: library.id }, 1, async (tx) => {
          const outcome = await libraries.withScanClaim(
            {
              operationId,
              claimToken: domainToken,
              libraryId: library.id,
              fingerprint: libraryPathsFingerprint(library),
            },
            async (assets) => {
              const ids = await assets.createAll([
                libraryAssetFromFile(
                  { path: '/external/source/late.jpg', mtime: new Date() },
                  { ownerId: library.ownerId, libraryId: library.id },
                  (value) => createHash('sha1').update(value).digest(),
                  false,
                ),
              ]);
              const written = await operations.setBulkResult(
                operationId,
                domainToken,
                {
                  result: { ...emptyLibraryScanResult(), added: 1 },
                  processedUnits: 1,
                  totalUnits: 0,
                  progress: 10,
                  leaseMs: 300_000,
                },
                tx,
                true,
              );
              expect(written).toBeDefined();
              await sql`select pg_sleep(1.2)`.execute(tx);
              return ids;
            },
            tx,
          );
          return {
            value: outcome,
            assetIds: outcome && 'value' in outcome ? outcome.value : [],
            accepted: !!outcome && 'value' in outcome,
          };
        }),
      ),
    ).rejects.toThrow('queue claim');
    expect(await new AssetRepository(db).getLibraryAssetCount(library.id)).toBe(0);
    expect(await members()).toBe(0);
    expect((await operations.getForWorker(operationId))!.processedUnits).toBe(0);
    expect(await header()).toMatchObject({ appendSequence: 0, capturedAt: null, sourceClosedAt: null });
  });

  it.each([0, 1])(
    'keeps %s partial rows non-runnable after domain failure, including empty-source attention',
    async (count) => {
      await accept(count);
      await jobs.settleLibraryScanSource(operationId, (executor) =>
        operations.fail(
          operationId,
          domainToken,
          { error: 'source disconnected', errorCode: 'library_source_unavailable' },
          { retry: false, executor },
        ),
      );
      expect(await header()).toMatchObject({ state: 'needs_attention', capturedAt: null, sourceClosedAt: null });
      expect(await members()).toBe(count);
      expect(await store.feedManifest(queue)).toBe(0);
      expect((await store.listRuns(100, 0)).find((run) => run.id === operationId)).toMatchObject({
        state: 'needs_attention',
        enumerationDone: false,
        reasons: expect.arrayContaining(['needs_attention']),
      });
      expect((await operations.getForWorker(operationId))!.autoRetries).toBe(0);
    },
  );

  it.each([false, true])(
    'settles an aborted queue SQL context with exact domain token fencing (replacement=%s)',
    async (replace) => {
      await accept();
      const originalToken = domainToken;
      const context = await wake();
      const controller = new AbortController();
      context.signal = controller.signal;
      controller.abort(new Error('queue interrupted'));
      const failure = { error: 'queue interrupted', errorCode: 'library_scan_interrupted' };
      const settle = () =>
        jobs.settleLibraryScanSource(operationId, (executor) =>
          operations.fail(operationId, originalToken, failure, { retry: false, executor }),
        );
      await expect(queueExecution.run(context, settle)).rejects.toThrow('queue interrupted');
      expect(await header()).toMatchObject({ state: 'enumerating', capturedAt: null, sourceClosedAt: null });
      if (replace) {
        domainToken = randomUUID();
        await db
          .updateTable('media_operation')
          .set({ claimToken: domainToken })
          .where('id', '=', operationId)
          .execute();
      }
      await queueExecution.run(context, () => withExecutionCleanup(settle));
      const operation = (await operations.getForWorker(operationId))!;
      expect(operation).toMatchObject(
        replace
          ? { status: MediaOperationStatus.Rendering, claimToken: domainToken }
          : { status: MediaOperationStatus.Failed, claimToken: null, errorCode: failure.errorCode, autoRetries: 0 },
      );
      expect(await header()).toMatchObject({
        state: replace ? 'enumerating' : 'needs_attention',
        capturedAt: null,
        sourceClosedAt: null,
      });
      expect(await members()).toBe(1);
      expect(await store.feedManifest(queue)).toBe(0);
      await expect(
        queueExecution.run(context, () => db.selectFrom('media_operation').select('id').execute()),
      ).rejects.toThrow('queue interrupted');
    },
  );

  it('freezes actual source close before admitting any media and caps paused/slow initial execution at 1000', async () => {
    for (let i = 0; i < 5; i++) await accept(QUEUE_BATCH);
    expect(await members()).toBe(1250);
    expect(await store.feedManifest(queue)).toBe(0);
    expect(await live()).toBe(0);
    await sql`update job_queue set paused = true where name = ${queue}`.execute(db);
    await accept(0, true);
    expect(await header()).toMatchObject({
      state: 'ready',
      capturedAt: expect.any(Date),
      sourceClosedAt: expect.any(Date),
    });
    expect(await store.feedManifest(queue)).toBe(0);
    // BEFORE INSERT also observes attempted ON CONFLICT inserts into retained canonical rows.
    await sql`create table library_feeder_insert_count(calls integer not null)`.execute(db);
    await sql`insert into library_feeder_insert_count values (0)`.execute(db);
    await sql`create function count_library_feeder_insert() returns trigger language plpgsql as $$
      begin update library_feeder_insert_count set calls = calls + 1; return new; end $$`.execute(db);
    await sql`create trigger count_library_feeder_insert before insert on job_run_item for each row
      when (new."runId" = ${sql.lit(operationId)}::uuid and new.stage = ${sql.lit(JobName.SidecarCheck)}
        and new."selectionId" is null) execute function count_library_feeder_insert()`.execute(db);
    await sql`update job_queue set paused = false where name = ${queue}`.execute(db);
    for (let i = 0; i < 4; i++) {
      expect(await store.feedManifest(queue)).toBe(250);
      expect(await live()).toBeLessThanOrEqual(QUEUE_HIGH_WATER);
    }
    expect(await store.feedManifest(queue)).toBe(0);
    expect(await live()).toBe(1000);
    expect(
      (await sql<{ calls: number }>`select calls from library_feeder_insert_count`.execute(db)).rows[0].calls,
    ).toBe(0);
    const linked = await sql<{ count: string }>`select count(*)::text as count from job_run_item item
      join job on job.id = item."jobId" and job."runId" = item."runId"
        and job."itemKey" = item."itemKey" and job.name = item.stage
      where item."selectionId" = ${operationId}::uuid and item.state = 'pending' and job.state = 'pending'`.execute(db);
    expect(Number(linked.rows[0].count)).toBe(1000);
    expect(await members()).toBe(1250);
    await expect(accept()).rejects.toThrow('not open');
    expect(await new AssetRepository(db).getLibraryAssetCount(library.id)).toBe(1250);
  });

  it('creates retained membership for an ordinary enqueue without a frozen manifest tuple', async () => {
    const runId = await store.createRun('ordinary-admission-control', {});
    const itemKey = randomUUID();
    await store.enqueue([
      {
        queue,
        name: JobName.SidecarCheck,
        data: { id: itemKey },
        runId,
        itemKey,
        rootItemKey: itemKey,
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 60_000,
      },
    ]);
    const { rows } = await sql<{ selectionId: string | null; state: string; jobState: string; id: string }>`
      select item."selectionId", item.state, job.state as "jobState", job.id from job_run_item item
      join job on job.id = item."jobId" and job."runId" = item."runId"
        and job."itemKey" = item."itemKey" and job.name = item.stage
      where item."runId" = ${runId}::uuid and item."itemKey" = ${itemKey} and item.stage = ${JobName.SidecarCheck}`.execute(
      db,
    );
    expect(rows).toEqual([{ selectionId: null, state: 'pending', jobState: 'pending', id: expect.any(String) }]);
  });

  scaleIt('streams %i asset/source admissions with no eager pending media and a capped feeder', 1.2, async () => {
    // Fixed 250-item JS pages; counters only. No collected ID list, per-asset spies, raw RSS SLA or decoded-media claim.
    await sql`update job_queue set paused = true where name = ${queue}`.execute(db);
    let maximumPage = 0;
    const pages = SCALE_ITEMS / QUEUE_BATCH;
    for (let page = 0; page < pages; page++) {
      const outcome = await accept(QUEUE_BATCH);
      if (!outcome || !('value' in outcome)) throw new Error('Source acceptance lost its domain claim');
      maximumPage = Math.max(maximumPage, outcome.value.length);
      if ([0, pages / 2 - 1, pages - 1].includes(page)) {
        expect(await live()).toBe(0);
        expect(await header()).toMatchObject({ state: 'enumerating', capturedAt: null, sourceClosedAt: null });
        expect(await store.feedManifest(queue)).toBe(0);
      }
    }
    expect(maximumPage).toBe(250);
    expect(await new AssetRepository(db).getLibraryAssetCount(library.id)).toBe(SCALE_ITEMS);
    expect(await members()).toBe(SCALE_ITEMS);
    await accept(0, true);
    expect(await store.feedManifest(queue)).toBe(0);
    await sql`update job_queue set paused = false where name = ${queue}`.execute(db);
    for (let page = 0; page < 4; page++) expect(await store.feedManifest(queue)).toBe(250);
    for (let attempt = 0; attempt < 3; attempt++) expect(await store.feedManifest(queue)).toBe(0);
    expect(await live()).toBe(1000);
    expect(await members()).toBe(SCALE_ITEMS);
  });

  it('invalidates a copier final-page acknowledgement on late child append without resetting its monotonic cursor', async () => {
    await accept(2, true);
    await store.feedManifest(queue);
    await store.setConcurrency(queue, 2);
    const parents = await store.claim(queue, worker, 2);
    const childQueue = `${queue}-tail`;
    await store.initialize([childQueue]);
    const publish = async (parent: (typeof parents)[number]) => {
      expect(
        await store.complete(parent, [
          {
            name: JobName.AssetExtractMetadata,
            queue: childQueue,
            data: { id: parent.data.id },
            safeToRetry: true,
            sensitive: false,
            deadlineMs: 60_000,
          },
        ]),
      ).toBe(true);
      return (
        await sql<{ id: string }>`select id from job_selection where "libraryOperationId" = ${operationId}::uuid
        and stage = ${`library-child/${JobName.AssetExtractMetadata}`}`.execute(db)
      ).rows.map(({ id }) => id);
    };
    const [sourceId] = await publish(parents[0]);
    // Prior child work has finished; the next accepted production parent publishes a new version.
    await sql`update job_run_item set state = 'completed' where "selectionId" = ${sourceId}::uuid`.execute(db);
    const originContext = await wake(JobName.LibraryScanQueueAll, `${queue}-origin`);
    await queueExecution.run(originContext, () => jobs.ensureLibraryScanSource({ operationId, libraryId: library.id }));
    expect(await store.complete(originContext.claim, [])).toBe(true);
    const origin = (
      await sql<{ runId: string }>`select "runId" from job where id=${originContext.claim.id}::uuid`.execute(db)
    ).rows[0].runId;
    const otherLibrary = await libraries.create({
      ownerId: library.ownerId,
      name: 'Second producer library',
      importPaths: [],
      exclusionPatterns: [],
    });
    // Real summary SQL must exclude library/producer identities from selected media totals.
    await sql`insert into job_run_item("runId", "itemKey", stage, queue, selection, state) values
      (${origin}::uuid, ${`producer/${library.id}`}, ${JobName.LibraryScanQueueAll}, ${queue}, jsonb_build_object('libraryId', ${library.id}::text), 'completed'),
      (${origin}::uuid, ${`producer/${otherLibrary.id}`}, ${JobName.LibraryScanQueueAll}, ${queue}, jsonb_build_object('libraryId', ${otherLibrary.id}::text), 'completed')`.execute(
      db,
    );

    await sql`insert into job_selection_run("runId", "selectionId", "copyComplete") values
      (${origin}::uuid, ${operationId}::uuid, false), (${origin}::uuid, ${sourceId}::uuid, false) on conflict do nothing`.execute(
      db,
    );
    await drainCopies(queue);
    await drainCopies(childQueue);
    const read = async () =>
      (
        await sql<{
          copyComplete: boolean;
          copyAfter: string;
          libraryVersion: string;
          appendSequence: string;
          enumerationDone: boolean;
          finishedAt: Date | null;
        }>`
      select m."copyComplete", m."copyAfter", m."libraryVersion", s."appendSequence", r."enumerationDone", r."finishedAt" from job_selection_run m
      join job_selection s on s.id = m."selectionId"
      join job_run r on r.id = m."runId" where m."runId" = ${origin}::uuid and m."selectionId" = ${sourceId}::uuid`.execute(
          db,
        )
      ).rows[0];
    const before = await read();
    expect(before.copyComplete).toBe(true);
    expect(before.enumerationDone).toBe(true);
    expect(await publish(parents[1])).toEqual([sourceId]);
    expect(await read()).toMatchObject({
      copyComplete: true, // acknowledged prior version; derived reads must reject its stale acknowledgement
      copyAfter: before.copyAfter,
      libraryVersion: before.libraryVersion,
      appendSequence: 2,
    });
    expect((await store.listRuns(100, 0)).find((run) => run.id === origin)).toMatchObject({
      enumerationDone: false,
      finishedAt: null,
    });
    await drainCopies(childQueue);
    expect(await read()).toMatchObject({ copyComplete: true, enumerationDone: true });
    const {
      rows: [counts],
    } = await sql<{ headers: number; items: number; distinctItems: number }>`
      select count(distinct s.id)::int headers, count(i.*)::int items, count(distinct (i."itemKey", i.stage))::int "distinctItems"
      from job_selection s join job_run_item i on i."selectionId" = s.id and i."runId" = ${origin}::uuid
      where s."libraryOperationId" = ${operationId}::uuid and s."sourceKind" = 'library-child'`.execute(db);
    expect(counts).toEqual({ headers: 1, items: 2, distinctItems: 2 });
    // A second declared child stage still refers to the same two actual selected-media roots.
    let thumbnailSource: string | undefined;
    for (const parent of parents) {
      await db.transaction().execute(async (tx) => {
        await sql`select name from job_queue order by name for no key update`.execute(tx);
        [thumbnailSource] = await appendLibraryChildSources(
          tx,
          { operationId, jobId: parent.id, rootItemKey: parent.rootItemKey! },
          [
            {
              name: JobName.AssetGenerateThumbnails,
              queue: childQueue,
              data: { id: parent.data.id },
              safeToRetry: true,
              sensitive: false,
              deadlineMs: 60_000,
              rootItemKey: parent.rootItemKey,
            },
          ],
        );
        await sql`with attached as (insert into job_selection_run("runId", "selectionId", "copyComplete")
          values (${origin}::uuid, ${thumbnailSource}::uuid, false) on conflict do nothing returning "runId")
          update job_run set "enumerationDone" = false, "finishedAt" = null where id in (select "runId" from attached)`.execute(
          tx,
        );
      });
    }
    await drainCopies(childQueue);
    const summary = (await store.listRuns(100, 0)).find((run) => run.id === origin)!;
    expect(summary.total).toBe(2);
    expect(summary.stageTotals.total).toBe(9); // actual producer + two library bookkeeping + two initial + two metadata + two thumbnails
    const canonical = (await store.listRuns(100, 0)).find((run) => run.id === operationId)!;
    expect(canonical.total).toBe(2);
    expect(canonical.stageTotals.total).toBe(6);
  });

  it('creates one authoritative child stage for many parent assets, retaining full declared options', async () => {
    await accept(2, true);
    await store.feedManifest(queue);
    await store.setConcurrency(queue, 2);
    const parents = await store.claim(queue, worker, 2);
    const childQueue = `${queue}-child`;
    await store.initialize([childQueue]);
    for (const parent of parents) {
      const child: QueueIntent = {
        queue: childQueue,
        name: JobName.AssetExtractMetadata,
        data: { id: parent.data.id, destination: 'local', modelId: 'pinned' },
        options: { delay: 123, deduplication: { id: `child-${parent.data.id}` } },
        safeToRetry: true,
        sensitive: true,
        deadlineMs: 456_000,
      };
      expect(await store.complete(parent, [child])).toBe(true);
    }
    const { rows } = await sql<{
      headers: number;
      items: number;
      intents: QueueIntent[];
    }>`select count(distinct s.id)::int headers,
      count(i.*)::int items, jsonb_agg(i."libraryIntent") intents from job_selection s join job_run_item i on i."selectionId" = s.id
      where s."libraryOperationId" = ${operationId}::uuid and s."sourceKind" = 'library-child'`.execute(db);
    expect(rows[0]).toMatchObject({ headers: 1, items: 2 });
    for (const intent of rows[0].intents)
      expect(intent).toMatchObject({
        sensitive: true,
        deadlineMs: 456_000,
        options: { delay: 123 },
        data: { destination: 'local', modelId: 'pinned' },
      });
    expect(await sql`select 1 from job where queue = ${childQueue}`.execute(db)).toMatchObject({ rows: [] });
  });

  it('attaches more than 250 origin and child participants without eager arrays, including a cancelled negative control', async () => {
    const context = await wake(JobName.LibraryScanQueueAll, `${queue}-producer`);
    await queueExecution.run(context, () => jobs.ensureLibraryScanSource({ operationId, libraryId: library.id }));
    await sql`with origins as (insert into job_run(id, kind, selection)
      select gen_random_uuid(), 'library-origin', '{}'::jsonb from generate_series(1, 300) returning id)
      insert into job_run_item("runId", "itemKey", stage, queue, selection, "jobId", state)
      select id, 'producer', ${JobName.LibraryScanQueueAll}, ${context.claim.queue}, '{}'::jsonb, ${context.claim.id}::uuid, 'active'
      from origins`.execute(db);
    const cancelled = (
      await sql<{ runId: string }>`update job_run_item set state = 'cancelled'
      where "runId" = (select "runId" from job_run_item where "jobId" = ${context.claim.id}::uuid and "itemKey" = 'producer' limit 1)
      returning "runId"`.execute(db)
    ).rows[0].runId;
    let maximumAttached = 0;
    for (let visit = 0; visit < 3; visit++) {
      const before = (
        await sql<{
          count: number;
        }>`select count(*)::int count from job_selection_run where "selectionId" = ${operationId}::uuid`.execute(db)
      ).rows[0].count;
      await db.transaction().execute(async (tx) => {
        await sql`select name from job_queue order by name for no key update`.execute(tx);
        await attachLibraryParticipants(tx, { producerId: context.claim.id });
      });
      const after = (
        await sql<{
          count: number;
        }>`select count(*)::int count from job_selection_run where "selectionId" = ${operationId}::uuid`.execute(db)
      ).rows[0].count;
      maximumAttached = Math.max(maximumAttached, after - before);
      expect(after - before).toBeLessThanOrEqual(250);
    }
    expect(maximumAttached).toBe(250);
    expect(await store.complete(context.claim, [])).toBe(true);
    expect(
      (
        await sql<{
          count: number;
        }>`select count(*)::int count from job_selection_run where "selectionId" = ${operationId}::uuid`.execute(db)
      ).rows[0].count,
    ).toBe(301);
    expect(
      (
        await sql`select 1 from job_selection_run where "selectionId" = ${operationId}::uuid and "runId" = ${cancelled}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([]);
    await accept(1, true);
    await drainCopies(queue);
    await store.feedManifest(queue);
    const [parent] = await store.claim(queue, worker);
    const downstream = `${queue}-descendants`;
    await store.initialize([downstream]);
    expect(
      await store.complete(parent, [
        {
          name: JobName.AssetExtractMetadata,
          queue: downstream,
          data: { id: parent.data.id },
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 60_000,
        },
      ]),
    ).toBe(true);
    await drainCopies(downstream);
    expect(
      (
        await sql<{
          count: number;
        }>`select count(*)::int count from job_selection_run m join job_selection s on s.id=m."selectionId"
      where s."libraryOperationId"=${operationId}::uuid and s."sourceKind"='library-child'`.execute(db)
      ).rows[0].count,
    ).toBe(301);
    expect(
      (
        await sql`select 1 from job_selection_lineage l join job_run_item i on (i."runId",i."itemKey",i.stage)=(l."runId",l."itemKey",l.stage)
      join job_selection s on s.id=i."selectionId" where s."sourceKind"='library-child'`.execute(db)
      ).rows,
    ).toEqual([]);
    const late = await wake(JobName.LibraryScanQueueAll, `${queue}-late`);
    await queueExecution.run(late, () => jobs.ensureLibraryScanSource({ operationId, libraryId: library.id }));
    expect(await store.complete(late.claim, [])).toBe(true);
    await drainCopies(queue);
    await drainCopies(downstream);
    const lateRun = (await sql<{ runId: string }>`select "runId" from job where id=${late.claim.id}::uuid`.execute(db))
      .rows[0].runId;
    const summary = (await store.listRuns(500, 0)).find((run) => run.id === lateRun)!;
    expect(summary.total).toBe(1);
    expect(summary.stageTotals.total).toBe(3); // producer + sidecar + metadata, one authoritative discovery owner
  }, 120_000);

  it.each(['completed', 'failed', 'cancelled', 'restore', 'prune'])(
    'clears sensitive library intent data/options through %s while retaining source proof',
    async (outcome) => {
      await accept(1, true);
      await store.feedManifest(queue);
      const [parent] = await store.claim(queue, worker);
      const destination = `${queue}-private`;
      await store.initialize([destination]);
      expect(
        await store.complete(parent, [
          {
            name: JobName.AssetExtractMetadata,
            queue: destination,
            data: { id: parent.data.id, privateDestination: 'private-token' },
            options: { delay: 0, jobId: 'private-pin' },
            safeToRetry: false,
            sensitive: true,
            deadlineMs: 61_234,
          },
        ]),
      ).toBe(true);
      expect(await feedOnly(destination)).toBe(0); // isolate the feeder: the store wrapper may discover and feed in one visit
      await drainCopies(destination);
      await store.feedManifest(destination);
      const [child] = await store.claim(destination, worker);
      expect(child).toMatchObject({
        data: { privateDestination: 'private-token' },
        deadlineMs: 61_234,
        safeToRetry: false,
      });
      expect((await sql`select sensitive from job where id=${child.id}::uuid`.execute(db)).rows).toEqual([
        { sensitive: true },
      ]);
      switch (outcome) {
        case 'completed':
        case 'prune': {
          expect(await store.complete(child, [])).toBe(true);
          break;
        }
        case 'failed': {
          await store.fail(child, 'sensitive failure');
          break;
        }
        case 'cancelled': {
          await sql`update job set "cancelRequestedAt"=now() where id=${child.id}::uuid`.execute(db);
          await recordStoppedAttempt(db, child.id, child.token);
          expect(await store.fail(child, 'cancelled')).toBe(true);

          break;
        }
        default: {
          await resetQueueAfterRestore(db);
        }
      }
      if (outcome === 'prune') {
        await sql`update job set "finishedAt"=now()-interval '8 days' where id=${child.id}::uuid`.execute(db);
        await sql`update job_run set "finishedAt"=now() where id=${operationId}::uuid`.execute(db);
        await pruneQueueHistory(db);
      }
      const rows = (
        await sql<{
          selection: unknown;
          libraryIntent: QueueIntent;
          librarySourceKey: string;
        }>`select selection,"libraryIntent","librarySourceKey"
      from job_run_item i join job_selection s on s.id=i."selectionId" where s."libraryOperationId"=${operationId}::uuid and s."sourceKind"='library-child'`.execute(
          db,
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].selection).toEqual({});
      expect(rows[0].libraryIntent.data).toEqual({});
      expect(rows[0].libraryIntent.options).toBeUndefined();
      expect(rows[0].librarySourceKey).toHaveLength(64);
      expect(rows[0].libraryIntent).toMatchObject({
        sensitive: true,
        deadlineMs: 61_234,
        name: JobName.AssetExtractMetadata,
      });
    },
  );

  // Fixture construction includes 1250 serial real parent publications and 500 completions.
  // Its outer lifetime does not alter pool2/5s SQL/3s lock or per-job budgets.
  it('publishes every declared downstream stage to capped paused manifests and refills only at low water', async () => {
    const destinations = [
      [JobName.AssetExtractMetadata, QueueName.MetadataExtraction],
      [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration],
      [JobName.AssetDetectFaces, QueueName.FaceDetection],
      [JobName.FacialRecognition, QueueName.FacialRecognition],
      [JobName.SmartSearch, QueueName.SmartSearch],
      [JobName.AssetDetectDuplicates, QueueName.DuplicateDetection],
      [JobName.IntegrityChecksumFiles, QueueName.IntegrityCheck],
    ] as const;
    for (const [, destination] of destinations) {
      await store.initialize([destination]);
      await store.pause(destination, true);
    }
    for (let page = 0; page < 5; page++) await accept(250);
    await accept(0, true);
    await store.setConcurrency(queue, 250);
    for (let page = 0; page < 5; page++) {
      expect(await store.feedManifest(queue)).toBe(250);
      const parents = await store.claim(queue, worker, 250);
      expect(parents).toHaveLength(250);
      const pageStarted = performance.now();
      for (const parent of parents) {
        expect(
          await store.complete(
            parent,
            destinations.map(([name, destination]) => ({
              name,
              queue: destination,
              data: { id: parent.data.id, destination: 'local', modelId: 'frozen-model' },
              options: { deduplication: { id: `${name}:${parent.data.id}` } },
              safeToRetry: true,
              sensitive: false,
              deadlineMs: 60_123,
            })),
          ),
        ).toBe(true);
      }
      if (page === 0) console.info('library-stage-settlement-plan', JSON.stringify(await explainLibrarySettlement(db)));
      console.info(
        'library-stage-publication-page',
        JSON.stringify({ page, parents: parents.length, elapsedMs: performance.now() - pageStarted }),
      );
    }
    const counts = (
      await sql<{ headers: number; items: number }>`select count(distinct s.id)::int headers,count(i.*)::int items
      from job_selection s join job_run_item i on i."selectionId"=s.id and i."runId"=s."runId"
      where s."libraryOperationId"=${operationId}::uuid and s."sourceKind"='library-child'`.execute(db)
    ).rows[0];
    expect(counts).toEqual({ headers: destinations.length, items: 1250 * destinations.length });
    for (const [, destination] of destinations) {
      expect(await store.feedManifest(destination)).toBe(0);
      expect((await store.counts(destination)).waiting).toBe(0);
      await drainCopies(destination);
      await store.pause(destination, false);
      for (let page = 0; page < 4; page++) expect(await store.feedManifest(destination)).toBe(250);
      expect(await store.feedManifest(destination)).toBe(0);
      expect((await store.counts(destination)).waiting).toBe(1000);
    }
    const destination = destinations[0][1];
    await store.setConcurrency(destination, 250);
    for (let page = 0; page < 2; page++) {
      const children = await store.claim(destination, worker, 250);
      expect(children).toHaveLength(250);
      for (const child of children) expect(await store.complete(child, [])).toBe(true);
      if (page === 0) expect(await store.feedManifest(destination)).toBe(0); // 750 still exceeds low water
    }
    expect((await store.counts(destination)).waiting).toBe(500);
    expect(await store.feedManifest(destination)).toBe(250);
    expect((await store.counts(destination)).waiting).toBe(750);
    expect(await store.feedManifest(destination)).toBe(0);
    const summary = (await store.listRuns(100, 0)).find((run) => run.id === operationId)!;
    expect(summary.total).toBe(1250);
    expect(summary.stageTotals.total).toBe(1250 * (destinations.length + 1));
  }, 600_000);

  it.each(['replacement', 'cancel'])(
    'rejects production child publication after %s wins without late intent rows',
    async (change) => {
      await accept(1, true);
      await store.feedManifest(queue);
      const [parent] = await store.claim(queue, worker);
      if (change === 'replacement')
        await sql`update job set token=${randomUUID()}::uuid where id=${parent.id}::uuid`.execute(db);
      else await sql`update job set "cancelRequestedAt"=now() where id=${parent.id}::uuid`.execute(db);
      expect(
        await store.complete(parent, [
          {
            name: JobName.AssetExtractMetadata,
            queue,
            data: { id: parent.data.id },
            safeToRetry: true,
            sensitive: false,
            deadlineMs: 60_000,
          },
        ]),
      ).toBe(false);
      expect(
        (
          await sql`select 1 from job_selection where "libraryOperationId"=${operationId}::uuid and "sourceKind"='library-child'`.execute(
            db,
          )
        ).rows,
      ).toEqual([]);
    },
  );

  it('copies only two frozen roots through late child append, >250 aliases and pruned payloads; never the third root', async () => {
    await accept(3, true);
    await store.feedManifest(queue);
    await store.setConcurrency(queue, 3);
    const initial = await store.claim(queue, worker, 3);
    const parentQueue = `${queue}-smart-parent`,
      childQueue = `${queue}-smart-child`;
    await store.initialize([parentQueue, childQueue]);
    await store.setConcurrency(parentQueue, 3);
    for (const parent of initial)
      expect(
        await store.complete(parent, [
          {
            name: JobName.SmartAlbumReevaluate,
            queue: parentQueue,
            data: { id: parent.data.id, kind: 'all' },
            options: getManifestJobOptions(JobName.SmartAlbumReevaluate, { id: parent.data.id, kind: 'all' }),
            safeToRetry: true,
            sensitive: false,
            deadlineMs: 62_345,
          },
        ]),
      ).toBe(true);
    expect(await feedOnly(parentQueue)).toBe(0);
    await drainCopies(parentQueue);
    expect(await store.feedManifest(parentQueue)).toBe(3);
    const parents = await store.claim(parentQueue, worker, 3);
    const producerQueue = `${queue}-frozen-producer`,
      producerKey = 'shared-frozen-producer';
    const context = await wake(JobName.SmartAlbumReevaluateAll, producerQueue, { deduplication: { id: producerKey } });
    const retainedClaims = [...parents, context.claim];
    const stopHeartbeat = keepFixtureLeases(retainedClaims);
    try {
      const selected = parents.slice(0, 2).map((parent) => String(parent.data.id));
      const frozenRun = await freezeSelection(
        db,
        {
          name: JobName.SmartAlbumReevaluate,
          queue: parentQueue,
          data: { kind: 'all' },
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 62_345,
        },
        db.selectFrom(sql<{ id: string }>`(select unnest(${selected}::text[]) id)`.as('selected')).select('id'),
        context,
      );
      // The immutable snapshot is complete. These accepted requests coalesce with the already
      // active library executions, preserving their actual options and one executor budget.
      for (const id of selected)
        await store.enqueue([
          {
            name: JobName.SmartAlbumReevaluate,
            queue: parentQueue,
            data: { id, kind: 'all' },
            options: getManifestJobOptions(JobName.SmartAlbumReevaluate, { id, kind: 'all' }),
            safeToRetry: true,
            sensitive: false,
            deadlineMs: 62_345,
            runId: frozenRun,
            itemKey: id,
            rootItemKey: id,
          },
        ]);
      await sql`with aliases as (insert into job_run(id,kind,selection)
      select gen_random_uuid(),'frozen-alias','{}'::jsonb from generate_series(1,300) returning id)
      insert into job_run_item("runId","itemKey",stage,queue,selection,"jobId",state)
      select id,'producer',${context.claim.name},${producerQueue},'{}'::jsonb,${context.claim.id}::uuid,'active' from aliases`.execute(
        db,
      );
      const emit = async (parent: (typeof parents)[number]) =>
        expect(
          await store.complete(parent, [
            {
              name: JobName.AssetGenerateThumbnails,
              queue: childQueue,
              data: { id: parent.data.id, privateSource: 'redact-me' },
              options: { jobId: `private/${parent.data.id}` },
              safeToRetry: false,
              sensitive: true,
              deadlineMs: 65_432,
            },
          ]),
        ).toBe(true);
      await emit(parents[0]);
      await emit(parents[2]); // selected one and unselected control
      await drainCopies(childQueue, [context.claim]);
      const lateRun = await store.createRun('late-frozen-alias', {});
      await store.enqueue([
        {
          name: context.claim.name,
          queue: producerQueue,
          data: {},
          options: { deduplication: { id: producerKey } },
          safeToRetry: false,
          sensitive: false,
          deadlineMs: 300_000,
          runId: lateRun,
          itemKey: 'late-producer',
          rootItemKey: null,
        },
      ]);
      expect(await store.complete(context.claim, [])).toBe(true);
      await drainCopies(parentQueue);
      await drainCopies(childQueue, [context.claim]);
      const before = (await store.listRuns(500, 0)).find((run) => run.id === lateRun)!;
      expect(before.total).toBe(2);
      expect(before.stageTotals.total).toBe(4); // producer + 2 frozen parents + only selected first child
      await emit(parents[1]);
      expect((await store.listRuns(500, 0)).find((run) => run.id === lateRun)).toMatchObject({
        enumerationDone: false,
        finishedAt: null,
      });
      await drainCopies(childQueue, [context.claim]);
      expect(await store.feedManifest(childQueue)).toBe(3);
      await store.setConcurrency(childQueue, 3);
      const children = await store.claim(childQueue, worker, 3);
      retainedClaims.push(...children); // at most seven owned claims in this synthetic fixture
      for (const child of children) {
        if (selected.includes(String(child.data.id))) expect(await store.complete(child, [])).toBe(true);
      }
      await drainCopies(childQueue, [context.claim]);
      await drainCopies(childQueue, [context.claim]);
      await drainCopies(parentQueue);
      await drainCopies(parentQueue);
      const subsetDone = (await store.listRuns(500, 0)).find((run) => run.id === lateRun)!;
      expect(subsetDone).toMatchObject({ state: 'completed', enumerationDone: true });
      expect(subsetDone.finishedAt).not.toBeNull();
      expect(subsetDone.stageTotals.waiting).toBe(0);
      expect((await store.listRuns(500, 0)).find((run) => run.id === operationId)).toMatchObject({
        finishedAt: null,
        state: 'running',
        stageTotals: { active: 1 },
      });
      const unselected = children.find((child) => !selected.includes(String(child.data.id)))!;
      expect(await store.complete(unselected, [])).toBe(true);
      await drainCopies(childQueue, [context.claim]);
      await drainCopies(childQueue, [context.claim]);
      await sql`update job set "finishedAt"=now()-interval '8 days' where queue=${childQueue} or id=${context.claim.id}::uuid`.execute(
        db,
      );
      // Ordinary queue visits settle at most 250 alias headers, without completion-time fanout.
      await drainCopies(childQueue, [context.claim]);
      await drainCopies(childQueue, [context.claim]);
      await drainCopies(parentQueue);
      await drainCopies(parentQueue);
      // Complete copying before pruning; the frozen/root/lineage identities remain after payload unlink.
      await pruneQueueHistory(db);
      expect(
        (
          await sql`select id from job where id=any(${[context.claim.id, ...children.map((child) => child.id)]}::uuid[])`.execute(
            db,
          )
        ).rows,
      ).toEqual([]);
      const rows = (
        await sql<{
          rootItemKey: string;
          selection: unknown;
        }>`select i."rootItemKey",i.selection from job_run_item i join job_selection s on s.id=i."selectionId"
      where i."runId"=${lateRun}::uuid and s."sourceKind"='library-child'`.execute(db)
      ).rows;
      expect(rows.map((row) => row.rootItemKey).sort()).toEqual([...selected].sort());
      expect(rows.every((row) => JSON.stringify(row.selection) === '{}')).toBe(true);
      const summary = (await store.listRuns(500, 0)).find((run) => run.id === lateRun)!;
      expect(summary.total).toBe(2);
      expect(summary.stageTotals.total).toBe(5);
      expect(
        (
          await sql<{
            count: number;
            attempt: number;
          }>`select count(*)::int count,max(attempt)::int attempt from job_attempt
      where "jobId"=any(${parents.map((parent) => parent.id)}::uuid[])`.execute(db)
        ).rows[0],
      ).toEqual({ count: 3, attempt: 1 });
    } finally {
      await stopHeartbeat();
    }
  }, 600_000);
  it('does not grant child entitlement to a superseded frozen request sharing an active library executor', async () => {
    await accept(1, true);
    await store.feedManifest(queue);
    const [initial] = await store.claim(queue, worker);
    const parentQueue = `${queue}-latest-parent`,
      childQueue = `${queue}-latest-child`;
    await store.initialize([parentQueue, childQueue]);
    const id = String(initial.data.id);
    const options = { deduplication: { id: `${queue}/latest`, keepLastIfActive: true } };
    const intent = {
      name: JobName.SmartAlbumReevaluate,
      queue: parentQueue,
      data: { id, revision: 0 },
      options,
      safeToRetry: true,
      sensitive: false,
      deadlineMs: 62_345,
    };
    expect(await store.complete(initial, [intent])).toBe(true);
    await drainCopies(parentQueue);
    await store.feedManifest(parentQueue);
    const [parent] = await store.claim(parentQueue, worker);
    const requests: string[] = [];
    for (const revision of [1, 2]) {
      const runId = await freezeSelection(
        db,
        { ...intent, data: { revision } },
        db.selectFrom(sql<{ id: string }>`(select ${id}::text id)`.as('selected')).select('id'),
      );
      requests.push(runId);
      await store.enqueue([{ ...intent, data: { id, revision }, runId, itemKey: id, rootItemKey: id }]);
    }
    expect(
      (
        await sql`select state,"jobId" from job_run_item where "runId"=${requests[0]}::uuid and stage=${intent.name}`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ state: 'cancelled', jobId: null }]);
    expect(
      await store.complete(parent, [
        {
          name: JobName.AssetGenerateThumbnails,
          queue: childQueue,
          data: { id },
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 65_432,
        },
      ]),
    ).toBe(true);
    await drainCopies(childQueue);
    expect(
      (
        await sql`select 1 from job_selection_run m join job_selection s on s.id=m."selectionId"
      where m."runId"=${requests[0]}::uuid and s."sourceKind"='library-child'`.execute(db)
      ).rows,
    ).toEqual([]);
    expect(
      (
        await sql`select 1 from job_run_item i join job_selection s on s.id=i."selectionId"
      where i."runId"=${requests[0]}::uuid and s."sourceKind"='library-child'`.execute(db)
      ).rows,
    ).toEqual([]);
    const [replacement] = await store.claim(parentQueue, worker);
    expect(replacement).toMatchObject({ data: { id, revision: 2 }, attempt: 1 });
    expect(await store.complete(replacement, [])).toBe(true);
    expect(
      (
        await sql<{ count: number; attempt: number }>`select count(*)::int count,max(attempt)::int attempt
      from job_attempt where "jobId"=any(${[parent.id, replacement.id]}::uuid[])`.execute(db)
      ).rows,
    ).toEqual([{ count: 2, attempt: 1 }]);
    expect(await store.claim(parentQueue, worker)).toEqual([]);
  });

  it('redacts cancelled cold sensitive intents in at most 250 rows per maintenance visit while preserving paused valid sources', async () => {
    await accept(1, true);
    await store.feedManifest(queue);
    const [parent] = await store.claim(queue, worker);
    expect(await store.complete(parent, [])).toBe(true);
    const childQueue = `${queue}-cold-sensitive`;
    await store.initialize([childQueue]);
    await store.pause(childQueue, true);
    const intent = {
      name: JobName.AssetGenerateThumbnails,
      queue: childQueue,
      data: { secret: 'cold-secret' },
      options: { jobId: 'private-source' },
      safeToRetry: false,
      sensitive: true,
      deadlineMs: 65_432,
    };
    for (let after = 0; after < 300; after += 250)
      await db.transaction().execute(async (tx) => {
        await sql`select name from job_queue where name=${childQueue} for no key update`.execute(tx);
        await appendLibraryChildSources(
          tx,
          { operationId, jobId: parent.id, rootItemKey: String(parent.data.id) },
          Array.from({ length: Math.min(250, 300 - after) }, (_, index) => ({
            ...intent,
            data: { ...intent.data, revision: after + index },
            rootItemKey: String(parent.data.id),
          })),
        );
      });
    const remaining = async () =>
      (
        await sql<{ count: number }>`select count(*)::int count from job_run_item i
      join job_selection s on s.id=i."selectionId" where s.queue=${childQueue} and i."libraryIntent"->'data' != '{}'::jsonb`.execute(
          db,
        )
      ).rows[0].count;
    expect(await db.transaction().execute((tx) => redactLibrarySourcePage(tx, childQueue))).toBe(false);
    expect(await remaining()).toBe(300); // pausing valid work does not destroy its payload
    await sql`update job_selection set state='cancelled' where queue=${childQueue}`.execute(db);
    expect(await feedOnly(childQueue)).toBe(0);
    expect(await db.transaction().execute((tx) => redactLibrarySourcePage(tx, childQueue))).toBe(true);
    expect(await remaining()).toBe(250); // finish the remaining 50-row tail before revisiting the passed prefix
    expect(await db.transaction().execute((tx) => redactLibrarySourcePage(tx, childQueue))).toBe(true);
    expect(await remaining()).toBe(0);
    expect(await db.transaction().execute((tx) => redactLibrarySourcePage(tx, childQueue))).toBe(false);
    expect(
      (
        await sql<{
          count: number;
        }>`select count(*)::int count from job_run_item i join job_selection s on s.id=i."selectionId"
      where s.queue=${childQueue} and i."librarySourceKey" is not null and i."rootItemKey"=${String(parent.data.id)}
      and i.selection='{}'::jsonb and not (i."libraryIntent" ? 'options')`.execute(db)
      ).rows[0].count,
    ).toBe(300);
  });
  it.each(['cloudDescription', 'lockedIds', 'operationId'] as const)(
    'fails closed after restore for a safe-first/unsafe-later cold %s stage',
    async (variant) => {
      await accept(2, true);
      await store.feedManifest(queue);
      await store.setConcurrency(queue, 2);
      const parents = await store.claim(queue, worker, 2);
      const destination = `${queue}-mixed-restore`;
      await store.initialize([destination]);
      await store.pause(destination, true);
      jobs['handlers'][JobName.ImageEnrichmentPostprocess] = {
        jobName: JobName.ImageEnrichmentPostprocess,
        queueName: destination as QueueName,
        label: 'mixed classification',
        handler: () => Promise.resolve(JobStatus.Success),
      };
      const safe = jobs['intent']({
        name: JobName.ImageEnrichmentPostprocess,
        data: { id: parents[0].data.id },
      } as never);
      const unsafe = jobs['intent']({
        name: JobName.ImageEnrichmentPostprocess,
        data: {
          id: parents[1].data.id,
          [variant]:
            variant === 'lockedIds'
              ? ['locked-asset']
              : variant === 'operationId'
                ? randomUUID()
                : { description: 'private-cloud-result' },
        },
      } as never);
      expect(safe.safeToRetry).toBe(true);
      expect(unsafe.safeToRetry).toBe(false);
      expect(await store.complete(parents[0], [{ ...safe, sensitive: true }])).toBe(true);
      expect(
        (
          await sql<{
            safeToRetry: boolean;
          }>`select "safeToRetry" from job_selection where queue=${destination}`.execute(db)
        ).rows[0].safeToRetry,
      ).toBe(true);
      expect(await store.complete(parents[1], [{ ...unsafe, sensitive: true }])).toBe(true);
      expect(
        (
          await sql<{
            safeToRetry: boolean;
          }>`select "safeToRetry" from job_selection where queue=${destination}`.execute(db)
        ).rows[0].safeToRetry,
      ).toBe(false);
      expect((await sql`select id from job where queue=${destination}`.execute(db)).rows).toEqual([]);
      await resetQueueAfterRestore(db);
      await drainCopies(destination);
      await store.pause(destination, false);
      expect(await store.feedManifest(destination)).toBe(0);
      expect(await store.claim(destination, worker)).toEqual([]);
      const rows = (
        await sql<{ state: string; libraryIntent: QueueIntent }>`select s.state,i."libraryIntent" from job_run_item i
        join job_selection s on s.id=i."selectionId" where s.queue=${destination} and i."runId"=s."runId"`.execute(db)
      ).rows;
      expect(rows).toHaveLength(2);
      expect(
        rows.every(
          (row) =>
            row.state === 'needs_attention' &&
            JSON.stringify(row.libraryIntent.data) === '{}' &&
            !row.libraryIntent.options,
        ),
      ).toBe(true);
      expect(
        (await sql`select 1 from job_attempt a join job j on j.id=a."jobId" where j.queue=${destination}`.execute(db))
          .rows,
      ).toEqual([]);
    },
  );

  it('refuses a queue-run UUID without a real active library-scan domain operation', async () => {
    const run = await store.createRun('invalid-domain-negative', {});
    await expect(jobs.ensureLibraryScanSource({ operationId: run, libraryId: library.id }, false)).rejects.toThrow(
      'no longer active',
    );
    expect((await sql`select id from job_selection where id=${run}::uuid`.execute(db)).rows).toEqual([]);
  });

  it.each(['owner', 'secondary'] as const)(
    'settles a stopped %s header without reviving or vetoing the healthy shared operation',
    async (stopped) => {
      const accepted = await accept(2, true);
      if (!accepted || !('value' in accepted)) throw new Error('Expected actual roots');
      const [shared, exclusiveA] = accepted.value;
      const otherLibrary = await libraries.create({
        ownerId: library.ownerId,
        name: 'Real shared-operation fixture',
        importPaths: ['/external/secondary'],
        exclusionPatterns: [],
      });
      const created = await operations.createUnlessActive(
        {
          ownerId: library.ownerId,
          kind: MediaOperationKind.LibraryScan,
          destination: MediaOperationDestination.Local,
          destinationDetail: null,
          label: 'Secondary domain fixture',
          snapshot: { libraryId: otherLibrary.id, trigger: 'manual' },
          settings: {},
          estimate: null,
          result: emptyLibraryScanResult() as unknown as Record<string, unknown>,
        },
        { key: 'libraryId', value: otherLibrary.id, lock: DatabaseLock.Library },
      );
      if (!('created' in created)) throw new Error('Expected real secondary operation');
      const secondary = created.created.id,
        token = randomUUID();
      await sql`update media_operation set status=${MediaOperationStatus.Rendering},"claimToken"=${token}::uuid,"claimExpiresAt"=now()+interval '5 minutes' where id=${secondary}::uuid`.execute(
        db,
      );
      await jobs.ensureLibraryScanSource({ operationId: secondary, libraryId: otherLibrary.id }, false);
      let exclusiveB = '';
      await jobs.commitLibraryScanBatch(
        { operationId: secondary, libraryId: otherLibrary.id },
        2,
        async (tx) => {
          const result = await libraries.withScanClaim(
            {
              operationId: secondary,
              claimToken: token,
              libraryId: otherLibrary.id,
              fingerprint: libraryPathsFingerprint(otherLibrary),
            },
            async (assets) => {
              [exclusiveB] = await assets.createAll([
                libraryAssetFromFile(
                  { path: '/external/secondary/exclusive.jpg', mtime: new Date(1_700_000_000_000) },
                  { ownerId: library.ownerId, libraryId: otherLibrary.id },
                  (value) => createHash('sha1').update(value).digest(),
                  false,
                ),
              ]);
              expect(
                await operations.setBulkResult(
                  secondary,
                  token,
                  {
                    result: { ...emptyLibraryScanResult(), phase: 'done', checked: 2 },
                    processedUnits: 2,
                    totalUnits: 2,
                    progress: 100,
                    leaseMs: 300_000,
                  },
                  tx,
                  true,
                ),
              ).toMatchObject({
                status: MediaOperationStatus.Rendering,
                cancelRequestedAt: null,
                pauseRequestedAt: null,
              });
              return [shared, exclusiveB];
            },
            tx,
          );
          return {
            value: result,
            assetIds: result && 'value' in result ? result.value : [],
            accepted: !!result && 'value' in result,
          };
        },
        true,
      );
      const origin = await wake(JobName.LibraryScanQueueAll, `${queue}-mixed-secondary-origin`);
      await queueExecution.run(origin, () =>
        jobs.ensureLibraryScanSource({ operationId: secondary, libraryId: otherLibrary.id }),
      );
      await store.complete(origin.claim, []);
      const originRun = (
        await sql<{ runId: string }>`select "runId" from job where id=${origin.claim.id}::uuid`.execute(db)
      ).rows[0].runId;
      await drainCopies(queue);
      await store.feedManifest(queue);
      await store.setConcurrency(queue, 4);
      const initial = await store.claim(queue, worker, 4);
      expect(initial).toHaveLength(4);
      const smartQueue = `${queue}-shared-parent`,
        destination = `${queue}-shared-private-child`,
        nextQueue = `${queue}-healthy-next`;
      await store.initialize([smartQueue, destination, nextQueue]);
      await store.pause(destination, true);
      for (const parent of initial)
        if (parent.data.id === shared)
          expect(
            await store.complete(parent, [
              {
                name: JobName.SmartAlbumReevaluate,
                queue: smartQueue,
                data: { id: shared, kind: 'all' },
                options: getManifestJobOptions(JobName.SmartAlbumReevaluate, { id: shared, kind: 'all' }),
                safeToRetry: true,
                sensitive: false,
                deadlineMs: 61_234,
              },
            ]),
          ).toBe(true);
      await drainCopies(smartQueue);
      expect(await store.feedManifest(smartQueue)).toBe(1);
      const [parent] = await store.claim(smartQueue, worker);
      expect(await store.complete(parent, [])).toBe(true);
      const safe: QueueIntent = {
        name: JobName.ImageEnrichmentPostprocess,
        queue: destination,
        data: { id: shared, secret: 'safe-private' },
        options: { delay: 0 },
        safeToRetry: true,
        sensitive: true,
        deadlineMs: 65_432,
      };
      // Accepted real shared parent; fix first ownership deterministically for both directions.
      await db.transaction().execute(async (tx) => {
        await sql`select name from job_queue order by name for no key update`.execute(tx);
        const owners = new Map<string, { runId: string; itemKey: string; rootItemKey: string | null }>();
        await appendLibraryChildSources(tx, { operationId, jobId: parent.id, rootItemKey: shared }, [safe], owners);
        await appendLibraryChildSources(
          tx,
          { operationId: secondary, jobId: parent.id, rootItemKey: shared },
          [safe],
          owners,
        );
      });
      await drainCopies(destination);
      const sharedOutcome = async (run: string) =>
        (await store.listRunItems(run, 10, 0))!.find(
          (item) => item.id === createHash('md5').update(`${run}:${shared}`).digest('hex'),
        )!;
      expect((await sharedOutcome(originRun)).outcome).toBe('paused');
      const unsafeRoot = stopped === 'owner' ? exclusiveA : exclusiveB;
      const unsafeParent = initial.find((parent) => parent.data.id === unsafeRoot)!;
      expect(
        await store.complete(unsafeParent, [
          { ...safe, data: { id: unsafeRoot, operationId: randomUUID() }, safeToRetry: false },
        ]),
      ).toBe(true);
      for (const pending of initial)
        if (pending.data.id !== shared && pending.id !== unsafeParent.id)
          expect(await store.complete(pending, [])).toBe(true);
      await resetQueueAfterRestore(db);
      await drainCopies(destination);
      expect((await sharedOutcome(originRun)).outcome).toBe('needsAttention');
      const payloads = (
        await sql<{
          runId: string;
          libraryIntent: QueueIntent;
        }>`select i."runId",i."libraryIntent" from job_run_item i join job_selection s on s.id=i."selectionId" where s.queue=${destination} and i."runId"=s."runId"`.execute(
          db,
        )
      ).rows;
      const stoppedId = stopped === 'owner' ? operationId : secondary;
      expect(
        payloads
          .filter((row) => row.runId === stoppedId)
          .every((row) => JSON.stringify(row.libraryIntent.data) === '{}' && !row.libraryIntent.options),
      ).toBe(true);
      if (stopped === 'secondary')
        expect(payloads.find((row) => row.runId === operationId)!.libraryIntent).toMatchObject({
          data: safe.data,
          options: safe.options,
        });
      await store.pause(destination, false);
      if (stopped === 'owner') {
        expect(await store.feedManifest(destination)).toBe(0);
        expect(await store.claim(destination, worker)).toEqual([]);
      } else {
        expect(await store.feedManifest(destination)).toBe(1);
        const [child] = await store.claim(destination, worker);
        expect(child).toMatchObject({ runId: operationId, attempt: 1, data: safe.data, deadlineMs: safe.deadlineMs });
        expect((await sharedOutcome(originRun)).outcome).toBe('needsAttention'); // active A cannot mask cold stopped B
        expect(
          await store.complete(child, [
            {
              name: JobName.AssetDetectFaces,
              queue: nextQueue,
              data: { id: shared },
              safeToRetry: true,
              sensitive: false,
              deadlineMs: 61_234,
            },
          ]),
        ).toBe(true);
        expect((await sql`select "runId" from job_selection where queue=${nextQueue}`.execute(db)).rows).toEqual([
          { runId: operationId },
        ]);
        await drainCopies(nextQueue);
        expect(await store.feedManifest(nextQueue)).toBe(1);
        const [next] = await store.claim(nextQueue, worker);
        expect(next).toMatchObject({ runId: operationId, attempt: 1 });
        expect(await store.complete(next, [])).toBe(true);
        expect((await sql`select attempt from job_attempt where "jobId"=${child.id}::uuid`.execute(db)).rows).toEqual([
          { attempt: 1 },
        ]);
      }
      await drainCopies(destination);
      expect((await sharedOutcome(originRun)).outcome).toBe('needsAttention');
      expect((await store.listRuns(20, 0)).find((run) => run.id === originRun)!.stageTotals.waiting).toBe(0);
      await sql`update job_run_item set state='cancelled' where "runId"=${originRun}::uuid and stage=${safe.name}`.execute(
        db,
      );
      expect((await sharedOutcome(originRun)).outcome).toBe('cancelled');
      const late = await wake(JobName.LibraryScanQueueAll, `${queue}-mixed-secondary-late`);
      await queueExecution.run(late, () =>
        jobs.ensureLibraryScanSource({ operationId: secondary, libraryId: otherLibrary.id }),
      );
      await store.complete(late.claim, []);
      await drainCopies(destination);
      await drainCopies(queue);
      await drainCopies(smartQueue);
      const lateRun = (
        await sql<{ runId: string }>`select "runId" from job where id=${late.claim.id}::uuid`.execute(db)
      ).rows[0].runId;
      expect((await sharedOutcome(lateRun)).outcome).toBe('needsAttention');
      expect((await store.listRuns(20, 0)).find((run) => run.id === lateRun)!.stageTotals.waiting).toBe(0);
      expect(
        (
          await sql`select 1 from job_selection where "libraryOperationId"=${secondary}::uuid and queue=${nextQueue}`.execute(
            db,
          )
        ).rows,
      ).toEqual([]);
    },
  );

  it.each([SCALE_ITEMS / 10, SCALE_ITEMS])(
    'bounds physical cleanup/control SQL work behind %i blocked shared owners and fairly revisits arrivals',
    async (size) => {
      const destination = `${queue}-privacy-prefix`,
        secondary = await store.createRun('privacy-prefix-fixture', {});
      const ownerSource = randomUUID(),
        secondarySource = randomUUID();
      await store.initialize([destination]);
      await store.pause(destination, true);
      for (const [source, run] of [
        [ownerSource, operationId],
        [secondarySource, secondary],
      ]) {
        await sql`insert into job_selection(id,"runId",stage,queue,"safeToRetry",sensitive,"deadlineMs",state,"sourceKind","libraryOperationId","capturedAt","sourceClosedAt")
        values (${source}::uuid,${run}::uuid,'library-child/privacy-prefix',${destination},true,true,60000,'ready','library-child',${run}::uuid,now(),now())`.execute(
          db,
        );
      }
      const declared: QueueIntent = {
        name: JobName.AssetGenerateThumbnails,
        queue: destination,
        data: { secret: 'private-prefix' },
        options: { delay: 0 },
        safeToRetry: true,
        sensitive: true,
        deadlineMs: 60_000,
      };
      type Plan = {
        'Node Type': string;
        'Relation Name'?: string;
        'Index Name'?: string;
        'Actual Rows': number;
        'Actual Loops': number;
        'Rows Removed by Filter'?: number;
        Plans?: Plan[];
      };
      const scans = (node: Plan): Plan[] =>
        [node, ...(node.Plans ?? []).flatMap((child) => scans(child))].filter(
          (node) => node['Relation Name'] === 'job_run_item',
        );
      const key = `frameleaf-library-redact/${destination}`;
      let visits = 0,
        maximumPageMs = 0,
        maximumControlMs = 0,
        maximumScannedRows = 0,
        maximumCommitted = 0;
      const started = performance.now();
      try {
        // Large fixture creation is deliberately separate from production admission/control work.
        for (let first = 1; first <= size + 1; first += 250) {
          await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"selectionId",state,"librarySourceKey","libraryIntent","libraryOriginComplete")
        select ${operationId}::uuid,'owner/'||n,'media/'||n,${declared.name},${destination},'{}'::jsonb,${ownerSource}::uuid,
          case when n=${size + 1} then 'completed' else 'pending' end,'owner/'||n,'{"data":{},"sensitive":false}'::jsonb,true
          from generate_series(${first}::int,${Math.min(first + 249, size + 1)}::int) n order by n`.execute(db);
          await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"selectionId",state,"librarySourceKey","libraryIntent","libraryOriginComplete","libraryExecutionRunId","libraryExecutionItemKey")
        select ${secondary}::uuid,'secondary/'||n,'media/'||n,${declared.name},${destination},'{"privateCopy":"discard"}'::jsonb,${secondarySource}::uuid,
          'pending','secondary/'||n,${JSON.stringify(declared)}::text::jsonb,true,${operationId}::uuid,'owner/'||n
          from generate_series(${first}::int,${Math.min(first + 249, size + 1)}::int) n order by n`.execute(db);
        }
        await sql`analyze job_run_item`.execute(db);
        // Executable negative control: filtering owners BEFORE LIMIT reads the blocked prefix
        // or exhausts the unchanged five-second control lifetime. It is never production code.
        let negativeScanned = 0,
          negativeDeadline = false;
        try {
          const result = await sql<{ 'QUERY PLAN': { Plan: Plan }[] }>`explain (analyze,buffers,format json)
          select i."itemKey" from job_run_item i where i.queue=${destination} and i."runId"=${secondary}::uuid
            and i."libraryIntent"->>'sensitive'='true' and (${libraryCanonicalState('i')}) not in ('pending','waiting','active')
          order by i."libraryCleanupId" limit 250`.execute(db);
          negativeScanned = Math.max(
            ...scans(result.rows[0]['QUERY PLAN'][0].Plan).map(
              (node) => (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'],
            ),
          );
          expect(negativeScanned).toBeGreaterThan(250);
        } catch (error) {
          expect(String(error)).toMatch(/abort|cancel|timeout|timed out|expired/i);
          negativeDeadline = true;
        }
        // EXPLAIN executes the EXACT production mutation, with its real catalogue lock order.
        console.info(
          'library-privacy-prefix-estimated-plan',
          JSON.stringify(
            (
              await sql`
          explain (format json) ${libraryRedactionPage(destination)}`.execute(db)
            ).rows[0],
          ),
        );
        const firstStarted = performance.now();
        const explanation = await withExecutionCleanup(() =>
          db.transaction().execute(async (tx) => {
            await sql`select name from job_queue order by name for no key update`.execute(tx);
            return sql<{
              'QUERY PLAN': { Plan: Plan }[];
            }>`explain (analyze,buffers,format json) ${libraryRedactionPage(destination)}`.execute(tx);
          }),
        );
        maximumPageMs = performance.now() - firstStarted;
        visits++;
        for (const node of scans(explanation.rows[0]['QUERY PLAN'][0].Plan)) {
          const touched = (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'];
          maximumScannedRows = Math.max(maximumScannedRows, touched);
          expect(touched).toBeLessThanOrEqual(250);
        }
        expect(
          scans(explanation.rows[0]['QUERY PLAN'][0].Plan).some((node) =>
            ['job_library_redact_cursor', 'job_library_redact_all_cursor'].includes(node['Index Name'] ?? ''),
          ),
        ).toBe(true);
        const cursor = async () =>
          (await sql<{ value: Record<string, string> }>`select value from system_metadata where key=${key}`.execute(db))
            .rows[0].value;
        const firstCursor = await cursor();
        expect(BigInt(firstCursor.after)).toBeLessThan(BigInt(firstCursor.through));
        const dirty = async (...keys: string[]) =>
          (
            await sql<{ count: number }>`select count(*)::int count from job_run_item where "runId"=${secondary}::uuid
        and "itemKey"=any(${keys}::text[]) and "libraryIntent"->'data'!='{}'::jsonb`.execute(db)
          ).rows[0].count;
        expect(await dirty('secondary/1', `secondary/${size + 1}`)).toBe(2);
        // An owner passed by this cycle becomes terminal; a new eligible intent arrives beyond
        // its captured ceiling. Both must be revisited, without resetting to the live prefix.
        await sql`update job_run_item set state='completed' where "runId"=${operationId}::uuid and "itemKey"='owner/1' and stage=${declared.name}`.execute(
          db,
        );
        await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"selectionId",state,"librarySourceKey","libraryIntent","libraryOriginComplete","libraryExecutionRunId","libraryExecutionItemKey")
        values (${secondary}::uuid,'arrival','media/1',${declared.name},${destination},'{}'::jsonb,${secondarySource}::uuid,'pending','arrival',${JSON.stringify(declared)}::text::jsonb,true,${operationId}::uuid,'owner/1')`.execute(
          db,
        );
        const visit = async () => {
          const before = performance.now();
          const page = withExecutionCleanup(() =>
            db.transaction().execute(async (tx) => {
              await sql`select name from job_queue order by name for no key update`.execute(tx);
              return libraryRedactionPage(destination).execute(tx);
            }),
          );
          const controlStarted = performance.now();
          const control = withExecutionCleanup(async () => {
            await store.pause(destination, true); // real control write contends on the guarded catalogue row
            expect(await store.isPaused(destination)).toBe(true);
          }, 3000).then(() => {
            maximumControlMs = Math.max(maximumControlMs, performance.now() - controlStarted);
          });
          const [result] = await Promise.all([page, control]);
          maximumPageMs = Math.max(maximumPageMs, performance.now() - before);
          maximumCommitted = Math.max(maximumCommitted, result.rows[0].redacted);
          expect(result.rows[0].visited).toBeLessThanOrEqual(250);
          expect(result.rows[0].redacted).toBeLessThanOrEqual(250);
          visits++;
        };
        for (
          let remaining = Math.ceil((size + 1) / 250);
          Object.keys(await cursor()).length > 0 && remaining > 0;
          remaining--
        )
          await visit();
        expect(await cursor()).toEqual({});
        expect(await dirty(`secondary/${size + 1}`)).toBe(0); // eligible behind the entire blocked prefix
        expect(await dirty('secondary/1', 'arrival')).toBe(2); // current pass cannot ingest late arrivals
        for (
          let remaining = Math.ceil((size + 2) / 250) + 1;
          (await dirty('secondary/1', 'arrival')) > 0 && remaining > 0;
          remaining--
        )
          await visit();
        expect(await dirty('secondary/1', 'arrival')).toBe(0);
        expect(await dirty('secondary/2')).toBe(1); // valid paused owner retains its payload/options
        expect((await sql`select id from job where queue=${destination}`.execute(db)).rows).toEqual([]);
        expect(maximumPageMs).toBeLessThan(5000);
        expect(maximumControlMs).toBeLessThan(3000);
        console.info(
          'library-privacy-prefix-calibration',
          JSON.stringify({
            size,
            visits,
            maximumPageMs,
            maximumControlMs,
            maximumScannedRows,
            maximumCommitted,
            negativeScanned,
            negativeDeadline,
            elapsedMs: performance.now() - started,
          }),
        );
      } finally {
        // afterEach closes both execution connections and drops only this synthetic clone.
        // No fixture-sized row deletion runs under a production control transaction.
      }
    },
    600_000,
  );

  it('preserves an explicitly independent full intent while publishing inherited library work', async () => {
    await accept(1, true);
    await store.feedManifest(queue);
    const [parent] = await store.claim(queue, worker);
    const destination = `${queue}-independent`;
    await store.initialize([destination]);
    const independentRun = await store.createRun('independent-library-followup', {});
    const independent: QueueIntent = {
      name: JobName.AssetExtractMetadata,
      queue: destination,
      data: { id: 'independent-asset', destination: { model: 'separate-pin' } },
      options: { jobId: 'separate-physical-id' },
      safeToRetry: false,
      sensitive: false,
      deadlineMs: 65_432,
      runId: independentRun,
      itemKey: 'separate-item',
      rootItemKey: 'separate-root',
    };
    expect(
      await store.complete(parent, [
        independent,
        {
          name: JobName.AssetGenerateThumbnails,
          queue: destination,
          data: { id: parent.data.id },
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 61_234,
        },
      ]),
    ).toBe(true);
    const [actual] = await store.claim(destination, worker);
    expect(actual).toMatchObject({
      name: independent.name,
      data: independent.data,
      runId: independentRun,
      itemKey: 'separate-item',
      rootItemKey: 'separate-root',
      safeToRetry: false,
      deadlineMs: 65_432,
    });
    expect((await sql`select "externalId" from job where id=${actual.id}::uuid`.execute(db)).rows).toEqual([
      { externalId: 'separate-physical-id' },
    ]);
    expect(
      (
        await sql`select 1 from job_run_item i join job_selection s on s.id=i."selectionId"
      where s."sourceKind"='library-child' and i.stage=${independent.name} and s."libraryOperationId"=${operationId}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([]);
    expect(await store.complete(actual, [])).toBe(true);
    await drainCopies(destination);
    expect(await store.feedManifest(destination)).toBe(1);
    const [inherited] = await store.claim(destination, worker);
    expect(inherited).toMatchObject({
      name: JobName.AssetGenerateThumbnails,
      runId: operationId,
      rootItemKey: String(parent.data.id),
    });
    expect(await store.complete(inherited, [])).toBe(true);
  });

  it('gives two canonical library operations one unkeyed physical child and one attempt budget', async () => {
    const accepted = await accept(1, true);
    const root = accepted && 'value' in accepted ? accepted.value[0] : undefined;
    if (!root) throw new Error('Expected actual accepted asset');
    const otherLibrary = await libraries.create({
      ownerId: library.ownerId,
      name: 'Shared physical root',
      importPaths: ['/external/source'],
      exclusionPatterns: [],
    });
    const other = await operations.createUnlessActive(
      {
        ownerId: library.ownerId,
        kind: MediaOperationKind.LibraryScan,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: 'Shared root operation',
        snapshot: { libraryId: otherLibrary.id, trigger: 'manual' },
        settings: {},
        estimate: null,
        result: emptyLibraryScanResult() as unknown as Record<string, unknown>,
      },
      { key: 'libraryId', value: otherLibrary.id, lock: DatabaseLock.Library },
    );
    if (!('created' in other)) throw new Error('Expected independent domain operation');
    const otherId = other.created.id,
      otherToken = randomUUID();
    await sql`update media_operation set status=${MediaOperationStatus.Rendering},"claimToken"=${otherToken}::uuid,"claimExpiresAt"=now()+interval '5 minutes' where id=${otherId}::uuid`.execute(
      db,
    );
    await jobs.ensureLibraryScanSource({ operationId: otherId, libraryId: otherLibrary.id }, false);
    await jobs.commitLibraryScanBatch(
      { operationId: otherId, libraryId: otherLibrary.id },
      1,
      async (tx) => {
        const result = await libraries.withScanClaim(
          {
            operationId: otherId,
            claimToken: otherToken,
            libraryId: otherLibrary.id,
            fingerprint: libraryPathsFingerprint(otherLibrary),
          },
          async () => {
            expect(
              await operations.setBulkResult(
                otherId,
                otherToken,
                {
                  result: { ...emptyLibraryScanResult(), phase: 'done', checked: 1 },
                  processedUnits: 1,
                  totalUnits: 1,
                  progress: 100,
                  leaseMs: 300_000,
                },
                tx,
                true,
              ),
            ).toMatchObject({
              status: MediaOperationStatus.Rendering,
              cancelRequestedAt: null,
              pauseRequestedAt: null,
            });
            return [root];
          },
          tx,
        );
        return {
          value: result,
          assetIds: result && 'value' in result ? result.value : [],
          accepted: !!result && 'value' in result,
        };
      },
      true,
    );
    await store.setConcurrency(queue, 2);
    expect(await store.feedManifest(queue)).toBe(2);
    const parents = await store.claim(queue, worker, 2);
    expect(parents).toHaveLength(2);
    const parentQueue = `${queue}-shared-smart`,
      childQueue = `${queue}-shared-unkeyed`;
    await store.initialize([parentQueue, childQueue]);
    for (const parent of parents)
      expect(
        await store.complete(parent, [
          {
            name: JobName.SmartAlbumReevaluate,
            queue: parentQueue,
            data: { id: root, kind: 'all' },
            options: getManifestJobOptions(JobName.SmartAlbumReevaluate, { id: root, kind: 'all' }),
            safeToRetry: true,
            sensitive: false,
            deadlineMs: 61_234,
          },
        ]),
      ).toBe(true);
    await drainCopies(parentQueue);
    expect(await store.feedManifest(parentQueue)).toBe(1);
    const [physicalParent] = await store.claim(parentQueue, worker);
    expect(
      (
        await sql`select distinct s."libraryOperationId" from job_run_item i join job_selection s on s.id=i."selectionId"
      where i."jobId"=${physicalParent.id}::uuid and i."runId"=s."runId"`.execute(db)
      ).rows,
    ).toHaveLength(2);
    expect(
      await store.complete(physicalParent, [
        {
          name: JobName.AssetGenerateThumbnails,
          queue: childQueue,
          data: { id: root, destination: 'unchanged-pin' },
          safeToRetry: false,
          sensitive: false,
          deadlineMs: 65_432,
        },
      ]),
    ).toBe(true);
    await drainCopies(childQueue);
    // The first visit admits the owner; a second may only link the other source's accounting.
    expect(await store.feedManifest(childQueue)).toBe(1);
    // Complete before the secondary source has been fed; its next-stage entitlement must survive.
    expect(
      (
        await sql`select i."jobId" from job_run_item i join job_selection s on s.id=i."selectionId"
      where s.queue=${childQueue} and i."runId"=s."runId" and i."jobId" is null`.execute(db)
      ).rows,
    ).toHaveLength(1);
    const [child] = await store.claim(childQueue, worker);
    expect(child).toMatchObject({
      data: { id: root, destination: 'unchanged-pin' },
      safeToRetry: false,
      deadlineMs: 65_432,
      attempt: 1,
    });
    expect((await sql`select "dedupKey" from job where id=${child.id}::uuid`.execute(db)).rows).toEqual([
      { dedupKey: null },
    ]);
    const nextQueue = `${queue}-shared-next`;
    await store.initialize([nextQueue]);
    expect(
      await store.complete(child, [
        {
          name: JobName.AssetDetectFaces,
          queue: nextQueue,
          data: { id: root, model: 'same-pin' },
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 62_345,
        },
      ]),
    ).toBe(true);
    expect(
      (await sql`select id from job_selection where queue=${nextQueue} and "sourceKind"='library-child'`.execute(db))
        .rows,
    ).toHaveLength(2);
    expect(await store.feedManifest(childQueue)).toBe(0);
    await drainCopies(childQueue);
    await drainCopies(nextQueue);
    expect(await store.feedManifest(nextQueue)).toBe(1);
    expect(await store.feedManifest(nextQueue)).toBe(0);
    const [next] = await store.claim(nextQueue, worker);
    expect(next).toMatchObject({ data: { id: root, model: 'same-pin' }, deadlineMs: 62_345, attempt: 1 });
    expect(await store.complete(next, [])).toBe(true);
    await drainCopies(nextQueue);
    await drainCopies(childQueue);
    expect(
      (
        await sql`select distinct i."jobId" from job_run_item i join job_selection s on s.id=i."selectionId"
      where s.queue=${childQueue} and i."runId"=s."runId"`.execute(db)
      ).rows,
    ).toEqual([{ jobId: child.id }]);
    expect((await sql`select id from job where queue=${childQueue}`.execute(db)).rows).toHaveLength(1);
    expect((await sql`select attempt from job_attempt where "jobId"=${child.id}::uuid`.execute(db)).rows).toEqual([
      { attempt: 1 },
    ]);
    for (const id of [operationId, otherId])
      expect((await store.listRuns(20, 0)).find((run) => run.id === id)).toMatchObject({
        total: 1,
        state: 'completed',
      });
  });

  it('preserves pre-feed ordinary library aliases and explicit cancellation after actual job pruning and late copying', async () => {
    const producerQueue = `${queue}-retained-origin`,
      producerKey = `${queue}/retained`;
    const originContext = await wake(JobName.LibraryScanQueueAll, producerQueue, {
      deduplication: { id: producerKey },
    });
    await queueExecution.run(originContext, () => jobs.ensureLibraryScanSource({ operationId, libraryId: library.id }));
    await accept(1, true);
    await store.complete(originContext.claim, []);
    const origin = (
      await sql<{ runId: string }>`select "runId" from job where id=${originContext.claim.id}::uuid`.execute(db)
    ).rows[0].runId;
    await drainCopies(queue);
    const before = (
      await sql`select "jobId",state from job_run_item where "runId"=${origin}::uuid and stage=${JobName.SidecarCheck}`.execute(
        db,
      )
    ).rows;
    expect(before).toEqual([{ jobId: null, state: 'pending' }]);
    await store.feedManifest(queue);
    const [parent] = await store.claim(queue, worker);
    const childQueue = `${queue}-retained-child`;
    await store.initialize([childQueue]);
    await store.pause(childQueue, true);
    await store.complete(parent, [
      {
        name: JobName.AssetGenerateThumbnails,
        queue: childQueue,
        data: { id: parent.data.id },
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 61_234,
      },
    ]);
    await drainCopies(childQueue);
    expect(
      (
        await sql`select "jobId",state from job_run_item where "runId"=${origin}::uuid and stage=${JobName.AssetGenerateThumbnails}`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ jobId: null, state: 'pending' }]);
    const cancelled = await store.createRun('cancelled-retained-alias', {});
    await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"selectionId",state)
      select ${cancelled}::uuid,"itemKey","rootItemKey",stage,queue,'{}'::jsonb,"selectionId",'cancelled' from job_run_item
      where "runId"=${origin}::uuid and stage=${JobName.AssetGenerateThumbnails}`.execute(db);
    await store.pause(childQueue, false);
    await store.feedManifest(childQueue);
    const [child] = await store.claim(childQueue, worker);
    await store.complete(child, []);
    await drainCopies(queue);
    await drainCopies(childQueue);
    expect((await store.listRuns(20, 0)).find((run) => run.id === origin)!.finishedAt).not.toBeNull();
    await sql`update job set "finishedAt"=now()-interval '8 days' where id=any(${[originContext.claim.id, parent.id, child.id]}::uuid[])`.execute(
      db,
    );
    for (let visit = 0; visit < 4; visit++) await pruneQueueHistory(db);
    expect(
      (await sql`select id from job where id=any(${[originContext.claim.id, parent.id, child.id]}::uuid[])`.execute(db))
        .rows,
    ).toEqual([]);
    const summary = (await store.listRuns(20, 0)).find((run) => run.id === origin)!;
    expect(summary).toMatchObject({ state: 'completed', total: 1 });
    expect(summary.stageTotals).toMatchObject({ completed: 3, waiting: 0 });
    expect((await store.listRunItems(cancelled, 10, 0))![0]).toMatchObject({ outcome: 'cancelled' });
    const late = await wake(JobName.LibraryScanQueueAll, `${queue}-retained-late`);
    await queueExecution.run(late, () => jobs.ensureLibraryScanSource({ operationId, libraryId: library.id }));
    await store.complete(late.claim, []);
    await drainCopies(queue);
    await drainCopies(childQueue);
    const lateRun = (await sql<{ runId: string }>`select "runId" from job where id=${late.claim.id}::uuid`.execute(db))
      .rows[0].runId;
    expect((await store.listRunItems(lateRun, 10, 0))![0]).toMatchObject({ outcome: 'completed' });
    expect((await store.listRuns(20, 0)).find((run) => run.id === lateRun)!.stageTotals.waiting).toBe(0);
  });

  it('redacts a deferred sensitive library intent behind an unconfirmed stop under a ready header, including copied and late aliases', async () => {
    await accept(1, true);
    await store.feedManifest(queue);
    const [parent] = await store.claim(queue, worker);
    const destination = `${queue}-deferred-private`,
      key = `${queue}/private-latest`;
    await store.initialize([destination]);
    const options = { deduplication: { id: key, keepLastIfActive: true } };
    await store.enqueue([
      {
        name: JobName.AssetExtractMetadata,
        queue: destination,
        data: { id: 'predecessor' },
        options,
        safeToRetry: true,
        sensitive: true,
        deadlineMs: 61_234,
      },
    ]);
    const [prior] = await store.claim(destination, worker);
    const origin = await wake(JobName.LibraryScanQueueAll, `${queue}-deferred-origin`);
    await queueExecution.run(origin, () => jobs.ensureLibraryScanSource({ operationId, libraryId: library.id }));
    await store.complete(origin.claim, []);
    expect(
      await store.complete(parent, [
        {
          name: JobName.AssetExtractMetadata,
          queue: destination,
          data: { id: parent.data.id, secret: 'private-deferred' },
          options,
          safeToRetry: false,
          sensitive: true,
          deadlineMs: 65_432,
        },
      ]),
    ).toBe(true);
    await drainCopies(destination);
    expect(await store.feedManifest(destination)).toBe(0);
    const retained = async () =>
      (
        await sql<{
          state: string;
          headerState: string;
          libraryIntent: QueueIntent;
          librarySourceKey: string;
          rootItemKey: string;
          jobId: string | null;
        }>`
      select i.state,s.state "headerState",i."libraryIntent",i."librarySourceKey",i."rootItemKey",i."jobId" from job_run_item i join job_selection s on s.id=i."selectionId"
      where s.queue=${destination} and i."runId"=s."runId"`.execute(db)
      ).rows[0];
    expect(await retained()).toMatchObject({ state: 'pending', headerState: 'ready', jobId: null });
    const originRun = (
      await sql<{ runId: string }>`select "runId" from job where id=${origin.claim.id}::uuid`.execute(db)
    ).rows[0].runId;
    expect(
      (
        await sql`select state,"jobId" from job_run_item where "runId"=${originRun}::uuid and stage=${JobName.AssetExtractMetadata}`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ state: 'pending', jobId: null }]);
    await sql`insert into system_metadata(key,value) values
      (${'frameleaf-attempt-evidence:' + prior.token},${JSON.stringify({ jobId: randomUUID(), stoppedAt: Date.now() })}::text::jsonb),
      (${'frameleaf-worker-stopped:' + worker},${JSON.stringify({ workerId: randomUUID(), stoppedAt: Date.now() })}::text::jsonb)`.execute(
      db,
    );
    await sql`update job set "leaseExpiresAt"=clock_timestamp()-interval '1 second' where id=${prior.id}::uuid`.execute(
      db,
    );
    await store.recoverExpired();
    await sql`update job set "leaseExpiresAt"=clock_timestamp()-interval '31 seconds' where id=${prior.id}::uuid`.execute(
      db,
    );
    await store.recoverExpired();
    await drainCopies(destination);
    const value = await retained();
    expect(value).toMatchObject({
      state: 'needs_attention',
      headerState: 'ready',
      jobId: null,
      rootItemKey: String(parent.data.id),
    });
    expect(value.librarySourceKey).toHaveLength(64);
    expect(value.libraryIntent.data).toEqual({});
    expect(value.libraryIntent.options).toBeUndefined();
    expect((await store.listRunItems(originRun, 10, 0))![0]).toMatchObject({ outcome: 'needsAttention' });
    const late = await wake(JobName.LibraryScanQueueAll, `${queue}-deferred-late`);
    await queueExecution.run(late, () => jobs.ensureLibraryScanSource({ operationId, libraryId: library.id }));
    await store.complete(late.claim, []);
    await drainCopies(queue);
    await drainCopies(destination);
    const lateRun = (await sql<{ runId: string }>`select "runId" from job where id=${late.claim.id}::uuid`.execute(db))
      .rows[0].runId;
    expect((await store.listRunItems(lateRun, 10, 0))![0]).toMatchObject({ outcome: 'needsAttention' });
    expect(await store.feedManifest(destination)).toBe(0);
    expect(await store.claim(destination, worker)).toEqual([]);
    expect((await sql`select id from job where queue=${destination}`.execute(db)).rows).toEqual([{ id: prior.id }]);
  });
});

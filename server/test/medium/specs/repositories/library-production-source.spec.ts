import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobName, JobStatus, MediaOperationKind, MediaOperationStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { shareSelectionPage } from 'src/queue/manifest.js';
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
import { explainLibraryRunRead, getLibraryQueueDB, profileLibraryRunRead } from 'test/medium/library-queue-database.js';
import { MediumTestContext } from 'test/medium.factory.js';

const libraryLedgerShape = () => sql<{
  rows: number;
  maximumItemKeyLength: number | null;
  maximumSourceKeyLength: number | null;
  intentRows: number;
  runs: number;
}>`select coalesce(sum(rows),0)::int rows,
  max("maximumItemKeyLength")::int "maximumItemKeyLength",
  max("maximumSourceKeyLength")::int "maximumSourceKeyLength",
  coalesce(sum("intentRows"),0)::int "intentRows",count(*)::int runs
  from (select "runId",count(*) rows,max(length("itemKey")) "maximumItemKeyLength",
    max(length("librarySourceKey")) "maximumSourceKeyLength",
    count(*) filter (where "libraryIntent" is not null) "intentRows"
    from job_run_item group by "runId") per_run`;

it('preserves ledger diagnostics for empty and multiple-run ledgers', async () => {
  const db = await getLibraryQueueDB();
  const store = new SqlQueueStore(db);
  const original = () =>
    sql`select count(*)::int rows,
    max(length("itemKey"))::int "maximumItemKeyLength",max(length("librarySourceKey"))::int "maximumSourceKeyLength",
    count(*) filter (where "libraryIntent" is not null)::int "intentRows",count(distinct "runId")::int runs
    from job_run_item`.execute(db);
  try {
    const empty = (await libraryLedgerShape().execute(db)).rows;
    expect(empty).toEqual((await original()).rows);
    expect(empty).toEqual([
      { rows: 0, maximumItemKeyLength: null, maximumSourceKeyLength: null, intentRows: 0, runs: 0 },
    ]);
    await store.initialize([QueueName.Sidecar]);
    const first = await store.createRun('diagnostic-first', {});
    const second = await store.createRun('diagnostic-second', {});
    await sql`insert into job_run_item("runId","itemKey",stage,queue,selection,"librarySourceKey","libraryIntent")
      values (${first}::uuid,'x',${JobName.SidecarCheck},${QueueName.Sidecar},'{}',null,null),
        (${first}::uuid,'long-key',${JobName.SidecarCheck},${QueueName.Sidecar},'{}','12345','{}'),
        (${second}::uuid,'yyy',${JobName.SidecarCheck},${QueueName.Sidecar},'{}',null,null)`.execute(db);
    const populated = (await libraryLedgerShape().execute(db)).rows;
    expect(populated).toEqual((await original()).rows);
    expect(populated).toEqual([
      { rows: 3, maximumItemKeyLength: 8, maximumSourceKeyLength: 5, intentRows: 1, runs: 2 },
    ]);
  } finally {
    await db.destroy();
  }
});

/** Synthetic read-only paths, real service/queue/domain/asset/source SQL. This does not decode media. */
it('scans 500000 paths through manual/QueueAll/tick entrypoints with operation-owned sources and bounded control reads', async () => {
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
    async *walkLibrary(options: Parameters<StorageRepository['walkLibrary']>[0]) {
      activeIterators++;
      maximumActiveIterators = Math.max(maximumActiveIterators, activeIterators);
      try {
        for (const root of options.pathsToCrawl) {
          const count = root === '/external/one' ? 499_999 : 1;
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
    const sources = (
      await sql<{
        id: string;
        state: string;
        sourceClosedAt: Date | null;
      }>`select id,state,"sourceClosedAt" from job_selection
      where "sourceKind"='library-initial' order by id`.execute(db)
    ).rows;
    expect(sources).toHaveLength(2);
    expect(sources.every((source) => source.state === 'enumerating' && source.sourceClosedAt === null)).toBe(true);
    expect(sources.map((source) => source.id)).toContain(requested.operation.id);
    expect(sources.map((source) => source.id)).not.toContain(origin);
    expect((await store.listRuns(10, 0)).find((run) => run.id === origin)).toMatchObject({
      total: 0,
      enumerationDone: false,
      finishedAt: null,
    });
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
    } = await sql<{ assets: number; sources: number; media: number; open: number; hot: number }>`
      select (select count(*)::int from asset where "libraryId"=any(${[first.id, second.id]}::uuid[])) assets,
        (select count(*)::int from job_selection where "sourceKind"='library-initial') sources,
        (select count(*)::int from job_run_item i join job_selection s on s.id=i."selectionId" where s."sourceKind"='library-initial' and i."runId"=s."runId") media,
        (select count(*)::int from job_selection where "sourceKind"='library-initial' and ("sourceClosedAt" is null or "capturedAt" is null or state!='ready')) open,
        (select count(*)::int from job where queue=${QueueName.Sidecar} and state in ('pending','waiting','active')) hot`.execute(
      db,
    );
    expect(counts).toEqual({ assets: 500_000, sources: 2, media: 500_000, open: 0, hot: 0 });
    let visits = 0,
      maximumCopyPage = 0,
      maximumControlMs = 0,
      previousCopied = 0;
    while (await shareSelectionPage(db, { queue: QueueName.Sidecar })) {
      visits++;
      const copyStarted = performance.now();
      // Fixed two-source metadata query, never a count over the growing 500k alias manifest.
      const cursors = (
        await sql<{ copyAfter: string | null }>`select m."copyAfter" from job_selection_run m
          join job_selection s on s.id=m."selectionId" where m."runId"=${origin}::uuid
          and s."sourceKind"='library-initial'`.execute(db)
      ).rows;
      maximumControlMs = Math.max(maximumControlMs, performance.now() - copyStarted);
      const copied = cursors.reduce((total, cursor) => total + Number(cursor.copyAfter?.split('/').at(-1) ?? 0), 0);
      maximumCopyPage = Math.max(maximumCopyPage, copied - previousCopied);
      previousCopied = copied;
    }
    const ledgerQuery = libraryLedgerShape().compile(db);
    // Estimated plan of this diagnostic itself; no extra full-ledger execution or connection.
    console.info(
      'library-service-ledger-estimated-plan',
      JSON.stringify(
        (
          await db.executeQuery({
            ...ledgerQuery,
            sql: 'explain (format json) ' + ledgerQuery.sql,
          })
        ).rows[0],
      ),
    );
    const ledgerStarted = performance.now();
    const ledgerShape = (await db.executeQuery(ledgerQuery)).rows[0];
    console.info(
      'library-service-ledger-shape',
      JSON.stringify({ ...ledgerShape, elapsedMs: performance.now() - ledgerStarted }),
    );
    const summaryStarted = performance.now();
    const summary = await (async () => {
      try {
        return (await store.listRuns(10, 0)).find((run) => run.id === origin)!;
      } catch (error) {
        console.info('library-service-summary-estimated-plan', JSON.stringify(await explainLibraryRunRead(db)));
        await profileLibraryRunRead(db);
        throw error;
      }
    })();
    maximumControlMs = Math.max(maximumControlMs, performance.now() - summaryStarted);
    expect(summary.total).toBe(500_000);
    expect(summary.stageTotals.total).toBe(500_001);
    expect(summary.enumerationDone).toBe(true);
    expect(summary.state).toBe('paused');
    expect(maximumWalkPage).toBe(1000);
    expect(maximumActiveIterators).toBe(1);
    expect(activeIterators).toBe(0);
    expect(maximumCopyPage).toBeLessThanOrEqual(250);
    expect(await store.feedManifest(QueueName.Sidecar)).toBe(0);
    await store.pause(QueueName.Sidecar, false);
    for (let page = 0; page < 4; page++) expect(await store.feedManifest(QueueName.Sidecar)).toBe(250);
    expect(await store.feedManifest(QueueName.Sidecar)).toBe(0);
    expect((await store.counts(QueueName.Sidecar)).waiting).toBe(1000);
    console.info(
      'library-service-source-calibration',
      JSON.stringify({
        paths: 500_000,
        sourceHeaders: 2,
        maximumWalkPage,
        maximumCopyPage,
        maximumActiveIterators,
        visits,
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
}, 600_000);

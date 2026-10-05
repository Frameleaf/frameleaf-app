import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, PetRecognitionRunStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { pruneQueueHistory } from 'src/queue/retention.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueClaim } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PetRecognitionRun, PetRepository } from 'src/repositories/pet.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { getLibraryQueueDB } from 'test/medium/library-queue-database.js';
import { newMediumService } from 'test/medium.factory.js';

/** Real queue transitions and transactions; fixture setup replaces media/ML work only. */
describe('pet run reconciliation with canonical queue outcomes', () => {
  let db: Kysely<DB>;
  let store: SqlQueueStore;
  let pets: PetRepository;
  let jobs: JobRepository;
  let queue: string;
  let workerId: string;

  beforeAll(async () => {
    db = await getLibraryQueueDB();
    store = new SqlQueueStore(db);
    pets = new PetRepository(db, LoggingRepository.create());
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    queue = `pet-reconciliation-${randomUUID()}`;
    workerId = randomUUID();
    await store.initialize([queue], workerId);
    jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    jobs['handlers'][JobName.PetRecognitionQueueAll] = { queueName: queue as QueueName } as never;
  });

  const newOwner = async () => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    return (await ctx.newUser()).user.id;
  };
  const start = (ownerId: string) =>
    pets.startRun(ownerId, 'local', (tx, runId) =>
      jobs.queueInTransaction(tx, { name: JobName.PetRecognitionQueueAll, data: { userId: ownerId } }, runId),
    );
  const inClaim = <T>(claim: QueueClaim, action: () => Promise<T>) =>
    queueExecution.run(
      {
        claim,
        signal: new AbortController().signal,
        progress: () => {},
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: false,
      },
      action,
    );
  const fail = async (claim: QueueClaim) => {
    // The bounded fixture handler returned; this is positive stop evidence, not lease expiry.
    await recordStoppedAttempt(db, claim.id, claim.token);
    await store.fail(claim, 'fixture setup failure');
  };
  const retry = async (claim: QueueClaim) => {
    await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
    const [next] = await store.claim(queue, workerId);
    expect(next.id).toBe(claim.id);
    expect(next.attempt).toBe(2);
    return next;
  };

  it('executes the production status query for an owner with no queue or domain run', async () => {
    const ownerId = await newOwner();
    expect(await pets.getRun(ownerId)).toBeUndefined();
    const domain = await pets.startRun(ownerId, 'local');
    expect(await pets.getRun(ownerId)).toMatchObject({ id: domain.id, status: PetRecognitionRunStatus.Queued });
  });

  it.each([
    ['pending', 'needs_attention', PetRecognitionRunStatus.Failed],
    ['pending', 'cancelled', PetRecognitionRunStatus.Cancelled],
    ['completed', 'needs_attention', PetRecognitionRunStatus.Completed],
  ] as const)(
    'reconciles a retained %s shared executor under a %s cold header',
    async (itemState, headerState, expected) => {
      const ownerId = await newOwner(),
        domain = await pets.startRun(ownerId, 'local');
      const executorRun = await store.createRun('library-executor-status-fixture', {});
      const secondaryRun = await store.createRun('library-secondary-status-fixture', {});
      const ownerSource = randomUUID(),
        secondarySource = randomUUID();
      for (const [source, run, state] of [
        [ownerSource, executorRun, headerState],
        [secondarySource, secondaryRun, 'ready'],
      ] as const) {
        await sql`insert into job_selection(id,"runId",stage,queue,"safeToRetry",sensitive,"deadlineMs",state,
        "sourceKind","libraryOperationId","capturedAt","sourceClosedAt")
        values (${source}::uuid,${run}::uuid,'library-child/pet-status',${queue},true,false,60000,${state},
          'library-child',${run}::uuid,now(),now())`.execute(db);
        await sql`insert into job_selection_run("selectionId","runId","copyComplete") values (${source}::uuid,${run}::uuid,true)`.execute(
          db,
        );
      }
      await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"selectionId",state)
      values (${executorRun}::uuid,'owner','media-root',${JobName.PetRecognition},${queue},'{}'::jsonb,${ownerSource}::uuid,${itemState})`.execute(
        db,
      );
      await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"selectionId",state,"libraryExecutionRunId","libraryExecutionItemKey")
      values (${secondaryRun}::uuid,'secondary','media-root',${JobName.PetRecognition},${queue},'{}'::jsonb,${secondarySource}::uuid,'pending',${executorRun}::uuid,'owner')`.execute(
        db,
      );
      await sql`update job_run set "enumerationDone"=true,"finishedAt"=now() where id=${secondaryRun}::uuid`.execute(
        db,
      );
      await pets.linkRun(domain.id, secondaryRun);
      // No detailed job exists: outcome and source decision must survive payload/job retention.
      expect(await pets.getRun(ownerId)).toMatchObject({ id: domain.id, status: expected });
      expect(await pets.getRun(ownerId)).toMatchObject({ id: domain.id, status: expected });
      expect((await sql`select id from job where queue=${queue}`.execute(db)).rows).toEqual([]);
    },
  );

  it('rolls back the replacement domain run, canonical run, linkage and admission together', async () => {
    const ownerId = await newOwner();
    const prior = await pets.startRun(ownerId, 'local');
    let attemptedId: string | undefined;
    await expect(
      pets.startRun(ownerId, 'local', async (tx, runId) => {
        attemptedId = runId;
        await jobs.queueInTransaction(tx, { name: JobName.PetRecognitionQueueAll, data: { userId: ownerId } }, runId);
        throw new Error('crash before admission commit');
      }),
    ).rejects.toThrow('crash before admission commit');
    expect(await pets.getRun(ownerId)).toMatchObject({ id: prior.id, status: PetRecognitionRunStatus.Queued });
    const { rows } = await sql`select id from job_run where id = ${attemptedId}::uuid`.execute(db);
    expect(rows).toEqual([]);
    expect(await store.claim(queue, workerId)).toEqual([]);
    const metadata = await sql`select key from system_metadata where key = ${'frameleaf-pet-run:' + ownerId}`.execute(
      db,
    );
    expect(metadata.rows).toEqual([]);
  });

  it('keeps one safe retry and reconciles exhausted setup after payload/attempt retention', async () => {
    const ownerId = await newOwner();
    const run = await start(ownerId);
    const [first] = await store.claim(queue, workerId);
    await inClaim(first, async () => {
      expect(await jobs.ensureProducerRun()).toBe(run.id);
      await expect(
        jobs.prepareCheckpoint('pet-runs', () => Promise.reject(new Error('checkpoint setup interrupted'))),
      ).rejects.toThrow('checkpoint setup interrupted');
    });
    await fail(first);
    expect(await pets.getRun(ownerId)).toMatchObject({ id: run.id, status: PetRecognitionRunStatus.Queued });
    expect(await store.claim(queue, workerId)).toEqual([]); // durable retry backoff
    const second = await retry(first);
    await fail(second);
    await sql`update job set "finishedAt" = now() - interval '31 days' where id = ${first.id}::uuid`.execute(db);
    await pruneQueueHistory(db);
    const history = await sql`select id from job where id = ${first.id}::uuid`.execute(db);
    expect(history.rows).toEqual([]);
    expect(await pets.getRun(ownerId)).toMatchObject({
      id: run.id,
      status: PetRecognitionRunStatus.Failed,
      processedCount: 0,
      proposalCount: 0,
    });
    expect(await pets.getRun(ownerId)).toMatchObject({ status: PetRecognitionRunStatus.Failed });
    expect(await store.claim(queue, workerId)).toEqual([]);
  });

  it('reuses a nightly setup checkpoint and preserves owner cancellation and replacement', async () => {
    const ownerId = await newOwner();
    const cancelledOwner = await newOwner();
    const replacedOwner = await newOwner();
    await jobs.queue({ name: JobName.PetRecognitionQueueAll, data: {} });
    const [first] = await store.claim(queue, workerId);
    const prepared = await inClaim(first, async () => {
      const queueRunId = (await jobs.ensureProducerRun())!;
      return jobs.prepareCheckpoint('pet-runs', async () => {
        const runs: PetRecognitionRun[] = [];
        for (const owner of [ownerId, cancelledOwner, replacedOwner]) {
          const run = await pets.startRun(owner, null);
          await pets.linkRun(run.id, queueRunId);
          runs.push(run);
        }
        return runs;
      });
    });
    await fail(first); // process returned after checkpoint, before selection freeze
    await pets.cancelRun(cancelledOwner);
    const replacement = await pets.startRun(replacedOwner, null);
    const second = await retry(first);
    await inClaim(second, async () => {
      expect(await jobs.ensureProducerRun()).toBe(first.runId);
      const resumed = await jobs.prepareCheckpoint('pet-runs', () =>
        Promise.reject(new Error('must not repeat committed domain setup')),
      );
      expect(resumed).toEqual(JSON.parse(JSON.stringify(prepared)));
    });
    await fail(second);
    expect(await pets.getRun(ownerId)).toMatchObject({ id: prepared[0].id, status: PetRecognitionRunStatus.Failed });
    expect(await pets.getRun(cancelledOwner)).toMatchObject({ status: PetRecognitionRunStatus.Cancelled });
    expect(await pets.getRun(replacedOwner)).toMatchObject({
      id: replacement.id,
      status: PetRecognitionRunStatus.Queued,
    });
  });

  it('reuses pre-setup run attachment when freezing a successful empty selection', async () => {
    const ownerId = await newOwner();
    const run = await start(ownerId);
    const [claim] = await store.claim(queue, workerId);
    jobs['handlers'][JobName.PetRecognition] = { queueName: queue as QueueName } as never;
    await inClaim(claim, async () => {
      expect(await jobs.ensureProducerRun()).toBe(run.id);
      await jobs.queueSelection(
        JobName.PetRecognition,
        db
          .selectFrom('asset')
          .select('id')
          .where(sql<boolean>`false`),
      );
      expect(claim.runId).toBe(run.id);
    });
    await store.complete(claim, []);
    expect(await pets.getRun(ownerId)).toMatchObject({ id: run.id, status: PetRecognitionRunStatus.Completed });
    const { rows } = await sql`select id from job_selection where "runId" = ${run.id}::uuid`.execute(db);
    expect(rows).toHaveLength(1);
  });

  it('keeps paused and dependency-deferred work live, then reflects canonical cancellation', async () => {
    const ownerId = await newOwner();
    const run = await start(ownerId);
    await store.pause(queue, true);
    expect(await pets.getRun(ownerId)).toMatchObject({ id: run.id, status: PetRecognitionRunStatus.Queued });
    await store.pause(queue, false);
    const [claim] = await store.claim(queue, workerId);
    await store.defer(claim, 'destination-unavailable');
    expect(await pets.getRun(ownerId)).toMatchObject({ status: PetRecognitionRunStatus.Queued });
    await store.clear(queue, ['pending', 'waiting']);
    expect(await pets.getRun(ownerId)).toMatchObject({ status: PetRecognitionRunStatus.Cancelled });
    expect(await store.claim(queue, workerId)).toEqual([]);
  });

  it('reflects an unconfirmed executor stop as failure without replaying its effects', async () => {
    const ownerId = await newOwner();
    const run = await start(ownerId);
    const [claim] = await store.claim(queue, workerId);
    await sql`update job set "leaseExpiresAt" = now() - interval '2 minutes' where id = ${claim.id}::uuid`.execute(db);
    await store.recoverExpired();
    const {
      rows: [outcome],
    } = await sql<{ state: string; attempt: number }>`select state, attempt from job
      where id = ${claim.id}::uuid`.execute(db);
    expect(outcome).toEqual({ state: 'needs_attention', attempt: 1 });
    expect(await pets.getRun(ownerId)).toMatchObject({ id: run.id, status: PetRecognitionRunStatus.Failed });
    expect(await store.claim(queue, workerId)).toEqual([]);
  });

  it('refuses a replaced or different-owner explicit request and fences stale producer attachment', async () => {
    const ownerId = await newOwner();
    const otherOwner = await newOwner();
    const old = await start(ownerId);
    const [claim] = await store.claim(queue, workerId);
    const replacement = await start(ownerId);
    await pets.startRun(otherOwner, null);
    expect(await pets.getRun(ownerId, old.id)).toBeUndefined();
    expect(await pets.getRun(otherOwner, old.id)).toBeUndefined();
    expect(await pets.getRun(ownerId, replacement.id)).toMatchObject({ id: replacement.id });
    await fail(claim);
    await inClaim(claim, async () => {
      await expect(jobs.ensureProducerRun()).rejects.toThrow('lost its claim');
    });
  });
});

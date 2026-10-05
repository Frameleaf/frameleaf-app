import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueCommand, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueExecution } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { QueueService } from 'src/services/queue.service.js';
import { getKyselyDB, newTestService } from 'test/utils.js';

describe('atomic initial run admission', () => {
  let db: Kysely<any>;
  let jobs: JobRepository;
  let store: SqlQueueStore;
  let queue: string;
  let workerId: string;
  const item = () => ({ name: JobName.ImageDescriptionQueueAll, data: { force: true } }) as const;
  const submit = () => jobs.createRun(queue, {}, () => jobs.queue(item()));
  const runs = () => db.selectFrom('job_run').selectAll().where('kind', '=', queue).execute();
  const assertNoAdmission = async () => {
    expect(await runs()).toEqual([]);
    expect(await db.selectFrom('job').select('id').where('queue', '=', queue).execute()).toEqual([]);
    expect(await db.selectFrom('job_run_item').select('runId').where('queue', '=', queue).execute()).toEqual([]);
  };
  const assertFinished = async (ids: string[]) => {
    const rows = await db.selectFrom('job_run').selectAll().where('id', 'in', ids).execute();
    expect(rows).toHaveLength(ids.length);
    for (const row of rows) {
      expect(row.enumerationDone).toBe(true);
      expect(row.finishedAt).not.toBeNull();
    }
  };

  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    queue = `run-admission-${randomUUID()}`;
    workerId = randomUUID();
    await store.initialize([queue], workerId);
    jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    for (const name of [JobName.ImageDescriptionQueueAll, JobName.LibraryScanRun, JobName.AssetEncodeVideoQueueAll]) {
      jobs['handlers'][name] = { queueName: queue as QueueName } as never;
    }
  });

  it('discards prepared intents when later validation fails and exposes nothing during preparation', async () => {
    await expect(
      jobs.createRun(queue, {}, async () => {
        await jobs.queue(item());
        await assertNoAdmission();
        throw new Error('validation rejected');
      }),
    ).rejects.toThrow('validation rejected');
    await assertNoAdmission();
  });

  it('rolls back the run, intents and item ledger after an actual SQL admission failure', async () => {
    const admissionStore = jobs['store'];
    const enqueue = admissionStore.enqueue.bind(admissionStore);
    const injected = vi.spyOn(admissionStore, 'enqueue').mockImplementationOnce(async (intents, tx) => {
      await enqueue(intents, tx);
      await sql`select 1 / 0`.execute(tx!);
    });
    try {
      await expect(submit()).rejects.toThrow(/division by zero/);
      await assertNoAdmission();
    } finally {
      injected.mockRestore();
    }
    const accepted = await submit();
    const [claim] = await store.claim(queue, workerId);
    expect(claim.runId).toBe(accepted);
    expect(await store.complete(claim, [])).toBe(true);
    await assertFinished([accepted]);
  });

  it('settles an accepted empty selection immediately', async () => {
    const id = await jobs.createRun(queue, {}, async () => {});
    await assertFinished([id]);
    expect(await store.claim(queue, workerId)).toEqual([]);
  });

  it('rejects oversized initial submissions before admission', async () => {
    await expect(jobs.createRun(queue, {}, () => jobs.queueAll(Array.from({ length: 251 }, item)))).rejects.toThrow(
      'limited to 250 initial intents',
    );
    await assertNoAdmission();
  });

  it('rejects nested admissions and independent transactional admission before either can write', async () => {
    await expect(jobs.createRun(queue, {}, () => submit().then(() => {}))).rejects.toThrow('cannot be nested');
    await expect(
      jobs.createRun(queue, {}, () => db.transaction().execute((tx) => jobs.queueInTransaction(tx, item()))),
    ).rejects.toThrow('independent transaction');
    await assertNoAdmission();
  });

  it('rejects manifest admission inside the callback before materializing a selection', async () => {
    await expect(
      jobs.createRun(queue, {}, () =>
        jobs.queueSelection(JobName.ImageDescription, db.selectFrom('asset').select('id')),
      ),
    ).rejects.toThrow('not queueSelection');
    await assertNoAdmission();
  });

  it('attaches concurrent deduplicated starts to one job and settles both accepted runs', async () => {
    const ids = await Promise.all([submit(), submit()]);
    expect(new Set(ids).size).toBe(2);
    const claims = await store.claim(queue, workerId);
    expect(claims).toHaveLength(1);
    const memberships = await db.selectFrom('job_run_item').selectAll().where('runId', 'in', ids).execute();
    expect(memberships).toHaveLength(2);
    expect(new Set(memberships.map((row) => row.jobId))).toEqual(new Set([claims[0].id]));
    expect(await store.complete(claims[0], [])).toBe(true);
    await assertFinished(ids);
  });

  it('retains latest-active replacement accounting until that replacement actually completes', async () => {
    const start = () => jobs.createRun(queue, {}, () => jobs.queue({ name: JobName.LibraryScanRun }));
    const firstId = await start();
    const [first] = await store.claim(queue, workerId);
    const latestId = await start();
    expect(await store.complete(first, [])).toBe(true);
    await assertFinished([firstId]);
    expect((await runs()).find((run) => run.id === latestId)).toMatchObject({ finishedAt: null });
    const [latest] = await store.claim(queue, workerId);
    expect(latest.runId).toBe(latestId);
    expect(await store.complete(latest, [])).toBe(true);
    await assertFinished([latestId]);
  });

  it.each(['pending', 'active'] as const)(
    'settles four %s producer replacements without closing an independent active run',
    async (state) => {
      await store.setConcurrency(queue, 2);
      const independentId = await submit();
      const [independent] = await store.claim(queue, workerId);
      const start = (force = false) =>
        jobs.createRun(queue, {}, () => jobs.queue({ name: JobName.LibraryScanRun, data: { force } }));
      const ids = [await start()];
      const predecessor = state === 'active' ? (await store.claim(queue, workerId))[0] : undefined;
      for (let replacement = 0; replacement < 4; replacement++) ids.push(await start(replacement === 3));
      const cancelled = ids.slice(state === 'active' ? 1 : 0, -1);
      await assertFinished(cancelled);
      const reads = await store.listRuns(100, 0);
      for (const id of cancelled) {
        expect(reads.find((run) => run.id === id)).toMatchObject({
          enumerationDone: true,
          state: 'cancelled',
          total: 0,
          stageTotals: { total: 1, cancelled: 1, active: 0, waiting: 0 },
        });
      }
      expect(reads.find((run) => run.id === independentId)).toMatchObject({
        enumerationDone: false,
        finishedAt: null,
        state: 'running',
        stageTotals: { active: 1 },
      });
      if (predecessor) expect(await store.complete(predecessor, [])).toBe(true);
      const claims = await store.claim(queue, workerId);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ runId: ids.at(-1), data: { force: true }, attempt: 1 });
      expect(await store.complete(claims[0], [])).toBe(true);
      await assertFinished(ids);
      expect(await store.claim(queue, workerId)).toEqual([]);
      expect(await db.selectFrom('job_attempt').select('attempt').where('jobId', '=', claims[0].id).execute()).toEqual([
        { attempt: 1 },
      ]);
      expect((await runs()).find((run) => run.id === independentId)).toMatchObject({ finishedAt: null });
      expect(await store.complete(independent, [])).toBe(true);
      await assertFinished([independentId]);
    },
  );

  it('waits for durable unadmitted descendant stages after a producer is superseded', async () => {
    await store.setConcurrency(queue, 2);
    const originalId = await jobs.createRun(queue, {}, () =>
      jobs.queueAll([{ name: JobName.LibraryScanRun }, { name: JobName.AssetEncodeVideoQueueAll, data: {} }]),
    );
    const claims = await store.claim(queue, workerId);
    expect(claims).toHaveLength(2);
    const replaced = claims.find((claim) => claim.name === JobName.LibraryScanRun)!;
    const producer = claims.find((claim) => claim.name === JobName.AssetEncodeVideoQueueAll)!;
    await queueExecution.run(
      {
        claim: producer,
        signal: new AbortController().signal,
        progress: () => {},
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: false,
      },
      () =>
        jobs.queueSelection(
          JobName.ImageDescriptionQueueAll,
          db.selectFrom('job_run').select('id').where('id', '=', originalId),
        ),
    );
    expect(await store.complete(producer, [])).toBe(true);
    await store.defer(replaced, 'source-unavailable');
    const latestId = await jobs.createRun(queue, {}, () => jobs.queue({ name: JobName.LibraryScanRun }));
    expect((await runs()).find((run) => run.id === originalId)).toMatchObject({
      enumerationDone: true,
      finishedAt: null,
    });
    const descendant = await db
      .selectFrom('job_run_item')
      .selectAll()
      .where('runId', '=', originalId)
      .where('rootItemKey', '=', originalId)
      .executeTakeFirstOrThrow();
    expect(descendant).toMatchObject({ state: 'pending', jobId: null });
    expect(await store.feedManifest(queue)).toBe(1);
    const finalClaims = await store.claim(queue, workerId);
    expect(finalClaims).toHaveLength(2);
    for (const claim of finalClaims) expect(await store.complete(claim, [])).toBe(true);
    await assertFinished([originalId, latestId]);
    const read = (await store.listRuns(100, 0)).find((run) => run.id === originalId);
    expect(read).toMatchObject({
      state: 'cancelled',
      total: 1,
      completed: 1,
      stageTotals: { total: 3, completed: 2, cancelled: 1 },
    });
  });

  it('preserves a stopped manifest producer across reload and supersession until its descendants settle', async () => {
    await store.setConcurrency(queue, 2);
    const start = (force = false) =>
      jobs.createRun(queue, {}, () => jobs.queue({ name: JobName.LibraryScanRun, data: { force } }));
    const originalId = await start();
    const [producer] = await store.claim(queue, workerId);
    const freeze = (claim: typeof producer, id: string) =>
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
        () =>
          jobs.queueSelection(
            JobName.ImageDescriptionQueueAll,
            db.selectFrom('job_run').select('id').where('id', '=', id),
          ),
      );
    await freeze(producer, originalId);
    await store.defer(producer, 'source-unavailable');
    const replacements: string[] = [];
    for (let replacement = 0; replacement < 4; replacement++) replacements.push(await start(replacement === 3));
    await assertFinished(replacements.slice(0, -1));
    expect((await runs()).find((run) => run.id === originalId)).toMatchObject({
      enumerationDone: false,
      finishedAt: null,
    });
    expect(
      await db.selectFrom('job').select(['runId', 'data']).where('id', '=', producer.id).executeTakeFirstOrThrow(),
    ).toMatchObject({ runId: originalId, data: { force: false } });

    // Reload only persisted state, as a replacement worker does; no previous execution context survives.
    const restarted = new SqlQueueStore(db);
    await sql`update job set "availableAt" = now() where id = ${producer.id}::uuid`.execute(db);
    const resumed = await restarted.claim(queue, workerId);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ id: producer.id, runId: originalId, attempt: 2 });
    await freeze(resumed[0], randomUUID()); // retry reuses the original snapshot, not the changed selection
    expect(await db.selectFrom('job_selection').select('id').where('runId', '=', originalId).execute()).toHaveLength(1);
    expect(await restarted.complete(resumed[0], [])).toBe(true);
    expect((await runs()).find((run) => run.id === originalId)).toMatchObject({
      enumerationDone: true,
      finishedAt: null,
    });
    expect(await restarted.feedManifest(queue)).toBe(1);
    const finalClaims = await restarted.claim(queue, workerId);
    expect(finalClaims).toHaveLength(2);
    const latest = finalClaims.find((claim) => claim.name === JobName.LibraryScanRun)!;
    const descendant = finalClaims.find((claim) => claim.name === JobName.ImageDescriptionQueueAll)!;
    expect(latest).toMatchObject({ runId: replacements.at(-1), data: { force: true }, attempt: 1 });
    expect(descendant).toMatchObject({ runId: originalId, data: { id: originalId } });
    for (const claim of finalClaims) expect(await restarted.complete(claim, [])).toBe(true);
    await assertFinished([originalId, ...replacements]);
    expect(await restarted.claim(queue, workerId)).toEqual([]);
    expect(await db.selectFrom('job_attempt').select('attempt').where('jobId', '=', latest.id).execute()).toEqual([
      { attempt: 1 },
    ]);
    expect((await restarted.listRuns(100, 0)).find((run) => run.id === originalId)).toMatchObject({
      state: 'completed',
      total: 1,
      completed: 1,
      stageTotals: { total: 2, completed: 2 },
    });
  });

  it('preserves a stopped checkpoint owner even before it has materialized a selection', async () => {
    const start = () => jobs.createRun(queue, {}, () => jobs.queue({ name: JobName.LibraryScanRun }));
    const originalId = await start();
    const [producer] = await store.claim(queue, workerId);
    const checkpoint = { domainRunId: randomUUID() };
    await queueExecution.run(
      {
        claim: producer,
        signal: new AbortController().signal,
        progress: () => {},
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: false,
      },
      () => jobs.prepareCheckpoint('setup', () => Promise.resolve(checkpoint)),
    );
    await store.defer(producer, 'source-unavailable');
    const latestId = await start();
    expect(
      await db.selectFrom('job').select(['runId', 'data']).where('id', '=', producer.id).executeTakeFirstOrThrow(),
    ).toMatchObject({ runId: originalId, data: { _producerCheckpoints: { setup: checkpoint } } });
    await sql`update job set "availableAt" = now() where id = ${producer.id}::uuid`.execute(db);
    const [resumed] = await store.claim(queue, workerId);
    expect(resumed.runId).toBe(originalId);
    expect(await store.complete(resumed, [])).toBe(true);
    const [latest] = await store.claim(queue, workerId);
    expect(latest.runId).toBe(latestId);
    expect(await store.complete(latest, [])).toBe(true);
    await assertFinished([originalId, latestId]);
    expect(await store.claim(queue, workerId)).toEqual([]);
  });

  it('rolls back deferred child run admission with parent publication, then admits it once on acceptance', async () => {
    await jobs.queue(item());
    const [parent] = await store.claim(queue, workerId);
    const context: QueueExecution = {
      claim: parent,
      signal: new AbortController().signal,
      progress: () => {},
      progressUnits: 0,
      adoptions: [],
      followups: [],
      buffering: true,
    };
    const childId = await queueExecution.run(context, () =>
      jobs.createRun(queue, {}, () => jobs.queue({ name: JobName.AssetEncodeVideoQueueAll, data: {} })),
    );
    expect(await runs()).toEqual([]);
    await expect(
      store.complete(parent, [], async (tx) => {
        for (const adopt of context.adoptions) await adopt(tx);
        throw new Error('parent publication rolled back');
      }),
    ).rejects.toThrow('parent publication rolled back');
    expect(await runs()).toEqual([]);
    expect(await db.selectFrom('job').select('id').where('parentId', '=', parent.id).execute()).toEqual([]);
    expect(
      await store.complete(parent, [], async (tx) => {
        for (const adopt of context.adoptions) await adopt(tx);
      }),
    ).toBe(true);
    const [child] = await store.claim(queue, workerId);
    expect(child.runId).toBe(childId);
    expect(await store.complete(child, [])).toBe(true);
    await assertFinished([childId]);
  });

  it('rejects immediate admission from an expired parent claim without creating a child run', async () => {
    await jobs.queue(item());
    const [claim] = await store.claim(queue, workerId);
    await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${claim.id}::uuid`.execute(db);
    const context: QueueExecution = {
      claim,
      signal: new AbortController().signal,
      progress: () => {},
      progressUnits: 0,
      adoptions: [],
      followups: [],
      buffering: false,
    };
    await expect(queueExecution.run(context, submit)).rejects.toThrow('Producer lost its claim');
    expect(await runs()).toEqual([]);
    expect(await db.selectFrom('job_run_item').select('runId').where('queue', '=', queue).execute()).toEqual([]);
  });

  it.each(['expired', 'cancelled', 'token-replaced', 'aborted'] as const)(
    'rolls back initial intents when the parent becomes %s during admission',
    async (reason) => {
      await jobs.queue(item());
      const [parent] = await store.claim(queue, workerId);
      const abort = new AbortController();
      const context: QueueExecution = {
        claim: parent,
        signal: abort.signal,
        progress: () => {},
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: false,
      };
      const admissionStore = jobs['store'];
      const admit = admissionStore.admitRun.bind(admissionStore);
      const fault = vi.spyOn(admissionStore, 'admitRun').mockImplementationOnce(async (...args) => {
        await admit(...args); // Real run, item and job rows exist inside the transaction before authority changes.
        const tx = args[4];
        switch (reason) {
          case 'expired': {
            await sql`update job set "leaseExpiresAt" = clock_timestamp() - interval '1 second'
            where id = ${parent.id}::uuid`.execute(tx);
            break;
          }
          case 'cancelled': {
            await sql`update job set "cancelRequestedAt" = clock_timestamp() where id = ${parent.id}::uuid`.execute(tx);
            break;
          }
          case 'token-replaced': {
            await sql`update job set token = gen_random_uuid() where id = ${parent.id}::uuid`.execute(tx);
            break;
          }
          case 'aborted': {
            abort.abort(new Error('parent stopped during admission'));
            // No default
            break;
          }
        }
      });
      try {
        await expect(
          queueExecution.run(context, () =>
            jobs.createRun(queue, {}, () => jobs.queue({ name: JobName.AssetEncodeVideoQueueAll, data: {} })),
          ),
        ).rejects.toThrow(
          reason === 'aborted' ? 'parent stopped during admission' : 'Producer lost its claim during admission',
        );
      } finally {
        fault.mockRestore();
      }
      expect(await runs()).toEqual([]);
      expect(await db.selectFrom('job_run_item').select('runId').where('queue', '=', queue).execute()).toEqual([]);
      expect(await db.selectFrom('job').select(['id', 'runId', 'token']).where('queue', '=', queue).execute()).toEqual([
        { id: parent.id, runId: null, token: parent.token },
      ]);
    },
  );

  it.each(['checkpoint', 'snapshot'] as const)(
    'empty settles a waiting %s owner and its never-started latest run with retained descendants',
    async (kind) => {
      const start = () => jobs.createRun(queue, {}, () => jobs.queue({ name: JobName.LibraryScanRun }));
      const originalId = await start();
      const [owner] = await store.claim(queue, workerId);
      const context: QueueExecution = {
        claim: owner,
        signal: new AbortController().signal,
        progress: () => {},
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: false,
      };
      await queueExecution.run(context, async () => {
        if (kind === 'checkpoint') await jobs.prepareCheckpoint('setup', () => Promise.resolve({ accepted: true }));
        else
          await jobs.queueSelection(
            JobName.ImageDescriptionQueueAll,
            db.selectFrom('job_run').select('id').where('id', '=', originalId),
          );
      });
      await store.defer(owner, 'source-unavailable');
      const latestId = await start();
      await sql`update job set state = 'waiting' where id = ${owner.id}::uuid`.execute(db);
      await jobs.empty(queue as QueueName);
      await assertFinished([originalId, latestId]);
      const reads = await store.listRuns(100, 0);
      expect(reads.find((run) => run.id === latestId)).toMatchObject({
        state: 'cancelled',
        total: 0,
        stageTotals: { total: 1, cancelled: 1 },
      });
      expect(reads.find((run) => run.id === originalId)).toMatchObject({
        state: 'cancelled',
        total: kind === 'snapshot' ? 1 : 0,
        stageTotals: { total: kind === 'snapshot' ? 2 : 1, cancelled: kind === 'snapshot' ? 2 : 1 },
      });
      if (kind === 'snapshot') {
        expect(
          await db
            .selectFrom('job_run_item')
            .select(['state', 'jobId'])
            .where('runId', '=', originalId)
            .where('rootItemKey', '=', originalId)
            .execute(),
        ).toEqual([{ state: 'pending', jobId: null }]);
        // Cold rows remain immutable; the terminal header supplies their cancelled outcome.
        expect(await db.selectFrom('job_selection').select('state').where('runId', '=', originalId).execute()).toEqual([
          { state: 'cancelled' },
        ]);
        expect(await store.feedManifest(queue)).toBe(0);
      }
      expect(await store.claim(queue, workerId)).toEqual([]);
      expect(
        await db.selectFrom('job').select(['state', 'latestPending']).where('id', '=', owner.id).execute(),
      ).toEqual([{ state: 'cancelled', latestPending: null }]);
    },
  );

  it('does not create a run after the real QueueService rejects an already-active start', async () => {
    await jobs.queue(item());
    expect(await store.claim(queue, workerId)).toHaveLength(1);
    const { sut } = newTestService(QueueService);
    Object.assign(sut, { jobRepository: jobs });
    await expect(sut.runCommandLegacy(queue as QueueName, { command: QueueCommand.Start })).rejects.toThrow(
      'Job is already running',
    );
    expect(await runs()).toEqual([]);
  });

  it('preserves caller-owned explicit run IDs outside createRun admission', async () => {
    const id = await store.createRun(queue, {});
    await db.transaction().execute((tx) => jobs.queueInTransaction(tx, item(), id));
    const [claim] = await store.claim(queue, workerId);
    expect(claim.runId).toBe(id);
    expect(await store.complete(claim, [])).toBe(true);
    await assertFinished([id]);
  });
});

import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName } from 'src/enum.js';
import { QUEUE_EXECUTION_CAPACITY, queueAdmission } from 'src/queue/admission.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_BATCH, QueueIntent } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { getKyselyDB } from 'test/utils.js';

describe('queue database admission', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  let claimCommands: string[] | undefined;
  const intent = (extra: Partial<QueueIntent> = {}): QueueIntent => ({
    queue,
    name: JobName.AssetExtractMetadata,
    data: {},
    safeToRetry: true,
    sensitive: false,
    deadlineMs: 60_000,
    ...extra,
  });
  const executor = (handler: () => Promise<void>) =>
    new JobRepository(
      {} as never,
      {} as never,
      { emit: handler } as never,
      { setContext: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      db,
    );
  beforeAll(async () => {
    db = await getKyselyDB(undefined, (event) => {
      if (!claimCommands || event.level !== 'query') return;
      const text = event.query.sql.trimStart();
      if (text.startsWith('insert into job_attempt')) claimCommands.push('attempt');
      if (text.startsWith('update job set')) claimCommands.push('claim');
    });
    store = new SqlQueueStore(db);
  });
  beforeEach(async () => {
    claimCommands = undefined;
    queue = `admission-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });
  afterAll(async () => db?.destroy());

  it('leaves excess jobs waiting with untouched attempts when the worker has only three free slots', async () => {
    await store.setConcurrency(queue, 128);
    await store.enqueue(Array.from({ length: 10 }, () => intent()));
    const claims = await store.claim(queue, worker, 3);
    expect(claims).toHaveLength(3);
    expect(await store.claim(queue, worker, 0)).toEqual([]);
    const { rows } = await sql<{ state: string; attempt: number; count: number }>`
      select state, attempt, count(*)::int count from job where queue = ${queue} group by state, attempt`.execute(db);
    expect(rows).toEqual(
      expect.arrayContaining([
        { state: 'active', attempt: 1, count: 3 },
        { state: 'pending', attempt: 0, count: 7 },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(await store.hasUnfinishedWork(queue)).toBe(true);
  });

  it('claims and audits one bounded claim page in three statements with matching ownership', async () => {
    const owner = await store.createRun('claim-page-owner', {});
    await store.setConcurrency(queue, QUEUE_BATCH + 1);
    await store.enqueue(
      Array.from({ length: QUEUE_BATCH + 1 }, (_, index) =>
        intent({
          runId: owner,
          itemKey: String(index),
          rootItemKey: String(index),
        }),
      ),
    );
    claimCommands = [];
    const claims = await store.claim(queue, worker);
    // the jobs started by hand, then the page, then its audit
    expect(claimCommands).toEqual(['claim', 'claim', 'attempt']);
    claimCommands = undefined;
    expect(claims).toHaveLength(QUEUE_BATCH);
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(QUEUE_BATCH);
    expect(new Set(claims.map((claim) => claim.token)).size).toBe(QUEUE_BATCH);
    const { rows: attempts } = await sql<{ jobId: string; token: string; workerId: string; attempt: number }>`
      select a."jobId",a.token,a."workerId",a.attempt from job_attempt a join job j on j.id=a."jobId"
      where j.queue=${queue}`.execute(db);
    expect(attempts).toHaveLength(QUEUE_BATCH);
    expect(attempts).toEqual(
      expect.arrayContaining(
        claims.map((claim) => ({
          jobId: claim.id,
          token: claim.token,
          workerId: worker,
          attempt: 1,
        })),
      ),
    );
    expect(
      (
        await sql`select state,attempt,count(*)::int count from job where queue=${queue}
      group by state,attempt order by state`.execute(db)
      ).rows,
    ).toEqual([
      { state: 'active', attempt: 1, count: QUEUE_BATCH },
      { state: 'pending', attempt: 0, count: 1 },
    ]);
  });

  it('rolls back the entire claim page when one attempt audit conflicts', async () => {
    const runId = await store.createRun('claim-page-rollback', {});
    await store.setConcurrency(queue, 3);
    await store.enqueue(['one', 'two', 'three'].map((itemKey) => intent({ runId, itemKey, rootItemKey: itemKey })));
    const {
      rows: [blocked],
    } = await sql<{ id: string }>`select id from job where queue=${queue} limit 1`.execute(db);
    // Deliberately collide with the next audit key; a page may not escape without every audit.
    const token = randomUUID();
    await sql`insert into job_attempt("jobId",attempt,token,"workerId")
      values (${blocked.id}::uuid,1,${token}::uuid,${worker}::uuid)`.execute(db);
    await expect(store.claim(queue, worker)).rejects.toMatchObject({ code: '23505' });
    expect((await sql`select state,attempt,token,"workerId" from job where queue=${queue}`.execute(db)).rows).toEqual(
      Array.from({ length: 3 }, () => ({ state: 'pending', attempt: 0, token: null, workerId: null })),
    );
    expect(
      (await sql`select a.token from job_attempt a join job j on j.id=a."jobId" where j.queue=${queue}`.execute(db))
        .rows,
    ).toEqual([{ token }]);
    await sql`delete from job_attempt where token=${token}::uuid`.execute(db);
    const claims = await store.claim(queue, worker);
    expect(claims).toHaveLength(3);
    expect(claims.every((claim) => claim.attempt === 1 && claim.workerId === worker)).toBe(true);
    expect(
      (
        await sql`select count(*)::int count from job_attempt a join job j on j.id=a."jobId"
      where j.queue=${queue}`.execute(db)
      ).rows,
    ).toEqual([{ count: 3 }]);
  });

  it('defers overflow before any external work and preserves identity and both processing attempts', async () => {
    const runId = await store.createRun('admission-pressure', {});
    const remoteIdentity = {
      operationId: randomUUID(),
      remoteJobId: 'accepted-remote-id',
      destination: 'pinned-destination',
    };
    await store.enqueue([
      intent({ runId, itemKey: 'safe', rootItemKey: 'safe' }),
      intent({
        runId,
        itemKey: 'remote',
        rootItemKey: 'remote',
        name: JobName.SendMail,
        data: remoteIdentity,
        safeToRetry: false,
      }),
    ]);
    await store.setConcurrency(queue, 2);
    const claims = await store.claim(queue, worker);
    expect(claims).toHaveLength(2);
    let effects = 0;
    const sut = executor(() => {
      effects++;
      return Promise.resolve();
    });
    const admission = queueAdmission(db);
    const held = await Promise.all(
      Array.from({ length: QUEUE_EXECUTION_CAPACITY }, () => admission.execution.acquire(new AbortController().signal)),
    );
    const cancel = new AbortController();
    const waiting = Array.from({ length: QUEUE_BATCH }, () =>
      admission.execution.acquire(cancel.signal).catch(() => {}),
    );
    try {
      await Promise.all(claims.map((claim) => sut['execute'](claim, new AbortController())));
      expect(effects).toBe(0);
      const { rows } = await sql<{
        state: string;
        attempt: number;
        retryBaseAttempt: number;
        dependencyReason: string;
        data: unknown;
      }>`
        select state, attempt, "retryBaseAttempt", "dependencyReason", data from job where queue = ${queue}`.execute(
        db,
      );
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(row).toMatchObject({
          state: 'pending',
          attempt: 1,
          retryBaseAttempt: 1,
          dependencyReason: 'local-capacity',
        });
      expect(rows.map((row) => row.data)).toContainEqual(remoteIdentity);
      expect(await store.hasUnfinishedWork(queue)).toBe(true);
      const items = await store.listRunItems(runId, 10, 0);
      expect(items).toHaveLength(2);
      for (const item of items!) expect(item.reasons).toContain('local-capacity');
    } finally {
      cancel.abort();
      await Promise.all(waiting);
      for (const release of held) release();
    }
    await sql`update job set "availableAt" = now() where queue = ${queue}`.execute(db);
    const next = await store.claim(queue, worker);
    const safe = next.find((claim) => claim.itemKey === 'safe')!;
    const remote = next.find((claim) => claim.itemKey === 'remote')!;
    expect(remote.data).toEqual(remoteIdentity);
    await sut['execute'](remote, new AbortController());
    expect(effects).toBe(1);
    await store.fail(safe, 'first processing failure');
    await sql`update job set "availableAt" = now() where id = ${safe.id}::uuid`.execute(db);
    const [retry] = await store.claim(queue, worker);
    expect(retry.attempt).toBe(3);
    await store.fail(retry, 'second processing failure');
    const { rows: outcomes } = await sql<{
      itemKey: string;
      state: string;
    }>`select "itemKey", state from job where queue = ${queue}`.execute(db);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { itemKey: 'safe', state: 'failed' },
        { itemKey: 'remote', state: 'completed' },
      ]),
    );
  });

  it('retains stopped proof and fenced recovery when a queued claim expires before its handler starts', async () => {
    await store.enqueue([intent()]);
    const [claim] = await store.claim(queue, worker);
    const admission = queueAdmission(db);
    const held = await Promise.all(
      Array.from({ length: QUEUE_EXECUTION_CAPACITY }, () => admission.execution.acquire(new AbortController().signal)),
    );
    let effects = 0;
    const sut = executor(() => {
      effects++;
      return Promise.resolve();
    });
    const abort = new AbortController();
    try {
      const execution = sut['execute'](claim, abort);
      await sql`update job set "leaseExpiresAt" = now() - interval '31 seconds'
        where id = ${claim.id}::uuid`.execute(db);
      abort.abort(new Error('Expired while waiting for local capacity'));
      await execution;
      expect(effects).toBe(0);
      expect(
        (await db.selectFrom('job').select('state').where('id', '=', claim.id).executeTakeFirstOrThrow()).state,
      ).toBe('active');
      const proof = await db
        .selectFrom('system_metadata')
        .select('value')
        .where('key', '=', `frameleaf-attempt-evidence:${claim.token}`)
        .executeTakeFirstOrThrow();
      expect(proof.value).toMatchObject({ jobId: claim.id, stoppedAt: expect.any(Number) });
      await store.recoverExpired();
      expect(
        (await db.selectFrom('job').select('state').where('id', '=', claim.id).executeTakeFirstOrThrow()).state,
      ).toBe('pending');
    } finally {
      for (const release of held) release();
    }
    expect(effects).toBe(0);
    await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
    const [retry] = await store.claim(queue, worker);
    await sut['execute'](retry, new AbortController());
    expect(effects).toBe(1);
    expect(
      await db.selectFrom('job').select(['state', 'attempt']).where('id', '=', claim.id).executeTakeFirstOrThrow(),
    ).toEqual({ state: 'completed', attempt: 2 });
  });
});

import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { queueExecution } from 'src/queue/context.js';
import { RUN_OUTCOMES } from 'src/queue/run-query.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueClaim, QueueIntent } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { getKyselyDB } from 'test/utils.js';

/** Real driver/JSONB round trips: mocks cannot detect PostgreSQL parameter-type serialization. */
describe('PostgreSQL queue JSON parameters', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let repository: JobRepository;
  let queue: string;
  let worker: string;
  const intent = (extra: Partial<QueueIntent> = {}): QueueIntent => ({
    queue,
    name: 'json-stage',
    data: {},
    safeToRetry: true,
    sensitive: false,
    deadlineMs: QUEUE_TIMING.opaqueDeadline,
    ...extra,
  });
  const inClaim = <T>(claim: QueueClaim, body: () => T) =>
    queueExecution.run(
      {
        claim,
        signal: new AbortController().signal,
        progress: vi.fn(),
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: false,
      },
      body,
    );
  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  });
  beforeEach(async () => {
    queue = `json-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });
  afterAll(async () => db?.destroy());

  it('retains structured run selections, job payloads, ledger selections and downstream data', async () => {
    const data = { id: 'asset-a', nested: { array: [null, false, 7.5, { label: String.raw`"quoted" \ path` }] } };
    const selection = { filter: data.nested };
    const emptyRun = await store.createRun('json-empty', selection);
    const zeroCounts = Object.fromEntries(['total', ...RUN_OUTCOMES].map((key) => [key, 0]));
    expect((await store.listRuns(1000, 0)).find((run) => run.id === emptyRun)).toMatchObject({
      ...zeroCounts,
      stageTotals: zeroCounts,
    });
    const runId = randomUUID();
    await db
      .transaction()
      .execute((tx) =>
        store.admitRun(
          runId,
          'json-admission',
          selection,
          [intent({ data, runId, itemKey: 'asset-a', rootItemKey: 'asset-a' })],
          tx,
        ),
      );
    const { rows: runs } = await sql`select selection, jsonb_typeof(selection) as type from job_run
      where id = any(${[emptyRun, runId]}::uuid[])`.execute(db);
    expect(runs).toEqual([
      { selection, type: 'object' },
      { selection, type: 'object' },
    ]);
    const [first] = await store.claim(queue, worker);
    expect(first.data).toEqual(data);
    const downstream = { ...data, id: 'asset-b', result: [true, null, { ready: false }] };
    expect(await store.complete(first, [intent({ name: 'next-stage', data: downstream })])).toBe(true);
    const [next] = await store.claim(queue, worker);
    expect(next).toMatchObject({ runId, rootItemKey: 'asset-a', data: downstream });
    const { rows: ledger } = await sql`select stage, selection, jsonb_typeof(selection) as type from job_run_item
      where "runId" = ${runId}::uuid order by stage`.execute(db);
    expect(ledger).toEqual([
      { stage: 'json-stage', selection: data, type: 'object' },
      { stage: 'next-stage', selection: downstream, type: 'object' },
    ]);
    expect(await store.complete(next, [])).toBe(true);
  });

  it('retains the newest structured request both before and during an active claim', async () => {
    const runId = await store.createRun('json-latest', {});
    const options = { deduplication: { id: queue, keepLastIfActive: true } };
    const request = (revision: number) =>
      intent({
        options,
        runId,
        itemKey: 'same-item',
        rootItemKey: 'same-item',
        data: { revision, values: [null, false] },
      });
    await store.enqueue([request(0), request(1)]);
    const [first] = await store.claim(queue, worker);
    expect(first.data).toEqual(request(1).data);
    const latest = request(3);
    await store.enqueue([request(2), latest]);
    const { rows } = await sql`select "latestPending", jsonb_typeof("latestPending") as type,
      jsonb_typeof("latestPending"->'data') as "dataType" from job where id = ${first.id}::uuid`.execute(db);
    expect(rows).toEqual([{ latestPending: latest, type: 'object', dataType: 'object' }]);
    expect(await store.complete(first, [])).toBe(true);
    const [next] = await store.claim(queue, worker);
    expect(next).toMatchObject({ id: first.id, data: latest.data, attempt: 2 });
    expect(await store.complete(next, [])).toBe(true);
    expect(await store.claim(queue, worker)).toEqual([]);
  });

  it.each([
    { type: 'object', value: { enabled: false, values: [null, 17] } },
    { type: 'array', value: [null, { enabled: true }, 'text'] },
    { type: 'string', value: '{"this":"stays a string"}' },
    { type: 'number', value: 17.5 },
    { type: 'boolean', value: false },
    { type: 'null', value: null },
  ])('preserves a $type checkpoint and its admitted destination across retries', async ({ type, value }) => {
    await store.enqueue([intent()]);
    const [first] = await store.claim(queue, worker);
    const prepare = vi.fn(() => Promise.resolve(value));
    await inClaim(first, async () => {
      expect(await repository.prepareCheckpoint('contract', prepare)).toEqual(value);
      expect(await repository.pinDestination('search', 'original-route')).toBe('original-route');
    });
    const { rows } = await sql`select data #> '{_producerCheckpoints,contract}' as value,
      jsonb_typeof(data #> '{_producerCheckpoints,contract}') as type,
      (data #> '{_producerCheckpoints,contract}') is null as "sqlNull",
      data->'_queueDestinations' as destinations from job where id = ${first.id}::uuid`.execute(db);
    expect(rows).toEqual([{ value, type, sqlNull: false, destinations: { search: 'original-route' } }]);
    await store.fail(first, 'retry fixture');
    await sql`update job set "availableAt" = now() where id = ${first.id}::uuid`.execute(db);
    const [retry] = await store.claim(queue, worker);
    await inClaim(retry, async () => {
      expect(await repository.prepareCheckpoint('contract', prepare)).toEqual(value);
      expect(await repository.pinDestination('search', 'changed-route')).toBe('original-route');
    });
    expect(prepare).toHaveBeenCalledOnce();
    await expect(inClaim(first, () => repository.prepareCheckpoint('contract', prepare))).rejects.toThrow(
      'lost its claim',
    );
    await expect(inClaim(first, () => repository.pinDestination('search', 'stale-route'))).rejects.toThrow(
      'lost its claim',
    );
    expect(await store.complete(retry, [])).toBe(true);
  });

  it('decodes heartbeat record arrays without extending stale-token or foreign-worker leases', async () => {
    const otherWorker = randomUUID();
    await store.initialize([], otherWorker);
    await store.setConcurrency(queue, 3);
    await store.enqueue([intent(), intent(), intent()]);
    const [owned, stale, foreign] = await store.claim(queue, worker);
    await sql`update job set "workerId" = ${otherWorker}::uuid where id = ${foreign.id}::uuid`.execute(db);
    const { rows: before } = await sql<{ id: string; lease: Date }>`update job
      set "leaseExpiresAt" = now() + interval '20 seconds' where queue = ${queue}
      returning id, "leaseExpiresAt" as lease`.execute(db);
    const leases = new Map(before.map((row) => [row.id, row.lease]));
    await store.heartbeat(worker, [
      { id: owned.id, token: owned.token },
      { id: stale.id, token: randomUUID() },
      { id: foreign.id, token: foreign.token },
    ]);
    await store.heartbeat(worker, []);
    const { rows: after } = await sql<{ id: string; lease: Date }>`select id, "leaseExpiresAt" as lease
      from job where queue = ${queue}`.execute(db);
    for (const row of after) {
      if (row.id === owned.id) expect(row.lease.getTime()).toBeGreaterThan(leases.get(row.id)!.getTime());
      else expect(row.lease).toEqual(leases.get(row.id));
    }
  });
});

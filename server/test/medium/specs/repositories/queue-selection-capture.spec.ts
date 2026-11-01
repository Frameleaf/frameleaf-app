import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { queueAdmission } from 'src/queue/admission.js';
import { freezeSelection, shareSelectionPage } from 'src/queue/manifest.js';
import { mirrorSelectionLineage } from 'src/queue/selection-lineage.js';
import { SqlQueueStore, resetQueueAfterRestore } from 'src/queue/store.js';
import { QueueClaim, QueueExecution, QueueIntent } from 'src/queue/types.js';
import * as selectionHeaders from 'src/schema/migrations/1791101300000-SelectionOutcomeHeaders.js';
import * as selectionLineage from 'src/schema/migrations/1791101500000-RetainSelectionLineage.js';
import * as librarySources from 'src/schema/migrations/1791101600000-LibraryScanSources.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('selection capture isolation', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let otherQueue: string;
  let worker: string;
  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    await sql`create table capture_source(id text primary key)`.execute(db);
    await sql`create function capture_gate(value text, gate integer) returns text language plpgsql as $$
      begin
        if value = '3' then perform pg_advisory_xact_lock(-334, gate); end if;
        return value;
      end
    $$`.execute(db);
  });
  beforeEach(async () => {
    queue = `capture-${randomUUID()}`;
    otherQueue = `other-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue, otherQueue], worker);
    await sql`truncate capture_source`.execute(db);
    await sql`insert into capture_source select n::text from generate_series(1, 6) n`.execute(db);
  });
  afterAll(async () => db?.destroy());

  const intent = (overrides: Partial<QueueIntent> = {}): QueueIntent => ({
    queue,
    name: 'selected-stage',
    data: {},
    safeToRetry: true,
    sensitive: false,
    deadlineMs: 600_000,
    ...overrides,
  });
  const producer = (runId?: string) =>
    intent({
      name: 'producer',
      runId,
      itemKey: runId ? 'producer' : undefined,
      options: { deduplication: { id: queue } },
    });
  const context = (claim: QueueClaim): QueueExecution => ({
    claim,
    signal: new AbortController().signal,
    progress: () => {},
    progressUnits: 0,
    adoptions: [],
    followups: [],
    buffering: false,
  });
  const selected = (gate?: number) =>
    db.selectFrom('capture_source').select(gate ? sql<string>`capture_gate(id, ${gate})`.as('id') : 'id');
  const freeze = (claim: QueueClaim, gate?: number) => freezeSelection(db, intent(), selected(gate), context(claim));
  const capturedKeys = (runId: string) =>
    sql<{ itemKey: string }>`select "itemKey" from job_run_item
      where "runId" = ${runId}::uuid and "selectionId" is not null order by "itemKey"`
      .execute(db)
      .then(({ rows }) => rows.map((row) => row.itemKey));
  const holdGate = async (gate: number) => {
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(-334, ${gate})`.execute(tx);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    return async () => {
      release.resolve();
      await held;
    };
  };
  const waitForGate = async (gate: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows } = await sql`select 1 from pg_locks where locktype = 'advisory'
        and classid = 4294966962 and objid = ${gate} and not granted`.execute(db);
      if (rows.length > 0) return;
      await sleep(10);
    }
    throw new Error('Capture did not reach its deterministic SQL gate');
  };
  const within = <T>(work: Promise<T>) =>
    Promise.race([
      work,
      sleep(1000).then(() => {
        throw new Error('Unrelated queue work waited for selection capture');
      }),
    ]);

  it('keeps heartbeat, dispatch and accepted publication responsive while a snapshot holds foreign-key locks', async () => {
    await store.enqueue([producer(), intent({ queue: otherQueue, name: 'other-first' })]);
    const [claim] = await store.claim(queue, worker);
    const [other] = await store.claim(otherQueue, worker);
    await store.enqueue([intent({ queue: otherQueue, name: 'other-next' })]);
    const release = await holdGate(1);
    const capture = freeze(claim, 1);
    const observed = capture.catch(() => {});
    let probes: Promise<unknown> | undefined;
    try {
      await waitForGate(1);
      probes = (async () => {
        await store.heartbeat(worker, [claim, other]);
        expect(await store.complete(other, [])).toBe(true);
        expect(await store.claim(otherQueue, worker)).toHaveLength(1);
      })();
      await within(probes);
      // INSERT SELECT keeps its original statement snapshot even as the live source changes.
      await sql`delete from capture_source where id = '6'`.execute(db);
      await sql`insert into capture_source values ('7')`.execute(db);
    } finally {
      await release();
      await observed;
      await probes?.catch(() => {});
    }
    const runId = await capture;
    expect(await capturedKeys(runId)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(await store.feedManifest(queue)).toBe(0);
    expect(await store.complete(claim, [])).toBe(true);
    expect(await store.feedManifest(queue)).toBe(6);
  });

  it.each([false, true])(
    'renews other leases without waiting for a producer publication fence (expired: %s)',
    async (expired) => {
      await store.enqueue([producer(), intent({ queue: otherQueue, name: 'other' })]);
      const [claim] = await store.claim(queue, worker);
      const [other] = await store.claim(otherQueue, worker);
      const { rows: before } = await sql<{ id: string; lease: Date }>`update job
      set "leaseExpiresAt" = now() + interval '20 seconds'
      where id in (${claim.id}::uuid, ${other.id}::uuid)
      returning id, "leaseExpiresAt" as lease`.execute(db);
      const leases = new Map(before.map((row) => [row.id, row.lease]));
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const fence = db.transaction().execute(async (tx) => {
        await sql`select id from job where id = ${claim.id}::uuid for no key update`.execute(tx);
        if (expired) {
          await sql`update job set "leaseExpiresAt" = clock_timestamp() - interval '1 second'
          where id = ${claim.id}::uuid`.execute(tx);
        }
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const heartbeat = store.heartbeat(worker, [claim, other]);
      try {
        await within(heartbeat);
        const { rows } = await sql<{ id: string; lease: Date }>`select id, "leaseExpiresAt" as lease
        from job where id in (${claim.id}::uuid, ${other.id}::uuid)`.execute(db);
        expect(rows.find(({ id }) => id === claim.id)?.lease).toEqual(leases.get(claim.id));
        expect(rows.find(({ id }) => id === other.id)!.lease.getTime()).toBeGreaterThan(
          leases.get(other.id)!.getTime(),
        );
      } finally {
        release.resolve();
        await fence;
        await heartbeat;
      }
      await store.heartbeat(worker, [claim]);
      const {
        rows: [renewed],
      } = await sql<{ lease: Date }>`select "leaseExpiresAt" as lease
      from job where id = ${claim.id}::uuid`.execute(db);
      if (expired) {
        expect(renewed.lease.getTime()).toBeLessThan(leases.get(claim.id)!.getTime());
        expect(await store.complete(claim, [])).toBe(false);
      } else {
        expect(renewed.lease.getTime()).toBeGreaterThan(leases.get(claim.id)!.getTime());
      }
    },
  );

  it('does not scan an uncommitted manifest for an unrelated job with no lineage', async () => {
    const runId = randomUUID();
    await sql`insert into job_run(id, kind, selection) values (${runId}::uuid, 'fixture', '{}')`.execute(db);
    await sql`analyze job_run_item`.execute(db);
    const inserted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const growing = db.transaction().execute(async (tx) => {
      await sql`insert into job_run_item("runId", "itemKey", stage, queue, selection)
        select ${runId}::uuid, n::text, 'fixture', ${queue}, '{}'::jsonb
        from generate_series(1,25000) n`.execute(tx);
      inserted.resolve();
      await release.promise;
    });
    await inserted.promise;
    const {
      rows: [database],
    } = await sql<{ name: string }>`select current_database() name`.execute(db);
    let captured: CompiledQuery | undefined;
    const observed = new Kysely<any>({
      ...getKyselyConfig({
        connectionType: 'url',
        url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, database.name),
      }),
      log: (event) => {
        if (event.level === 'query' && event.query.sql.includes('update job_run_item shadow')) captured = event.query;
      },
    });
    try {
      expect(await mirrorSelectionLineage(observed, { jobIds: [randomUUID()] })).toEqual([]);
      expect(captured).toBeDefined();
      type Plan = { Alias?: string; 'Actual Loops': number; Plans?: Plan[] };
      const { rows } = await observed.executeQuery<{ 'QUERY PLAN': [{ Plan: Plan }] }>(
        CompiledQuery.raw(`explain (analyze, buffers, format json) ${captured!.sql}`, [...captured!.parameters]),
      );
      const nodes = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap((child) => nodes(child))];
      const scans = nodes(rows[0]['QUERY PLAN'][0].Plan)
        .slice(1)
        .filter((node) => node.Alias === 'shadow');
      expect(scans.length).toBeGreaterThan(0);
      expect(scans.every((node) => node['Actual Loops'] === 0)).toBe(true);
    } finally {
      release.resolve();
      await growing;
      await observed.destroy();
    }
  });

  it('rolls back partial materialization on cancellation and never publishes it', async () => {
    await store.enqueue([producer()]);
    const [claim] = await store.claim(queue, worker);
    const release = await holdGate(2);
    const capture = freeze(claim, 2);
    const rejected = expect(capture).rejects.toThrow('lost its claim');
    try {
      await waitForGate(2);
      await within(
        sql`update job set "cancelRequestedAt" = clock_timestamp() where id = ${claim.id}::uuid`.execute(db),
      );
    } finally {
      await release();
      await rejected;
    }
    expect(await store.complete(claim, [])).toBe(false);
    expect(await store.feedManifest(queue)).toBe(0);
    const { rows } = await sql`select 1 from job_run_item where queue = ${queue} and "selectionId" is not null`.execute(
      db,
    );
    expect(rows).toEqual([]);
  });

  it('reuses a committed empty snapshot after a new claim and source growth', async () => {
    await sql`truncate capture_source`.execute(db);
    await store.enqueue([producer()]);
    const [first] = await store.claim(queue, worker);
    const runId = await freeze(first);
    await store.fail(first, 'interrupted after capture commit');
    await sql`insert into capture_source values ('new')`.execute(db);
    await sql`update job set "availableAt" = now() where id = ${first.id}::uuid`.execute(db);
    const [retry] = await store.claim(queue, worker);
    expect(retry.attempt).toBe(2);
    expect(await freeze(retry)).toBe(runId);
    expect(await capturedKeys(runId)).toEqual([]);
    expect(await store.complete(first, [])).toBe(false);
    expect(await store.complete(retry, [])).toBe(true);
    const { rows } = await sql`select "enumerationDone", "finishedAt" is not null finished from job_run
      where id = ${runId}::uuid`.execute(db);
    expect(rows).toEqual([{ enumerationDone: true, finished: true }]);
  });

  it('commits materialized rows and their marker atomically across interruption and retry', async () => {
    await store.enqueue([producer()]);
    const [first] = await store.claim(queue, worker);
    await sql`create function reject_capture_marker() returns trigger language plpgsql as $$
      begin raise exception 'injected interruption before capture marker'; end
    $$`.execute(db);
    await sql`create trigger reject_capture_marker before update of "capturedAt" on job_selection
      for each row execute function reject_capture_marker()`.execute(db);
    try {
      await expect(freeze(first)).rejects.toThrow('injected interruption before capture marker');
    } finally {
      await sql`drop trigger reject_capture_marker on job_selection`.execute(db);
    }
    expect(await capturedKeys(first.runId!)).toEqual([]);
    const { rows } = await sql`select "capturedAt" from job_selection where "producerId" = ${first.id}::uuid`.execute(
      db,
    );
    expect(rows).toEqual([{ capturedAt: null }]);
    await store.fail(first, 'interrupted before atomic capture commit');
    await sql`truncate capture_source`.execute(db);
    await sql`insert into capture_source values ('after-interruption')`.execute(db);
    await sql`update job set "availableAt" = now() where id = ${first.id}::uuid`.execute(db);
    const [retry] = await store.claim(queue, worker);
    await freeze(retry);
    expect(await capturedKeys(first.runId!)).toEqual(['after-interruption']);
    // After commit, changing the source cannot append new identities, even on the same attempt.
    await sql`insert into capture_source values ('after-commit')`.execute(db);
    await freeze(retry);
    expect(await capturedKeys(first.runId!)).toEqual(['after-interruption']);
    expect(await store.complete(retry, [])).toBe(true);
  });

  it('shares late producer memberships in bounded pages outside the local publication gate', async () => {
    const runs = await Promise.all([1, 2, 3].map(() => store.createRun('shared-capture', {})));
    await store.enqueue([producer(runs[0]), intent({ queue: otherQueue })]);
    const [claim] = await store.claim(queue, worker);
    const [other] = await store.claim(otherQueue, worker);
    await freeze(claim);
    await store.enqueue([producer(runs[1])]);
    const publish = <T>(work: () => Promise<T>) => queueAdmission(db).publication.run(AbortSignal.timeout(5000), work);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = publish(async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    try {
      expect(await within(shareSelectionPage(db, { producerId: claim.id }))).toBe(true);
    } finally {
      release.resolve();
      await holder;
    }
    await within(
      (async () => {
        await store.heartbeat(worker, [claim]);
        expect(await store.complete(other, [], undefined, publish)).toBe(true);
        await store.enqueue([producer(runs[2])]);
      })(),
    );
    expect(await store.complete(claim, [], undefined, publish)).toBe(true);
    for (const run of runs) expect(await capturedKeys(run)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(await store.feedManifest(queue)).toBe(6);
    await store.setConcurrency(queue, 6);
    for (const child of await store.claim(queue, worker)) expect(await store.complete(child, [])).toBe(true);
    const { rows } = await sql`select "enumerationDone", "finishedAt" is not null finished from job_run
      where id = any(${runs}::uuid[])`.execute(db);
    expect(rows).toEqual(Array.from({ length: 3 }, () => ({ enumerationDone: true, finished: true })));
  });

  const gateSharedPage = async (runId: string) => {
    await sql`create table if not exists share_capture_gate("runId" uuid primary key)`.execute(db);
    await sql`truncate share_capture_gate`.execute(db);
    await sql`insert into share_capture_gate values (${runId}::uuid)`.execute(db);
    await sql`create or replace function pause_shared_capture() returns trigger language plpgsql as $$
      begin
        if new."itemKey" = '3' and exists(select 1 from share_capture_gate where "runId" = new."runId") then
          perform pg_advisory_xact_lock(-334, 3);
        end if;
        return new;
      end
    $$`.execute(db);
    await sql`create trigger pause_shared_capture before insert on job_run_item for each row
      when (new."selectionId" is not null) execute function pause_shared_capture()`.execute(db);
    return holdGate(3);
  };

  it('serializes clear with the current shared page and preserves cancellation for every run', async () => {
    const runs = await Promise.all([1, 2].map(() => store.createRun('shared-clear', {})));
    await store.enqueue([producer(runs[0])]);
    const [claim] = await store.claim(queue, worker);
    await freeze(claim);
    await store.enqueue([producer(runs[1])]);
    const release = await gateSharedPage(runs[1]);
    const copying = shareSelectionPage(db, { producerId: claim.id });
    const observed = copying.catch(() => {});
    let cleared = false;
    let clearing: Promise<void> | undefined;
    try {
      await waitForGate(3);
      clearing = store.clear(queue, ['pending', 'waiting']).then(() => {
        cleared = true;
      });
      await sleep(50);
      expect(cleared, 'clear must serialize with the current bounded copy page').toBe(false);
    } finally {
      await release();
      await observed;
      await clearing;
      await sql`drop trigger pause_shared_capture on job_run_item`.execute(db);
    }
    expect(await copying).toBe(true);
    expect(await store.complete(claim, [])).toBe(true);
    expect(await store.feedManifest(queue)).toBe(0);
    expect(await store.hasUnfinishedWork(queue)).toBe(false);
    const summaries = await store.listRuns(100, 0);
    for (const runId of runs) {
      expect(summaries.find((run) => run.id === runId)).toMatchObject({
        total: 6,
        cancelled: 6,
        finishedAt: expect.any(Date),
      });
    }
  });

  it('copies admitted outcomes atomically with child completion during a producer replay', async () => {
    const runs = await Promise.all([1, 2].map(() => store.createRun('shared-completion', {})));
    await store.enqueue([producer(runs[0])]);
    const [first] = await store.claim(queue, worker);
    await freeze(first);
    await store.enqueue([{ ...producer(runs[0]), options: { deduplication: { id: queue, keepLastIfActive: true } } }]);
    expect(await store.complete(first, [])).toBe(true);
    expect(await store.feedManifest(queue)).toBe(6);
    await store.setConcurrency(queue, 2);
    const claims = await store.claim(queue, worker);
    const replay = claims.find((claim) => claim.name === 'producer')!;
    const child = claims.find((claim) => claim.name === 'selected-stage')!;
    expect(replay).toBeDefined();
    expect(child).toBeDefined();
    await freeze(replay);
    await store.enqueue([producer(runs[1])]);
    const release = await gateSharedPage(runs[1]);
    const copying = shareSelectionPage(db, { producerId: replay.id });
    const observed = copying.catch(() => {});
    let completed = false;
    let completing: Promise<boolean> | undefined;
    try {
      await waitForGate(3);
      completing = store.complete(child, []).then((accepted) => {
        completed = true;
        return accepted;
      });
      await sleep(50);
      expect(completed, 'completion cannot publish before the copied membership commits').toBe(false);
    } finally {
      await release();
      await observed;
      await completing;
      await sql`drop trigger pause_shared_capture on job_run_item`.execute(db);
    }
    expect(await copying).toBe(true);
    expect(await completing).toBe(true);
    const { rows } =
      await sql`select state from job_run_item where "jobId" = ${child.id}::uuid order by "runId"`.execute(db);
    expect(rows).toEqual([{ state: 'completed' }, { state: 'completed' }]);
    expect(await store.complete(replay, [])).toBe(true);
    await store.setConcurrency(queue, 6);
    for (const pending of await store.claim(queue, worker)) expect(await store.complete(pending, [])).toBe(true);
    const summaries = await store.listRuns(100, 0);
    for (const runId of runs) {
      expect(summaries.find((run) => run.id === runId)).toMatchObject({
        total: 6,
        completed: 6,
        finishedAt: expect.any(Date),
      });
    }
  });

  it('retains header cancellation through producer retry and restore', async () => {
    await store.enqueue([producer()]);
    const [first] = await store.claim(queue, worker);
    const runId = await freeze(first);
    await store.clear(queue, ['pending', 'waiting']);
    await store.fail(first, 'retry after queue clear');
    await sql`update job set "availableAt" = now() where id = ${first.id}::uuid`.execute(db);
    const [retry] = await store.claim(queue, worker);
    await freeze(retry);
    expect(await store.complete(retry, [])).toBe(true);
    expect(await store.feedManifest(queue)).toBe(0);
    await resetQueueAfterRestore(db);
    expect((await store.listRuns(100, 0)).find((run) => run.id === runId)).toMatchObject({
      total: 6,
      cancelled: 6,
      waiting: 0,
      finishedAt: expect.any(Date),
    });
    const { rows } = await sql<{ state: string }>`select state from job_run_item where "runId" = ${runId}::uuid
      and "selectionId" is not null`.execute(db);
    expect(rows.every((row) => row.state === 'pending')).toBe(true); // Header changes do not rewrite the manifest.
  });

  it('commits a shared page and its cursor atomically across interruption and restore', async () => {
    const runs = await Promise.all([1, 2].map(() => store.createRun('shared-recovery', {})));
    await store.enqueue([producer(runs[0])]);
    const [claim] = await store.claim(queue, worker);
    await freeze(claim);
    await store.enqueue([producer(runs[1])]);
    await sql`create function reject_share_cursor() returns trigger language plpgsql as $$
      begin raise exception 'interrupted before durable share cursor'; end
    $$`.execute(db);
    await sql`create trigger reject_share_cursor before update of "copyAfter" on job_selection_run
      for each row execute function reject_share_cursor()`.execute(db);
    try {
      await expect(shareSelectionPage(db, { producerId: claim.id })).rejects.toThrow(
        'interrupted before durable share cursor',
      );
    } finally {
      await sql`drop trigger reject_share_cursor on job_selection_run`.execute(db);
    }
    expect(await capturedKeys(runs[1])).toEqual([]);
    const { rows } =
      await sql`select "copyAfter", "copyComplete" from job_selection_run where "runId" = ${runs[1]}::uuid`.execute(db);
    expect(rows).toEqual([{ copyAfter: null, copyComplete: false }]);
    await sql`truncate capture_source`.execute(db);
    // Exhausted restore fences the producer and lets ordinary bounded visits finish sharing.
    await sql`update job set attempt = 2 where id = ${claim.id}::uuid`.execute(db);
    await resetQueueAfterRestore(db);
    expect(await store.complete(claim, [])).toBe(false);
    expect(await store.hasUnfinishedWork(queue)).toBe(true);
    expect(await store.feedManifest(queue)).toBe(0);
    expect(await capturedKeys(runs[1])).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(await store.hasUnfinishedWork(queue)).toBe(false);
    expect((await store.listRuns(100, 0)).find((run) => run.id === runs[1])).toMatchObject({
      total: 6,
      needsAttention: 6,
      enumerationDone: true,
      finishedAt: expect.any(Date),
    });
  });

  it('preserves pending shared outcomes through downgrade and forward replay', async () => {
    const runs = await Promise.all([1, 2].map(() => store.createRun('shared-migration', {})));
    await store.enqueue([{ ...producer(runs[0]), safeToRetry: false }]);
    const [claim] = await store.claim(queue, worker);
    await freeze(claim);
    await store.enqueue([producer(runs[1])]);
    expect(await store.fail(claim, 'manual review required')).toBe(true);
    expect(await capturedKeys(runs[1])).toEqual([]);
    await db.transaction().execute(async (tx) => {
      await librarySources.down(tx);
      await selectionLineage.down(tx);
      await selectionHeaders.down(tx);
    });
    try {
      const { rows } = await sql`select "runId", count(*)::int count from job_run_item
        where "runId" = any(${runs}::uuid[]) and "selectionId" is not null and state = 'needs_attention'
        group by "runId" order by "runId"`.execute(db);
      expect(rows).toEqual(runs.toSorted().map((runId) => ({ runId, count: 6 })));
    } finally {
      await db.transaction().execute(async (tx) => {
        await selectionHeaders.up(tx);
        await selectionLineage.up(tx);
        await librarySources.up(tx);
      });
    }
    const summaries = await store.listRuns(100, 0);
    for (const runId of runs) {
      expect(summaries.find((run) => run.id === runId)).toMatchObject({
        total: 6,
        needsAttention: 6,
        enumerationDone: true,
        finishedAt: expect.any(Date),
      });
    }
  });
});

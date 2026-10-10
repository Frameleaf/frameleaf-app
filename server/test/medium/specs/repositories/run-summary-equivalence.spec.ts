import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { listRuns } from 'src/queue/run-query.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { DB } from 'src/schema/index.js';
import { legacyListRuns } from 'test/medium/legacy-run-query.js';
import { getKyselyDB } from 'test/utils.js';

// The collapsed run summary must answer exactly as the row-by-row read it replaced. Each seed builds
// a small ledger with every shape the summary distinguishes, then both reads are compared after
// each kind of change that moves a row's effective state without writing that row.

/** Deterministic, so a failing seed can be replayed. */
const generator = (seed: number) => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (below: number) => Math.floor(next() * below);
  return {
    int,
    chance: (probability: number) => next() < probability,
    pick: <T>(values: readonly T[]) => values[int(values.length)],
  };
};

const ITEM_STATES = [
  'pending',
  'waiting',
  'active',
  'completed',
  'failed',
  'needs_attention',
  'cancelled',
  'blocked',
] as const;
const HEADER_STATES = ['enumerating', 'ready', 'needs_attention', 'cancelled'] as const;
const DEPENDENCY_REASONS = ['local-capacity', 'source-unavailable', 'destination-budget', null, null, null] as const;
// Far from now() on both sides: the two reads run a moment apart and must agree on every clock test.
const PAST = new Date(Date.now() - 3_600_000);
const FUTURE = new Date(Date.now() + 3_600_000);

type Item = {
  runId: string;
  itemKey: string;
  rootItemKey: string | null;
  stage: string;
  queue: string;
  selection: object;
  selectionId?: string | null;
  jobId?: string | null;
  state?: string;
  librarySourceKey?: string | null;
  libraryIntent?: object | null;
  libraryProducerId?: string | null;
  libraryExecutionRunId?: string | null;
  libraryExecutionItemKey?: string | null;
};

type World = {
  runs: string[];
  selections: string[];
  queues: string[];
  producers: { runId: string; itemKey: string }[];
};

const buildWorld = async (db: Kysely<DB>, store: SqlQueueStore, seed: number): Promise<World> => {
  const random = generator(seed);
  const open = `equivalence-${seed}-open`;
  const held = `equivalence-${seed}-held`;
  await store.initialize([open, held]);
  await store.pause(held, true);
  const queues = [open, held];
  const queue = () => random.pick(queues);

  const items: Item[] = [];
  const jobs: Record<string, unknown>[] = [];
  const job = (item: Item, overrides: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const state = random.pick(ITEM_STATES);
    jobs.push({
      id,
      runId: item.runId,
      itemKey: item.itemKey,
      rootItemKey: item.rootItemKey,
      name: item.stage,
      queue: random.chance(0.8) ? item.queue : queue(),
      data: {},
      safeToRetry: true,
      sensitive: false,
      deadlineMs: 60_000,
      state,
      token: state === 'active' ? randomUUID() : null,
      attempt: random.chance(0.3) ? 2 : 0,
      retryBaseAttempt: 0,
      availableAt: random.chance(0.3) ? FUTURE : PAST,
      startedAt: random.chance(0.5) ? PAST : null,
      progressAt: random.chance(0.3) ? new Date(PAST.getTime() - random.int(1000) * 1000) : null,
      dependencyReason: random.pick(DEPENDENCY_REASONS),
      ...overrides,
    });
    item.jobId = id;
    // The ledger row usually trails its job; sometimes it has already been settled.
    item.state = random.chance(0.7) ? state : random.pick(ITEM_STATES);
    return id;
  };

  const operation = await store.createRun(`equivalence-${seed}-operation`, {});
  const entitled = await store.createRun(`equivalence-${seed}-origin`, {});
  const detached = await store.createRun(`equivalence-${seed}-detached`, {});
  const plain = await store.createRun(`equivalence-${seed}-plain`, {});
  const runs = [operation, entitled, detached, plain];

  // A library source, its children, and a frozen selection on the plain run.
  const initial = randomUUID();
  const child = randomUUID();
  const frozen = randomUUID();
  const selections = [initial, child, frozen];
  const header = () => random.pick(HEADER_STATES);
  await sql`insert into job_selection(id,"runId",stage,queue,"safeToRetry",sensitive,"deadlineMs",state,"sourceKind","libraryOperationId","capturedAt") values
    (${initial}::uuid,${operation}::uuid,'initial',${queue()},false,false,60000,${random.chance(0.6) ? 'ready' : header()},'library-initial',${operation}::uuid,now()),
    (${child}::uuid,${operation}::uuid,'child',${queue()},false,false,60000,${header()},'library-child',${operation}::uuid,now()),
    (${frozen}::uuid,${plain}::uuid,'frozen',${queue()},false,false,60000,${header()},'frozen',null,${random.chance(0.8) ? PAST : null})`.execute(
    db,
  );

  // Each origin asks for the library through a producer request; only a live request entitles it.
  const producers: World['producers'] = [];
  for (const [runId, live] of [
    [entitled, true],
    [detached, random.chance(0.5)],
  ] as const) {
    const request: Item = {
      runId,
      itemKey: 'producer',
      rootItemKey: null,
      stage: 'produce',
      queue: open,
      selection: {},
    };
    const producer = job(request, { state: 'completed', token: null });
    request.state = live ? 'completed' : 'cancelled';
    if (random.chance(0.3)) {
      // The detailed job may be pruned; the request keeps the producer's identity.
      request.libraryProducerId = producer;
      request.jobId = null;
      jobs.pop();
    }
    items.push(request);
    producers.push({ runId, itemKey: 'producer' });
    await sql`insert into job_selection_run("runId","selectionId","copyComplete","libraryVersion")
      values (${runId}::uuid,${initial}::uuid,${random.chance(0.7)},${random.int(3)})`.execute(db);
    await sql`insert into job_library_source_producer("selectionId","producerId") values (${initial}::uuid,${producer}::uuid)`.execute(
      db,
    );
    if (random.chance(0.5)) {
      await sql`insert into job_selection_run("runId","selectionId","copyComplete") values (${runId}::uuid,${child}::uuid,true)`.execute(
        db,
      );
    }
  }

  // Fewer roots than rows: some roots hold several ledger rows, most hold one.
  const count = 12 + random.int(40);
  const roots = Array.from({ length: Math.max(4, Math.floor(count * (0.5 + random.int(5) / 10))) }, () => randomUUID());
  const root = () => (random.chance(0.04) ? null : random.pick(roots));
  const canonical: Item[] = [];
  for (let index = 0; index < count; index++) {
    const item: Item = {
      runId: operation,
      itemKey: `library/${index.toString().padStart(6, '0')}`,
      rootItemKey: root(),
      stage: 'initial',
      queue: queue(),
      selection: {},
      selectionId: initial,
      librarySourceKey: `source-${index}`,
      libraryIntent: { name: 'initial' },
      state: 'pending',
    };
    const shape = random.int(10);
    if (shape === 0) {
      job(item);
    } else if (shape === 1) {
      // A cold row with a retained outcome: its job has been pruned.
      item.state = random.pick(ITEM_STATES);
    } else if (shape === 2 && canonical.length > 0) {
      // Shares another row's physical execution.
      const owner = random.pick(canonical);
      item.libraryExecutionRunId = owner.runId;
      item.libraryExecutionItemKey = owner.itemKey;
    }
    canonical.push(item);
    items.push(item);
    // The origins hold copies of the canonical rows, cold unless they were settled on their own.
    for (const runId of [entitled, detached]) {
      if (!random.chance(0.85)) {
        continue;
      }

      const alias: Item = {
        ...item,
        runId,
        librarySourceKey: null,
        libraryIntent: null,
        jobId: null,
        state: 'pending',
        libraryExecutionRunId: null,
        libraryExecutionItemKey: null,
      };
      const settled = random.int(12);
      if (settled === 0) {
        alias.state = random.pick(ITEM_STATES);
      } else if (settled === 1) {
        job(alias);
      }
      items.push(alias);
    }
    // A processed root gains child stages in the operation, and sometimes in an origin.
    if (item.rootItemKey && random.chance(0.25)) {
      for (const runId of random.chance(0.3) ? [operation, entitled] : [operation]) {
        const stage: Item = {
          runId,
          itemKey: `${item.itemKey}/child`,
          rootItemKey: item.rootItemKey,
          stage: 'child',
          queue: queue(),
          selection: {},
          selectionId: child,
          state: random.pick(ITEM_STATES),
          ...(runId === operation && { librarySourceKey: `child-${index}`, libraryIntent: { name: 'child' } }),
        };
        if (random.chance(0.5)) {
          job(stage);
        }
        items.push(stage);
      }
    }
  }

  // A frozen manifest and rows that never belonged to a selection, two stages for some roots.
  for (let index = 0; index < 6 + random.int(12); index++) {
    const rootItemKey = root();
    for (const stage of random.chance(0.4) ? ['first', 'second'] : ['first']) {
      const item: Item = {
        runId: plain,
        itemKey: `plain/${index}`,
        rootItemKey,
        stage,
        queue: queue(),
        selection: {},
        selectionId: stage === 'first' && random.chance(0.5) ? frozen : null,
        state: random.pick(ITEM_STATES),
      };
      if (random.chance(0.6)) {
        const parent = jobs.findLast((candidate) => candidate.runId === plain);
        job(item, random.chance(0.3) && parent ? { parentId: parent.id } : {});
      }
      items.push(item);
    }
  }

  await db
    .insertInto('job_run_item')
    .values(items as never)
    .execute();
  if (jobs.length > 0) {
    await db
      .insertInto('job')
      .values(jobs as never)
      .execute();
  }
  for (const runId of runs) {
    if (random.chance(0.5)) {
      await sql`update job_run set "enumerationDone"=true,"finishedAt"=${random.chance(0.5) ? PAST : null} where id=${runId}::uuid`.execute(
        db,
      );
    }
  }
  return { runs, selections, queues, producers };
};

const expectSameSummary = async (db: Kysely<DB>, world: World, step: string) => {
  const expected = await legacyListRuns(db, 500, 0);
  expect(await listRuns(db, 500, 0), step).toEqual(expected);
  expect(expected.map((run) => run.id)).toEqual(expect.arrayContaining(world.runs));
  for (const runId of world.runs) {
    expect(await listRuns(db, 1, 0, runId), `${step}: ${runId}`).toEqual(await legacyListRuns(db, 1, 0, runId));
  }
  return expected;
};

it('summarises randomised ledgers exactly as the row-by-row read did', async () => {
  const db = await getKyselyDB();
  const store = new SqlQueueStore(db);
  try {
    let collapsed = 0;
    let shared = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const world = await buildWorld(db, store, seed);
      const random = generator(seed * 7919);
      await expectSameSummary(db, world, `seed ${seed}: built`);

      // Changes that move many rows' effective state without writing those rows.
      for (const state of HEADER_STATES) {
        await sql`update job_selection set state=${state} where id=${random.pick(world.selections)}::uuid`.execute(db);
        await expectSameSummary(db, world, `seed ${seed}: header ${state}`);
      }
      for (const queue of world.queues) {
        await store.pause(queue, random.chance(0.5));
      }
      await expectSameSummary(db, world, `seed ${seed}: pauses`);
      const producer = random.pick(world.producers);
      await sql`update job_run_item set state=${random.pick(['cancelled', 'completed'])}
        where "runId"=${producer.runId}::uuid and "itemKey"=${producer.itemKey}`.execute(db);
      await expectSameSummary(db, world, `seed ${seed}: producer request`);
      // A canonical row leaving its default state changes what its cold copies read.
      await sql`update job_run_item set state=${random.pick(ITEM_STATES)} where ("runId","itemKey",stage) in (
        select "runId","itemKey",stage from job_run_item where "runId"=${world.runs[0]}::uuid and "libraryIntent" is not null
        order by md5("itemKey"||${seed}::text) limit 5)`.execute(db);
      await expectSameSummary(db, world, `seed ${seed}: canonical outcomes`);

      const {
        rows: [shape],
      } = await sql<{ shared: number; cold: number }>`select
        (select count(*)::int from (select 1 from job_run_item where "runId"=any(${world.runs}::uuid[]) and "rootItemKey" is not null
          group by "runId","rootItemKey" having count(*) > 1) multiple) shared,
        (select count(*)::int from job_run_item where "runId"=any(${world.runs}::uuid[]) and "selectionId"=${world.selections[0]}::uuid
          and "jobId" is null and "libraryExecutionRunId" is null and state='pending') cold`.execute(db);
      shared += shape.shared;
      collapsed += shape.cold;
    }
    // The seeds exercised both paths: rows that collapse and roots that must be read row by row.
    expect(collapsed).toBeGreaterThan(200);
    expect(shared).toBeGreaterThan(50);
  } finally {
    await db.destroy();
  }
}, 180_000);

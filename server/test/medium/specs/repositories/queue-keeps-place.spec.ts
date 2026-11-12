import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { SqlQueueStore } from 'src/queue/store.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1479: work at the front of the line stays there through a retry or a wait for a busy server. */
describe('a job keeps its place in line', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  beforeEach(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    queue = `place-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });
  afterEach(async () => {
    await db.destroy();
  });

  const createRun = async (origin: string | null) => {
    const id = randomUUID();
    await sql`insert into job_run(id, kind, selection, "enumerationDone", origin)
      values (${id}::uuid, 'test', '{}', true, ${origin})`.execute(db);
    return id;
  };
  const intent = (itemKey: string, runId?: string) => ({
    queue,
    name: 'StorageTemplateMigrationSingle',
    data: { itemKey },
    safeToRetry: true,
    sensitive: false,
    deadlineMs: 600_000,
    ...(runId && { runId, itemKey, rootItemKey: itemKey }),
  });
  const key = (claim: { data: unknown }) => (claim.data as { itemKey: string }).itemKey;
  /** The wait a deferral or retry set is over. */
  const waitOver = () =>
    sql`update job set "availableAt" = now() where queue = ${queue} and "availableAt" > now()
      and "availableAt" <> 'infinity'`.execute(db);
  const idOf = async (itemKey: string) =>
    (await sql<{ id: string }>`select id from job where queue = ${queue} and data->>'itemKey' = ${itemKey}`.execute(db))
      .rows[0].id;

  it('claims an arrival before the backlog again after the server was busy', async () => {
    const upload = await createRun('phone');
    await store.enqueue([intent('upload', upload)]);
    const [first] = await store.claim(queue, worker, 1);
    expect(key(first)).toBe('upload');
    await store.enqueue([intent('backlog-1'), intent('backlog-2')]);
    expect(await store.defer(first, 'local-capacity')).toBe(true);
    await waitOver();

    const [next] = await store.claim(queue, worker, 1);
    expect(key(next)).toBe('upload');
  });

  it('claims an arrival before the backlog again when it is tried again after failing', async () => {
    const upload = await createRun('phone');
    await store.enqueue([intent('upload', upload)]);
    const [first] = await store.claim(queue, worker, 1);
    await store.enqueue([intent('backlog')]);
    await store.fail(first, 'The disk was busy');
    await waitOver();

    const [next] = await store.claim(queue, worker, 1);
    expect(key(next)).toBe('upload');
  });

  it('still claims a job started by hand on a paused task after it waited', async () => {
    await store.enqueue([intent('backlog'), intent('chosen')]);
    expect(await store.startNow(queue, await idOf('chosen'))).toBe(true);
    const [first] = await store.claim(queue, worker, 1);
    expect(key(first)).toBe('chosen');
    await store.defer(first, 'local-capacity');
    await waitOver();
    await sql`update job_queue set paused = true where name = ${queue}`.execute(db);

    const claims = await store.claim(queue, worker, 5);
    expect(claims.map((claim) => key(claim))).toEqual(['chosen']);
  });

  it('leaves a backlog job that waited where the wait put it', async () => {
    await store.enqueue([intent('backlog-1')]);
    const [first] = await store.claim(queue, worker, 1);
    await store.defer(first, 'local-capacity');
    const { rows } = await sql<{
      resumeAt: Date | null;
    }>`select "resumeAt" from job where id = ${first.id}::uuid`.execute(db);
    expect(rows[0].resumeAt).toBeNull();
  });

  it('runs the next steps of a job started by hand ahead of the backlog, and reports the queue as holding front work', async () => {
    await store.enqueue([intent('backlog'), intent('chosen')]);
    expect(await store.queuesWithFrontWork([queue])).toEqual([]);
    await store.startNow(queue, await idOf('chosen'));
    expect(await store.queuesWithFrontWork([queue])).toEqual([queue]);
    const [chosen] = await store.claim(queue, worker, 1);
    await store.complete(chosen, [intent('next-step')]);

    const [next] = await store.claim(queue, worker, 1);
    expect(key(next)).toBe('next-step');
  });
});

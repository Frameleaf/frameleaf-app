import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { SqlQueueStore } from 'src/queue/store.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1478: photos that just came in are processed before a library-wide backlog in the same queue. */
describe('arrivals first', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  beforeEach(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    queue = `arrivals-${randomUUID()}`;
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
  const intent = (itemKey: string, runId?: string, delay?: number) => ({
    queue,
    name: 'StorageTemplateMigrationSingle',
    data: { itemKey },
    safeToRetry: true,
    sensitive: false,
    deadlineMs: 600_000,
    ...(runId && { runId, itemKey, rootItemKey: itemKey }),
    ...(delay && { options: { delay } }),
  });
  const claimAll = async () => {
    const order: string[] = [];
    for (
      let claims = await store.claim(queue, worker, 1);
      claims.length > 0;
      claims = await store.claim(queue, worker, 1)
    ) {
      for (const claim of claims) {
        order.push((claim.data as { itemKey: string }).itemKey);
        await store.complete(claim, []);
      }
    }
    return order;
  };

  it('claims an upload’s work before older backlog work, and arrivals in the order they came', async () => {
    const backlog = await createRun(null);
    await store.enqueue([intent('backlog-1', backlog), intent('backlog-2'), intent('backlog-3', backlog)]);
    const first = await createRun('computer');
    await store.enqueue([intent('upload-1', first)]);
    const second = await createRun('phone');
    await store.enqueue([intent('upload-2', second)]);

    expect(await claimAll()).toEqual(['upload-1', 'upload-2', 'backlog-1', 'backlog-2', 'backlog-3']);
  });

  it('keeps a requested delay for arrival work', async () => {
    const upload = await createRun('computer');
    await store.enqueue([intent('later', upload, 60_000)]);

    expect(await claimAll()).toEqual([]);
  });
});

import { Kysely, sql } from 'kysely';
import { DB } from 'src/schema/index.js';
import { DATABASE_CLOSE_TIMEOUT_SECONDS } from 'src/utils/shutdown.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-299: the application's close ends with the database pool's. The driver closes it with no timeout,
 * which waits for every query in flight: a worker stopped during a long one (the geodata import's
 * index builds on a fresh boot) sat there until its 8 s deadline. The pool now gives such a query
 * DATABASE_CLOSE_TIMEOUT_SECONDS, then closes its connection.
 */
describe('closing the database pool (FL-299)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    // the pool logs the query it cuts
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db = await getKyselyDB();
  });

  afterEach(async () => {
    await db.destroy();
    vi.restoreAllMocks();
  });

  it('closes within its timeout though a query is still running, and that query fails', async () => {
    const slow = sql`select pg_sleep(30), 'fl-299-slow'`
      .execute(db)
      .then(() => 'finished')
      .catch((error: unknown) => error);
    await vi.waitFor(async () => {
      const { rows } = await sql<{ running: number }>`
        select count(*)::int as running from pg_stat_activity
        where state = 'active' and pid <> pg_backend_pid() and query like '%fl-299-slow%'
      `.execute(db);
      expect(rows[0].running).toBe(1);
    });

    const startedAt = performance.now();
    await db.destroy();
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(DATABASE_CLOSE_TIMEOUT_SECONDS * 1000 - 50);
    expect(elapsed).toBeLessThan(2000);
    await expect(slow).resolves.toMatchObject({ code: 'CONNECTION_DESTROYED' });
  }, 20_000);

  it('closes at once when nothing is running', async () => {
    await sql`select 1`.execute(db);

    const startedAt = performance.now();
    await db.destroy();

    expect(performance.now() - startedAt).toBeLessThan(DATABASE_CLOSE_TIMEOUT_SECONDS * 1000);
  });
});

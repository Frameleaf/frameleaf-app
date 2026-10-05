import { sql } from 'kysely';
import { createRequire } from 'node:module';
import postgres from 'postgres';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

const require = createRequire(import.meta.url);
const commonJS = require('postgres') as typeof postgres;

// Exercise both Node entrypoints of the pinned driver, without the application reservation wrapper.
describe.each([
  { entrypoint: 'ESM', driver: postgres },
  { entrypoint: 'CJS', driver: commonJS },
])('postgres reservation ownership ($entrypoint)', ({ driver }) => {
  it('rejects lost-session rollback and queued writes while granting a fresh waiting reservation without replay', async ({
    onTestFinished,
  }) => {
    const observer = await getKyselyDB();
    const { rows } = await sql<{ name: string }>`select current_database() name`.execute(observer);
    const url = canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name);
    const dispatched: string[] = [];
    const closed = Promise.withResolvers<void>();
    // The pinned runtime supports max_pipeline; its published Options omit this setting.
    const options: postgres.Options<Record<string, never>> & { max_pipeline: number } = {
      max: 1,
      max_pipeline: 1,
      connect_timeout: 3,
      connection: { statement_timeout: 5000 },
      debug: (_connection, query) => {
        dispatched.push(query);
      },
      onclose: () => closed.resolve(),
    };
    const client = driver(url, options);
    const close = async () => {
      await client.end({ timeout: 0 });
      await observer.destroy();
    };
    onTestFinished(close);
    let held: postgres.ReservedSql | undefined;
    let fresh: postgres.ReservedSql | undefined;
    let following: postgres.ReservedSql | undefined;
    try {
      await sql`create table reservation_probe (id integer primary key)`.execute(observer);
      held = await client.reserve();
      const [{ pid }] = await held.unsafe<{ pid: number }[]>('select pg_backend_pid() pid');
      await held.unsafe('begin');
      await held.unsafe('insert into reservation_probe values (1)');
      const outcome = (query: PromiseLike<unknown>) =>
        Promise.resolve(query)
          .then(() => ({ fulfilled: true, code: undefined }))
          .catch((error: unknown) => ({ fulfilled: false, code: (error as { code?: string }).code }));
      const sleeping = outcome(held.unsafe('select pg_sleep(20)'));
      await vi.waitFor(
        async () => {
          const { rows } = await sql<{ wait: string | null }>`select wait_event as wait from pg_stat_activity
            where pid = ${pid} and state = 'active'`.execute(observer);
          expect(rows[0]?.wait).toBe('PgSleep');
        },
        { timeout: 2000, interval: 20 },
      );
      // max_pipeline counts sent queries in addition to the active sleep. Fill that slot explicitly.
      const sentWrite = 'insert into reservation_probe values (2)';
      const sent = outcome(held.unsafe(sentWrite));
      await sql`select 1`.execute(observer);
      expect(dispatched).toContain(sentWrite);
      const writes = ['insert into reservation_probe values (3)', 'insert into reservation_probe values (4)'];
      const queued = writes.map((query) => outcome(held!.unsafe(query)));
      // The only connection is held: this pool-level consumer must survive loss of the old reservation.
      const waiting = client
        .reserve()
        .then((grant) => ({ grant, error: undefined }))
        .catch((error: unknown) => ({ grant: undefined, error }));
      let followingGranted = false;
      const nextWaiting = client
        .reserve()
        .then((grant) => {
          followingGranted = true;
          return { grant, error: undefined };
        })
        .catch((error: unknown) => ({ grant: undefined, error }));
      // A fresh ordinary consumer behind both reserves must execute only after both owners release.
      const ordinaryWrite = 'insert into reservation_probe values (5)';
      const ordinary = outcome(client.unsafe(ordinaryWrite));
      // The sent slot is full; an independent round trip lets both private-queue handlers run.
      await sql`select 1`.execute(observer);
      for (const query of writes) expect(dispatched).not.toContain(query);
      const { rows: stopped } = await sql<{
        stopped: boolean;
      }>`select pg_terminate_backend(${pid}, 5000) stopped`.execute(observer);
      expect(stopped).toEqual([{ stopped: true }]);
      await closed.promise;
      await expect(held.unsafe('rollback')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
      expect(await sleeping).toEqual({ fulfilled: false, code: '57P01' });
      expect(await sent).toEqual({ fulfilled: false, code: '57P01' });
      expect(await Promise.all(queued)).toEqual([
        { fulfilled: false, code: 'CONNECTION_CLOSED' },
        { fulfilled: false, code: 'CONNECTION_CLOSED' },
      ]);
      const result = await waiting;
      expect(result.error).toBeUndefined();
      expect(result.grant).toBeDefined();
      fresh = result.grant!;
      const [{ pid: replacementPid }] = await fresh.unsafe<{ pid: number }[]>('select pg_backend_pid() pid');
      expect(replacementPid).not.toBe(pid);
      held.release();
      held.release();
      expect(await fresh.unsafe('select id from reservation_probe')).toHaveLength(0);
      expect(followingGranted).toBe(false);
      expect(dispatched).not.toContain(ordinaryWrite);
      await fresh.unsafe('insert into reservation_probe values (6)');
      expect(await fresh.unsafe('select id from reservation_probe order by id')).toEqual([{ id: 6 }]);
      fresh.release();
      const nextResult = await nextWaiting;
      expect(nextResult.error).toBeUndefined();
      expect(nextResult.grant).toBeDefined();
      following = nextResult.grant!;
      fresh.release();
      expect(await following.unsafe('select id from reservation_probe order by id')).toEqual([{ id: 6 }]);
      expect(dispatched).not.toContain(ordinaryWrite);
      following.release();
      expect(await ordinary).toEqual({ fulfilled: true, code: undefined });
      expect(await client.unsafe('select id from reservation_probe order by id')).toEqual([{ id: 5 }, { id: 6 }]);
      for (const query of writes) expect(dispatched).not.toContain(query);
    } finally {
      following?.release();
      fresh?.release();
      held?.release();
      await close();
    }
  }, 10_000);

  it('refuses queries and duplicate releases from an old owner without exposing the current reservation', async ({
    onTestFinished,
  }) => {
    const client = driver(process.env.IMMICH_TEST_POSTGRES_URL!, { max: 1, connect_timeout: 3 });
    onTestFinished(() => client.end({ timeout: 0 }));
    let old: postgres.ReservedSql | undefined;
    let current: postgres.ReservedSql | undefined;
    let next: postgres.ReservedSql | undefined;
    try {
      old = await client.reserve();
      const [{ pid }] = await old.unsafe<{ pid: number }[]>('select pg_backend_pid() pid');
      old.release();
      current = await client.reserve();
      await current.unsafe('begin');
      old.release();
      old.release();
      let delivered = false;
      const waiting = client
        .reserve()
        .then((grant) => {
          delivered = true;
          return { grant, error: undefined };
        })
        .catch((error: unknown) => ({ grant: undefined, error }));
      // The current owner's real round trip is the barrier; no timing assumption about a sleeping waiter.
      expect(await current.unsafe('select pg_backend_pid() pid')).toEqual([{ pid }]);
      expect(delivered).toBe(false);
      await expect(old.unsafe('rollback')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
      await current.unsafe('commit');
      current.release();
      const result = await waiting;
      expect(result.error).toBeUndefined();
      next = result.grant!;
      expect(next).toBeDefined();
      current.release();
      expect(await next.unsafe('select pg_backend_pid() pid')).toEqual([{ pid }]);
    } finally {
      next?.release();
      current?.release();
      old?.release();
      await client.end({ timeout: 0 });
    }
  }, 10_000);
});

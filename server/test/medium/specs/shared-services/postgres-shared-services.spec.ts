import { Kysely } from 'kysely';
import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { Server } from 'socket.io';
import type { DB } from 'src/schema/index.js';
import { PostgresSocketTransport } from 'src/middleware/websocket.adapter.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type RateLimitHit, RateLimitRepository, type SignInAttempt } from 'src/repositories/rate-limit.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { closeSharedServicePool, createSharedServicePool, trackPoolClients } from 'src/utils/shared-service-pool.js';

/** Uses the canonical PG19 medium-test template. No test performs application startup DDL. */
describe('PostgreSQL shared services', () => {
  let admin: Pool;
  let database: Pool;
  let databaseName: string;
  let url: string;
  let config: ConfigRepository;
  let repositories: RateLimitRepository[];
  let transport: PostgresSocketTransport | undefined;
  let server: Server | undefined;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    const template = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    const templateName = template.pathname.slice(1);
    // Identifiers are generated here; the template name comes from the fixed hosted test bootstrap.
    expect(templateName).toMatch(/^[a-zA-Z0-9_]+$/);
    template.pathname = '/postgres';
    admin = new Pool({ connectionString: template.href, max: 1 });
    databaseName = `frameleaf_shared_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE "${templateName}"`);
    template.pathname = `/${databaseName}`;
    url = template.href;
    database = new Pool({ connectionString: url, max: 2 });
    config = {
      getEnv: () => ({ database: { config: { connectionType: 'url', url } } }),
    } as unknown as ConfigRepository;
  }, 30_000);

  beforeEach(() => {
    repositories = [];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      const peer = child;
      if (peer && peer.exitCode === null && peer.signalCode === null) {
        const exited = once(peer, 'exit');
        const timer = setTimeout(() => peer.kill('SIGKILL'), 5000);
        try {
          if (peer.connected) {
            peer.send({ type: 'stop' }, (error) => {
              if (error) peer.kill('SIGTERM');
            });
          } else {
            peer.kill('SIGTERM');
          }
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      child = undefined;
      try {
        if (server) {
          await server.close();
          expect(server.httpServer.listening).toBe(false);
        }
      } finally {
        server = undefined;
        try {
          if (transport) {
            await transport.close();
            expect(transport.pool.totalCount).toBe(0);
          }
        } finally {
          transport = undefined;
          await Promise.all(repositories.map((repository) => repository.onModuleDestroy()));
          await database.query(
            'TRUNCATE public.frameleaf_rate_limit, public.frameleaf_upload_lease, public.socket_io_attachments, public.frameleaf_websocket_worker',
          );
        }
      }
    }
  }, 15_000);
  afterAll(async () => {
    await database?.end();
    if (admin) {
      try {
        await admin.query(`DROP DATABASE "${databaseName}"`);
      } finally {
        await admin.end();
      }
    }
  });

  const admission = () => {
    const repository = new RateLimitRepository(config);
    repositories.push(repository);
    return repository;
  };

  it('grows the wait after confirmed failures, independently of other addresses, and resets on success', async () => {
    const counters = admission();
    const key = 'sign-in-backoff:address-a';
    await Promise.all(Array.from({ length: 4 }, () => counters.recordSignInFailure(key)));
    expect(await counters.getSignInWait(key)).toBe(0);
    await counters.recordSignInFailure(key);
    expect(await counters.getSignInWait(key)).toBeGreaterThanOrEqual(28);
    expect(await counters.getSignInWait('sign-in-backoff:address-b')).toBe(0);

    await database.query(
      "update public.frameleaf_rate_limit set expires_at = expires_at - interval '31 seconds' where key = $1",
      [key],
    );
    expect(await counters.getSignInWait(key)).toBe(0);
    await counters.recordSignInFailure(key);
    expect(await counters.getSignInWait(key)).toBeGreaterThanOrEqual(58);

    await counters.clearSignInFailures(key);
    expect(await counters.getSignInWait(key)).toBe(0);
  });

  it('holds one sign-in attempt per key across admission workers and exposes the recorded result', async () => {
    const first = admission();
    const second = admission();
    const key = 'sign-in-backoff:concurrent-a';
    const other = 'sign-in-backoff:concurrent-b';
    for (let attempt = 0; attempt < 4; attempt++) await first.recordSignInFailure(key);

    const owner = await first.acquireSignInAttempt(key);
    expect(owner).toBeDefined();
    try {
      expect(await second.acquireSignInAttempt(key)).toBeUndefined();
      const unrelated = await second.acquireSignInAttempt(other);
      expect(unrelated).toBeDefined();
      await unrelated?.release();
      expect(await owner?.getWait()).toBe(0);
      await owner?.recordFailure();
    } finally {
      await owner?.release();
    }

    const later = await second.acquireSignInAttempt(key);
    try {
      expect(await later?.getWait()).toBeGreaterThanOrEqual(28);
    } finally {
      await later?.release();
    }
  });

  it('keeps distinct sign-in checks available while other checks hold connections', async () => {
    const counters = admission();
    const attempts: SignInAttempt[] = [];
    try {
      for (const address of ['a', 'b', 'c']) {
        const attempt = await counters.acquireSignInAttempt(`sign-in-backoff:parallel-${address}`);
        if (attempt) attempts.push(attempt);
      }
      expect(attempts).toHaveLength(3);
    } finally {
      await Promise.all(attempts.map((attempt) => attempt.release()));
    }
  });

  it('counts a rolling hour of failures and stores at most twenty timestamps', async () => {
    const counters = admission();
    const key = 'sign-in-burst:account';
    for (let count = 0; count < 19; count++) expect(await counters.recordSignInBurst(key)).toBe(false);
    expect(await counters.recordSignInBurst(key)).toBe(true);
    await database.query(
      "update public.frameleaf_rate_limit set failure_times = array[clock_timestamp() - interval '61 minutes'] where key = $1",
      [key],
    );
    expect(await counters.recordSignInBurst(key)).toBe(false);
    const { rows } = await database.query(
      'select cardinality(failure_times) as count from public.frameleaf_rate_limit where key = $1',
      [key],
    );
    expect(rows[0].count).toBe(1);
  });

  it('observes the first device silently and admits a new device exactly once across workers', async () => {
    const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url }));
    try {
      const sessions = new SessionRepository(db);
      const group = await db.insertInto('cluster_group').defaultValues().returning('id').executeTakeFirstOrThrow();
      const user = await db
        .insertInto('user')
        .values({
          email: 'known-device@example.test',
          name: 'Known device',
          clusterGroupId: group.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const first = Buffer.alloc(32, 1);
      const second = Buffer.alloc(32, 2);
      const publish = vi.fn(() => Promise.resolve());
      const prepare = vi.fn(() => Promise.resolve(publish));
      expect(await sessions.observeKnownDevice(user.id, first, prepare)).toBe(false);
      expect(await sessions.observeKnownDevice(user.id, first, prepare)).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      await expect(
        sessions.observeKnownDevice(user.id, second, () =>
          Promise.resolve(() => Promise.reject(new Error('queue unavailable'))),
        ),
      ).rejects.toThrow('queue unavailable');
      const results = await Promise.all(
        Array.from({ length: 3 }, () => sessions.observeKnownDevice(user.id, second, prepare)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(await db.selectFrom('user_known_device').selectAll().where('userId', '=', user.id).execute()).toHaveLength(
        2,
      );
      await db.deleteFrom('user').where('id', '=', user.id).execute();
      expect(await db.selectFrom('user_known_device').selectAll().where('userId', '=', user.id).execute()).toEqual([]);
      await db.deleteFrom('cluster_group').where('id', '=', group.id).execute();
    } finally {
      await db.destroy();
    }
  });

  it('retries failed sign-in notice channels without publishing completed channels twice', async () => {
    const db = new Kysely<DB>(getKyselyConfig(config.getEnv().database.config));
    const notices = new DatabaseRepository(db, LoggingRepository.create(), config);
    const notification = vi.fn(() => Promise.resolve('notice'));
    const email = vi.fn(() => Promise.resolve('email'));
    const notificationKey = 'sign-in-notice:in-app:account';
    const emailKey = 'sign-in-notice:email:account';
    try {
      await expect(notices.publishSignInNotice(notificationKey, notification)).resolves.toBe('notice');
      await expect(
        notices.publishSignInNotice(emailKey, () => Promise.reject(new Error('queue unavailable'))),
      ).rejects.toThrow('queue unavailable');
      expect(await notices.hasSignInNotice(notificationKey)).toBe(true);
      expect(await notices.hasSignInNotice(emailKey)).toBe(false);
      await expect(notices.publishSignInNotice(notificationKey, notification)).resolves.toBeUndefined();
      const results = await Promise.all(Array.from({ length: 3 }, () => notices.publishSignInNotice(emailKey, email)));
      expect(results.filter(Boolean)).toEqual(['email']);
      expect(notification).toHaveBeenCalledTimes(1);
      expect(email).toHaveBeenCalledTimes(1);
    } finally {
      await notices.shutdown();
    }
  });

  const socketServer = async () => {
    const http = createServer();
    server = new Server(http, { transports: ['websocket'] });
    const listening = once(http, 'listening');
    http.listen(0, '127.0.0.1');
    await listening;
    return server;
  };

  it('increments one fixed window atomically across independent workers and releases without underflow', async () => {
    const workers = [admission(), admission(), admission(), admission()];
    const hits = await Promise.all(Array.from({ length: 48 }, (_, index) => workers[index % 4].hit('counter', 600)));
    expect(hits.map((hit) => hit.count).toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 48 }, (_, index) => index + 1),
    );
    expect(hits.every((hit) => hit.resetSeconds >= 598 && hit.resetSeconds <= 600)).toBe(true);
    await Promise.all(
      Array.from({ length: 48 }, (_, index) => workers[index % 4].release('counter', hits[index].windowExpiresAt!)),
    );
    const restarted = await workers[0].hit('counter', 600);
    expect(restarted).toEqual({ count: 1, resetSeconds: 600, windowExpiresAt: expect.any(String) });
    await database.query(
      `UPDATE public.frameleaf_rate_limit SET expires_at = clock_timestamp() - interval '1 second' WHERE key = $1`,
      ['counter'],
    );
    await workers[1].release('counter', restarted.windowExpiresAt!);
    await expect(workers[2].hit('counter', 600)).resolves.toEqual({
      count: 1,
      resetSeconds: 600,
      windowExpiresAt: expect.any(String),
    });
  });

  it('does not refund a replacement counter window with a late request from the expired window', async () => {
    const repository = admission();
    const old = await repository.hit('refund-window', 600);
    await database.query(
      "UPDATE public.frameleaf_rate_limit SET expires_at = clock_timestamp() - interval '1 second' WHERE key = $1",
      ['refund-window'],
    );
    const current = await repository.hit('refund-window', 600);
    expect(current.count).toBe(1);
    expect(current.windowExpiresAt).not.toBe(old.windowExpiresAt);
    await repository.release('refund-window', old.windowExpiresAt!);
    expect(
      (await database.query('SELECT count FROM public.frameleaf_rate_limit WHERE key = $1', ['refund-window'])).rows,
    ).toEqual([{ count: 1 }]);
    await repository.release('refund-window', current.windowExpiresAt!);
    expect(
      (await database.query('SELECT count FROM public.frameleaf_rate_limit WHERE key = $1', ['refund-window'])).rows,
    ).toEqual([{ count: 0 }]);
  });

  it('reports the remaining window when an older waiting hit loses row creation to a newer hit', async () => {
    const blocker = await database.connect();
    let locked = false;
    let pending: Promise<{ hit?: RateLimitHit; error?: unknown }> | undefined;
    try {
      await database.query(`CREATE FUNCTION public.wait_for_rate_winner() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.key = 'ordered-counter' AND pg_try_advisory_xact_lock(333, 1) THEN
            PERFORM pg_advisory_xact_lock(333, 2);
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER wait_for_rate_winner BEFORE INSERT ON public.frameleaf_rate_limit
          FOR EACH ROW EXECUTE FUNCTION public.wait_for_rate_winner()`);
      await blocker.query('BEGIN');
      locked = true;
      await blocker.query('SELECT pg_advisory_xact_lock(333, 2)');
      // The first request owns (333, 1) and waits at (333, 2). The later request bypasses that barrier.
      pending = admission()
        .hit('ordered-counter', 600)
        .then((hit) => ({ hit }))
        .catch((error: unknown) => ({ error }));
      const pid = await vi.waitFor(
        async () => {
          const waiting = await database.query<{ pid: number }>(`SELECT l.pid FROM pg_locks l
            JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND l.classid = 333 AND l.objid = 2 AND l.objsubid = 2
              AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND NOT l.granted AND a.application_name = 'frameleaf:admission'`);
          expect(waiting.rows).toHaveLength(1);
          return waiting.rows[0].pid;
        },
        { timeout: 1000, interval: 10 },
      );
      await expect(admission().hit('ordered-counter', 600)).resolves.toEqual({
        count: 1,
        resetSeconds: 600,
        windowExpiresAt: expect.any(String),
      });
      const winner = await database.query<{ expiresAt: string; startedAfterWaiter: boolean }>(
        `SELECT expires_at::text AS "expiresAt",
           expires_at - interval '600 seconds' > a.query_start AS "startedAfterWaiter"
         FROM public.frameleaf_rate_limit CROSS JOIN pg_stat_activity a
         WHERE key = 'ordered-counter' AND a.pid = $1`,
        [pid],
      );
      expect(winner.rows).toHaveLength(1);
      expect(winner.rows[0].startedAfterWaiter).toBe(true);
      await blocker.query('COMMIT');
      locked = false;
      const result = await pending;
      expect(result.error).toBeUndefined();
      expect(result.hit?.count).toBe(2);
      expect(result.hit?.resetSeconds).toBeGreaterThanOrEqual(598);
      expect(result.hit?.resetSeconds).toBeLessThanOrEqual(600);
      const stored = await database.query(`SELECT count, expires_at::text AS "expiresAt"
        FROM public.frameleaf_rate_limit WHERE key = 'ordered-counter'`);
      expect(stored.rows).toEqual([{ count: 2, expiresAt: winner.rows[0].expiresAt }]);
    } finally {
      try {
        if (locked) await blocker.query('ROLLBACK');
      } finally {
        blocker.release();
        await pending;
        await database.query(`DROP TRIGGER IF EXISTS wait_for_rate_winner ON public.frameleaf_rate_limit;
          DROP FUNCTION IF EXISTS public.wait_for_rate_winner()`);
      }
    }
  });

  it('admits exactly one upload token, survives claimant exit, and fences stale token release after expiry', async () => {
    const workers = [admission(), admission()];
    const tokens = Array.from({ length: 32 }, () => randomUUID());
    const attempts = await Promise.all(
      tokens.map((token, index) => workers[index % 2].claimUploadStream('resource', token)),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const winner = tokens[attempts.indexOf(true)];
    const lease = await database.query(
      `SELECT CEIL(EXTRACT(EPOCH FROM expires_at - clock_timestamp()))::integer AS ttl FROM public.frameleaf_upload_lease WHERE key = $1`,
      ['resource'],
    );
    expect(lease.rows[0].ttl).toBeGreaterThan(895);
    expect(lease.rows[0].ttl).toBeLessThanOrEqual(900);
    await workers[0].onModuleDestroy();
    repositories.shift();
    await expect(workers[1].claimUploadStream('resource', 'replacement')).resolves.toBe(false);
    await database.query(
      `UPDATE public.frameleaf_upload_lease SET expires_at = clock_timestamp() - interval '1 second' WHERE key = $1`,
      ['resource'],
    );
    await expect(workers[1].isUploadStreamCurrent('resource', winner)).resolves.toBe(false);
    await expect(workers[1].claimUploadStream('resource', 'replacement')).resolves.toBe(true);
    await workers[1].releaseUploadStream('resource', winner);
    await expect(workers[1].isUploadStreamCurrent('resource', 'replacement')).resolves.toBe(true);
    await workers[1].releaseUploadStream('resource', 'replacement');
    await expect(workers[1].isUploadStreamCurrent('resource', 'replacement')).resolves.toBe(false);
  });

  it('times out pool saturation and blocked SQL and closes the bounded pool', async () => {
    const pool = createSharedServicePool(config, 'timeout-test', 1);
    const clients = trackPoolClients(pool);
    const reserved = await pool.connect();
    try {
      const started = Date.now();
      await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/i);
      expect(Date.now() - started).toBeLessThan(4000);
      reserved.release();
      await expect(pool.query('SELECT pg_sleep(10)')).rejects.toThrow(/timeout|canceling statement/i);
    } finally {
      await closeSharedServicePool(pool, clients);
    }
  }, 15_000);

  it('destroys a checked-out listener when shutdown must reach its deadline', async () => {
    const pool = createSharedServicePool(config, 'shutdown-test', 1);
    const clients = trackPoolClients(pool);
    await pool.connect();
    await closeSharedServicePool(pool, clients);
    expect(pool.totalCount).toBe(0);
    await expect(pool.query('SELECT 1')).rejects.toThrow(/end/i);
  }, 5000);

  it('delivers rooms, binary attachments, channel messages and restart ACKs across OS processes and cleans stale attachments', async () => {
    server = await socketServer();
    const websocket = new WebsocketRepository({} as never, { setContext: vi.fn(), debug: vi.fn() } as never);
    Reflect.set(websocket, 'server', server);
    server.on('AppRestart', async (_state, ack) => websocket.acknowledgeRestart(ack));
    transport = new PostgresSocketTransport(config);
    await transport.attach(server);
    child = fork(fileURLToPath(new URL('../../fixtures/postgres-socket-worker.mjs', import.meta.url)), [], {
      env: { ...process.env, FRAMELEAF_TEST_DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const peer = await new Promise<{ pid: number; id: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child websocket worker startup timed out')), 10_000);
      child!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Child websocket worker exited during startup'));
      });
      child!.once('message', (message) => {
        clearTimeout(timer);
        resolve(message as { pid: number; id: string });
      });
    });
    expect(peer.pid).not.toBe(process.pid);
    await vi.waitFor(async () => expect(await server!.sockets.adapter.serverCount()).toBe(2));
    const payload = Buffer.alloc(12_000, 7);
    const messages = await server.serverSideEmitWithAck('channel-test', payload);
    expect(messages).toEqual([{ pid: peer.pid, size: payload.length }]);
    const rooms = await server.to('frameleaf-test-room').timeout(5000).emitWithAck('room-test', payload);
    expect(rooms).toEqual([{ size: payload.length, pid: peer.pid }]);
    const observeRestart = async (type: string, send: () => Promise<void>) => {
      let timer: NodeJS.Timeout | undefined;
      let listener: ((message: unknown) => void) | undefined;
      let stopWaiting!: (error: Error) => void;
      const notice = new Promise<unknown>((resolve, reject) => {
        stopWaiting = reject;
        listener = (message) => {
          if ((message as { type?: string }).type === type) {
            resolve(message);
          }
        };
        child!.on('message', listener);
        timer = setTimeout(() => reject(new Error(`Peer did not receive ${type}`)), 5000);
      });
      // Attach failure ownership before invoking the publisher, then settle both paths in finally.
      const outcome = notice.then((message) => ({ message })).catch((error: unknown) => ({ error }));
      try {
        await send();
        expect(await outcome).toEqual({ message: { type, state: { isMaintenanceMode: true } } });
      } finally {
        clearTimeout(timer);
        child!.off('message', listener!);
        stopWaiting(new Error('Restart observation owner finished'));
        await outcome;
      }
    };
    await observeRestart('client-restart', () =>
      websocket.clientBroadcastAndFlush('AppRestartV1', { isMaintenanceMode: true }),
    );
    await observeRestart('worker-restart', () =>
      websocket.serverSendAndFlush('AppRestart', { isMaintenanceMode: true }),
    );
    vi.spyOn(ConfigRepository.prototype, 'getEnv').mockReturnValue(config.getEnv());
    await expect(new AppRepository().sendOneShotAppRestart({ isMaintenanceMode: true })).resolves.toBeUndefined();
    await database.query(
      `INSERT INTO public.socket_io_attachments (created_at, payload) VALUES (clock_timestamp() - interval '1 hour', $1)`,
      [Buffer.from('stale')],
    );
    await vi.waitFor(
      async () => {
        const stale = await database.query(
          `SELECT id FROM public.socket_io_attachments WHERE created_at < clock_timestamp() - interval '1 minute'`,
        );
        expect(stale.rowCount).toBe(0);
      },
      { timeout: 5000 },
    );
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await vi.waitFor(
      async () => {
        const workers = await database.query(
          `SELECT COUNT(*)::integer AS count FROM public.frameleaf_websocket_worker WHERE expires_at > clock_timestamp()`,
        );
        expect(workers.rows[0].count).toBe(1);
      },
      { timeout: 8000 },
    );
  }, 35_000);

  it.each([false, true])(
    'joins actual remote configuration handlers and propagates failure=%s',
    async (fixtureFailure) => {
      server = await socketServer();
      transport = new PostgresSocketTransport(config);
      await transport.attach(server);
      const websocket = new WebsocketRepository({} as never, { setContext: vi.fn(), debug: vi.fn() } as never);
      Reflect.set(websocket, 'server', server);
      child = fork(fileURLToPath(new URL('../../fixtures/postgres-config-worker.mjs', import.meta.url)), [], {
        env: { ...process.env, FRAMELEAF_TEST_DATABASE_URL: url },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const peerMessage = (type: string) =>
        new Promise<unknown>((resolve, reject) => {
          const peer = child!;
          const listener = (message: unknown) => {
            if ((message as { type?: string }).type !== type) return;
            clearTimeout(timer);
            peer.off('message', listener);
            resolve(message);
          };
          const timer = setTimeout(() => {
            peer.off('message', listener);
            reject(new Error(`Owned peer did not reach ${type}`));
          }, 10_000);
          peer.on('message', listener);
        });
      const ready = (await peerMessage('ready')) as { pid: number };
      expect(ready.pid).not.toBe(process.pid);
      const entered = peerMessage('config-entered');
      let settled = false;
      const outcome = websocket
        .awaitConfigUpdate({ fixtureFailure } as never)
        .then(() => ({ success: true }))
        .catch((error: unknown) => ({ error }))
        .finally(() => (settled = true));
      await entered;
      expect(settled).toBe(false);
      child.send({ type: 'release' });
      const result = await outcome;
      if (fixtureFailure) {
        expect(result).toHaveProperty('error');
        expect((result as { error: Error }).error.message).toMatch(/failed configuration reconciliation/);
      } else {
        expect(result).toEqual({ success: true });
      }
    },
    20_000,
  );

  it.each([false, true])(
    'binds newly joined peer ACKs to discovered identities after installed adapter eviction; expected worker ACK=%s',
    async (expectedWorkerAck) => {
      server = await socketServer();
      transport = new PostgresSocketTransport(config);
      await transport.attach(server);
      const publisher = server;
      const peerA = await socketServer();
      const transportA = new PostgresSocketTransport(config);
      const peerB = await socketServer();
      const transportB = new PostgresSocketTransport(config);
      server = publisher;
      try {
        await transportA.attach(peerA);
        let enteredA!: () => void;
        const receivedA = new Promise<void>((resolve) => (enteredA = resolve));
        let ackA!: (result: unknown) => void;
        let publicationA!: Record<string, unknown>;
        peerA.on('ConfigUpdate', (...args: unknown[]) => {
          publicationA = args.at(-2) as Record<string, unknown>;
          ackA = args.at(-1) as (result: unknown) => void;
          enteredA();
        });
        peerB.on('ConfigUpdate', (...args: unknown[]) => {
          const ack = args.at(-1) as (result: unknown) => void;
          const publication = args.at(-2) as Record<string, unknown>;
          ack({ ...publication, workerId: transportB.workerId, result: 'ok' });
        });
        const discover = transport.discoverWorkers.bind(transport);
        let discovered: unknown;
        vi.spyOn(transport, 'discoverWorkers').mockImplementation(async (publisher) => {
          const expected = await discover(publisher, true);
          discovered = expected;
          await transportB.attach(peerB);
          await vi.waitFor(async () => expect(await server!.sockets.adapter.serverCount()).toBe(3));
          // Vitest types overloaded mocks using the final restart signature (number).
          return expected as never;
        });
        const websocket = new WebsocketRepository({} as never, { setContext: vi.fn() } as never);
        Reflect.set(websocket, 'server', server);
        const outcome = websocket
          .awaitConfigUpdate({} as never)
          .then(() => ({ success: true }))
          .catch((error: unknown) => ({ error }));
        await receivedA;
        expect(discovered).toEqual([transportA.workerId]);
        if (expectedWorkerAck)
          await transportA.publish(() => ackA({ ...publicationA, workerId: transportA.workerId, result: 'ok' }));
        await peerA.close();
        const result = await outcome;
        if (expectedWorkerAck) {
          expect(result).toEqual({ success: true });
        } else {
          expect(result).toHaveProperty('error');
          expect((result as { error: Error }).error.message).toMatch(/failed configuration reconciliation/);
        }
      } finally {
        await peerA.close();
        await transportA.close();
        await peerB.close();
        await transportB.close();
      }
    },
    20_000,
  );

  it('rejects restart discovery with no live worker instead of accepting an empty ACK set', async () => {
    server = await socketServer();
    transport = new PostgresSocketTransport(config);
    await transport.attach(server, false);
    await expect(transport.discoverWorkers(server)).rejects.toThrow('No live websocket workers');
  });
});

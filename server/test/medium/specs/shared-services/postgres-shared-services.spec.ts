import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { Server } from 'socket.io';
import { PostgresSocketTransport } from 'src/middleware/websocket.adapter.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { type RateLimitHit, RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
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
    await Promise.all(Array.from({ length: 48 }, (_, index) => workers[index % 4].release('counter')));
    await expect(workers[0].hit('counter', 600)).resolves.toEqual({ count: 1, resetSeconds: 600 });
    await database.query(
      `UPDATE public.frameleaf_rate_limit SET expires_at = clock_timestamp() - interval '1 second' WHERE key = $1`,
      ['counter'],
    );
    await workers[1].release('counter');
    await expect(workers[2].hit('counter', 600)).resolves.toEqual({ count: 1, resetSeconds: 600 });
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
      await expect(admission().hit('ordered-counter', 600)).resolves.toEqual({ count: 1, resetSeconds: 600 });
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

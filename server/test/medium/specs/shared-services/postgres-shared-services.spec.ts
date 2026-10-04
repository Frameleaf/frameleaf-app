import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { Server } from 'socket.io';
import { PostgresSocketTransport } from 'src/middleware/websocket.adapter.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
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
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);
      child.send({ type: 'stop' });
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    child = undefined;
    if (server) {
      await new Promise<void>((resolve) => void server!.close(() => resolve()));
      server = undefined;
    }
    await transport?.close();
    transport = undefined;
    await Promise.all(repositories.map((repository) => repository.onModuleDestroy()));
    await database.query(
      'TRUNCATE public.frameleaf_rate_limit, public.frameleaf_upload_lease, public.socket_io_attachments, public.frameleaf_websocket_worker',
    );
  }, 15_000);
  afterAll(async () => {
    await database?.end();
    if (admin) {
      await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin.end();
    }
  });

  const admission = () => {
    const repository = new RateLimitRepository(config);
    repositories.push(repository);
    return repository;
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
    server = new Server();
    server.on('AppRestart', (_state, ack) => ack('ok'));
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

  it('rejects restart discovery with no live worker instead of accepting an empty ACK set', async () => {
    server = new Server();
    transport = new PostgresSocketTransport(config);
    await transport.attach(server, false);
    await expect(transport.discoverWorkers(server)).rejects.toThrow('No live websocket workers');
  });
});

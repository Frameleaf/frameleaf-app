import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/postgres-adapter';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type Pool, type PoolClient } from 'pg';
import { Server, ServerOptions } from 'socket.io';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { closeSharedServicePool, createSharedServicePool, trackPoolClients } from 'src/utils/shared-service-pool.js';

const CHANNEL = 'frameleaf-socket.io';
const HEARTBEAT_MS = 1000;
const DISCOVERY_MS = 5000;
const transports = new WeakMap<Server, PostgresSocketTransport>();

/** Own the small restart/ACK messages whose Socket.IO emit methods discard publication promises. */
export const withSocketPublication = async (server: Server, action: (workerId: string) => unknown): Promise<void> => {
  const transport = transports.get(server);
  if (!transport) {
    throw new Error('PostgreSQL websocket transport is unavailable');
  }
  await transport.publish(() => action(transport.workerId));
};

/** Configuration saves must join remote handlers, not just publish their event. */
export const withSocketConfigUpdate = async (
  server: Server,
  action: (expectedWorkers: readonly string[], publisherWorkerId: string) => Promise<void>,
): Promise<void> => {
  const transport = transports.get(server);
  if (!transport) {
    throw new Error('PostgreSQL websocket transport is unavailable');
  }
  await transport.publish(async () => {
    const expectedWorkers = await transport.discoverWorkers(server, true);
    await action(expectedWorkers, transport.workerId);
  });
};

/** Adapter 0.5.0 has no readiness promise. Observe successful LISTEN, never a guessed startup sleep. */
export class PostgresSocketTransport {
  readonly pool: Pool;
  private readonly clients: Set<PoolClient>;
  private readonly listeners = new Map<string, () => void>();
  private readonly listening = new Set<string>();
  readonly workerId = randomUUID();
  private heartbeat?: NodeJS.Timeout;
  private heartbeatWork?: Promise<void>;
  private stopped = false;
  private server?: Server;
  private initialization?: Promise<void>;
  private readonly publications = new Set<Promise<unknown>>();
  private publicationFailures = 0;
  private publicationError?: unknown;

  constructor(config: ConfigRepository) {
    // LISTEN reserves one client. Two others handle publishing/attachments without pool starvation.
    this.pool = createSharedServicePool(config, 'websocket', 3);
    this.clients = trackPoolClients(this.pool);
    this.pool.query = new Proxy(this.pool.query, {
      apply: (target, receiver, args) => {
        const result = Reflect.apply(target, receiver, args);
        if (args[0] === 'SELECT pg_notify($1, $2)' && result instanceof Promise) {
          this.publications.add(result);
          // Record rejection on the original promise before the adapter's swallowing handler.
          // eslint-disable-next-line unicorn/prefer-then-catch
          void result.then(
            () => this.publications.delete(result),
            (error: unknown) => {
              this.publicationFailures++;
              this.publicationError = error;
              this.publications.delete(result);
            },
          );
        }
        return result;
      },
    });
    this.pool.on('connect', (client: PoolClient) => {
      const query = client.query;
      client.query = new Proxy(query, {
        apply: (target, receiver, args) => {
          const result = Reflect.apply(target, receiver, args);
          const text = args[0];
          if (typeof text === 'string' && text.startsWith('LISTEN ') && result instanceof Promise) {
            void result
              .then(() => {
                const channel = text.slice('LISTEN "'.length, -1);
                this.listening.add(channel);
                this.listeners.get(channel)?.();
              })
              .catch(() => {
                // Failed LISTEN is retried by the adapter; readiness still has its deadline.
              });
          }
          return result;
        },
      });
      client.once('end', () => this.listening.clear());
    });
  }

  attach(server: Server, registerWorker = true) {
    this.server = server;
    transports.set(server, this);
    server.adapter(
      createAdapter(this.pool, {
        channelPrefix: CHANNEL,
        tableName: 'public.socket_io_attachments',
        cleanupInterval: 30_000,
        heartbeatInterval: HEARTBEAT_MS,
        heartbeatTimeout: 5000,
        errorHandler: (error) => console.error('PostgreSQL websocket transport failed:', error.message),
      }),
    );
    const ready = this.waitForListener(`${CHANNEL}#/`).then(async () => {
      if (this.stopped) {
        throw new Error('Websocket transport stopped during startup');
      }
      // Repeat initial heartbeat after LISTEN. Responses to the constructor's heartbeat can be lost.
      await server.sockets.adapter.init();
      if (registerWorker) {
        await this.refreshWorker();
        this.heartbeat = setInterval(() => {
          if (!this.heartbeatWork) {
            this.heartbeatWork = this.refreshWorker()
              .catch((error: Error) => console.error('Websocket worker heartbeat failed:', error.message))
              .finally(() => (this.heartbeatWork = undefined));
          }
        }, HEARTBEAT_MS);
        this.heartbeat.unref();
      }
    });
    this.initialization = ready;
    // Native IoAdapter creation is synchronous; asynchronous failures still surface in diagnostics.
    void ready.catch((error: Error) => console.error('Websocket transport startup failed:', error.message));
    return ready;
  }

  /** Bound by the existing pool acquisition/query deadlines; no connection is held by this barrier. */
  async publish(action: () => unknown): Promise<void> {
    if (this.stopped) {
      throw new Error('PostgreSQL websocket transport is stopping');
    }
    const failures = this.publicationFailures;
    await action();
    await Promise.all(this.publications);
    if (this.publicationFailures !== failures) {
      throw this.publicationError;
    }
  }

  private async waitForListener(channel: string): Promise<void> {
    if (this.listening.has(channel)) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.listeners.set(channel, resolve);
        timer = setTimeout(() => reject(new Error('PostgreSQL websocket LISTEN timed out')), DISCOVERY_MS);
      });
    } finally {
      clearTimeout(timer);
      this.listeners.delete(channel);
    }
  }

  private async refreshWorker() {
    if (this.stopped) {
      return;
    }
    await this.pool.query(
      `INSERT INTO public.frameleaf_websocket_worker (id, expires_at)
      VALUES ($1, clock_timestamp() + interval '5 seconds')
      ON CONFLICT (id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [this.workerId],
    );
    await this.pool.query(`DELETE FROM public.frameleaf_websocket_worker WHERE id IN (
      SELECT id FROM public.frameleaf_websocket_worker WHERE expires_at <= clock_timestamp()
      ORDER BY expires_at LIMIT 256 FOR UPDATE SKIP LOCKED
    ) AND expires_at <= clock_timestamp()`);
  }

  /** A restart may not silently succeed with an empty adapter peer cache. No SQL connection is held while waiting. */
  async discoverWorkers(server: Server, excludeSelf: true): Promise<string[]>;
  async discoverWorkers(server: Server, excludeSelf?: false): Promise<number>;
  async discoverWorkers(server: Server, excludeSelf = false): Promise<number | string[]> {
    if (excludeSelf) {
      await this.initialization;
    }
    const { rows } = await this.pool.query<{ count: number; selfLive: boolean; workerIds: string[] }>(
      `SELECT COUNT(*) FILTER (WHERE NOT $1::boolean OR id <> $2)::integer AS count,
      COALESCE(bool_or(id = $2), false) AS "selfLive",
      COALESCE(array_agg(id::text ORDER BY id) FILTER (WHERE id <> $2), ARRAY[]::text[]) AS "workerIds"
      FROM public.frameleaf_websocket_worker WHERE expires_at > clock_timestamp()`,
      [excludeSelf, this.workerId],
    );
    if (excludeSelf && !rows[0].selfLive) {
      throw new Error('Configuration publisher is not a live registered websocket worker');
    }
    const expected = rows[0].count;
    if (expected === 0 && !excludeSelf) {
      throw new Error('No live websocket workers are available to acknowledge a restart');
    }
    await server.sockets.adapter.init();
    const deadline = Date.now() + DISCOVERY_MS;
    while ((await server.sockets.adapter.serverCount()) - 1 < expected) {
      if (Date.now() >= deadline) {
        throw new Error('PostgreSQL websocket worker discovery timed out');
      }
      await delay(50);
    }
    return excludeSelf ? rows[0].workerIds : expected;
  }

  async close() {
    this.stopped = true;
    if (this.server && transports.get(this.server) === this) {
      transports.delete(this.server);
    }
    clearInterval(this.heartbeat);
    await this.initialization?.catch(() => {
      // A failed startup must still close all resources.
    });
    await this.heartbeatWork;
    try {
      await this.server?.sockets.adapter.close();
      await this.pool.query('DELETE FROM public.frameleaf_websocket_worker WHERE id = $1', [this.workerId]);
    } finally {
      await closeSharedServicePool(this.pool, this.clients);
      // Clear a reconnect scheduled by an in-flight failed adapter initialization during teardown.
      await this.server?.sockets.adapter.close();
    }
  }
}

export class WebSocketAdapter extends IoAdapter {
  private readonly transports = new Map<Server, PostgresSocketTransport>();

  constructor(private app: INestApplicationContext) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, options);
    const transport = new PostgresSocketTransport(this.app.get(ConfigRepository));
    this.transports.set(server, transport);
    void transport.attach(server);
    return server;
  }

  async close(server: Server): Promise<void> {
    try {
      await super.close(server);
    } finally {
      const transport = this.transports.get(server);
      this.transports.delete(server);
      await transport?.close();
    }
  }
}

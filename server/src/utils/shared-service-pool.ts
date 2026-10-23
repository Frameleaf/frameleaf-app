import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { DatabaseConnectionParams } from '@frameleaf/sql-tools';
import type { ConfigRepository } from 'src/repositories/config.repository.js';

export const SHARED_SERVICE_TIMEOUT_MS = 2000;

const SSL_REFUSED = 'The server does not support SSL connections';

/**
 * A pg pool for the configured database. pg has no `prefer`/`allow` fallback, so a server that refuses TLS
 * gets plaintext connections from then on, as the main postgres.js pool does.
 */
export const createDatabasePool = (connection: DatabaseConnectionParams, config: PoolConfig): Pool => {
  if (connection.connectionType === 'url') {
    return new Pool({ connectionString: connection.url, ...config });
  }
  const pool = new Pool({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: connection.database,
    ssl:
      !connection.ssl || connection.ssl === 'disable'
        ? false
        : { rejectUnauthorized: connection.ssl === 'verify-full' },
    ...config,
  });
  if (connection.ssl !== 'prefer' && connection.ssl !== 'allow') {
    return pool;
  }
  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  const connectWithFallback = async () => {
    try {
      return await connect();
    } catch (error) {
      if (!pool.options.ssl || (error as Error)?.message !== SSL_REFUSED) {
        throw error;
      }
      pool.options.ssl = false;
      return connect();
    }
  };
  pool.connect = ((callback?: (error: Error | undefined, client?: PoolClient, done?: () => void) => void) => {
    if (!callback) {
      return connectWithFallback();
    }
    void (async () => {
      let client: PoolClient;
      try {
        client = await connectWithFallback();
      } catch (error) {
        callback(error as Error);
        return;
      }
      callback(undefined, client, () => client.release());
    })();
  }) as Pool['connect'];
  return pool;
};

/** One bounded pool per owner, never per request; pool acquisition and SQL both have deadlines. */
export const createSharedServicePool = (config: ConfigRepository, name: string, max = 2): Pool => {
  const pool = createDatabasePool(config.getEnv().database.config, {
    application_name: `frameleaf:${name}`,
    max,
    connectionTimeoutMillis: SHARED_SERVICE_TIMEOUT_MS,
    query_timeout: SHARED_SERVICE_TIMEOUT_MS,
    statement_timeout: SHARED_SERVICE_TIMEOUT_MS,
    lock_timeout: SHARED_SERVICE_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
  });
  // An idle-client error is otherwise an uncaught EventEmitter error. Commands still reject.
  pool.on('error', () => {
    // Query failures are reported to the caller.
  });
  return pool;
};

/** The adapter holds a LISTEN client; make even an interrupted startup/shutdown finite. */
export const trackPoolClients = (pool: Pool): Set<PoolClient> => {
  const clients = new Set<PoolClient>();
  pool.on('connect', (client) => {
    clients.add(client);
    client.on('error', () => {
      // A LISTEN connection also emits end, which the adapter uses to reconnect.
    });
    client.once('end', () => {
      if (clients.delete(client)) {
        try {
          client.release(true);
        } catch {
          // The pool may already have released this failed client.
        }
      }
    });
  });
  pool.on('acquire', (client) => clients.add(client));
  pool.on('release', (_error, client) => clients.delete(client));
  return clients;
};

export const closeSharedServicePool = async (pool: Pool, clients: Set<PoolClient> = new Set()): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.end(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          for (const client of clients) {
            try {
              client.release(true);
            } catch {
              void client.end().catch(() => {
                // Closing a connection that has already failed needs no retry.
              });
            }
          }
          resolve();
        }, SHARED_SERVICE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

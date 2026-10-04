import { AsyncLocalStorage } from 'node:async_hooks';
import { parentPort } from 'node:worker_threads';
import type { createPostgres } from '@frameleaf/sql-tools';
import { executionSignal } from 'src/utils/execution-signal.js';

type Client = ReturnType<typeof createPostgres>;
export const DATABASE_POOL_SIZE = 10;
export const DATABASE_ACQUIRE_TIMEOUT_MS = 5000;
export const DATABASE_MAX_WAITERS = 64;
export const DATABASE_CLEANUP_TIMEOUT_MS = 2000;
const cleanupExecution = new AsyncLocalStorage<AbortSignal>();

/** Only rollback and mandatory session-lock cleanup may outlive an aborted job. */
export const withDatabaseCleanup = <T>(callback: () => Promise<T>): Promise<T> =>
  cleanupExecution.run(AbortSignal.timeout(DATABASE_CLEANUP_TIMEOUT_MS), callback);

const requestDatabaseRestart = () => {
  const message = { type: 'database-unusable' };
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
};

/**
 * A timed-out reservation never executes SQL. If the driver grants it later, it is immediately
 * returned. The waiter cap also bounds the underlying driver's queue during pool exhaustion.
 */
export const boundExecutionReservations = (client: Client, onUnusable: () => void = requestDatabaseRestart): Client => {
  const reserve = client.reserve.bind(client);
  let pending = 0;
  let unusable: Promise<void> | undefined;
  const discardPool = () => {
    // PostgresJS cannot discard one reserved session. Close this worker's pool before any
    // poisoned reservation can be released, then let its supervisor create a fresh worker.
    unusable ??= client.end({ timeout: 0 }).finally(onUnusable);
    return unusable;
  };
  client.reserve = async () => {
    if (unusable) throw new Error('Database pool requires worker restart');
    const signal = cleanupExecution.getStore() ?? executionSignal();
    signal?.throwIfAborted();
    if (pending >= DATABASE_MAX_WAITERS) throw new Error('Database acquisition capacity exhausted');
    pending++;
    return new Promise<Awaited<ReturnType<Client['reserve']>>>((resolve, reject) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', fail);
        reject(signal?.reason ?? new Error('Database acquisition timed out'));
      };
      const timer = setTimeout(fail, DATABASE_ACQUIRE_TIMEOUT_MS);
      timer.unref();
      signal?.addEventListener('abort', fail, { once: true });
      // Only a driver rejection decrements the pending count here; callback errors must not decrement twice.
      // eslint-disable-next-line unicorn/prefer-then-catch
      void reserve().then(
        (connection) => {
          pending--;
          if (settled) {
            connection.release();
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', fail);
          const release = connection.release.bind(connection);
          connection.release = () => {
            if (!unusable) release();
          };
          const unsafe = connection.unsafe.bind(connection);
          connection.unsafe = ((...args: Parameters<typeof connection.unsafe>) => {
            const query = unsafe(...args);
            const cleanup =
              cleanupExecution.getStore() ??
              (/^\s*rollback\b/i.test(args[0]) ? AbortSignal.timeout(DATABASE_CLEANUP_TIMEOUT_MS) : undefined);
            const cancellation = cleanup ?? executionSignal();
            if (!cancellation) return query;
            const cancel = () => {
              query.cancel();
              // A cleanup timeout must close the underlying connection, not just stop awaiting it.
              if (cleanup) void discardPool().catch(() => {});
            };
            const watch = () => {
              cancellation.throwIfAborted();
              cancellation.addEventListener('abort', cancel, { once: true });
            };
            const unwatch = () => cancellation.removeEventListener('abort', cancel);
            return new Proxy(query, {
              get(target, property, receiver) {
                if (property === 'then') {
                  return (...callbacks: Parameters<typeof query.then>) => {
                    const execute = async () => {
                      try {
                        watch();
                        return await query;
                      } catch (error) {
                        if (cleanup) await discardPool();
                        throw error;
                      } finally {
                        unwatch();
                      }
                    };
                    return execute().then(...callbacks);
                  };
                }
                if (property === 'cursor') {
                  return (size: number) =>
                    (async function* () {
                      try {
                        watch();
                        for await (const rows of query.cursor(size)) yield rows;
                      } catch (error) {
                        if (cleanup) await discardPool();
                        throw error;
                      } finally {
                        unwatch();
                      }
                    })();
                }
                return Reflect.get(target, property, receiver);
              },
            });
          }) as typeof connection.unsafe;
          resolve(connection);
        },
        (error: unknown) => {
          pending--;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', fail);
          reject(error);
        },
      );
    });
  };
  return client;
};

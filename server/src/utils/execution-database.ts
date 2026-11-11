import { ServiceUnavailableException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parentPort } from 'node:worker_threads';
import type { createPostgres } from '@frameleaf/sql-tools';
import { executionSignal } from 'src/utils/execution-signal.js';

type Client = ReturnType<typeof createPostgres>;
// FL-1265: room for the largest job capacity (32) plus request work; postgres.js opens connections only on demand.
export const DATABASE_POOL_SIZE = 36;
export const DATABASE_ACQUIRE_TIMEOUT_MS = 5000;
export const DATABASE_MAX_WAITERS = 64;
export const DATABASE_CLEANUP_TIMEOUT_MS = 2000;
/**
 * A full pool is a passing overload, not a server fault: answer 503 so clients and proxies retry,
 * instead of a 500 that reads as a bug. Outside a request (jobs) it is still an ordinary Error.
 */
export const databaseBusy = (message: string) => new ServiceUnavailableException(message);
const cleanupExecution = new AsyncLocalStorage<AbortSignal>();
/**
 * PostgreSQL cancels whatever a session runs when a cancel request arrives, not the statement it was sent for.
 * A job's cancelled query can finish first, so the request stops the transaction's ROLLBACK. Each request stops
 * at most one statement; the bound only guards against a driver that keeps cancelling.
 */
const STRAY_CANCEL_ROLLBACK_RETRIES = 2;
const isCancelRequest = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  (error as { code?: unknown }).code === '57014' &&
  (error as { message?: unknown }).message === 'canceling statement due to user request';

/** Only rollback and mandatory session-lock cleanup may outlive an aborted job. */
export const withDatabaseCleanup = <T>(callback: () => Promise<T>): Promise<T> =>
  cleanupExecution.run(AbortSignal.timeout(DATABASE_CLEANUP_TIMEOUT_MS), callback);

const requestDatabaseRestart = () => {
  const message = { type: 'database-unusable' };
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
};

let readPoolUsage = () => ({ reserved: 0, waiting: 0, capacity: DATABASE_POOL_SIZE });
export const getDatabasePoolUsage = () => readPoolUsage();

/**
 * A timed-out reservation never executes SQL. If the driver grants it later, it is immediately
 * returned. The waiter cap also bounds the underlying driver's queue during pool exhaustion.
 */
export const boundExecutionReservations = (
  client: Client,
  onUnusable: () => void = requestDatabaseRestart,
  monitorPool = false,
): Client => {
  const reserve = client.reserve.bind(client);
  let pending = 0;
  let reserved = 0;
  if (monitorPool) readPoolUsage = () => ({ reserved, waiting: pending, capacity: DATABASE_POOL_SIZE });
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
    if (pending >= DATABASE_MAX_WAITERS) throw databaseBusy('Database acquisition capacity exhausted');
    pending++;
    return new Promise<Awaited<ReturnType<Client['reserve']>>>((resolve, reject) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', fail);
        reject(signal?.reason ?? databaseBusy('Database acquisition timed out'));
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
          if (monitorPool) reserved++;
          let released = false;
          const release = connection.release.bind(connection);
          connection.release = () => {
            if (monitorPool && !released) {
              released = true;
              reserved--;
            }
            if (!unusable) release();
          };
          const unsafe = connection.unsafe.bind(connection);
          connection.unsafe = ((...args: Parameters<typeof connection.unsafe>) => {
            const query = unsafe(...args);
            const rollback = /^\s*rollback\b/i.test(args[0]);
            const cleanup =
              cleanupExecution.getStore() ?? (rollback ? AbortSignal.timeout(DATABASE_CLEANUP_TIMEOUT_MS) : undefined);
            const cancellation = cleanup ?? executionSignal();
            if (!cancellation) return query;
            let current = query;
            const cancel = () => {
              current.cancel();
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
                        for (let retries = 0; ; retries++) {
                          try {
                            return await current;
                          } catch (error) {
                            if (
                              !rollback ||
                              !cleanup ||
                              cleanup.aborted ||
                              retries >= STRAY_CANCEL_ROLLBACK_RETRIES ||
                              !isCancelRequest(error)
                            ) {
                              throw error;
                            }
                            // FL-1443: an earlier statement's cancel request reached the session after that
                            // statement finished and stopped this ROLLBACK instead. Nothing ran, so roll back again
                            // rather than closing the pool and restarting the worker (its claims then wait out the lease).
                            current = unsafe(...args);
                          }
                        }
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

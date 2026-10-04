import type { createPostgres } from '@frameleaf/sql-tools';
import { jobSignal } from 'src/queue/context.js';

type Client = ReturnType<typeof createPostgres>;
export const DATABASE_ACQUIRE_TIMEOUT_MS = 5000;
export const DATABASE_MAX_WAITERS = 64;

/**
 * A timed-out reservation never executes SQL. If the driver grants it later, it is immediately
 * returned. The waiter cap also bounds the underlying driver's queue during pool exhaustion.
 */
export const boundExecutionReservations = (client: Client): Client => {
  const reserve = client.reserve.bind(client);
  let pending = 0;
  client.reserve = async () => {
    const signal = jobSignal();
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
          const unsafe = connection.unsafe.bind(connection);
          connection.unsafe = ((...args: Parameters<typeof connection.unsafe>) => {
            const query = unsafe(...args);
            // Rollback must still execute after cancellation before the connection is released.
            if (/^\s*rollback\b/i.test(args[0])) return query;
            const cancellation = jobSignal();
            if (!cancellation) return query;
            const cancel = () => query.cancel();
            const watch = () => {
              cancellation.throwIfAborted();
              cancellation.addEventListener('abort', cancel, { once: true });
            };
            const unwatch = () => cancellation.removeEventListener('abort', cancel);
            return new Proxy(query, {
              get(target, property, receiver) {
                if (property === 'then') {
                  return (...callbacks: Parameters<typeof query.then>) => {
                    watch();
                    return query.then(...callbacks).finally(unwatch);
                  };
                }
                if (property === 'cursor') {
                  return (size: number) =>
                    (async function* () {
                      watch();
                      try {
                        for await (const rows of query.cursor(size)) yield rows;
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

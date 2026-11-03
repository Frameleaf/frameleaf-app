import { schemaFromDatabase } from '@frameleaf/sql-tools';
import { once } from 'node:events';
import { Socket } from 'node:net';
import postgres from 'postgres';
import { ImportDatabase, ImportRow } from 'src/immich-import/types.js';

export const connectImportDatabase = (url: string, readOnly: boolean) => {
  const createClient = (socket?: (options: postgres.ParsedOptions) => Promise<Socket>) =>
    postgres(url, {
      max: 1,
      onnotice: () => {},
      ...(socket && { socket }),
      connection: {
        application_name: 'frameleaf-import-immich',
        ...(readOnly && { default_transaction_read_only: true }),
      },
    });
  const client = createClient();
  const wrap = (connection: typeof client | postgres.TransactionSql): ImportDatabase => ({
    ...(!readOnly && {
      readSchema: () =>
        schemaFromDatabase({
          connection: { connectionType: 'url', url },
          maxConnections: 1,
          overrides: false,
          excludeMigrationTables: true,
          onNotice: () => {},
        }),
    }),
    query: async (statement, parameters = []) => {
      const result = await connection.unsafe(statement, parameters as postgres.ParameterOrJSON<never>[]);
      return [...result] as ImportRow[];
    },
    transaction: async <T>(body: (db: ImportDatabase) => Promise<T>): Promise<T> => {
      // Root connection is used for transactions; callers never nest transactions.
      return (await client.begin((transaction) => body(wrap(transaction)))) as T;
    },
  });
  const withSession = async <T>(body: (session: ImportDatabase) => Promise<T>): Promise<T> => {
    let transport: Socket | undefined;
    let hostIndex = 0;
    const startupFailure = Promise.withResolvers<never>();
    const owner = createClient(async (options) => {
      let failure: unknown;
      for (let attempt = 0; attempt < options.host.length; attempt++) {
        transport?.destroy();
        const index = hostIndex++ % options.host.length;
        const socket = Object.assign(new Socket(), {
          host: options.host[index],
          port: options.port[index],
          ssl: options.ssl,
        });
        transport = socket;
        const connected = once(socket, 'connect');
        const deadline = setTimeout(
          () => socket.destroy(new Error('IMPORT_SESSION_CONNECT_TIMEOUT')),
          (options.connect_timeout || 30) * 1000,
        );
        try {
          if (options.path) socket.connect(options.path);
          else socket.connect(socket.port, socket.host);
          await connected;
          return socket;
        } catch (error) {
          failure = error;
          socket.destroy();
        } finally {
          clearTimeout(deadline);
        }
      }
      // Factory rejection precedes postgres.js's close listener and cannot drive its multi-host failover.
      startupFailure.reject(failure);
      throw failure;
    });
    let reserved: postgres.ReservedSql | undefined;
    let failed = false;
    let failure: unknown;
    let result!: T;
    let active = true;
    let inTransaction = false;
    try {
      reserved = await Promise.race([owner.reserve(), startupFailure.promise]);
      const connection = reserved;
      const wrapped = wrap(connection);
      const { readSchema } = wrapped;
      const session: ImportDatabase = {
        ...wrapped,
        ...(readSchema && {
          readSchema: async () => {
            if (!active) throw new Error('IMPORT_SESSION_CLOSED');
            return readSchema();
          },
        }),
        query: async (statement, parameters) => {
          if (!active) throw new Error('IMPORT_SESSION_CLOSED');
          return wrapped.query(statement, parameters);
        },
        transaction: async (work) => {
          if (!active) throw new Error('IMPORT_SESSION_CLOSED');
          if (inTransaction) throw new Error('IMPORT_NESTED_TRANSACTION_UNSUPPORTED');
          inTransaction = true;
          try {
            // ReservedSql's runtime has no begin(), despite the declaration in postgres 3.4.9.
            await connection.unsafe('BEGIN');
            const result = await work(session);
            await connection.unsafe('COMMIT');
            return result;
          } catch (error) {
            const deadline = setTimeout(() => transport?.destroy(), 5000);
            try {
              await connection.unsafe('ROLLBACK');
            } catch {
              transport?.destroy();
              await owner.end({ timeout: 0 }).catch(() => {});
            } finally {
              clearTimeout(deadline);
            }
            throw error;
          } finally {
            inTransaction = false;
          }
        },
      };
      result = await body(session);
    } catch (error) {
      failed = true;
      failure = error;
    }
    active = false;
    let cleanupFailed = false;
    const deadline = setTimeout(() => transport?.destroy(), 5000);
    try {
      await reserved?.unsafe('ROLLBACK');
      await reserved?.unsafe('SELECT pg_advisory_unlock_all()');
    } catch {
      cleanupFailed = true;
    } finally {
      clearTimeout(deadline);
      // postgres end(timeout: 0) uses socket.end(), which cannot abort an unfinished write.
      transport?.destroy();
    }
    try {
      await owner.end({ timeout: 0 });
    } catch {
      cleanupFailed = true;
    }
    if (failed) throw failure;
    if (cleanupFailed) throw new Error('IMPORT_SESSION_CLEANUP_FAILED');
    return result;
  };
  return { db: { ...wrap(client), ...(!readOnly && { withSession }) }, close: () => client.end() };
};

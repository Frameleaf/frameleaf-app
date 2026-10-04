import { schemaFromDatabase } from '@frameleaf/sql-tools';
import postgres from 'postgres';
import { ImportDatabase, ImportRow } from 'src/immich-import/types.js';

export const connectImportDatabase = (url: string, readOnly: boolean) => {
  const client = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: {
      application_name: 'frameleaf-import-immich',
      ...(readOnly && { default_transaction_read_only: true }),
    },
  });
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
  return { db: wrap(client), close: () => client.end() };
};

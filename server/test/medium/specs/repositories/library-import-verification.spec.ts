import { CompiledQuery, Kysely, sql } from 'kysely';
import { ImportDatabase } from 'src/immich-import/types.js';
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { beginLibraryImportReadback } from 'src/library-import/verification.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const wrap = (connection: Kysely<any>): ImportDatabase => ({
  query: async (statement, parameters = []) =>
    (await connection.executeQuery(CompiledQuery.raw(statement, parameters))).rows as Record<string, unknown>[],
  transaction: (body) => connection.transaction().execute((tx) => body(wrap(tx))),
});
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());

it('establishes read-only repeatable-read protection and prevents lifecycle writes', async () => {
  await db.transaction().execute(async (connection) => {
    const tx = wrap(connection);
    await beginLibraryImportReadback(tx);
    expect(await tx.query('SHOW transaction_read_only')).toEqual([{ transaction_read_only: 'on' }]);
    expect(await tx.query('SHOW transaction_isolation')).toEqual([{ transaction_isolation: 'repeatable read' }]);
    await expect(
      db
        .transaction()
        .execute((other) =>
          sql`LOCK TABLE public.frameleaf_library_import IN ROW EXCLUSIVE MODE NOWAIT`.execute(other),
        ),
    ).rejects.toMatchObject({ code: '55P03' });
  });
});

it('does not allow the verification body to write destination data', async () => {
  await expect(
    db.transaction().execute(async (connection) => {
      const tx = wrap(connection);
      await beginLibraryImportReadback(tx);
      await tx.query("UPDATE public.frameleaf_library_import SET status='abandoned'");
    }),
  ).rejects.toThrow('read-only');
});

it('refuses an outstanding lifecycle update before acquiring its first query snapshot', async () => {
  await db.transaction().execute(async (connection) => {
    await sql`LOCK TABLE public.frameleaf_library_import IN ROW EXCLUSIVE MODE`.execute(connection);
    await expect(db.transaction().execute((tx) => beginLibraryImportReadback(wrap(tx)))).rejects.toThrow(
      'IMPORT_ALREADY_RUNNING',
    );
  });
});

it('refuses a competing importer and releases the provisional table lock', async () => {
  await db.transaction().execute(async (connection) => {
    await sql`SELECT pg_advisory_xact_lock(${LIBRARY_IMPORT_LOCK}::bigint)`.execute(connection);
    await expect(db.transaction().execute((tx) => beginLibraryImportReadback(wrap(tx)))).rejects.toThrow(
      'IMPORT_ALREADY_RUNNING',
    );
    await db
      .transaction()
      .execute((tx) => sql`LOCK TABLE public.frameleaf_library_import IN ROW EXCLUSIVE MODE NOWAIT`.execute(tx));
  });
});

it('refuses a transaction whose snapshot was already established', async () => {
  await expect(
    db.transaction().execute(async (connection) => {
      await sql`SELECT 1`.execute(connection);
      await beginLibraryImportReadback(wrap(connection));
    }),
  ).rejects.toThrow('before any query');
});

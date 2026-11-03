import { ImportDatabase } from 'src/immich-import/types.js';
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

const snapshots = new WeakSet<ImportDatabase>();

/** Call before any SELECT so lifecycle commits cannot hide behind an older repeatable-read snapshot. */
export async function beginLibraryImportReadback(tx: ImportDatabase): Promise<void> {
  if (snapshots.has(tx)) return;
  try {
    await tx.query('LOCK TABLE public.frameleaf_library_import IN SHARE MODE NOWAIT');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03')
      throw new LibraryImportRefused('IMPORT_ALREADY_RUNNING');
    throw error;
  }
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const [lock] = await tx.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [LIBRARY_IMPORT_LOCK]);
  if (!lock?.acquired) throw new LibraryImportRefused('IMPORT_ALREADY_RUNNING');
}

/** Compose existing reconciliations inside one read-only snapshot and operation fence. */
export async function withLibraryImportReadback<T>(
  db: ImportDatabase,
  body: (snapshot: ImportDatabase) => Promise<T>,
): Promise<T> {
  if (snapshots.has(db)) return body(db);
  return db.transaction(async (tx) => {
    await beginLibraryImportReadback(tx);
    const snapshot: ImportDatabase = {
      query: (statement, parameters) => tx.query(statement, parameters),
      transaction: (read) => read(snapshot),
    };
    snapshots.add(snapshot);
    try {
      return await body(snapshot);
    } finally {
      snapshots.delete(snapshot);
    }
  });
}

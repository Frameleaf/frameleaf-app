import { ImportDatabase } from 'src/immich-import/types.js';
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

/** Call before any SELECT so lifecycle commits cannot hide behind an older repeatable-read snapshot. */
export async function beginLibraryImportReadback(tx: ImportDatabase): Promise<void> {
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

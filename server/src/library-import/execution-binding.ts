import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type ImportDatabase } from 'src/immich-import/types.js';
import { assertFreshImportDestination } from 'src/library-import/admission.js';
import { LibraryImportRefused, parseLibraryImportBinding } from 'src/library-import/state.js';

const key = 'frameleaf-library-import-execution';
// Keep this separate from the transaction lock used by canonical writes and activation.
const lock = '7482923371154302';
const inode = z.strictObject({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^[1-9]\d*$/) });
const inputSchema = z.strictObject({
  binding: z.unknown().transform(parseLibraryImportBinding),
  destinationId: z.uuid(),
  identity: z.strictObject({ database: inode, lock: inode }),
});
const retainedSchema = z.strictObject({ version: z.literal(1), nonce: z.uuid(), input: inputSchema });
type Input = z.input<typeof inputSchema>;

/** Inspection holds the same non-reconnecting session lock without reserving a destination. */
export async function withLibraryImportInspection<T>(db: ImportDatabase, inspect: () => Promise<T>): Promise<T> {
  if (!db.withSession) throw new LibraryImportRefused('IMPORT_SESSION_REQUIRED');
  return db.withSession(async (session) => {
    const [owner] = await session.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [lock]);
    if (!owner?.acquired) throw new LibraryImportRefused('IMPORT_ALREADY_RUNNING');
    const result = await inspect();
    await session.query('SELECT 1');
    return result;
  });
}

/** The caller also holds the local process-lifetime lock; neither identity can be replaced to take over a run. */
export async function withLibraryImportExecution<T>(
  db: ImportDatabase,
  input: Input,
  execute: (destinationNonce: string) => Promise<T>,
): Promise<T> {
  const expected = inputSchema.safeParse(input);
  if (!expected.success) throw new LibraryImportRefused('IMPORT_EXECUTION_IDENTITY_INVALID');
  if (!db.withSession) throw new LibraryImportRefused('IMPORT_SESSION_REQUIRED');
  return db.withSession(async (session) => {
    const [owner] = await session.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [lock]);
    if (!owner?.acquired) throw new LibraryImportRefused('IMPORT_ALREADY_RUNNING');
    const nonce = await session.transaction(async (tx) => {
      const [row] = await tx.query('SELECT value FROM public.system_metadata WHERE key=$1 FOR UPDATE', [key]);
      if (row) {
        const retained = retainedSchema.safeParse(row.value);
        if (!retained.success) throw new LibraryImportRefused('IMPORT_EXECUTION_IDENTITY_INVALID');
        if (JSON.stringify(retained.data.input) !== JSON.stringify(expected.data))
          throw new LibraryImportRefused('IMPORT_EXECUTION_IDENTITY_CHANGED');
        return retained.data.nonce;
      }
      await assertFreshImportDestination(tx, { allowBootstrapAdmin: true });
      const nonce = randomUUID();
      await tx.query('INSERT INTO public.system_metadata(key,value) VALUES($1,$2::text::jsonb)', [
        key,
        JSON.stringify({ version: 1, nonce, input: expected.data }),
      ]);
      return nonce;
    });
    const result = await execute(nonce);
    await session.query('SELECT 1');
    return result;
  });
}

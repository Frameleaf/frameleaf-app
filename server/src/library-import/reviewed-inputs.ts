import { z } from 'zod';
import { ImportDatabase } from 'src/immich-import/types.js';
import { bindDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { parseImportManifest } from 'src/library-import/manifest.js';
import { LibraryImportBinding, LibraryImportRefused, parseLibraryImportBinding } from 'src/library-import/state.js';
import { beginLibraryImportReadback } from 'src/library-import/verification.js';

export type ReviewedImportContext = { binding: LibraryImportBinding; destinationId: string };
const inputsSchema = z.strictObject({ manifest: z.unknown(), plan: z.unknown() });
const refuse = (code: string): never => {
  throw new LibraryImportRefused(code);
};
const validate = (context: ReviewedImportContext, input: unknown) => {
  const parsed = inputsSchema.safeParse(input);
  if (!parsed.success) return refuse('IMPORT_REVIEWED_INPUTS_INVALID');
  let manifest;
  try {
    manifest = parseImportManifest(parsed.data.manifest);
  } catch {
    return refuse('IMPORT_REVIEWED_INPUTS_INVALID');
  }
  const plan = bindDestinationImportPlan(parsed.data.plan, context.binding, manifest, context.destinationId);
  return { manifest, plan };
};
type Inputs = ReturnType<typeof validate>;
type Stored = { binding: unknown; status: unknown };
type Reviewed = { reviewed_manifest: unknown; reviewed_plan: unknown };
export const withImportInputRun = async <T>(
  db: ImportDatabase,
  context: ReviewedImportContext,
  write: boolean,
  body: (tx: ImportDatabase, bound: ReviewedImportContext) => T | Promise<T>,
): Promise<T> => {
  const bound = { binding: parseLibraryImportBinding(context.binding), destinationId: context.destinationId };
  try {
    return await db.transaction(async (tx) => {
      if (write) {
        const [lock] = await tx.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [
          LIBRARY_IMPORT_LOCK,
        ]);
        if (!lock?.acquired) return refuse('IMPORT_ALREADY_RUNNING');
      } else {
        await beginLibraryImportReadback(tx);
      }
      const [row] = (await tx.query(
        `SELECT binding,status FROM public.frameleaf_library_import${write ? ' FOR UPDATE' : ''}`,
      )) as Stored[];
      if (!row) return refuse('IMPORT_JOURNAL_MISSING');
      if (JSON.stringify(parseLibraryImportBinding(row.binding)) !== JSON.stringify(bound.binding))
        return refuse('IMPORT_BINDING_CHANGED');
      if (write && row.status !== 'copying' && row.status !== 'verifying')
        return refuse('IMPORT_REVIEWED_INPUTS_READ_ONLY');
      return body(tx, bound);
    });
  } catch (error) {
    if (error instanceof LibraryImportRefused) throw error;
    // Database diagnostics may contain source identities, metadata and private storage paths.
    throw new LibraryImportRefused('IMPORT_REVIEWED_INPUTS_UNAVAILABLE');
  }
};
const storedInputs = (row: Reviewed, context: ReviewedImportContext): Inputs => {
  if (row.reviewed_manifest === null && row.reviewed_plan === null) return refuse('IMPORT_REVIEWED_INPUTS_MISSING');
  return validate(context, { manifest: row.reviewed_manifest, plan: row.reviewed_plan });
};

const readReviewedRow = async (tx: ImportDatabase): Promise<Reviewed> => {
  const [row] = await tx.query('SELECT reviewed_manifest,reviewed_plan FROM public.frameleaf_library_import');
  if (!row) return refuse('IMPORT_JOURNAL_MISSING');
  return row as Reviewed;
};

/** Internal helper: call only inside a transaction bound by withImportInputRun. */
export const readRetainedImportInputs = async (tx: ImportDatabase, context: ReviewedImportContext): Promise<Inputs> =>
  storedInputs(await readReviewedRow(tx), context);

/** Internal recovery inputs only; credentials and unrepresentable source metadata require a separate protected archive. */
export async function retainReviewedImportInputs(
  db: ImportDatabase,
  context: ReviewedImportContext,
  input: unknown,
): Promise<void> {
  await withImportInputRun(db, context, true, async (tx, bound) => {
    const row = await readReviewedRow(tx);
    const inputs = validate(bound, input);
    if (row.reviewed_manifest !== null || row.reviewed_plan !== null) {
      storedInputs(row, bound);
      return;
    }
    await tx.query(
      `UPDATE public.frameleaf_library_import SET reviewed_manifest=$1::text::jsonb,
      reviewed_plan=$2::text::jsonb,updated_at=now() WHERE operation_id=$3::uuid`,
      [JSON.stringify(inputs.manifest), JSON.stringify(inputs.plan), bound.binding.operationId],
    );
  });
}

/** Revalidate complete retained inputs on every recovery; ordinary status never returns this private inventory. */
export async function loadReviewedImportInputs(db: ImportDatabase, context: ReviewedImportContext): Promise<Inputs> {
  return withImportInputRun(db, context, false, (tx, bound) => readRetainedImportInputs(tx, bound));
}

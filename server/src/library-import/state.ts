import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type ImportDatabase, ImportRefused } from 'src/immich-import/types.js';
import { assertFreshImportDestination } from 'src/library-import/admission.js';
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { sourceKinds } from 'src/library-import/manifest.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(1024);
const uuid = z.uuid().transform((value) => value.toLowerCase());
const bindingSchema = z.strictObject({
  operationId: uuid,
  manifestSha256: hash,
  planSha256: hash,
  source: z.strictObject({ kind: z.enum(sourceKinds), version: id, identity: id, revision: id, schemaSha256: hash }),
});
const mappingSchema = z.strictObject({
  kind: z.enum(['owner', 'library', 'asset', 'file', 'album', 'person', 'stack']),
  sourceId: id,
  destinationId: uuid,
  recordSha256: hash,
});
const creationSchema = mappingSchema.omit({ destinationId: true }).extend({
  kind: z.enum(['library', 'asset', 'file', 'album', 'person', 'stack']),
});
export type LibraryImportBinding = z.infer<typeof bindingSchema>;
export type LibraryImportMapping = z.infer<typeof mappingSchema>;
type Phase = 'copying' | 'verifying' | 'activated' | 'abandoned';
type Run = { binding: LibraryImportBinding; status: Phase };

export class LibraryImportRefused extends Error {
  constructor(public readonly code: string) {
    super(`Library import refused: ${code}`);
  }
}
export const parseLibraryImportBinding = (input: unknown): LibraryImportBinding => {
  const parsed = bindingSchema.safeParse(input);
  if (!parsed.success) throw new LibraryImportRefused('INVALID_IMPORT_BINDING');
  return parsed.data;
};

/** Target-only durable records. The controller separately owns service fencing and source qualification. */
export class LibraryImportJournal {
  constructor(private db: ImportDatabase) {}

  private exclusive<T>(body: (db: ImportDatabase) => Promise<T>): Promise<T> {
    return this.db.transaction(async (db) => {
      const [lock] = await db.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [LIBRARY_IMPORT_LOCK]);
      if (!lock?.acquired) throw new LibraryImportRefused('IMPORT_ALREADY_RUNNING');
      return body(db);
    });
  }
  private async current(db: ImportDatabase, binding: LibraryImportBinding): Promise<Run> {
    const [row] = await db.query('SELECT binding,status FROM public.frameleaf_library_import FOR UPDATE');
    if (!row) throw new LibraryImportRefused('IMPORT_JOURNAL_MISSING');
    const recorded = parseLibraryImportBinding(row.binding);
    if (JSON.stringify(recorded) !== JSON.stringify(binding)) throw new LibraryImportRefused('IMPORT_BINDING_CHANGED');
    return { binding: recorded, status: row.status as Phase };
  }
  async begin(input: unknown): Promise<Run> {
    const binding = parseLibraryImportBinding(input);
    return this.exclusive(async (db) => {
      const [existing] = await db.query('SELECT 1 FROM public.frameleaf_library_import');
      if (existing) {
        const run = await this.current(db, binding);
        if (run.status === 'abandoned') throw new LibraryImportRefused('ABANDONED_DESTINATION_REQUIRES_FRESH_DATABASE');
        if (run.status === 'activated') throw new LibraryImportRefused('IMPORT_ALREADY_ACTIVATED');
        return run;
      }
      if ((await db.query('SELECT 1 FROM public.frameleaf_immich_import')).length > 0)
        throw new LibraryImportRefused('DESTINATION_ALREADY_IMPORTED');
      try {
        await assertFreshImportDestination(db, { allowBootstrapAdmin: true });
      } catch (error) {
        if (error instanceof ImportRefused) throw new LibraryImportRefused(error.code);
        throw error;
      }
      await db.query(
        `INSERT INTO public.frameleaf_library_import(operation_id,binding,status) VALUES($1::uuid,$2::text::jsonb,'copying')`,
        [binding.operationId, JSON.stringify(binding)],
      );
      return { binding, status: 'copying' };
    });
  }
  async apply(
    input: unknown,
    value: unknown,
    write: (db: ImportDatabase, destinationId: string) => Promise<void>,
  ): Promise<string> {
    const binding = parseLibraryImportBinding(input);
    const parsed = mappingSchema.safeParse(value);
    if (!parsed.success) throw new LibraryImportRefused('INVALID_IMPORT_MAPPING');
    return this.persist(binding, parsed.data, write);
  }
  /** Non-owner IDs are allocated with their writes, so reconnects recover the committed identity. */
  async create(
    input: unknown,
    value: unknown,
    write: (db: ImportDatabase, destinationId: string) => Promise<void>,
  ): Promise<string> {
    const binding = parseLibraryImportBinding(input);
    const parsed = creationSchema.safeParse(value);
    if (!parsed.success) throw new LibraryImportRefused('INVALID_IMPORT_MAPPING');
    return this.persist(binding, parsed.data, write);
  }
  private persist(
    binding: LibraryImportBinding,
    mapping: Omit<LibraryImportMapping, 'destinationId'> & { destinationId?: string },
    write: (db: ImportDatabase, destinationId: string) => Promise<void>,
  ): Promise<string> {
    return this.exclusive(async (db) => {
      const run = await this.current(db, binding);
      if (run.status !== 'copying') throw new LibraryImportRefused('IMPORT_NOT_COPYING');
      const [existing] = await db.query(
        `SELECT destination_id::text,record_sha256 FROM public.frameleaf_library_import_mapping
        WHERE operation_id=$1::uuid AND entity_kind=$2 AND source_id=$3`,
        [binding.operationId, mapping.kind, mapping.sourceId],
      );
      if (existing) {
        const destination = uuid.safeParse(existing.destination_id);
        if (
          !destination.success ||
          (mapping.destinationId !== undefined && destination.data !== mapping.destinationId) ||
          existing.record_sha256 !== mapping.recordSha256
        )
          throw new LibraryImportRefused('IMPORT_MAPPING_CHANGED');
        return destination.data;
      }
      const destinationId = mapping.destinationId ?? randomUUID();
      await write(db, destinationId);
      await db.query(
        `INSERT INTO public.frameleaf_library_import_mapping(operation_id,entity_kind,source_id,destination_id,record_sha256)
        VALUES($1::uuid,$2,$3,$4::uuid,$5)`,
        [binding.operationId, mapping.kind, mapping.sourceId, destinationId, mapping.recordSha256],
      );
      return destinationId;
    });
  }
  async phase(input: unknown, phase: 'verifying' | 'abandoned'): Promise<void> {
    const binding = parseLibraryImportBinding(input);
    if (phase !== 'verifying' && phase !== 'abandoned') throw new LibraryImportRefused('INVALID_IMPORT_PHASE');
    await this.exclusive(async (db) => {
      const run = await this.current(db, binding);
      if (run.status === phase) return;
      if (!['copying', 'verifying'].includes(run.status)) throw new LibraryImportRefused('IMPORT_PHASE_CHANGED');
      await db.query('UPDATE public.frameleaf_library_import SET status=$1,updated_at=clock_timestamp()', [phase]);
    });
  }
  async status(): Promise<{ run: Run | null; mappings: { kind: string; count: string }[] }> {
    const [row] = await this.db.query('SELECT binding,status FROM public.frameleaf_library_import');
    const run = row ? { binding: parseLibraryImportBinding(row.binding), status: row.status as Phase } : null;
    const mappings = await this.db.query(
      'SELECT entity_kind AS kind,count(*)::text AS count FROM public.frameleaf_library_import_mapping GROUP BY entity_kind ORDER BY entity_kind',
    );
    return { run, mappings: mappings as { kind: string; count: string }[] };
  }
}

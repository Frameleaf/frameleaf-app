import { type Kysely, sql } from 'kysely';
import {
  IMPORT_DERIVED_RUN_KIND,
  IMPORT_DERIVED_RUN_STAGES,
  importDerivedRunId,
} from 'src/immich-import/derived-work.js';
import {
  LIBRARY_IMPORT_DERIVED_RUN_KIND,
  LIBRARY_IMPORT_DERIVED_RUN_STAGES,
  libraryImportDerivedRunId,
} from 'src/library-import/derived-work.js';
import { LibraryImportRefused, parseLibraryImportBinding } from 'src/library-import/state.js';
import { type DB } from 'src/schema/index.js';

type SetupSelection = Record<string, unknown> & {
  managerSetupRequired?: unknown;
  managerSetup?: {
    installation: string;
    operationId: string;
    preparedAt: string | null;
    startedAt: string | null;
    paused?: boolean;
    /** FL-1177: stages held after the file check because their machine learning is off; see `releaseStages`. */
    parkedStages?: unknown;
  };
};
type SetupRun = { id: string; kind: string; selection: SetupSelection; enumerationDone: boolean };

/** Resolve the same retained setup protocol for legacy Immich and every generic source family. */
export async function readImportedSetupRun(db: Kysely<DB>, lock = false) {
  try {
    const { rows: journals } = await sql<{
      family: 'immich' | 'library';
      status: string;
      binding: unknown;
      source: string | null;
      config: string | null;
      destinationId: string | null;
    }>`SELECT 'immich' AS family,status,NULL::jsonb AS binding,source_fingerprint AS source,
        config_fingerprint AS config,NULL::text AS "destinationId" FROM frameleaf_immich_import
      UNION ALL SELECT 'library',status,binding,NULL::text,NULL::text,
        reviewed_plan->>'destinationId' FROM frameleaf_library_import`.execute(db);
    if (journals.length === 0) return null;
    if (journals.length !== 1) throw new LibraryImportRefused('IMPORT_SETUP_JOURNAL_AMBIGUOUS');
    const journal = journals[0];
    const binding = journal.family === 'library' ? parseLibraryImportBinding(journal.binding) : null;
    if (!binding && (journal.source === null || journal.config === null))
      throw new LibraryImportRefused('IMPORT_SETUP_IDENTITY_INVALID');
    const id = binding ? libraryImportDerivedRunId(binding) : importDerivedRunId(journal.source!, journal.config!);
    const kind = binding ? LIBRARY_IMPORT_DERIVED_RUN_KIND : IMPORT_DERIVED_RUN_KIND;
    const stages = binding ? LIBRARY_IMPORT_DERIVED_RUN_STAGES : IMPORT_DERIVED_RUN_STAGES;
    const { rows: runs } = await sql<SetupRun>`SELECT id,kind,selection,"enumerationDone" FROM job_run
      WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}`.execute(db);
    const run = runs[0];
    const selection = run?.selection;
    const object = selection !== null && typeof selection === 'object' && !Array.isArray(selection);
    const marker = selection?.managerSetup;
    const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
    const managed = object && (selection.managerSetupRequired !== undefined || marker !== undefined);
    const markerValid =
      !!marker &&
      typeof marker === 'object' &&
      !Array.isArray(marker) &&
      typeof marker.installation === 'string' &&
      /^[a-f0-9]{12}$/.test(marker.installation) &&
      typeof marker.operationId === 'string' &&
      !!marker.operationId.trim() &&
      (marker.preparedAt === null || timestamp(marker.preparedAt)) &&
      (marker.startedAt === null || (timestamp(marker.startedAt) && timestamp(marker.preparedAt))) &&
      (marker.paused === undefined || typeof marker.paused === 'boolean');
    const identityMatches =
      !!run &&
      object &&
      run.kind === kind &&
      (selection.managerSetupRequired === undefined || selection.managerSetupRequired === true) &&
      (!managed || markerValid) &&
      (binding
        ? selection.version === 1 &&
          selection.prepared === true &&
          selection.operationId === binding.operationId &&
          selection.manifestSha256 === binding.manifestSha256 &&
          selection.planSha256 === binding.planSha256 &&
          typeof journal.destinationId === 'string' &&
          selection.destinationId === journal.destinationId.toLowerCase() &&
          selection.managerSetup?.operationId === binding.operationId
        : selection.source === journal.source && selection.config === journal.config);
    return { journal: { status: journal.status }, run: object ? run : undefined, identityMatches, stages };
  } catch (error) {
    if (error instanceof LibraryImportRefused) throw error;
    // Driver diagnostics may contain private migration bindings or paths.
    throw new LibraryImportRefused('IMPORT_SETUP_UNAVAILABLE');
  }
}

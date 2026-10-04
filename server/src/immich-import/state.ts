import { IMPORT_DERIVED_RUN_KIND, importDerivedRunId } from 'src/immich-import/derived-work.js';
import { ImportDatabase, ImportRefused } from 'src/immich-import/types.js';

// Included in the canonical Frameleaf bootstrap by the integration owner. Never run on the source.
export const IMMICH_IMPORT_SCHEMA_SQL = `
CREATE TABLE public.frameleaf_immich_import (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  source_fingerprint text NOT NULL, config_fingerprint text NOT NULL,
  source_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('copying', 'verifying', 'activated', 'abandoned')),
  created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz
);
CREATE TABLE public.frameleaf_immich_import_checkpoint (
  table_name text PRIMARY KEY, cursor jsonb, row_count bigint NOT NULL DEFAULT 0,
  complete boolean NOT NULL DEFAULT false
);
CREATE TABLE public.frameleaf_immich_import_work (
  asset_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('metadata','thumbnail','smart-search','face-detection')),
  dispatched_at timestamptz, PRIMARY KEY (asset_id, kind)
);`;

export const getImmichImportState = async (db: ImportDatabase) => {
  const [run] = await db.query(
    'SELECT status, source_version, source_fingerprint, config_fingerprint, created_at, verified_at FROM public.frameleaf_immich_import',
  );
  const [derived] = run
    ? await db.query('SELECT id FROM public.job_run WHERE id=$1::uuid AND kind=$2', [
        importDerivedRunId(String(run.source_fingerprint), String(run.config_fingerprint)),
        IMPORT_DERIVED_RUN_KIND,
      ])
    : [];
  const checkpoints = await db.query(
    'SELECT table_name, row_count, complete FROM public.frameleaf_immich_import_checkpoint ORDER BY table_name',
  );
  const [work] = await db.query(
    'SELECT count(*)::text AS pending FROM public.frameleaf_immich_import_work WHERE dispatched_at IS NULL',
  );
  return {
    status: run?.status ?? 'fresh',
    version: run?.source_version,
    derivedRunId: derived?.id,
    checkpoints,
    pendingDerivedWork: work?.pending ?? '0',
  };
};

/** The API/worker bootstrap must call this before exposing a destination containing an import journal. */
export const assertImmichImportActivated = async (db: ImportDatabase): Promise<void> => {
  const [row] = await db.query('SELECT status FROM public.frameleaf_immich_import');
  if (row && row.status !== 'activated') {
    throw new ImportRefused('DESTINATION_IMPORT_NOT_ACTIVATED');
  }
};

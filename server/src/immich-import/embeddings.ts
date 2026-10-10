import { ImportDatabase } from 'src/immich-import/types.js';

export type EmbeddingTransferEvidence = {
  sourceDimensions: number | null;
  destinationDimensions: number | null;
  sourceConfiguredModel: string | null;
  destinationConfiguredModel: string | null;
  // Configuration is not provenance: a stored vector needs evidence of which model produced it.
  producingModel: string | null;
};
export type EmbeddingAdmission = Record<'smart_search' | 'face_search', EmbeddingTransferEvidence>;

export const inspectEmbeddingAdmission = async (
  source: ImportDatabase,
  destination: ImportDatabase,
): Promise<EmbeddingAdmission> => {
  const inspect = async (db: ImportDatabase) => {
    const dimensions = await db.query(`SELECT c.relname AS table_name, a.atttypmod AS dimensions
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_type t ON t.oid=a.atttypid
      WHERE n.nspname='public' AND c.relname IN ('smart_search','face_search')
        AND a.attname='embedding' AND NOT a.attisdropped AND t.typname='vector'`);
    const [config] = await db.query(`SELECT value #>> '{machineLearning,clip,modelName}' AS clip,
      value #>> '{machineLearning,facialRecognition,modelName}' AS face
      FROM public.system_metadata WHERE key='system-config'`);
    return { dimensions, config };
  };
  const [from, to] = await Promise.all([inspect(source), inspect(destination)]);
  const dimension = (rows: typeof from.dimensions, table: string): number | null => {
    const value = Number(rows.find((row) => row.table_name === table)?.dimensions);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const model = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
  const evidence = (table: string, key: string): EmbeddingTransferEvidence => ({
    sourceDimensions: dimension(from.dimensions, table),
    destinationDimensions: dimension(to.dimensions, table),
    sourceConfiguredModel: model(from.config?.[key]),
    destinationConfiguredModel: model(to.config?.[key]),
    // None of the frozen Immich 3.0–3.2.4 schemas stores per-row producer identity. Never elevate an
    // operator assertion or a selected config (which can be overridden by a file) into that evidence.
    producingModel: null,
  });
  return { smart_search: evidence('smart_search', 'clip'), face_search: evidence('face_search', 'face') };
};

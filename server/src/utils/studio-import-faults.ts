/** Internal test dependency only; never populate from a request or deployment configuration. */
export type ImportFaultPoint =
  | 'stage-file-barrier'
  | 'stage-namespace-barrier'
  | 'prepare-commit'
  | 'target-link'
  | 'target-namespace-barrier'
  | 'publication-commit'
  | 'stage-unlink'
  | 'cleanup-namespace-barrier';
export type ImportFaults = { reached(point: ImportFaultPoint): Promise<void> };
export const STUDIO_IMPORT_FAULTS = Symbol('StudioImportFaults');
export const noImportFaults: ImportFaults = { reached: () => Promise.resolve() };

import type { ImportFaultPoint, ImportFaults } from 'src/utils/studio-import-faults.js';

export const IMPORT_FAULT_POINTS = [
  'stage-file-barrier',
  'stage-namespace-barrier',
  'prepare-commit',
  'target-link',
  'target-namespace-barrier',
  'publication-commit',
  'stage-unlink',
  'cleanup-namespace-barrier',
] as const satisfies readonly ImportFaultPoint[];

/** Park at the actual completed barrier; only the external owned controller may crash the worker. */
export function barrierFaults(
  stop: ImportFaultPoint,
  notify: (point: ImportFaultPoint) => Promise<void>,
): ImportFaults {
  if (!IMPORT_FAULT_POINTS.includes(stop)) throw new Error('invalid_import_fault_point');
  return {
    reached: async (point) => {
      if (point !== stop) return;
      await notify(point);
      await new Promise<void>(() => {});
    },
  };
}

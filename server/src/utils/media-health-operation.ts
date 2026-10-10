import type { JobOf } from 'src/types.js';
import { JobName, MediaOperationBulkAction, MediaOperationKind } from 'src/enum.js';
import { isMediaHealthBulkAction } from 'src/utils/bulk-operation.js';

/**
 * The durable Library Care jobs (FL-69), kept free of the database so they can be read and tested
 * on their own.
 *
 * A Library Care scan or search is a `media_operation` of kind `media_health`. Its snapshot says
 * what was asked for and never changes; its result is the resume cursor, written after every batch,
 * so a paused, restarted or automatically retried job carries on from where it stopped instead of
 * starting again. Both come back out of `jsonb`, so they are parsed defensively.
 */

/** A health run's status as Library Care reports it, alongside the job's own status. */
export type MediaHealthRunState = 'running' | 'paused' | 'retrying' | 'cancelled' | 'failed' | 'completed';

type ManagedSearch = NonNullable<JobOf<JobName.MediaHealthLocateMissing>['managedSearch']>;

/** Scan every asset an owner has: missing files, then damage, then untracked files to restore. */
export type MediaHealthScanSnapshot = {
  mode: 'scan';
  userId: string;
  missingRunId: string;
  corruptRunId: string;
  /**
   * An incremental scan (Library care → "Schedule incremental health scans"): only assets changed
   * since this moment, the start of the account's last completed scan. Absent scans everything.
   */
  changedSince?: string;
  /** Started by the Library care schedule rather than by a person. */
  scheduled?: boolean;
};

/** Search chosen locations for exact copies of the originals behind a fixed set of findings. */
export type MediaHealthLocateSnapshot = {
  mode: 'locate';
  /** The person who asked. Only an administrator's search may cover another account's findings. */
  userId: string;
  runId: string;
  findingIds: string[];
  /** Null searches library storage and every external library, as before FL-69. */
  rootIds: string[] | null;
  /** True when the search covers findings of other accounts (administrators only, checked again). */
  anyOwner: boolean;
};

export type MediaHealthOperationSnapshot = MediaHealthScanSnapshot | MediaHealthLocateSnapshot;

export type MediaHealthScanResult = {
  /** The last asset id finished. The scan works in id order, so this is where it resumes. */
  cursor: string | null;
  /** Assets the scan covers, counted once at its first claim. */
  total: number | null;
  checked: number;
  missing: number;
  corrupt: number;
  /** Untracked files in library storage have been restored, the last step. */
  restored: boolean;
};

export type MediaHealthLocateResult = {
  /** The directory walk's cursor and the matches so far, while the search is incomplete. */
  managedSearch: ManagedSearch | null;
  checked: number;
  found: number;
  steps: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const asCount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export const parseMediaHealthSnapshot = (value: unknown): MediaHealthOperationSnapshot => {
  if (!isRecord(value) || typeof value.userId !== 'string') {
    throw new Error('Library Care job snapshot is missing');
  }

  if (value.mode === 'scan') {
    if (typeof value.missingRunId !== 'string' || typeof value.corruptRunId !== 'string') {
      throw new TypeError('Library Care scan snapshot has no runs');
    }
    return {
      mode: 'scan',
      userId: value.userId,
      missingRunId: value.missingRunId,
      corruptRunId: value.corruptRunId,
      ...(typeof value.changedSince === 'string' &&
        !Number.isNaN(Date.parse(value.changedSince)) && { changedSince: value.changedSince }),
      ...(value.scheduled === true && { scheduled: true }),
    };
  }

  if (value.mode === 'locate') {
    const findingIds = [...new Set(asStrings(value.findingIds))];
    if (typeof value.runId !== 'string' || findingIds.length === 0) {
      throw new Error('Library Care search snapshot has no findings');
    }
    return {
      mode: 'locate',
      userId: value.userId,
      runId: value.runId,
      findingIds,
      rootIds: Array.isArray(value.rootIds) ? asStrings(value.rootIds) : null,
      anyOwner: value.anyOwner === true,
    };
  }

  throw new Error(`Unsupported Library Care job: ${String(value.mode)}`);
};

export const parseScanResult = (value: unknown): MediaHealthScanResult => {
  const source = isRecord(value) ? value : {};
  return {
    cursor: typeof source.cursor === 'string' ? source.cursor : null,
    total: typeof source.total === 'number' ? source.total : null,
    checked: asCount(source.checked),
    missing: asCount(source.missing),
    corrupt: asCount(source.corrupt),
    restored: source.restored === true,
  };
};

const isManagedSearch = (value: unknown): value is ManagedSearch =>
  isRecord(value) &&
  Array.isArray(value.cursor) &&
  value.cursor.every((entry) => isRecord(entry) && typeof entry.path === 'string') &&
  isRecord(value.matches);

export const parseLocateResult = (value: unknown): MediaHealthLocateResult => {
  const source = isRecord(value) ? value : {};
  return {
    managedSearch: isManagedSearch(source.managedSearch) ? source.managedSearch : null,
    checked: asCount(source.checked),
    found: asCount(source.found),
    steps: asCount(source.steps),
  };
};

/** 0 to 100 for a scan. Never 100 before the job has actually completed. */
export const scanProgress = (result: MediaHealthScanResult): number => {
  if (!result.total) {
    return 0;
  }
  return Math.min(99, Math.round((result.checked / result.total) * 1000) / 10);
};

/** What Activity shows for a Library Care job when the client has no translation of its own. */
export const mediaHealthOperationLabel = (snapshot: MediaHealthOperationSnapshot): string =>
  snapshot.mode === 'scan'
    ? snapshot.scheduled
      ? 'Scheduled library health scan'
      : 'Library health scan'
    : `Search for originals (${snapshot.findingIds.length} ${snapshot.findingIds.length === 1 ? 'item' : 'items'})`;

/**
 * Library Care's "recent activity" name for a job, or null when the job is not Library Care's. Scans
 * and searches are `media_health` jobs; relinks, recoveries and trash are bulk jobs (FL-32).
 */
export const mediaHealthActivityAction = (
  kind: MediaOperationKind,
  snapshot: unknown,
): 'scan' | 'locate' | MediaOperationBulkAction | null => {
  if (!isRecord(snapshot)) {
    return null;
  }
  if (kind === MediaOperationKind.MediaHealth) {
    return snapshot.mode === 'scan' || snapshot.mode === 'locate' ? snapshot.mode : null;
  }
  if (kind === MediaOperationKind.Bulk) {
    const action = snapshot.action as MediaOperationBulkAction;
    return Object.values(MediaOperationBulkAction).includes(action) && isMediaHealthBulkAction(action) ? action : null;
  }
  return null;
};

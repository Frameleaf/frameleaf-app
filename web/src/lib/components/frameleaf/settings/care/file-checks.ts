/**
 * File checks (FL-366) in plain words: the pieces of the page that are not drawing, kept apart so
 * they can be tested on their own.
 *
 * - How much the damage check reads: "Stop after" (the server keeps milliseconds) and "Check each
 *   night" (the server keeps a share from 0 to 1).
 * - "A drive is unplugged": a folder of originals the server says it cannot reach (FL-520).
 * - The checks as a run in progress, and where "Restore from a backup" goes (FL-520).
 */
import type {
  IntegrityCheckHistoryEntryDto,
  IntegrityCheckProgressDto,
  IntegrityReport,
  IntegrityUnreachableFolderDto,
} from '@frameleaf/sdk';
import { commandCenterUrl } from '$lib/frameleaf/settings-areas';

const MINUTE_MS = 60_000;
/** "Stop after": how long one night's damage check may read files, in minutes. */
export const STOP_AFTER_MINUTES = [30, 60, 120, 240, 480] as const;
export const stopAfterMinutes = (timeLimit: number) => Math.round(timeLimit / MINUTE_MS);
export const stopAfterMs = (minutes: number) => minutes * MINUTE_MS;

/** "Check each night": the share of the library the damage check reads in one night. */
export const SHARES = { whole: 1, half: 0.5, quarter: 0.25 } as const;
export type Share = keyof typeof SHARES;
export const shareOf = (percentageLimit: number): Share | 'other' =>
  (Object.keys(SHARES) as Share[]).find((share) => SHARES[share] === percentageLimit) ?? 'other';

/** The folder a file is in, and its own name. */
export const splitPath = (path: string) => {
  const index = path.lastIndexOf('/');
  return index === -1 ? { folder: '', name: path } : { folder: path.slice(0, index + 1), name: path.slice(index + 1) };
};

/**
 * FL-737: how a finding is named. A photo's is the file name it came with (`beach-29868698.jpg`), as
 * Missing files and Damaged files name it, not the name it is stored under; a stray file belongs to no
 * photo, so it keeps its folder and name.
 */
export const findingWhere = ({ path, originalFileName }: { path: string; originalFileName?: string | null }) =>
  originalFileName ? { folder: '', name: originalFileName } : splitPath(path);

/**
 * FL-520: the folder to name when originals cannot be reached: the one holding the most missing files.
 * The server looks at each folder's drive (`IntegrityService.getUnreachableFolders`) instead of guessing
 * from many missing files in one folder. A folder that cannot be reached but holds no missing finding
 * yet says nothing until a check has looked.
 */
export const unreachableFolder = (folders: readonly IntegrityUnreachableFolderDto[]) =>
  folders.filter((folder) => folder.missing > 0).sort((a, b) => b.missing - a.missing)[0];

export type CheckStepState = { type: IntegrityReport; state: 'done' | 'now' | 'waiting'; percent?: number };

/**
 * FL-520: the checks that are on, as a run: the ones running now (with how far each has got, when the
 * server knows), the ones that finished since the earliest running one started, and the rest waiting
 * their turn.
 */
export const checkSteps = (
  types: readonly IntegrityReport[],
  running: readonly IntegrityCheckProgressDto[],
  history: readonly IntegrityCheckHistoryEntryDto[],
): CheckStepState[] => {
  const since = running.map((run) => run.startedAt).sort()[0];
  return types.map((type) => {
    const run = running.find((item) => item.type === type);
    if (run) {
      const percent = run.total ? Math.min(99, Math.floor((run.done / run.total) * 100)) : undefined;
      return { type, state: 'now', percent };
    }
    const finished = since !== undefined && history.some((entry) => entry.type === type && entry.finishedAt >= since);
    return { type, state: finished ? 'done' : 'waiting' };
  });
};

/** FL-520: Backup › Restore, with the photos behind the missing or damaged findings chosen. */
export const restoreUrl = (kind: 'missing' | 'damaged') => commandCenterUrl('backups', 'restore', { files: kind });

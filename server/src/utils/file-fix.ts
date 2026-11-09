import path from 'node:path';
import type { FileCause } from 'src/utils/file-problem.js';
import type { FindingStep, FixState } from 'src/utils/file-steps.js';
import type { JpegRepairMethod } from 'src/utils/jpeg-repair.js';

/**
 * The fix job's timings and small rules (FL-1337, design §3). The job itself is
 * `MediaHealthService.handleFixAsset`.
 */

/** How long a busy file waits before each of its three tries (FL-845's three tries). */
export const BUSY_RETRY_DELAYS_MS: readonly number[] = [5, 30, 120].map((minutes) => minutes * 60_000);
/** How long a fix waits for an unplugged drive, or for Cloud Backup to finish, before it looks again. */
export const FIX_WAIT_MS = 30 * 60_000;
/** A day of waits for an unplugged drive. Then it stops until the next file check or Try again. */
export const MAX_DRIVE_WAITS = 48;

/**
 * How a repair turned out for the history and the list. Part saved: the picture was rebuilt from a file
 * cut short, or only its small embedded picture could be saved. A lossless repair saves all of it.
 */
export const repairResult = ({ method, percentSaved }: { method: JpegRepairMethod; percentSaved?: number }) => {
  const saved = method === 'preview' ? undefined : (percentSaved ?? 100);
  const partSaved = method === 'preview' || (saved ?? 100) < 100;
  const fixState: FixState = partSaved ? 'part-saved' : 'repaired';
  return { percentSaved: saved, partSaved, fixState };
};

/**
 * Where a file is, as the owner's history may say it: its folder inside one of the owner's own roots,
 * with `/` between parts (shown as "Library › 2019 › 03"), and its name. A file anywhere else, such as
 * another account's folder, is not described at all: facts never hold another account's paths.
 */
export const folderFacts = (roots: string[], filePath: string): { folder?: string; name?: string } => {
  for (const root of roots) {
    const relative = path.relative(root, filePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      const folder = path.dirname(relative);
      return { folder: folder === '.' ? '' : folder.split(path.sep).join('/'), name: path.basename(filePath) };
    }
  }
  return {};
};

/** "Checked the file. Damaged: {cause}" (or busy: it could not be checked). */
export const checkedStep = (cause: FileCause): FindingStep => ({
  step: 'checked',
  outcome: 'failed',
  facts: { cause },
});

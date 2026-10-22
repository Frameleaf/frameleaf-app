/**
 * File checks (FL-366) in plain words: the pieces of the page that are not drawing, kept apart so
 * they can be tested on their own.
 *
 * - How much the damage check reads: "Stop after" (the server keeps milliseconds) and "Check each
 *   night" (the server keeps a share from 0 to 1).
 * - "A drive is unplugged": many missing files that all sit in one folder.
 */
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

/** At least this many missing files in one folder reads as a drive or folder that cannot be reached. */
export const UNPLUGGED_MIN = 10;

/**
 * The folder every missing file is in, when there are many and they all share it: that is usually a
 * drive that is unplugged or a folder that was moved, not photos that are gone. Only the loaded
 * findings are looked at, so it says nothing unless every one of them is in the same folder.
 */
export const unpluggedFolder = (count: number, paths: readonly string[]) => {
  if (count < UNPLUGGED_MIN || paths.length < UNPLUGGED_MIN) {
    return;
  }
  const folders = new Set(paths.map((path) => splitPath(path).folder));
  const [folder] = folders;
  return folders.size === 1 && folder ? folder : undefined;
};

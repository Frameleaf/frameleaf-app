// FL-1321: the drive under each folder on the Storage step, and the fast drive Manager suggests for the database
// and thumbnails. The report comes from GET /manager-api/drives (manager/src/drives.ts); wording follows the
// approved prototype (frameleaf-prototype src/manager-setup.mjs, FL-1310).
import { folderOverlap } from './presentation';

export type Drive = {
  path: string;
  name: string;
  label: string;
  kind: 'nvme' | 'ssd' | 'hdd' | 'unknown';
  speed: 'fast' | 'slow' | 'unknown';
  freeBytes: number | null;
  base: string;
};
/** The API's `too_full` is the prototype's "small" case: a fast drive without room, explained but never offered. */
export type Suggestion =
  | { status: 'found'; drive: Drive; title: string; reason: string; folder: string }
  | { status: 'too_full'; drive: Drive; reason: string }
  | { status: 'none'; reason: string };
export type DriveReport = { drives: Drive[]; database: Suggestion; thumbs: Suggestion };

const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
/** The drive holding `path`, by the closest drive path. Undefined when Manager doesn't know it. */
export const driveFor = (path: string, drives: Drive[] = []): Drive | undefined =>
  drives.filter((drive) => within(path, drive.path)).sort((a, b) => b.path.length - a.path.length)[0];

/** "180 GB", "2.1 TB": the same rounding the suggestion's reason uses. */
export const gigabytes = (bytes: number) => {
  const gb = Math.floor(bytes / 1024 ** 3);
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`;
};

/** Unraid's Unassigned Devices mounts network shares here; Manager never lists them as drives. */
const networkShare = (path: string) => within(path, '/mnt/remotes') || within(path, '/mnt/rootshare');

/** The line under a folder: its drive and free space, with the drive's speed. Null when Manager can't tell. */
export function driveHint(path: string, drives: Drive[] = []): { speed: 'fast' | 'slow' | 'network'; text: string } | null {
  if (networkShare(path)) return { speed: 'network', text: 'Network share' };
  const drive = driveFor(path, drives);
  if (!drive || drive.speed === 'unknown' || drive.freeBytes === null) return null;
  return { speed: drive.speed, text: `${drive.label} · ${gigabytes(drive.freeBytes)} free` };
}

/** Whether `path` is on the drive Manager suggests, so the suggestion reads as applied. */
export const onSuggested = (suggestion: Suggestion | undefined, path: string, drives: Drive[] = []) =>
  suggestion?.status === 'found' && driveFor(path, drives)?.path === suggestion.drive.path;

export type SetupFolders = { media: string; database: string; backups: string; manager: string };
/** Why a folder can't hold thumbnails or the database, in the words setup shows; null when it can. */
export function fastFolderIssue(path: string, folders: SetupFolders, kind: 'thumbnails' | 'database'): string | null {
  if (path.split('/').length < 4) return 'Choose a folder inside this one.';
  if (networkShare(path)) return 'This is a network share. Choose a drive inside this server.';
  if (folders.media && folderOverlap(path, folders.media)) return 'This is inside your photos and videos folder. Choose a folder of its own.';
  if (folderOverlap(path, folders.manager)) return 'This folder holds Frameleaf Manager’s own settings. Choose a folder of its own.';
  if (folders.backups && folderOverlap(path, folders.backups)) return 'This folder holds your Frameleaf backups. Choose a folder of its own.';
  if (kind === 'thumbnails' && folders.database && folderOverlap(path, folders.database))
    return 'This folder holds your Frameleaf database. Choose a folder of its own.';
  return null;
}

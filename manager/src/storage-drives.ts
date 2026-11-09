import { realpath, stat, statfs } from 'node:fs/promises';
import type { Installation } from './contracts.js';
import { thumbnailMount } from './mounts.js';

/**
 * FL-1324: the places a library keeps things, and the drive each is on. Photos and videos, thumbnails kept on a
 * folder of their own (FL-1320), the database and the backups can each be on another drive, and each can fill up.
 */
export type DriveUse = 'media' | 'thumbnails' | 'database' | 'backups';
export type StoragePlace = { name: string; path: string; use: DriveUse };

/** Under 5% or 2 GB left: the rule troubleshooting has always used for a mounted drive. */
const LOW_PERCENT = 5;
const LOW_BYTES = 2e9;
export const isLowOnSpace = (availableBytes: number, totalBytes: number) =>
  Math.round((100 * availableBytes) / Math.max(totalBytes, 1)) < LOW_PERCENT || availableBytes <= LOW_BYTES;

/**
 * Every place worth reporting, in order: media, thumbnails, database, backups. `media` are the media places as
 * Manager reports them today; the thumbnail mount's own folder is named for what it holds, not as more media.
 * `databaseRoots` stand in for the database before there is an installation.
 */
export function storagePlaces(
  installation: Pick<Installation, 'mounts' | 'databaseRoot'> | null,
  { media, backups, databaseRoots = [] }: { media: string[]; backups: string; databaseRoots?: string[] },
): StoragePlace[] {
  const thumbnails = installation ? thumbnailMount(installation.mounts)?.source : undefined;
  const database = installation?.databaseRoot ? [installation.databaseRoot] : databaseRoots;
  return [
    ...media.filter((path) => path !== thumbnails).map((path, i) => ({ name: `Storage ${i + 1}`, path, use: 'media' as const })),
    ...(thumbnails ? [{ name: 'Thumbnails drive', path: thumbnails, use: 'thumbnails' as const }] : []),
    ...database.map((path) => ({ name: 'Database drive', path, use: 'database' as const })),
    { name: 'Backup drive', path: backups, use: 'backups' as const },
  ];
}

/**
 * Media and backup folders are always Manager's own to read. A thumbnail or database folder of an imported library
 * can be one only Docker reaches (`mounts.ts` `visibility`): that one is listed as not measurable.
 */
export const measurableBy =
  (visible: (path: string) => boolean) =>
  (path: string, uses: DriveUse[]) =>
    uses.some((use) => use === 'media' || use === 'backups') || visible(path);

/** One folder on the Storage page: what it holds, its drive, and how much room that drive has. */
export type StorageSpace = {
  path: string;
  /** What the library keeps here. */
  uses: DriveUse[];
  /** The drive's id on this server: folders with the same `device` are on the same drive. Null when unreadable. */
  device: string | null;
  totalBytes: number | null;
  availableBytes: number | null;
  freeBytes: number | null;
  /** Under 5% or 2 GB left; null when the drive could not be read. */
  lowOnSpace: boolean | null;
  /**
   * False for a folder Manager can't see from where it runs (an imported library's thumbnail or database folder
   * that only Docker uses): it is listed, but its room is unknown rather than missing or full.
   */
  measurable: boolean;
};

type Readers = { realpath: typeof realpath; stat: typeof stat; statfs: typeof statfs };

/**
 * Reads each place once per folder (a folder used twice lists both uses). A moved or unreadable folder reads as
 * unknown; a folder `visible` says Manager can't see is listed as not measurable, without being read.
 */
export async function readStorage(
  places: StoragePlace[],
  fs: Readers = { realpath, stat, statfs },
  visible: (path: string, uses: DriveUse[]) => boolean = () => true,
): Promise<StorageSpace[]> {
  const byPath = new Map<string, DriveUse[]>();
  for (const { path, use } of places) {
    const uses = byPath.get(path) ?? [];
    if (!uses.includes(use)) uses.push(use);
    byPath.set(path, uses);
  }
  return Promise.all(
    [...byPath].map(async ([path, uses]) => {
      const unknown = { path, uses, device: null, totalBytes: null, availableBytes: null, freeBytes: null, lowOnSpace: null };
      if (!visible(path, uses)) return { ...unknown, measurable: false };
      try {
        if ((await fs.realpath(path)) !== path) throw new Error('storage_path_changed');
        const [space, info] = await Promise.all([fs.statfs(path), fs.stat(path)]);
        const totalBytes = space.blocks * space.bsize,
          availableBytes = space.bavail * space.bsize;
        return {
          path,
          uses,
          device: String(info.dev),
          totalBytes,
          availableBytes,
          freeBytes: space.bfree * space.bsize,
          lowOnSpace: isLowOnSpace(availableBytes, totalBytes),
          measurable: true,
        };
      } catch {
        return { ...unknown, measurable: true };
      }
    }),
  );
}

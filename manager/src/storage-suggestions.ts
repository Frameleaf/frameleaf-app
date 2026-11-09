import { resolve } from 'node:path';
import { NEW_LIBRARY_BYTES, suggestDrive, type Drive, type Suggestion } from './drives.js';

/** The drive a folder is on: the one whose path holds it most closely. */
const driveUnder = (path: string, drives: Drive[]): Drive | undefined =>
  drives
    .filter((drive) => resolve(path) === drive.path || resolve(path).startsWith(drive.path === '/' ? '/' : `${drive.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];

export type StorageSuggestions = { database: Suggestion | null; thumbs: Suggestion | null };

/**
 * FL-1323: what the Storage page suggests for an installed library, with its real sizes (frameleaf-prototype
 * ManagerStorage). The database gets a suggestion only while it is on a drive Manager knows is slow; thumbnails only
 * while they are with the photos. A database still waiting to move has first claim on a fast drive they share, so
 * thumbnails count its room as taken there.
 */
export function storageSuggestions(
  drives: Drive[],
  {
    database,
    thumbnails,
  }: { database: { path: string; bytes: number | null }; thumbnails: { own: boolean; bytes: number | null } },
): StorageSuggestions {
  const slowDatabase = driveUnder(database.path, drives)?.speed === 'slow';
  const databaseBytes = database.bytes || NEW_LIBRARY_BYTES.database;
  const forDatabase = suggestDrive('database', drives, { needBytes: databaseBytes });
  const keep =
    slowDatabase && forDatabase.status === 'found' ? { path: forDatabase.drive.path, bytes: databaseBytes } : undefined;
  return {
    database: slowDatabase ? forDatabase : null,
    thumbs: thumbnails.own ? null : suggestDrive('thumbs', drives, { needBytes: thumbnails.bytes || undefined, keep }),
  };
}

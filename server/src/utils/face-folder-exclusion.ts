import { sql } from 'kysely';
import { posix } from 'node:path';

/** Longest folder path an exclusion accepts. */
export const FACE_FOLDER_EXCLUSION_MAX_LENGTH = 4096;

/**
 * FL-934: the stored form of a folder left out of face recognition: an absolute path, `.` and `..` resolved,
 * repeated slashes folded, ending in exactly one `/` so `/photos/scan/` never matches `/photos/scans/...`.
 * Null when it is not an absolute folder path, or names the root (which would leave out every photo).
 */
export const normaliseFaceFolderPrefix = (input: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('\0') || trimmed.length > FACE_FOLDER_EXCLUSION_MAX_LENGTH) {
    return null;
  }
  const folder = posix.normalize(trimmed).replace(/\/+$/, '');
  return folder === '' ? null : `${folder}/`;
};

/**
 * FL-934: true when the photo under `alias` is in a folder its own owner left out of face recognition. Matched
 * against the photo's owner, so a partner's copy follows the exclusions of whoever owns the copy.
 */
export const faceFolderExcluded = (alias = 'asset') => sql<boolean>`exists (
  select 1 from face_folder_exclusion
  where face_folder_exclusion."ownerId" = ${sql.ref(`${alias}.ownerId`)}
    and starts_with(${sql.ref(`${alias}.originalPath`)}, face_folder_exclusion."pathPrefix")
)`;

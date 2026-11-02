import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { extname, join } from 'node:path';

/**
 * FL-417: a photo that shares a stored file shows its own path, never the folder the file is kept in.
 *
 * `asset.originalPath` stays the stored file's path: every reader of bytes and every guard that compares
 * it with `physical_file.path` keeps working unchanged. `asset.libraryPath` holds the photo's own path
 * while that file sits outside its owner's folder; what the API, folders and path search show is
 * `coalesce(libraryPath, originalPath)`.
 */

/** The path a photo shows: its own path, or the stored file's path when that is its own. */
export const displayPath = (asset: { originalPath: string; libraryPath?: string | null }) =>
  asset.libraryPath ?? asset.originalPath;

/** SQL for the path a photo shows, for folder and path-search queries. */
export const displayPathSql = (table = 'asset') =>
  sql<string>`coalesce(${sql.ref(`${table}.libraryPath`)}, ${sql.ref(`${table}.originalPath`)})`;

/**
 * The `libraryPath` an `UPDATE asset SET "originalPath" = newPath` sets in the same statement (SET reads
 * the row before the update):
 * - `ownFile`: the photo now has a file of its own; a new path clears its library path;
 * - otherwise the photo is linked onto a file it shares: its own path so far is kept as its library path.
 * The path not changing keeps whatever the photo shows today.
 */
export const libraryPathOnRelink = (newPath: string, ownFile: boolean) =>
  ownFile
    ? sql<string | null>`CASE WHEN "originalPath" = ${newPath} THEN "libraryPath" ELSE NULL END`
    : sql<
        string | null
      >`CASE WHEN "originalPath" = ${newPath} THEN "libraryPath" ELSE coalesce("libraryPath", "originalPath") END`;

type Owner = { id: string; storageLabel?: string | null };

const ROOT = /^(.*)\/(library|upload)\/([^/]+)\//;

/** Whether a managed path lies in the owner's own folder (`upload/<id>/…`, `library/<label or id>/…`). */
export const isInOwnerFolder = (path: string, owner: Owner) => {
  const root = ROOT.exec(path);
  if (!root) {
    return false;
  }
  const kind = root[2];
  const folder = root[3];
  return folder === owner.id || (kind === 'library' && folder === (owner.storageLabel || owner.id));
};

/**
 * A photo's own path, built from its owner's folder and its own date and name only (never from the folder
 * the shared file is kept in): `upload/<ownerId>/<aa>/<bb>/<assetId>.<ext>` beside an upload, else the
 * default library layout `library/<label>/<yyyy>/<yyyy-MM-dd>/<file name>`. Same rule as the FL-417
 * migration's backfill.
 */
export const ownLibraryPath = (
  asset: { id: string; originalPath: string; originalFileName: string; localDateTime: Date | string },
  owner: Owner,
) => {
  const root = ROOT.exec(asset.originalPath);
  const media = root?.[1] ?? '';
  if (root?.[2] === 'upload') {
    return join(
      `${media}/upload`,
      owner.id,
      asset.id.slice(0, 2),
      asset.id.slice(2, 4),
      `${asset.id}${extname(asset.originalPath)}`,
    );
  }
  const date = DateTime.fromJSDate(new Date(asset.localDateTime), { zone: 'UTC' });
  return join(
    `${media}/library`,
    owner.storageLabel || owner.id,
    date.toFormat('yyyy'),
    date.toFormat('yyyy-MM-dd'),
    asset.originalFileName.replaceAll('/', '_'),
  );
};

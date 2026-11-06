import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { digest, Refusal, type SourceFence } from './contracts.js';
import type { PhotoAppCapture } from './photo-app-capture.js';

/**
 * FL-1149 (Beta): photo apps imported from a folder the owner exported themselves, instead of from a container
 * Manager stops. Ente Photos: the owner runs the official CLI, so Manager never handles their Ente password,
 * second factor or keyring, and the same steps work against ente.io or a self-hosted Ente server.
 */
export const folderImportKinds = ['ente'] as const;
export type FolderImportKind = (typeof folderImportKinds)[number];
export const folderImportNames: Record<FolderImportKind, string> = { ente: 'Ente Photos' };

/** Written by `ente photos export <folder>`. */
export const ENTE_EXPORT_FILE = 'export.json';
/** `ente photos file list --all --json > <folder>/ente-files.json`: which account owns each file. */
export const ENTE_INVENTORY_FILE = 'ente-files.json';
/** The CLI's own export history, not the account's trash: never read, never imported. */
const TRASH = 'Trash';

export const folderSourceId = (kind: FolderImportKind, folder: string) => digest([kind, 'folder', folder]);

/**
 * The same approved-roots rule as the media and database folders, but read-only is enough: Manager never writes
 * to an export. Returns the folder's real path, which is also the path Docker mounts.
 */
export async function importFolderPath(path: string, roots: string[]): Promise<string> {
  if (!path.startsWith('/') || /[\n\0,]/u.test(path) || path !== resolve(path)) throw new Refusal('import_folder_invalid');
  const actual = await realpath(path).catch(() => {
    throw new Refusal('import_folder_unreachable');
  });
  if (!roots.some((root) => actual === root || actual.startsWith(`${root}/`)) || actual !== path)
    throw new Refusal('import_folder_outside_roots');
  if (!(await stat(actual)).isDirectory()) throw new Refusal('import_folder_unreachable');
  await access(actual, constants.R_OK | constants.X_OK).catch(() => {
    throw new Refusal('import_folder_unreachable');
  });
  return actual;
}

/** The export's account, after checking the folder holds an Ente export and the saved file list. */
export async function readEnteExport(folder: string): Promise<{ userID: string }> {
  let root: unknown;
  try {
    root = JSON.parse(await readFile(join(folder, ENTE_EXPORT_FILE), 'utf8'));
  } catch {
    throw new Refusal('ente_export_not_found');
  }
  const { format, version, userID } = (root ?? {}) as Record<string, unknown>;
  if (format !== 'ente-photos-export' || version !== 1 || typeof userID !== 'string' || !/^[1-9]\d{0,18}$/u.test(userID))
    throw new Refusal('ente_export_not_found');
  let inventory: unknown;
  try {
    inventory = JSON.parse(await readFile(join(folder, ENTE_INVENTORY_FILE), 'utf8'));
  } catch {
    throw new Refusal('ente_inventory_required');
  }
  if (!Array.isArray(inventory)) throw new Refusal('ente_inventory_required');
  return { userID };
}

/**
 * Nothing is stopped, so the export itself is the fence: export.json, the file list and every file outside
 * `Trash/` (path, type, size, modification time in nanoseconds). Any change means review again.
 */
export async function folderRevision(folder: string): Promise<string> {
  const hash = createHash('sha256');
  for (const name of [ENTE_EXPORT_FILE, ENTE_INVENTORY_FILE]) {
    const bytes = await readFile(join(folder, name)).catch(() => {
      throw new Refusal('source_changed_review_again');
    });
    hash.update(`${name}\0${bytes.length}\0`).update(bytes);
  }
  const entries = await readdir(folder, { recursive: true }).catch(() => {
    throw new Refusal('source_changed_review_again');
  });
  const listing: [string, string, string, string][] = [];
  for (const entry of entries) {
    const path = relative(folder, join(folder, entry));
    if (path === TRASH || path.startsWith(`${TRASH}/`)) continue;
    const info = await lstat(join(folder, path), { bigint: true }).catch(() => {
      throw new Refusal('source_changed_review_again');
    });
    if (info.isDirectory()) continue;
    listing.push([path, info.isFile() ? 'f' : info.isSymbolicLink() ? 'l' : 'o', String(info.size), String(info.mtimeNs)]);
  }
  listing.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  hash.update(JSON.stringify(listing));
  return hash.digest('hex');
}

/** The `capture-common-source` receipt for an export folder: no database, no copy, nothing stopped. */
export async function captureEnteFolder(folder: string): Promise<PhotoAppCapture> {
  const { userID } = await readEnteExport(folder);
  const revision = await folderRevision(folder);
  const fence: SourceFence = {
    id: folderSourceId('ente', folder),
    containers: [],
    workers: [],
    mounts: [{ type: 'bind', source: folder, target: '/import-media/source', readOnly: true }],
    fingerprint: revision,
    platform: 'docker',
    restart: {},
    folder: { path: folder, revision },
  };
  return {
    fence,
    originalsPath: folder,
    database: 'export',
    source: { kind: 'ente', version: 'ente-cli', identity: userID, revision, schemaSha256: revision },
  };
}

/** The export folder still holds exactly what was reviewed. */
export async function verifyFolderFence(folder: NonNullable<SourceFence['folder']>): Promise<void> {
  if ((await folderRevision(folder.path)) !== folder.revision) throw new Refusal('source_changed_review_again');
}

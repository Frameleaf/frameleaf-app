import { type Repository, type Snapshot, find, listFolder } from '@frameleaf/backup-core';
import { SNAPSHOT_FILES, decodeTreeName, fileTreePath } from 'src/utils/cloud-backup-catalog.js';

/**
 * FL-1677: a backup's files as they were stored, by their place on this server. Every read goes through the
 * engine's trees, so a folder is read without reading the rest of the backup.
 */
export type CloudBackupBrowseEntry = { name: string; type: 'file' | 'folder'; size: number; modifiedAt: string };

/** Where a storage path sits in a snapshot; `/` is the top of the stored files. */
const treePath = (storagePath: string) => (storagePath === '/' ? [SNAPSHOT_FILES] : fileTreePath(storagePath));

/** What a folder held in one backup, folders first, then by name. Throws when the backup has no such folder. */
export async function browseBackup(
  repository: Repository,
  snapshot: Snapshot,
  storagePath: string,
): Promise<CloudBackupBrowseEntry[]> {
  const entries = await listFolder(repository, snapshot, treePath(storagePath));
  return entries
    .filter(({ type }) => type !== 'symlink')
    .map(({ name, type, size, mtime }) => ({
      name: decodeTreeName(name),
      type: type === 'dir' ? ('folder' as const) : ('file' as const),
      size: type === 'dir' ? 0 : size,
      modifiedAt: new Date(mtime).toISOString(),
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
}

export type CloudBackupFileVersion = { snapshotKey: string; time: string; size: number; modifiedAt: string };

/**
 * Each different copy of one file the backups hold, newest first, named by the first backup that held it
 * (any later backup holding the same copy restores the same bytes). Two copies are the same when their
 * chunks are: the engine names chunks by their content.
 */
export async function fileVersions(
  repository: Repository,
  snapshots: Array<{ key: string; snapshot: Snapshot }>,
  storagePath: string,
): Promise<CloudBackupFileVersion[]> {
  const path = fileTreePath(storagePath);
  const oldestFirst = [...snapshots].sort((a, b) => a.snapshot.time.localeCompare(b.snapshot.time));
  const versions: CloudBackupFileVersion[] = [];
  let last: string | null = null;
  for (const { key, snapshot } of oldestFirst) {
    const entry = await find(repository, snapshot, path);
    if (entry?.type !== 'file') {
      last = null;
      continue;
    }
    const content = [...(entry.chunks ?? []), '|', ...(entry.lists ?? [])].join(',');
    if (content !== last) {
      versions.push({
        snapshotKey: key,
        time: snapshot.time,
        size: entry.size,
        modifiedAt: new Date(entry.mtime).toISOString(),
      });
      last = content;
    }
  }
  return versions.reverse();
}

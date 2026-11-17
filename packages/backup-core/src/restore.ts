import { chown, lstat, mkdir, open, rename, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { Repository, Snapshot } from './repository.js';
import { type Entry, fileChunks, readTree } from './tree.js';

// Times are kept in whole milliseconds. Half a millisecond is added because the conversion to the
// file system's seconds can otherwise land just under the stored value and lose a millisecond.
const stamp = (milliseconds: number) => (milliseconds + 0.5) / 1000;
const safeName = (name: string) => name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);

/** Finds one file or folder in a snapshot. An empty path is the top. */
export async function find(repository: Repository, snapshot: Snapshot, path: string[]): Promise<Entry | null> {
  let tree = snapshot.tree;
  let found: Entry = {
    name: '',
    type: 'dir',
    mode: 0o755,
    uid: 0,
    gid: 0,
    mtime: Date.parse(snapshot.time),
    size: 0,
    tree,
  };
  for (const name of path) {
    if (found.type !== 'dir' || !found.tree) {
      return null;
    }
    const next = (await readTree(repository, tree)).find((entry) => entry.name === name);
    if (!next) {
      return null;
    }
    found = next;
    tree = next.tree ?? '';
  }
  return found;
}

/** What a folder held in a snapshot. Reads only that folder, so browsing a huge backup stays quick. */
export async function listFolder(repository: Repository, snapshot: Snapshot, path: string[]): Promise<Entry[]> {
  const folder = await find(repository, snapshot, path);
  if (folder?.type !== 'dir' || !folder.tree) {
    throw new Error('No such folder in this backup');
  }
  return readTree(repository, folder.tree);
}

/** A file's content as stored. */
export async function* readFile(repository: Repository, entry: Entry): AsyncGenerator<Buffer> {
  for (const id of await fileChunks(repository, entry)) {
    yield await repository.readBlob(id);
  }
}

export interface RestoreResult {
  files: number;
  bytes: number;
  /** What was already there and was renamed out of the way. Nothing is ever deleted. */
  movedAside: { from: string; to: string }[];
}

export interface RestoreOptions {
  /** Where something already in the way is moved to. The default adds `.before-restore-<time>` to its name. */
  aside?: (path: string) => string;
}

/**
 * Puts one file, one folder or everything (an empty path) from a snapshot into `target`.
 * A folder that exists is filled in; a file or link in the way is moved aside first.
 */
export async function restore(
  repository: Repository,
  snapshot: Snapshot,
  path: string[],
  target: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const started = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const aside = options.aside ?? ((existing: string) => `${existing}.before-restore-${started}`);
  const result: RestoreResult = { files: 0, bytes: 0, movedAside: [] };
  const start = await find(repository, snapshot, path);
  if (!start) {
    throw new Error('No such file or folder in this backup');
  }

  const clear = async (place: string) => {
    if (await lstat(place).catch(() => null)) {
      const to = aside(place);
      await rename(place, to);
      result.movedAside.push({ from: place, to });
    }
  };
  // Ownership needs root; a restore by an ordinary user keeps the files and skips it.
  const own = (place: string, entry: Entry) => chown(place, entry.uid, entry.gid).catch(() => undefined);

  const put = async (entry: Entry, place: string): Promise<void> => {
    if (entry.type === 'dir') {
      const existing = await lstat(place).catch(() => null);
      if (existing && !existing.isDirectory()) {
        await clear(place);
      }
      await mkdir(place, { recursive: true, mode: entry.mode });
      for (const child of entry.tree ? await readTree(repository, entry.tree) : []) {
        if (!safeName(child.name)) {
          throw new Error('This backup holds a name that cannot be restored safely');
        }
        await put(child, join(place, child.name));
      }
      await own(place, entry);
      await utimes(place, stamp(entry.mtime), stamp(entry.mtime)).catch(() => undefined);
      return;
    }
    await clear(place);
    if (entry.type === 'symlink') {
      await symlink(entry.target ?? '', place);
      return;
    }
    const file = await open(place, 'wx', entry.mode);
    try {
      for await (const chunk of readFile(repository, entry)) {
        await file.write(chunk);
        result.bytes += chunk.length;
      }
    } finally {
      await file.close();
    }
    await own(place, entry);
    await utimes(place, stamp(entry.mtime), stamp(entry.mtime));
    result.files++;
  };

  await mkdir(target, { recursive: true });
  // Everything goes straight into `target`; one file or folder keeps its own name inside it.
  await put(start, path.length > 0 ? join(target, start.name) : target);
  return result;
}

import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Repository } from './repository.js';

export type EntryType = 'file' | 'dir' | 'symlink';

/** What a source says about one name in a folder. */
export interface SourceEntry {
  name: string;
  type: EntryType;
  mode: number;
  uid: number;
  gid: number;
  /** Milliseconds since 1970. */
  mtime: number;
  size: number;
  /** Symlinks only. */
  target?: string;
  /**
   * Anything that changes whenever the content might have. When a file's key is the same as last time,
   * it isn't read again. The photo server passes the checksum it already holds.
   */
  key?: string;
}

/**
 * Where a backup reads from: a folder on disk, or a tree the caller makes up (the photo server offers
 * its library, a database dump and a catalog as one tree). Paths are lists of names, never joined strings.
 */
export interface Source {
  list(path: string[]): Promise<SourceEntry[]>;
  read(path: string[]): AsyncIterable<Uint8Array>;
}

/** One name in a stored folder. */
export interface Entry extends Omit<SourceEntry, 'size'> {
  size: number;
  /** Files: the ids of the chunks, in order. */
  chunks?: string[];
  /** Very large files: ids of blobs that each hold a run of chunk ids, 32 bytes apiece. */
  lists?: string[];
  /** Folders: the id of the tree blob. */
  tree?: string;
}

/** A name that can be put back inside a folder without leaving it. */
export const safeName = (name: string) => name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);

export const encodeTree = (entries: Entry[]) =>
  Buffer.from(
    JSON.stringify({ v: 1, entries: entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }),
  );

export async function readTree(repository: Repository, id: string): Promise<Entry[]> {
  return (JSON.parse((await repository.readBlob(id)).toString()) as { entries: Entry[] }).entries;
}

/** The chunk ids of a file, in order. */
export async function fileChunks(repository: Repository, entry: Entry): Promise<string[]> {
  if (!entry.lists) {
    return entry.chunks ?? [];
  }
  const ids: string[] = [];
  for (const list of entry.lists) {
    const data = await repository.readBlob(list);
    for (let at = 0; at < data.length; at += 32) {
      ids.push(data.toString('hex', at, at + 32));
    }
  }
  return ids;
}

/** A folder on disk. Sockets, devices and pipes are left out: there is nothing in them to keep. */
export function fsSource(root: string): Source {
  return {
    async list(path) {
      const folder = join(root, ...path);
      const entries: SourceEntry[] = [];
      for (const name of await readdir(folder)) {
        // A file deleted between the listing and this look is simply no longer there; its neighbours still are.
        const info = await lstat(join(folder, name)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            return null;
          }
          throw error;
        });
        if (!info) {
          continue;
        }
        const type: EntryType | null = info.isFile()
          ? 'file'
          : info.isDirectory()
            ? 'dir'
            : info.isSymbolicLink()
              ? 'symlink'
              : null;
        if (!type) {
          continue;
        }
        entries.push({
          name,
          type,
          mode: info.mode & 0o7777,
          uid: info.uid,
          gid: info.gid,
          mtime: Math.floor(info.mtimeMs),
          size: type === 'file' ? info.size : 0,
          ...(type === 'symlink' ? { target: await readlink(join(folder, name)) } : {}),
          ...(type === 'file'
            ? { key: `${info.ino}:${info.size}:${Math.floor(info.mtimeMs)}:${Math.floor(info.ctimeMs)}` }
            : {}),
        });
      }
      return entries;
    },
    read(path) {
      return createReadStream(join(root, ...path), { highWaterMark: 1024 * 1024 });
    },
  };
}

const virtualFolder = (name: string): SourceEntry => ({
  name,
  type: 'dir',
  mode: 0o755,
  uid: 0,
  gid: 0,
  mtime: 0,
  size: 0,
});
const startsWith = (path: string[], start: string[]) => start.every((name, index) => path[index] === name);

/**
 * Several sources shown as one tree, each at its own path. Manager puts every chosen folder at the path
 * it has on the server, so a backup knows where each file belongs when it is restored.
 */
export function mountSource(mounts: { path: string[]; source: Source }[]): Source {
  for (const [index, mount] of mounts.entries()) {
    if (mount.path.length === 0 && mounts.length > 1) {
      throw new Error('A source at the top leaves no room for others');
    }
    if (mounts.some((other, at) => at !== index && startsWith(other.path, mount.path))) {
      throw new Error('One chosen folder is inside another');
    }
  }
  const owner = (path: string[]) => mounts.find((mount) => startsWith(path, mount.path));
  return {
    async list(path) {
      const mount = owner(path);
      if (mount) {
        return mount.source.list(path.slice(mount.path.length));
      }
      // Above the chosen folders there are only the folders that lead to them.
      const names = new Set(
        mounts.filter((item) => startsWith(item.path, path)).map((item) => item.path[path.length]!),
      );
      return [...names].map((name) => virtualFolder(name));
    },
    read(path) {
      const mount = owner(path);
      if (!mount) {
        throw new Error('No such file');
      }
      return mount.source.read(path.slice(mount.path.length));
    },
  };
}

/** A source without the entries `skip` picks: caches, temporary files, a folder the owner left out. */
export function filterSource(source: Source, skip: (path: string[], entry: SourceEntry) => boolean): Source {
  return {
    list: async (path) => (await source.list(path)).filter((entry) => !skip([...path, entry.name], entry)),
    read: (path) => source.read(path),
  };
}

/** How much a source holds, for showing progress. Folders that can't be listed count as empty. */
export async function measureSource(source: Source, path: string[] = []): Promise<{ files: number; bytes: number }> {
  const total = { files: 0, bytes: 0 };
  for (const entry of await source.list(path).catch(() => [])) {
    if (entry.type === 'dir') {
      const inside = await measureSource(source, [...path, entry.name]);
      total.files += inside.files;
      total.bytes += inside.bytes;
    } else if (entry.type === 'file') {
      total.files++;
      total.bytes += entry.size;
    }
  }
  return total;
}

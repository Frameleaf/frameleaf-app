import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Source, SourceEntry } from '@frameleaf/backup-core';
import { treeKey } from 'src/utils/cloud-backup-catalog.js';
import { compareCodeUnits } from 'src/utils/compare.js';

/** One file a backup run offers to the engine. */
export type BackupSourceFile = {
  /** Where it sits in the snapshot. */
  treePath: readonly string[];
  /** Where it is on this server. */
  path: string;
  /** The content, when it is not the file's bytes as they are (the dump is stored uncompressed). */
  open?: () => AsyncIterable<Uint8Array>;
  /** The content's length, when `open` gives something other than the file's bytes. */
  size?: number;
  /**
   * A part of the backup this server makes itself (the dump, the catalog). The engine leaves a file it
   * cannot read out of the snapshot and carries on; without one of these the snapshot is not a backup, so
   * failing to read it stops the run.
   */
  required?: boolean;
};

/** A top-level folder of the snapshot. `files` may be made only when the engine gets to the folder. */
export type BackupSourceFolder = {
  name: string;
  files: readonly BackupSourceFile[] | (() => Promise<readonly BackupSourceFile[]>);
};

type Folder = { folders: Set<string>; files: Map<string, BackupSourceFile> };

/** Files looked at together when a folder is listed. */
const STAT_BATCH = 32;

/**
 * What a cloud backup run gives the engine to back up (FL-1676): not a folder on disk but the files the
 * run decided on, each at its place in the snapshot (see `cloud-backup-catalog.ts`). The engine walks it
 * like a file system, in the order the top-level folders were given, so the catalog can be made last, from
 * what the run saw of every file before it.
 *
 * While the engine reads, this keeps what the catalog needs: each file's size and time when its folder was
 * listed, the SHA-256 of everything that was read, and which files were not there. A file the engine takes
 * from the previous backup without reading it has no hash here; the run takes that from the previous catalog.
 *
 * ponytail: the whole list of files is held in memory, a few hundred bytes each. Past a few million files
 * this wants a table on disk (`node:sqlite`) instead.
 */
export class BackupSource implements Source {
  /** Size and modification time (ms) of every file that was there when its folder was listed, by tree key. */
  readonly listed = new Map<string, { size: number; mtime: number }>();
  /** What each file that was read to its end hashed to, by tree key. */
  readonly hashed = new Map<string, { sha256: string; size: number }>();
  /** Files the engine started to read. One of these without a hash could not be read to its end. */
  readonly opened = new Set<string>();
  /** Files that were gone when their folder was listed, by tree key. */
  readonly missing = new Set<string>();

  private folders = new Map<string, Folder>();
  private pending = new Map<string, () => Promise<readonly BackupSourceFile[]>>();
  private top: string[] = [];

  /**
   * `fail` stops the run. The engine treats a folder it cannot list as a problem to report and carries
   * on, which is right for a folder on disk and wrong for a part of the backup this server must make itself:
   * a snapshot without its catalog must never be written.
   */
  constructor(
    folders: readonly BackupSourceFolder[],
    private fail: (error: unknown) => void,
  ) {
    for (const { name, files } of folders) {
      if (this.top.includes(name)) {
        throw new Error(`A snapshot folder is given twice: ${name}`);
      }
      if (typeof files === 'function') {
        this.top.push(name);
        this.pending.set(name, files);
      } else if (files.length > 0) {
        this.top.push(name);
        this.add(name, files);
      }
    }
  }

  private add(top: string, files: readonly BackupSourceFile[]) {
    for (const file of files) {
      if (file.treePath[0] !== top || file.treePath.length < 2) {
        throw new Error(`A file does not belong in the snapshot folder ${top}`);
      }
      for (let depth = 1; depth < file.treePath.length; depth++) {
        const key = treeKey(file.treePath.slice(0, depth));
        let folder = this.folders.get(key);
        if (!folder) {
          folder = { folders: new Set(), files: new Map() };
          this.folders.set(key, folder);
        }
        const name = file.treePath[depth];
        if (depth === file.treePath.length - 1) {
          // The same file listed for two items (a path two rows name) is stored once.
          folder.files.set(name, file);
        } else {
          folder.folders.add(name);
        }
      }
    }
  }

  private async folder(path: string[]): Promise<Folder> {
    const make = this.pending.get(path[0]);
    if (make) {
      try {
        this.add(path[0], await make());
      } catch (error) {
        this.fail(error);
        throw error;
      }
      this.pending.delete(path[0]);
    }
    const folder = this.folders.get(treeKey(path));
    if (!folder) {
      throw new Error('No such folder in this backup run');
    }
    return folder;
  }

  async list(path: string[]): Promise<SourceEntry[]> {
    const virtual = (name: string): SourceEntry => ({
      name,
      type: 'dir',
      mode: 0o755,
      uid: 0,
      gid: 0,
      mtime: 0,
      size: 0,
    });
    if (path.length === 0) {
      return this.top.map((name) => virtual(name));
    }
    const folder = await this.folder(path);
    const entries: SourceEntry[] = [...folder.folders].toSorted(compareCodeUnits).map((name) => virtual(name));
    const files = [...folder.files].toSorted(([a], [b]) => compareCodeUnits(a, b));
    for (let at = 0; at < files.length; at += STAT_BATCH) {
      const looked = await Promise.all(
        files.slice(at, at + STAT_BATCH).map(async ([name, file]): Promise<SourceEntry | null> => {
          const key = treeKey([...path, name]);
          try {
            // Followed, as the library follows it: an original may be a link into another drive.
            const info = await stat(file.path);
            if (!info.isFile()) {
              return { ...virtual(name), type: 'file', unreadable: 'This is not a file' };
            }
            const size = file.size ?? info.size;
            const mtime = Math.floor(info.mtimeMs);
            this.listed.set(key, { size, mtime });
            return { name, type: 'file', mode: info.mode & 0o7777, uid: info.uid, gid: info.gid, mtime, size };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              this.missing.add(key);
              return null;
            }
            return { ...virtual(name), type: 'file', unreadable: (error as Error).message };
          }
        }),
      );
      entries.push(...looked.filter((entry): entry is SourceEntry => entry !== null));
    }
    return entries;
  }

  read(path: string[]): AsyncIterable<Uint8Array> {
    const file = this.folders.get(treeKey(path.slice(0, -1)))?.files.get(path.at(-1) ?? '');
    if (!file) {
      throw new Error('No such file in this backup run');
    }
    const key = treeKey(path);
    // A second read of a file that changed size replaces what the first one found, whatever it ends in.
    this.opened.add(key);
    this.hashed.delete(key);
    const { hashed, fail } = this;
    const content = file.open ?? (() => createReadStream(file.path, { highWaterMark: 1024 * 1024 }));
    return (async function* () {
      const hash = createHash('sha256');
      let size = 0;
      try {
        for await (const part of content()) {
          hash.update(part);
          size += part.length;
          yield part;
        }
      } catch (error) {
        if (file.required) {
          fail(error);
        }
        throw error;
      }
      hashed.set(key, { sha256: hash.digest('hex'), size });
    })();
  }
}

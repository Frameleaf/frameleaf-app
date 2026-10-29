import { Injectable } from '@nestjs/common';
import { Dirent, constants } from 'node:fs';
import { FileHandle, access, lstat, open, opendir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isSafeSegment } from 'src/utils/eagle-library.js';

/** The library's own lists can be large; an item's details are small. Anything bigger is not Eagle's. */
const LIBRARY_METADATA_MAX_BYTES = 64 * 1024 * 1024;
const ITEM_METADATA_MAX_BYTES = 4 * 1024 * 1024;
const FIND_MAX_DEPTH = 4;
const FIND_MAX_LIBRARIES = 200;
const FIND_MAX_DIRECTORIES = 20_000;
const READ_CONCURRENCY = 16;

/** One `images/<id>.info` folder: its id, its parsed `metadata.json` (undefined when unreadable) and its files. */
export interface EagleInfoFolder {
  id: string;
  metadata: unknown;
  fileNames: string[];
}

/** An item's file, opened for reading: the copy reads from this handle, the one that was checked. */
export interface EagleOpenFile {
  handle: FileHandle;
  size: number;
  modifiedAt: Date;
}

const isInside = (child: string, root: string) => child.startsWith(root + path.sep);

/**
 * The real path of an open file. On Linux the kernel says which file the descriptor holds; elsewhere
 * the path is resolved and must still be that same file (device and inode), or there is no answer.
 */
async function realPathOf(handle: FileHandle, filePath: string): Promise<string | undefined> {
  const info = await handle.stat();
  if (process.platform === 'linux') {
    const real = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => {});
    if (real) {
      return real;
    }
  }
  const real = await realpath(filePath).catch(() => {});
  if (!real) {
    return;
  }
  const now = await stat(real).catch(() => {});
  return now && now.dev === info.dev && now.ino === info.ino ? real : undefined;
}

const isLibraryName = (name: string) => name.toLowerCase().endsWith('.library');

/**
 * This server can't list a folder through the handle it checked (no `/proc/self/fd`, so not
 * Linux), so it refuses rather than list by name, which a swapped link could redirect.
 */
export class EagleListingUnavailableError extends Error {
  constructor() {
    super('Importing from a folder on the server isn’t available on this server');
    this.name = 'EagleListingUnavailableError';
  }
}

/**
 * FL-653: reads Eagle libraries in the folders an administrator allowed for imports
 * (`FRAMELEAF_IMPORT_ROOTS`). It only ever reads: nothing in an Eagle library is written, moved or
 * deleted. Links are never followed, so a library can't reach outside the folder it was found in;
 * every name it opens comes from a directory listing, never from a library's own JSON.
 */
@Injectable()
export class EagleLibraryRepository {
  /** Runs between a folder's check and its listing. Tests use it to swap the folder; nothing else sets it. */
  protected afterDirectoryCheck?: (directory: string) => Promise<void>;

  /** Whether this server can list folders through a checked handle (Linux, where Frameleaf runs). */
  async isAvailable(): Promise<boolean> {
    return (
      process.platform === 'linux' &&
      (await access('/proc/self/fd')
        .then(() => true)
        .catch(() => false))
    );
  }

  /**
   * Lists an open folder through its descriptor (`/proc/self/fd/<fd>`), never by its name (`_directory`
   * is only for tests that can't list a descriptor). Throws `EagleListingUnavailableError` where that
   * isn't possible; nothing falls back to a listing by name.
   */
  protected async listOpenDirectory(handle: FileHandle, _directory: string): Promise<Dirent[]> {
    if (process.platform !== 'linux') {
      throw new EagleListingUnavailableError();
    }
    const listing = await opendir(`/proc/self/fd/${handle.fd}`).catch(() => {
      throw new EagleListingUnavailableError();
    });
    const entries: Dirent[] = [];
    for await (const entry of listing) {
      entries.push(entry);
    }
    return entries;
  }

  /**
   * The entries of a folder that is exactly `expected`, listed through the handle that was checked.
   * The folder is opened without following a link and must be a directory whose real path is
   * `expected`; the listing then reads that very handle. A folder that fails the check has no
   * entries; a server that can't list through a handle refuses (`EagleListingUnavailableError`).
   */
  private async listDirectory(directory: string, expected: string): Promise<Dirent[]> {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(
      () => {},
    );
    if (!handle) {
      return [];
    }
    try {
      const before = await handle.stat();
      if (!before.isDirectory() || (await realPathOf(handle, directory)) !== expected) {
        return [];
      }
      await this.afterDirectoryCheck?.(directory);
      return await this.listOpenDirectory(handle, directory);
    } catch (error) {
      if (error instanceof EagleListingUnavailableError) {
        throw error;
      }
      return [];
    } finally {
      await handle.close();
    }
  }

  /** `.library` folders below `root`, as paths relative to it, a few levels deep. */
  async findLibraries(root: string): Promise<string[]> {
    const realRoot = await realpath(root);
    const found: string[] = [];
    let visited = 0;
    const walk = async (directory: string, depth: number) => {
      if (depth > FIND_MAX_DEPTH || found.length >= FIND_MAX_LIBRARIES || visited >= FIND_MAX_DIRECTORIES) {
        return;
      }
      visited++;
      const entries = await this.listDirectory(directory, directory);
      for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
        // Hidden folders (the NAS's own, `.Trash`, `@eaDir`) and links are left alone.
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('@')) {
          continue;
        }
        const full = path.join(directory, entry.name);
        // Checked again here: a folder swapped for a link after it was listed is not followed.
        if ((await realpath(full).catch(() => {})) !== full) {
          continue;
        }
        if (isLibraryName(entry.name)) {
          if (await this.isRegularFile(path.join(full, 'metadata.json'))) {
            found.push(path.relative(realRoot, full));
          }
        } else {
          await walk(full, depth + 1);
        }
        if (found.length >= FIND_MAX_LIBRARIES) {
          return;
        }
      }
    };
    await walk(realRoot, 0);
    return found;
  }

  /** The library's `metadata.json`, parsed; undefined when it is missing or not JSON. */
  async readLibraryMetadata(library: string): Promise<unknown> {
    return this.readJson(path.join(library, 'metadata.json'), LIBRARY_METADATA_MAX_BYTES, library);
  }

  /** Every `images/<id>.info` folder with its details and the names of its files, sorted by id. */
  async readInfoFolders(library: string): Promise<EagleInfoFolder[]> {
    const realLibrary = await realpath(library).catch(() => {});
    if (!realLibrary) {
      return [];
    }
    const images = path.join(realLibrary, 'images');
    const folders = (await this.listDirectory(images, images))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.info') && isSafeSegment(entry.name))
      .map((entry) => entry.name)
      .toSorted((a, b) => a.localeCompare(b));
    const result = Array.from<EagleInfoFolder>({ length: folders.length });
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(READ_CONCURRENCY, folders.length) }, async () => {
        while (next < folders.length) {
          const index = next++;
          const name = folders[index];
          const folder = path.join(images, name);
          const entries = await this.listDirectory(folder, folder);
          result[index] = {
            id: name.slice(0, -'.info'.length),
            metadata: await this.readJson(path.join(folder, 'metadata.json'), ITEM_METADATA_MAX_BYTES, library),
            fileNames: entries
              .filter((entry) => entry.isFile() && isSafeSegment(entry.name))
              .map((entry) => entry.name),
          };
        }
      }),
    );
    return result;
  }

  /**
   * Opens an item's file for reading. The id and file name must each be one plain name (they come
   * from the library's folder listing); the file must be a regular file, opened without following a
   * link, and the file the handle holds must be inside the library. Undefined otherwise.
   */
  async openItemFile(library: string, id: string, fileName: string): Promise<EagleOpenFile | undefined> {
    if (!isSafeSegment(`${id}.info`) || !isSafeSegment(fileName)) {
      return;
    }
    return this.openInside(path.join(library, 'images', `${id}.info`, fileName), library);
  }

  /** A regular file inside `within`, opened without following a link and checked through its handle. */
  private async openInside(filePath: string, within: string): Promise<EagleOpenFile | undefined> {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {});
    if (!handle) {
      return;
    }
    try {
      const info = await handle.stat();
      const real = info.isFile() ? await realPathOf(handle, filePath) : undefined;
      const root = await realpath(within);
      if (real && isInside(real, root)) {
        return { handle, size: info.size, modifiedAt: info.mtime };
      }
    } catch {
      // Treated as not there.
    }
    await handle.close();
  }

  private async isRegularFile(filePath: string) {
    return (await lstat(filePath).catch(() => {}))?.isFile() ?? false;
  }

  /** JSON read through the checked handle, so a file swapped for a link after the check is never read. */
  private async readJson(filePath: string, maxBytes: number, within: string): Promise<unknown> {
    const file = await this.openInside(filePath, within);
    if (!file) {
      return undefined;
    }
    try {
      if (file.size > maxBytes) {
        return undefined;
      }
      // A FileHandle, not a path: the rule's string form is the same read through the checked descriptor.
      // eslint-disable-next-line unicorn/consistent-json-file-read
      const content = await file.handle.readFile({ encoding: 'utf8' });
      return JSON.parse(content) as unknown;
    } catch {
      return undefined;
    } finally {
      await file.handle.close();
    }
  }
}

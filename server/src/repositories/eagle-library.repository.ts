import { Injectable } from '@nestjs/common';
import { Dirent } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

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

const isLibraryName = (name: string) => name.toLowerCase().endsWith('.library');

/**
 * FL-653: reads Eagle libraries in the folders an administrator allowed for imports
 * (`FRAMELEAF_IMPORT_ROOTS`). It only ever reads: nothing in an Eagle library is written, moved or
 * deleted. Links are never followed, so a library can't reach outside the folder it was found in;
 * every name it opens comes from a directory listing, never from a library's own JSON.
 */
@Injectable()
export class EagleLibraryRepository {
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
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [] as Dirent[]);
      for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
        // Hidden folders (the NAS's own, `.Trash`, `@eaDir`) and links are left alone.
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('@')) {
          continue;
        }
        const full = path.join(directory, entry.name);
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
    return this.readJson(path.join(library, 'metadata.json'), LIBRARY_METADATA_MAX_BYTES);
  }

  /** Every `images/<id>.info` folder with its details and the names of its files, sorted by id. */
  async readInfoFolders(library: string): Promise<EagleInfoFolder[]> {
    const images = path.join(library, 'images');
    const info = await lstat(images).catch(() => {});
    if (!info?.isDirectory()) {
      return [];
    }
    const folders = (await readdir(images, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.info'))
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
          const entries = await readdir(folder, { withFileTypes: true }).catch(() => [] as Dirent[]);
          result[index] = {
            id: name.slice(0, -'.info'.length),
            metadata: await this.readJson(path.join(folder, 'metadata.json'), ITEM_METADATA_MAX_BYTES),
            fileNames: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
          };
        }
      }),
    );
    return result;
  }

  /** The path of an item's file, from names its folder listing gave. */
  itemFilePath(library: string, id: string, fileName: string) {
    return path.join(library, 'images', `${id}.info`, fileName);
  }

  /** Size and last change of a regular file reached without a link; undefined otherwise. */
  async statFile(filePath: string): Promise<{ size: number; modifiedAt: Date } | undefined> {
    const info = await lstat(filePath).catch(() => {});
    return info?.isFile() ? { size: info.size, modifiedAt: info.mtime } : undefined;
  }

  private async isRegularFile(filePath: string) {
    return (await lstat(filePath).catch(() => {}))?.isFile() ?? false;
  }

  private async readJson(filePath: string, maxBytes: number): Promise<unknown> {
    const info = await lstat(filePath).catch(() => {});
    if (!info?.isFile() || info.size > maxBytes) {
      return undefined;
    }
    try {
      return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  }
}

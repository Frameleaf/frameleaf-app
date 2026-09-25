import { Injectable } from '@nestjs/common';
import archiver from 'archiver';
import { ChokidarOptions, watch as chokidarWatch } from 'chokidar';
import fastGlob from 'fast-glob';
import {
  Dirent,
  ReadOptionsWithBuffer,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  watch,
} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { CrawlOptionsDto, WalkOptionsDto } from 'src/dtos/library.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { mimeTypes } from 'src/utils/mime-types.js';

export interface WatchEvents {
  onReady(): void;
  onAdd(path: string): void;
  onChange(path: string): void;
  onUnlink(path: string): void;
  onError(error: Error): void;
}

export interface ImmichReadStream {
  stream: Readable;
  type?: string;
  disposition?: string | string[];
  length?: number;
}

export interface ImmichZipStream extends ImmichReadStream {
  addFile: (inputPath: string, filename: string) => void;
  finalize: () => Promise<void>;
}

/**
 * A zip stream that can be filled one entry at a time (FL-54): `whenIdle` resolves once every entry added
 * so far has been written into the archive (so as fast as the client reads it), or once the archive has
 * been closed or has failed, so a producer never prepares more than the reader has consumed.
 */
export interface ImmichPacedZipStream extends ImmichZipStream {
  addBuffer: (content: Buffer, filename: string) => void;
  whenIdle: () => Promise<void>;
  /** true once the archive was closed, destroyed or failed before being finalized */
  isClosed: () => boolean;
}

export interface DiskUsage {
  available: number;
  free: number;
  total: number;
}

export type StorageWalkCursor = Array<{ path: string; after?: string }>;

@Injectable()
export class StorageRepository {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(StorageRepository.name);
  }

  realpath(filepath: string) {
    return fs.realpath(filepath);
  }

  readdir(folder: string): Promise<string[]> {
    return fs.readdir(folder);
  }

  readdirWithTypes(folder: string): Promise<Dirent[]> {
    return fs.readdir(folder, { withFileTypes: true });
  }

  copyFile(source: string, target: string) {
    return fs.copyFile(source, target);
  }

  stat(filepath: string) {
    return fs.stat(filepath);
  }

  createFile(filepath: string, buffer: Buffer) {
    return fs.writeFile(filepath, buffer, { flag: 'wx' });
  }

  createWriteStream(filepath: string): Writable {
    return createWriteStream(filepath, { flags: 'w', flush: true });
  }

  createOrOverwriteFile(filepath: string, buffer: Buffer) {
    return fs.writeFile(filepath, buffer, { flag: 'w' });
  }

  overwriteFile(filepath: string, buffer: Buffer) {
    return fs.writeFile(filepath, buffer, { flag: 'r+' });
  }

  rename(source: string, target: string) {
    return fs.rename(source, target);
  }

  utimes(filepath: string, atime: Date, mtime: Date) {
    return fs.utimes(filepath, atime, mtime);
  }

  createZipStream(): ImmichZipStream {
    const archive = archiver('zip', { store: true });

    const addFile = (input: string, filename: string) => {
      archive.file(input, { name: filename, mode: 0o644 });
    };

    const finalize = () => archive.finalize();

    return { stream: archive, addFile, finalize };
  }

  createPacedZipStream(): ImmichPacedZipStream {
    const archive = archiver('zip', { store: true });
    let pending = 0;
    let closed = false;
    let waiters: Array<() => void> = [];
    const wake = () => {
      if (!(pending === 0 || closed)) {
        return;
      }

      const ready = waiters;
      waiters = [];
      for (const resolve of ready) {
        resolve();
      }
    };

    archive.on('entry', () => {
      pending = Math.max(0, pending - 1);
      wake();
    });
    // a reader that goes away destroys the stream ('close'); a failing entry errors it
    for (const event of ['close', 'error'] as const) {
      archive.on(event, () => {
        closed = true;
        wake();
      });
    }

    return {
      stream: archive,
      addFile: (input: string, filename: string) => {
        pending++;
        archive.file(input, { name: filename, mode: 0o644 });
      },
      addBuffer: (content: Buffer, filename: string) => {
        pending++;
        archive.append(content, { name: filename, mode: 0o644 });
      },
      finalize: () => archive.finalize(),
      whenIdle: () =>
        pending === 0 || closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              waiters.push(resolve);
            }),
      isClosed: () => closed || archive.destroyed,
    };
  }

  createGzip(): PassThrough {
    return createGzip();
  }

  createGunzip(): PassThrough {
    return createGunzip();
  }

  createPlainReadStream(filepath: string): Readable {
    return createReadStream(filepath);
  }

  async createReadStream(filepath: string, mimeType?: string | null): Promise<ImmichReadStream> {
    const { size } = await fs.stat(filepath);
    await fs.access(filepath, constants.R_OK);
    return {
      stream: createReadStream(filepath),
      length: size,
      type: mimeType || undefined,
    };
  }

  async readFile(filepath: string, options?: ReadOptionsWithBuffer<Buffer>): Promise<Buffer> {
    // read a slice
    if (options) {
      const file = await fs.open(filepath);
      try {
        const { buffer } = await file.read(options);
        return buffer as Buffer;
      } finally {
        await file.close();
      }
    }

    // read everything
    return fs.readFile(filepath);
  }

  /**
   * Positional reads from one open file, for formats read from the end first (a ZIP's central
   * directory). Each read returns exactly the bytes that exist, never a zero-filled tail. The caller
   * closes the handle.
   */
  async openForRandomRead(filepath: string): Promise<{
    size: number;
    read: (position: number, length: number) => Promise<Buffer>;
    close: () => Promise<void>;
  }> {
    const handle = await fs.open(filepath, 'r');
    try {
      const { size } = await handle.stat();
      return {
        size,
        read: async (position: number, length: number) => {
          const buffer = Buffer.alloc(Math.max(0, length));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          return buffer.subarray(0, bytesRead);
        },
        close: () => handle.close(),
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async readJsonFile<T>(filepath: string): Promise<T> {
    const file = await fs.readFile(filepath, 'utf8');
    return JSON.parse(file) as T;
  }

  async checkFileExists(filepath: string, mode = constants.F_OK): Promise<boolean> {
    try {
      await fs.access(filepath, mode);
      return true;
    } catch {
      return false;
    }
  }

  async unlink(file: string) {
    try {
      await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.logger.warn(`File ${file} does not exist.`);
      } else {
        throw error;
      }
    }
  }

  async unlinkDir(folder: string, options: { recursive?: boolean; force?: boolean }) {
    await fs.rm(folder, { ...options, maxRetries: 5, retryDelay: 100 });
  }

  async removeEmptyDirs(directory: string, self: boolean = false) {
    // lstat does not follow symlinks (in contrast to stat)
    const stats = await fs.lstat(directory);
    if (!stats.isDirectory()) {
      return;
    }

    const files = await fs.readdir(directory);
    await Promise.all(files.map((file) => this.removeEmptyDirs(path.join(directory, file), true)));

    if (self) {
      const updated = await fs.readdir(directory);
      if (updated.length === 0) {
        try {
          await fs.rmdir(directory);
        } catch (error: any) {
          if (error.code !== 'ENOTEMPTY') {
            this.logger.warn(`Attempted to remove directory, but failed: ${error}`);
          }
        }
      }
    }
  }

  mkdirSync(filepath: string): void {
    if (!existsSync(filepath)) {
      mkdirSync(filepath, { recursive: true });
    }
  }

  existsSync(filepath: string) {
    return existsSync(filepath);
  }

  async checkDiskUsage(folder: string): Promise<DiskUsage> {
    const stats = await fs.statfs(folder);
    return {
      available: stats.bavail * stats.bsize,
      free: stats.bfree * stats.bsize,
      total: stats.blocks * stats.bsize,
    };
  }

  /**
   * The bytes of every regular file under a folder, symbolic links not followed (FL-79: the
   * nightly analytics collector's generated-file sizes). A missing folder is empty.
   */
  async getFolderBytes(folder: string, concurrency = 16): Promise<number> {
    const sizeOf = async (file: string) => {
      try {
        return (await fs.lstat(file)).size;
      } catch (error: any) {
        // a file removed while the folder is read no longer counts
        if (error?.code === 'ENOENT') {
          return 0;
        }
        throw error;
      }
    };
    let total = 0;
    const pending = [folder];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error: any) {
        if (error?.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      const files: string[] = [];
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else if (entry.isFile()) {
          files.push(entryPath);
        }
      }
      // a small, bounded number of lstat calls at once
      for (let index = 0; index < files.length; index += concurrency) {
        const sizes = await Promise.all(files.slice(index, index + concurrency).map((file) => sizeOf(file)));
        total += sizes.reduce((sum, size) => sum + size, 0);
      }
    }
    return total;
  }

  /**
   * Every non-directory entry under `folder`, depth first, symbolic links listed but never followed
   * (FL-44: user deletion checks each file's references before removing it). A missing folder is
   * empty. Matching is exact — unlike `walk`, no glob and no case folding reaches a sibling folder.
   */
  async *walkFiles(folder: string): AsyncGenerator<string> {
    const pending = [folder];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error: any) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          continue;
        }
        throw error;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else {
          yield entryPath;
        }
      }
    }
  }

  /** The device a path lives on (`stat.dev`), or null when it cannot be read. */
  async getDevice(filepath: string): Promise<number | null> {
    try {
      return (await fs.stat(filepath)).dev;
    } catch {
      return null;
    }
  }

  crawl(crawlOptions: CrawlOptionsDto): Promise<string[]> {
    const { pathsToCrawl, exclusionPatterns, includeHidden } = crawlOptions;
    if (pathsToCrawl.length === 0) {
      return Promise.resolve([]);
    }

    const globbedPaths = pathsToCrawl.map((path) => this.asGlob(path));

    // eslint-disable-next-line import-x/no-named-as-default-member
    return fastGlob.glob(globbedPaths, {
      absolute: true,
      caseSensitiveMatch: false,
      onlyFiles: true,
      dot: includeHidden,
      ignore: exclusionPatterns,
    });
  }

  async *walk(walkOptions: WalkOptionsDto): AsyncGenerator<string[]> {
    const { pathsToCrawl, exclusionPatterns, includeHidden } = walkOptions;
    if (pathsToCrawl.length === 0) {
      async function* emptyGenerator() {}
      return emptyGenerator();
    }

    const globbedPaths = pathsToCrawl.map((path) => this.asGlob(path));

    // eslint-disable-next-line import-x/no-named-as-default-member
    const stream = fastGlob.globStream(globbedPaths, {
      absolute: true,
      caseSensitiveMatch: false,
      onlyFiles: true,
      dot: includeHidden,
      ignore: exclusionPatterns,
    });

    let batch: string[] = [];
    for await (const value of stream) {
      batch.push(value.toString());
      if (batch.length === walkOptions.take) {
        yield batch;
        batch = [];
      }
    }

    if (batch.length > 0) {
      yield batch;
    }
  }

  /** Resume a sorted depth-first traversal. The caller persists the mutated cursor between batches. */
  async *walkWithCursor(cursor: StorageWalkCursor, maxEntries: number): AsyncGenerator<string> {
    let visited = 0;
    const directoryEntries = new Map<string, Dirent[]>();
    while (cursor.length > 0) {
      const directory = cursor.at(-1)!;
      let entries = directoryEntries.get(directory.path);
      try {
        if (!entries) {
          entries = await fs.readdir(directory.path, { withFileTypes: true });
          // Keep ordering identical to the cursor's ordinal comparison, including distinct Unicode names.
          // eslint-disable-next-line unicorn/prefer-simple-sort-comparator
          entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          directoryEntries.set(directory.path, entries);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        cursor.pop();
        continue;
      }
      let descended = false;
      for (const entry of entries) {
        if (directory.after !== undefined && entry.name <= directory.after) {
          continue;
        }
        if (visited++ >= maxEntries) {
          return;
        }
        directory.after = entry.name;
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
          continue;
        }
        const entryPath = path.join(directory.path, entry.name);
        if (entry.isDirectory()) {
          cursor.push({ path: entryPath });
          descended = true;
          break;
        }
        if (entry.isFile()) {
          yield entryPath;
        }
      }
      if (!descended) {
        directoryEntries.delete(directory.path);
        cursor.pop();
      }
    }
  }

  watch(paths: string[], options: ChokidarOptions, events: Partial<WatchEvents>) {
    const watcher = chokidarWatch(paths, options);

    watcher.on('ready', () => events.onReady?.());
    watcher.on('add', (path) => events.onAdd?.(path));
    watcher.on('change', (path) => events.onChange?.(path));
    watcher.on('unlink', (path) => events.onUnlink?.(path));
    watcher.on('error', (error) => events.onError?.(error as Error));

    return () => watcher.close();
  }

  watchDir = watch; // Native fs.watch without chokidar overhead

  private asGlob(pathToCrawl: string): string {
    // eslint-disable-next-line import-x/no-named-as-default-member
    const escapedPath = fastGlob
      .escapePath(pathToCrawl)
      .replaceAll('"', '["]')
      .replaceAll("'", "[']")
      .replaceAll('`', '[`]');
    const extensions = `*{${mimeTypes.getSupportedFileExtensions().join(',')}}`;
    return `${escapedPath}/**/${extensions}`;
  }
}

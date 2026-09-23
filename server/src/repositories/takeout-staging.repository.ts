import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';
import type { TakeoutSource } from 'src/repositories/takeout.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { compareCodeUnits } from 'src/utils/compare.js';
import {
  TakeoutZipEntry,
  TakeoutZipSource,
  readTakeoutZipDirectory,
  takeoutZipDataOffset,
} from 'src/utils/takeout-zip.js';

/** Upload chunk size the web client uses and the server accepts at most. */
export const TAKEOUT_CHUNK_BYTES = 8 * 1024 * 1024;
/** Space left free on the staging volume, beyond what a file or archive needs. */
export const TAKEOUT_STAGING_RESERVE_BYTES = 1024 * 1024 * 1024;
/** Sidecars larger than this are not Takeout photo metadata and are not read. */
export const TAKEOUT_SIDECAR_MAX_BYTES = 4 * 1024 * 1024;

/** A problem the owner can act on (the archive differs, the offset is wrong); the service answers 400. */
export class TakeoutStagingError extends Error {}

export type StagedDigest = { size: number; checksum: Buffer; legacyChecksum: Buffer };

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

/** Counts, hashes both digests and refuses more bytes than were declared, as the bytes pass. */
const digesting = (declared: number, onProgress?: (bytes: number) => void) => {
  const sha256 = createHash('sha256');
  const sha1 = createHash('sha1');
  let size = 0;
  let crc = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > declared) {
        callback(new TakeoutStagingError('A file holds more data than its archive declared'));
        return;
      }
      sha256.update(chunk);
      sha1.update(chunk);
      crc = crc32(chunk, crc);
      onProgress?.(size);
      callback(null, chunk);
    },
  });
  return {
    transform,
    result: () => ({ size, crc, checksum: sha256.digest(), legacyChecksum: sha1.digest() }),
  };
};

/**
 * The filesystem side of Google Photos imports (FL-65).
 *
 * Staged copies live under `<media>/takeout/<owner>/<import>/` with opaque generated names: an
 * archive as `<source id>.zip`, each extracted or copied file as its file id. No name from an
 * archive or a selected directory is ever used as a destination path. A server directory can only be
 * read when it lies under one of the roots the administrator configured (`IMMICH_IMPORT_ROOTS`), and
 * it is walked without following links.
 */
@Injectable()
export class TakeoutStagingRepository {
  root() {
    return path.resolve(StorageCore.getMediaLocation(), 'takeout');
  }

  directory(ownerId: string, importId: string) {
    if (!UUID.test(ownerId) || !UUID.test(importId)) {
      throw new Error('Invalid staging identity');
    }
    return path.join(this.root(), ownerId, importId);
  }

  async prepare(ownerId: string, importId: string) {
    const directory = this.directory(ownerId, importId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  async removeImport(ownerId: string, importId: string) {
    await rm(this.directory(ownerId, importId), { recursive: true, force: true });
  }

  async removeOwner(ownerId: string) {
    if (!UUID.test(ownerId)) {
      throw new Error('Invalid staging owner');
    }
    await rm(path.join(this.root(), ownerId), { recursive: true, force: true });
  }

  /** Bytes an unprivileged process may still write to the volume holding `directory`. */
  async freeBytes(directory: string) {
    const stats = await statfs(directory);
    return stats.bavail * stats.bsize;
  }

  async remove(filePath: string) {
    await rm(filePath, { force: true });
  }

  /* ------------------------------------------------------------------ */
  /* Server directories                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve a directory the administrator picked: `relative` inside the configured root `root`. The
   * result must exist, be a real directory reached without a link, stay inside the root, and not
   * overlap the library's own storage. Throws `TakeoutStagingError` otherwise.
   */
  async resolveDirectory(root: string, relative: string): Promise<string> {
    if (relative.includes('\0') || path.isAbsolute(relative)) {
      throw new TakeoutStagingError('Choose a folder inside the permitted import location');
    }
    const realRoot = await realpath(root).catch(() => {
      throw new TakeoutStagingError('The permitted import location is not available on the server');
    });
    const candidate = path.resolve(realRoot, relative || '.');
    if (candidate !== realRoot && !candidate.startsWith(realRoot + path.sep)) {
      throw new TakeoutStagingError('Choose a folder inside the permitted import location');
    }
    const info = await lstat(candidate).catch(() => {
      throw new TakeoutStagingError('That folder does not exist on the server');
    });
    if (!info.isDirectory()) {
      throw new TakeoutStagingError('Choose an existing folder, not a file or a link');
    }
    const resolved = await realpath(candidate);
    if (resolved !== candidate) {
      throw new TakeoutStagingError('Choose a folder that is not reached through a link');
    }
    const storage = await realpath(StorageCore.getMediaLocation());
    if (resolved === storage || storage.startsWith(resolved + path.sep) || resolved.startsWith(storage + path.sep)) {
      throw new TakeoutStagingError('Choose a folder outside the library’s own storage');
    }
    return resolved;
  }

  /** The folder still lies inside one of the permitted roots (they may have changed since it was chosen). */
  async isInsideRoots(directory: string, roots: readonly string[]): Promise<boolean> {
    for (const root of roots) {
      const realRoot = await realpath(root).catch(() => {});
      if (realRoot && (directory === realRoot || directory.startsWith(realRoot + path.sep))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Every regular file below a selected directory, depth first, as `(entry name, absolute path,
   * size, modified time)`. Links are refused, not followed; a directory that changed into a link
   * since it was selected stops the walk.
   */
  async *walk(
    directory: string,
    signal: AbortSignal,
  ): AsyncGenerator<{
    entryName: string;
    filePath: string;
    size: number;
    modifiedAt: Date;
    link: boolean;
    /** Device and inode the walk saw, so the read can prove it opened the same file. */
    dev: number;
    ino: number;
  }> {
    if ((await realpath(directory)) !== directory) {
      throw new TakeoutStagingError('The selected folder changed on the server; select it again');
    }
    const pending: Array<{ directory: string; prefix: string }> = [{ directory, prefix: '' }];
    while (pending.length > 0) {
      const next = pending.pop()!;
      const entries = await readdir(next.directory, { withFileTypes: true });
      entries.sort((a, b) => compareCodeUnits(b.name, a.name));
      for (const entry of entries) {
        signal.throwIfAborted();
        const filePath = path.join(next.directory, entry.name);
        const entryName = next.prefix + entry.name;
        if (entry.isSymbolicLink()) {
          yield { entryName, filePath, size: 0, modifiedAt: new Date(0), link: true, dev: 0, ino: 0 };
          continue;
        }
        if (entry.isDirectory()) {
          pending.push({ directory: filePath, prefix: `${entryName}/` });
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const info = await lstat(filePath);
        yield {
          entryName,
          filePath,
          size: info.size,
          modifiedAt: info.mtime,
          link: false,
          dev: info.dev,
          ino: info.ino,
        };
      }
    }
  }

  /**
   * Copy one file from a selected directory into staging, hashing it as it goes. The source is
   * reopened by its real path and must still be the plain file inside the directory that was walked.
   */
  async stageFile(
    directory: string,
    file: { filePath: string; size: number; dev: number; ino: number },
    destination: string,
    signal: AbortSignal,
  ): Promise<StagedDigest> {
    const { filePath, size: declared } = file;
    const actual = await realpath(filePath);
    if (actual !== filePath || !actual.startsWith(directory + path.sep)) {
      throw new TakeoutStagingError('A file changed into a link while it was being read');
    }
    // Opened without following a link, and checked on the open handle, so the file cannot be
    // swapped for a link between the check above and the read.
    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
      throw new TakeoutStagingError('A file changed into a link while it was being read');
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new TakeoutStagingError('Only plain files can be imported from a server folder');
      }
      // The same file the walk found: a parent folder swapped for a link since then leads elsewhere.
      if (info.dev !== file.dev || info.ino !== file.ino) {
        throw new TakeoutStagingError('A file changed while it was being read');
      }
    } catch (error) {
      await handle.close();
      throw error;
    }
    const stream = handle.createReadStream({ autoClose: true });
    try {
      return await this.writeStaged(() => Promise.resolve(stream), declared, destination, signal);
    } finally {
      // Closes the handle whether or not the copy got as far as reading it.
      stream.destroy();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Archives                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Append an uploaded chunk at `offset`. A chunk entirely before the current offset is compared
   * with what is staged instead, so a retried request is harmless and a different archive is caught.
   * Returns the new staged length.
   */
  async writeChunk(source: TakeoutSource, offset: number, bytes: Buffer): Promise<number> {
    if (bytes.length === 0 || bytes.length > TAKEOUT_CHUNK_BYTES || offset + bytes.length > source.size) {
      throw new TakeoutStagingError('An upload chunk must hold 1 byte to 8 MiB and fit the archive’s size');
    }
    const file = await open(source.path, 'r+').catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' || source.received !== 0) {
        throw error;
      }
      await mkdir(path.dirname(source.path), { recursive: true, mode: 0o700 });
      return open(source.path, 'wx+', 0o600);
    });
    try {
      if (offset < source.received && offset + bytes.length <= source.received) {
        const existing = Buffer.alloc(bytes.length);
        const { bytesRead } = await file.read(existing, 0, bytes.length, offset);
        if (bytesRead !== bytes.length || !existing.equals(bytes)) {
          throw new TakeoutStagingError('This is not the archive that was being uploaded');
        }
        return source.received;
      }
      if (offset !== source.received) {
        throw new TakeoutStagingError(`Resume this archive at byte ${source.received}`);
      }
      let written = 0;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, offset + written);
        if (!result.bytesWritten) {
          throw new Error('Archive staging stopped writing');
        }
        written += result.bytesWritten;
      }
      await file.truncate(offset + bytes.length);
      await file.sync();
      return offset + bytes.length;
    } finally {
      await file.close();
    }
  }

  /** Compare a range the browser is about to resume after with what is staged. */
  async verifyChunk(source: TakeoutSource, offset: number, size: number, sha256: string) {
    if (offset + size > source.received) {
      throw new TakeoutStagingError('That part of the archive has not been uploaded yet');
    }
    const file = await open(source.path, 'r');
    try {
      const bytes = Buffer.alloc(size);
      const { bytesRead } = await file.read(bytes, 0, size, offset);
      if (bytesRead !== size || createHash('sha256').update(bytes).digest('hex') !== sha256) {
        throw new TakeoutStagingError(
          'The selected archive differs from the one being uploaded. Select the original archive to resume.',
        );
      }
    } finally {
      await file.close();
    }
  }

  /** Open a staged archive for reading its directory and entries. The caller closes it. */
  async openArchive(archivePath: string): Promise<{ source: TakeoutZipSource; close: () => Promise<void> }> {
    const handle = await open(archivePath, 'r');
    try {
      const { size } = await handle.stat();
      return {
        source: {
          size,
          read: async (position, length) => {
            const buffer = Buffer.alloc(Math.max(0, length));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            return buffer.subarray(0, bytesRead);
          },
        },
        close: () => handle.close(),
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  readArchiveDirectory(source: TakeoutZipSource): Promise<TakeoutZipEntry[]> {
    return readTakeoutZipDirectory(source);
  }

  /**
   * Extract one archive entry into staging, inflating as a stream. The byte count must equal the
   * declared size and the CRC must match, or the partial copy is removed and the entry refused.
   */
  async stageArchiveEntry(
    archivePath: string,
    source: TakeoutZipSource,
    entry: TakeoutZipEntry,
    destination: string,
    signal: AbortSignal,
  ): Promise<StagedDigest> {
    const start = await takeoutZipDataOffset(source, entry);
    const openEntryNow = (): Readable => {
      const raw =
        entry.compressedSize === 0
          ? Readable.from([])
          : createReadStream(archivePath, { start, end: start + entry.compressedSize - 1 });
      if (entry.compression === 'store') {
        return raw;
      }
      const inflate = createInflateRaw();
      raw.on('error', (error: Error) => inflate.destroy(error));
      return raw.pipe(inflate);
    };
    // Deferred like an async function, so a synchronous failure to open still arrives as a rejection.
    const openEntry = () => Promise.try(openEntryNow);
    return this.writeStaged(openEntry, entry.uncompressedSize, destination, signal, entry.crc32);
  }

  /** Read a staged sidecar as JSON; undefined for anything that is not readable JSON of a sane size. */
  async readSidecar(filePath: string): Promise<unknown> {
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.size > TAKEOUT_SIDECAR_MAX_BYTES) {
        return undefined;
      }
      return JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      return undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Import                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Copy a staged file to its place in the library's upload folder. The copy is hashed as it is
   * written and must match what the scan recorded; the staged file is left untouched until the
   * caller removes it. The destination must not exist yet.
   */
  async copyToLibrary(
    staged: string,
    declared: number,
    destination: string,
    signal: AbortSignal,
  ): Promise<StagedDigest> {
    await mkdir(path.dirname(destination), { recursive: true });
    const digest = digesting(declared);
    try {
      await pipeline(
        createReadStream(staged),
        digest.transform,
        createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
    const { size, checksum, legacyChecksum } = digest.result();
    if (size !== declared) {
      await rm(destination, { force: true });
      throw new TakeoutStagingError('A staged file changed after it was scanned');
    }
    return { size, checksum, legacyChecksum };
  }

  /**
   * Stream `openSource()` into `destination` through a temporary file, renamed into place only when the
   * whole file arrived intact, so a crash never leaves a half-written file under a recorded name.
   */
  private async writeStaged(
    openSource: () => Promise<Readable>,
    declared: number,
    destination: string,
    signal: AbortSignal,
    expectedCrc?: number,
  ): Promise<StagedDigest> {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.part`;
    const digest = digesting(declared);
    try {
      await pipeline(await openSource(), digest.transform, createWriteStream(temporary, { mode: 0o600, flags: 'w' }), {
        signal,
      });
      const { size, crc, checksum, legacyChecksum } = digest.result();
      if (size !== declared || (expectedCrc !== undefined && crc !== expectedCrc)) {
        throw new TakeoutStagingError('An archive entry is damaged');
      }
      await rename(temporary, destination);
      return { size, checksum, legacyChecksum };
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

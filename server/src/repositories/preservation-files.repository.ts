import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import {
  PRESERVATION_METADATA_PREFIX,
  PRESERVATION_ORIGINALS_PREFIX,
  PRESERVATION_ZIP_LIMITS,
  PreservationPackageError,
  preservationArchiveCode,
} from 'src/utils/preservation.js';
import {
  StudioBundleArchiveError,
  ZipByteSource,
  ZipDirectory,
  digestZipEntry,
  readZipDirectory,
  readZipEntry,
  zipEntryNameProblem,
} from 'src/utils/studio-bundle.js';

/** An owner's exported packages, under their private exports folder: outside every served folder. */
export const preservationFolder = (ownerId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), 'preservation');

/** Where multer writes an owner's uploaded package before its manifest is read. */
export const preservationUploadFolder = (ownerId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), 'preservation-uploads');

/** The digests of one entry, measured as it was read. */
export type PreservationDigests = { sha1: string; sha256: string; bytes: number };

/**
 * One package opened for reading, whichever form it has. Every read is confined to the package:
 * entry names are checked before they are used, a directory member may not be a symbolic link at
 * any level, and a ZIP entry is read through the FL-91 reader with the package limits.
 */
export interface PreservationPackageSource {
  readonly format: 'directory' | 'zip';
  /** Every entry the package holds, for finding what its manifest does not account for. */
  listEntries(): Promise<string[]>;
  has(name: string): Promise<boolean>;
  /** A document, whole. Refuses more than `maxBytes`. */
  readDocument(name: string, maxBytes: number): Promise<Buffer>;
  /** Stream one entry through SHA-1 and SHA-256, handing each chunk to `onData`. */
  stream(name: string, onData?: (chunk: Buffer) => void | Promise<void>): Promise<PreservationDigests>;
  close(): Promise<void>;
}

const missing = (name: string) =>
  new PreservationPackageError('package_entry_missing', `${name.slice(0, 80)} is not in the package`);

const checkName = (name: string) => {
  const problem = zipEntryNameProblem(name);
  if (problem) {
    throw new PreservationPackageError('package_entry_name', problem);
  }
};

/** A package ZIP: the FL-91 reader with ZIP64 and the package limits. */
class ZipPackageSource implements PreservationPackageSource {
  readonly format = 'zip' as const;

  constructor(
    private source: ZipByteSource,
    private directory: ZipDirectory,
    private closer: () => Promise<void>,
  ) {}

  listEntries() {
    return Promise.resolve(this.directory.entries.map((entry) => entry.name));
  }

  has(name: string) {
    return Promise.resolve(this.directory.byName.has(name));
  }

  async readDocument(name: string, maxBytes: number) {
    checkName(name);
    const entry = this.directory.byName.get(name);
    if (!entry) {
      throw missing(name);
    }
    return wrapArchive(() => readZipEntry(this.source, entry, maxBytes));
  }

  async stream(name: string, onData?: (chunk: Buffer) => void | Promise<void>) {
    checkName(name);
    const entry = this.directory.byName.get(name);
    if (!entry) {
      throw missing(name);
    }
    const sha1 = createHash('sha1');
    const result = await wrapArchive(() =>
      digestZipEntry(this.source, entry, {
        // Small reads keep one inflated burst small when a package was recompressed by another tool.
        chunkSize: 256 * 1024,
        onData: async (chunk) => {
          sha1.update(chunk);
          await onData?.(chunk);
        },
      }),
    );
    return { sha1: sha1.digest('hex'), sha256: result.sha256, bytes: result.bytes };
  }

  close() {
    return this.closer();
  }
}

/** An extracted package directory, or a package this server wrote. */
class DirectoryPackageSource implements PreservationPackageSource {
  readonly format = 'directory' as const;

  constructor(private root: string) {}

  /**
   * The real path of a member, refusing anything that is not a regular file inside the package:
   * every component is checked, so a symbolic-linked `originals/` directory is refused as well.
   */
  private async member(name: string): Promise<string> {
    checkName(name);
    let current = this.root;
    for (const part of name.split('/')) {
      current = join(current, part);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw missing(name);
        }
        throw error;
      }
      if (info.isSymbolicLink()) {
        throw new PreservationPackageError('package_entry_link', `${name.slice(0, 80)} is a symbolic link`);
      }
    }
    const resolved = await realpath(current);
    if (!resolved.startsWith(this.root + sep)) {
      throw new PreservationPackageError('package_entry_name', `${name.slice(0, 80)} is outside the package`);
    }
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new PreservationPackageError('package_entry_name', `${name.slice(0, 80)} is not a file`);
    }
    return resolved;
  }

  async listEntries() {
    const names: string[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'originals' || entry.name === 'metadata')) {
        const prefix = entry.name === 'originals' ? PRESERVATION_ORIGINALS_PREFIX : PRESERVATION_METADATA_PREFIX;
        for (const child of await readdir(join(this.root, entry.name), { withFileTypes: true })) {
          names.push(`${prefix}${child.name}${child.isDirectory() ? '/' : ''}`);
        }
      } else {
        names.push(`${entry.name}${entry.isDirectory() ? '/' : ''}`);
      }
    }
    return names;
  }

  async has(name: string) {
    try {
      await this.member(name);
      return true;
    } catch (error) {
      if (error instanceof PreservationPackageError && error.code === 'package_entry_missing') {
        return false;
      }
      throw error;
    }
  }

  async readDocument(name: string, maxBytes: number) {
    const path = await this.member(name);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const { size } = await handle.stat();
      if (size > maxBytes) {
        throw new PreservationPackageError('package_too_large', `${name.slice(0, 80)} is larger than it may be`);
      }
      const bytes = await handle.readFile();
      if (bytes.length > maxBytes) {
        throw new PreservationPackageError('package_too_large', `${name.slice(0, 80)} grew while it was read`);
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async stream(name: string, onData?: (chunk: Buffer) => void | Promise<void>) {
    const path = await this.member(name);
    const sha1 = createHash('sha1');
    const sha256 = createHash('sha256');
    let bytes = 0;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        const buffer = chunk as Buffer;
        sha1.update(buffer);
        sha256.update(buffer);
        bytes += buffer.length;
        await onData?.(buffer);
      }
    } finally {
      await handle.close();
    }
    return { sha1: sha1.digest('hex'), sha256: sha256.digest('hex'), bytes };
  }

  close() {
    return Promise.resolve();
  }
}

/** The FL-91 reader's refusals as package refusals, with codes the client can translate. */
const wrapArchive = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof StudioBundleArchiveError) {
      throw new PreservationPackageError(preservationArchiveCode(error.code), error.message);
    }
    throw error;
  }
};

/**
 * The file system side of preservation packages (FL-74): opening packages for reading, writing an
 * export's files atomically, and the checks on a path an administrator names.
 *
 * Every write goes to a temporary name beside its destination, is flushed to disk, and is renamed
 * into place, so a package directory never holds a half-written original or sidecar under its real
 * name. Originals are only ever read here, with `O_NOFOLLOW`, and never moved or linked.
 */
@Injectable()
export class PreservationFileRepository {
  /** Where an owner's exported packages are written. Outside every served folder. */
  exportFolder(ownerId: string, packageId: string) {
    return join(preservationFolder(ownerId), packageId);
  }

  /** Where an owner's uploaded packages wait to be verified and restored. */
  uploadFolder(ownerId: string) {
    return preservationUploadFolder(ownerId);
  }

  /** Everything preservation keeps for an owner, removed when the account is deleted. */
  ownerFolders(ownerId: string) {
    return [preservationFolder(ownerId), preservationUploadFolder(ownerId)];
  }

  async openPackage(format: string, path: string): Promise<PreservationPackageSource> {
    if (format === 'directory') {
      return new DirectoryPackageSource(await realpath(path));
    }

    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const { size } = await handle.stat();
      const source: ZipByteSource = {
        size,
        read: async (position, length) => {
          const buffer = Buffer.alloc(Math.max(0, length));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          return buffer.subarray(0, bytesRead);
        },
      };
      const directory = await wrapArchive(() => readZipDirectory(source, PRESERVATION_ZIP_LIMITS));
      return new ZipPackageSource(source, directory, () => handle.close());
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /**
   * Copy one original into a package, measuring it on the way. The copy is refused if the source
   * changed while it was read (size, modification time or inode), so a package never holds a copy
   * of a file that was being rewritten.
   */
  async copyOriginal(source: string, destination: string): Promise<PreservationDigests> {
    const before = await stat(source);
    if (!before.isFile()) {
      throw new PreservationPackageError('original_missing', 'The original is not a regular file');
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.partial`;
    const sha1 = createHash('sha1');
    const sha256 = createHash('sha256');
    let bytes = 0;
    try {
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      await pipeline(
        handle.createReadStream(),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            sha1.update(chunk);
            sha256.update(chunk);
            bytes += chunk.length;
            callback(null, chunk);
          },
        }),
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
      const after = await stat(source);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino ||
        bytes !== before.size
      ) {
        throw new PreservationPackageError('original_changed', 'The original changed while it was copied');
      }
      await this.sync(temporary);
      await rename(temporary, destination);
      return { sha1: sha1.digest('hex'), sha256: sha256.digest('hex'), bytes };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /**
   * Copy one entry out of a package to `destination`, verifying it on the way. Only a copy whose
   * digests and size match `expected` is renamed into place; anything else is removed and refused.
   */
  async extractVerified(
    source: PreservationPackageSource,
    name: string,
    destination: string,
    expected: PreservationDigests,
  ): Promise<void> {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.partial`;
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    const closed = new Promise<void>((resolve, reject) => {
      output.once('close', () => resolve());
      output.once('error', reject);
    });
    // Observed now: a write error rejects this before it is awaited below.
    void closed.catch(() => {});
    try {
      const digests = await source.stream(name, (chunk) => writeChunk(output, chunk));
      output.end();
      await closed;
      if (digests.bytes !== expected.bytes || digests.sha256 !== expected.sha256 || digests.sha1 !== expected.sha1) {
        throw new PreservationPackageError(
          'original_changed',
          'The original in the package does not match its checksum',
        );
      }
      await this.sync(temporary);
      await rename(temporary, destination);
    } catch (error) {
      output.destroy();
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Write a document atomically and return its digest. */
  async writeDocument(destination: string, bytes: Buffer): Promise<{ sha256: string; bytes: number }> {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.partial`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }

  /**
   * Write a document line by line from pages the caller produces, atomically, and return its
   * digest. Used for the index, which can be tens of megabytes and is never built in memory.
   */
  async writeLines(
    destination: string,
    pages: AsyncIterable<string[]>,
  ): Promise<{ sha256: string; bytes: number; lines: number }> {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.partial`;
    const hash = createHash('sha256');
    let bytes = 0;
    let lines = 0;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      for await (const page of pages) {
        if (page.length === 0) {
          continue;
        }
        const chunk = Buffer.from(page.map((line) => `${line}\n`).join(''), 'utf8');
        hash.update(chunk);
        bytes += chunk.length;
        lines += page.length;
        await handle.write(chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    return { sha256: hash.digest('hex'), bytes, lines };
  }

  /** Stream a package document line by line, digesting the whole of it; refuses an overlong line. */
  async readLines(
    source: PreservationPackageSource,
    name: string,
    maxLineBytes: number,
    onLine: (line: string) => Promise<void>,
  ): Promise<{ sha256: string; bytes: number }> {
    const sha256 = createHash('sha256');
    let bytes = 0;
    let pending: Buffer = Buffer.alloc(0);
    await source.stream(name, async (chunk) => {
      sha256.update(chunk);
      bytes += chunk.length;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(0x0a);
      while (newline !== -1) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (line.length > maxLineBytes) {
          throw new PreservationPackageError('package_index_invalid', 'An index line is longer than it may be');
        }
        await onLine(line.toString('utf8'));
        newline = pending.indexOf(0x0a);
      }
      if (pending.length > maxLineBytes) {
        throw new PreservationPackageError('package_index_invalid', 'An index line is longer than it may be');
      }
    });
    if (pending.length > 0) {
      await onLine(pending.toString('utf8'));
    }
    return { sha256: sha256.digest('hex'), bytes };
  }

  async freeBytes(folder: string): Promise<number> {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const stats = await statfs(folder);
    return stats.bavail * stats.bsize;
  }

  async size(path: string): Promise<number> {
    return (await stat(path)).size;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  }

  async removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  async removeFile(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async sha256File(path: string): Promise<string> {
    const hash = createHash('sha256');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk as Buffer);
      }
    } finally {
      await handle.close();
    }
    return hash.digest('hex');
  }

  /**
   * A package an administrator names by path: an existing directory or ZIP file, not a symbolic
   * link, and entirely outside the server's managed media storage, which the server never reads
   * as a package source. Returns the real path and its form.
   */
  async resolveServerPackage(
    path: string,
  ): Promise<{ path: string; format: 'directory' | 'zip'; size: number | null }> {
    let info;
    try {
      info = await lstat(path);
    } catch {
      throw new PreservationPackageError('package_path_missing', 'Nothing exists at that path');
    }
    if (info.isSymbolicLink()) {
      throw new PreservationPackageError('package_path_link', 'Choose the package itself, not a symbolic link');
    }
    const resolved = await realpath(path);
    const managed = await realpath(StorageCore.getMediaLocation());
    if (resolved === managed || resolved.startsWith(managed + sep) || managed.startsWith(resolved + sep)) {
      throw new PreservationPackageError(
        'package_path_managed',
        'A package must be outside the server’s media storage',
      );
    }
    if (info.isDirectory()) {
      return { path: resolved, format: 'directory', size: null };
    }
    if (info.isFile() && resolved.toLowerCase().endsWith('.zip')) {
      return { path: resolved, format: 'zip', size: info.size };
    }
    throw new PreservationPackageError('package_path_kind', 'Choose a package directory or a .zip file');
  }

  private async sync(path: string) {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

/** Write one chunk, waiting for the stream to drain when it asks to, and failing if it fails. */
const writeChunk = (output: Writable, chunk: Buffer): Promise<void> => {
  if (output.write(chunk)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      output.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      output.off('drain', onDrain);
      reject(error);
    };
    output.once('drain', onDrain);
    output.once('error', onError);
  });
};

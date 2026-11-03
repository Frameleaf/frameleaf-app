import { type LockedKeyFile, PEPPER_BYTES, isKeyFileFormat } from '@frameleaf/locked-crypto';
import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';

const DIRECTORY = 'locked-keys';
/**
 * The Locked pepper: random bytes every PIN wrap's key depends on, kept apart from the key files so
 * a copy of the media root alone is not enough to try the 10^6 PINs offline. It lives with the
 * server's other secret files, in the identity directory (`FRAMELEAF_IDENTITY_DIR`, which should
 * point off the media volume; by default `<media>/frameleaf/identity`), as base64 text, mode 0600.
 * `frameleaf locked decrypt --pepper-file` reads the same file. It is never regenerated on its own:
 * a damaged file is an error, since a new pepper would close every PIN wrap (the recovery key and a
 * passphrase still open the key file).
 */
export const LOCKED_PEPPER_FILE = 'locked-pin-pepper.key';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
/** A wrap entry `hasPepperedWrap` can classify: a plain object, so `.pepper` reads its own metadata. */
const isWrapRecord = (wrap: unknown): wrap is { pepper?: unknown } =>
  typeof wrap === 'object' && wrap !== null && !Array.isArray(wrap);

/**
 * The pepper file cannot be used: it is damaged, or missing while key files hold PIN wraps made with
 * it. Either needs an operator (restore the file from a backup); the server never replaces it.
 */
export class LockedPepperFileError extends Error {
  constructor(
    message: string,
    public readonly reason: 'missing' | 'damaged',
  ) {
    super(message);
    this.name = 'LockedPepperFileError';
  }
}

/**
 * FL-721 (spec §4.2): the Locked key files, `<media root>/locked-keys/<userId>.json`, mode 0600. They
 * hold only the public key and the wrapped private key; they are the source of truth (the
 * `locked_encryption` table mirrors state only) and are self-contained for the recovery CLI.
 */
@Injectable()
export class LockedKeyRepository {
  private pepperCache?: Promise<Buffer>;

  /** Callers outside Nest (`locked-read.ts`, medium tests) construct it without one; only `pepper` needs it. */
  constructor(private configRepository: ConfigRepository = new ConfigRepository()) {}

  /** Null when there is no key file, or when it is not a key file (format 1 or 2) for this person. */
  async read(userId: string): Promise<LockedKeyFile | null> {
    let text: string;
    try {
      text = await fs.readFile(this.path(userId), 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
    const file = JSON.parse(text) as Partial<LockedKeyFile> | null;
    return file && isKeyFileFormat(file.format) && file.userId === userId ? (file as LockedKeyFile) : null;
  }

  /**
   * The server's Locked pepper (see `LOCKED_PEPPER_FILE`), made on first use. Two workers making it
   * at once end with one file: the loser's exclusive create fails and it reads the winner's. A file
   * that is missing although a key file holds a peppered wrap is a `LockedPepperFileError`, never
   * replaced: a new pepper would close every PIN wrap.
   */
  pepper(): Promise<Buffer> {
    this.pepperCache ??= this.loadPepper().catch((error) => {
      // a failure is not remembered: the next call tries again
      this.pepperCache = undefined;
      throw error;
    });
    return this.pepperCache;
  }

  private pepperPath() {
    const directory =
      this.configRepository.getEnv().frameleafCloud.identityDir ??
      join(StorageCore.getMediaLocation(), 'frameleaf', 'identity');
    return join(directory, LOCKED_PEPPER_FILE);
  }

  private async loadPepper(): Promise<Buffer> {
    const path = this.pepperPath();
    const existing = await this.readPepper(path);
    if (existing) {
      return existing;
    }
    if (await this.hasPepperedWrap()) {
      throw new LockedPepperFileError(
        `The Locked pepper file ${path} is missing, but key files hold PIN wraps made with it. Restore it from a backup; a new pepper would close every Locked PIN wrap (recovery keys still open the key files).`,
        'missing',
      );
    }
    const directory = join(path, '..');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // an identity directory that already existed keeps the mode it was made with: enforce ours
    await fs.chmod(directory, 0o700);
    const pepper = randomBytes(PEPPER_BYTES);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // another worker made it first; its file is complete once the sync below has run there,
        // so a short empty read is retried
        for (let attempt = 0; attempt < 50; attempt++) {
          const winner = await this.readPepper(path, true);
          if (winner) {
            return winner;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // still empty: the winner's file never filled, which is a damaged pepper file, not a race
        await this.readPepper(path);
      }
      throw error;
    }
    try {
      await handle.writeFile(`${pepper.toString('base64')}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.flush(join(path, '..'));
    return pepper;
  }

  /** The pepper in `path`; null when there is none. A file of the wrong shape is an error, never replaced. */
  private async readPepper(path: string, allowEmpty = false): Promise<Buffer | null> {
    let text: string;
    try {
      text = await fs.readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
    if (allowEmpty && text.trim() === '') {
      return null;
    }
    const pepper = Buffer.from(text.trim(), 'base64');
    if (text.trim() === '' || pepper.length < PEPPER_BYTES || pepper.toString('base64') !== text.trim()) {
      throw new LockedPepperFileError(
        `The Locked pepper file ${path} is damaged. Restore it from a backup; without it no Locked PIN opens a key file (recovery keys still do).`,
        'damaged',
      );
    }
    return pepper;
  }

  /**
   * Whether any key file on disk holds a wrap made with the pepper (a format-2 PIN wrap). Fails
   * closed: a key file that cannot be read or classified (a half-restored or damaged one) is a
   * `LockedPepperFileError`, since making a new pepper while it may hold a peppered wrap would
   * close that wrap for good once the file is restored.
   */
  private async hasPepperedWrap(): Promise<boolean> {
    let peppered = false;
    for (const name of await this.names()) {
      const userId = name.slice(0, -'.json'.length);
      if (!name.endsWith('.json') || !UUID.test(userId)) {
        continue;
      }
      let file: LockedKeyFile | null;
      try {
        file = await this.read(userId);
      } catch {
        file = null;
      }
      if (!file || !Array.isArray(file.wraps) || file.wraps.some((wrap) => !isWrapRecord(wrap))) {
        throw new LockedPepperFileError(
          `The Locked pepper file is missing and the key file ${join(this.directory(), name)} cannot be inspected. No new pepper is made until every key file can be read: restore the pepper file from a backup, or repair or remove that key file.`,
          'missing',
        );
      }
      if (file.wraps.some((wrap) => wrap.pepper !== undefined)) {
        peppered = true;
      }
    }
    return peppered;
  }

  /**
   * Whether a key file is on disk for this person, whether or not `read` can use it. A null `read`
   * never means a new key pair may be made: overwriting a key file loses that person's files.
   */
  async exists(userId: string): Promise<boolean> {
    try {
      await fs.lstat(this.path(userId));
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  /** Atomic: a temporary file is written and flushed, renamed over the old one, then the folder is flushed. */
  async write(file: LockedKeyFile): Promise<void> {
    const path = this.path(file.userId);
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // a folder made earlier (or by hand) may be wider; mkdir leaves an existing one as it is
    await fs.chmod(directory, 0o700);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(file, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, path);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    await this.flush(directory);
  }

  /** Overwrites the file with random bytes and flushes it before unlinking, so no copy is left behind. */
  async delete(userId: string): Promise<void> {
    const path = this.path(userId);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path, 'r+');
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
    try {
      const { size } = await handle.stat();
      const noise = randomBytes(size);
      for (let written = 0; written < size;) {
        const { bytesWritten } = await handle.write(noise, written, size - written, written);
        written += bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.unlink(path);
    await this.flush(this.directory());
  }

  /** The people with a key file on disk, by file name, whether or not it can be read. */
  async userIds(): Promise<string[]> {
    return (await this.names())
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((userId) => UUID.test(userId));
  }

  async list(): Promise<LockedKeyFile[]> {
    const files: LockedKeyFile[] = [];
    for (const name of await this.names()) {
      const userId = name.slice(0, -'.json'.length);
      if (!name.endsWith('.json') || !UUID.test(userId)) {
        continue;
      }
      // one unreadable file must not hide everyone else's
      const file = await this.read(userId).catch(() => null);
      if (file) {
        files.push(file);
      }
    }
    return files;
  }

  /** Removes the temporary files a crash left between writing and renaming. Returns how many. */
  async removeStaleTemp(): Promise<number> {
    let removed = 0;
    for (const name of await this.names()) {
      if (name.endsWith('.tmp')) {
        await fs.rm(join(this.directory(), name), { force: true });
        removed++;
      }
    }
    return removed;
  }

  private directory() {
    return join(StorageCore.getMediaLocation(), DIRECTORY);
  }

  private path(userId: string) {
    if (!UUID.test(userId)) {
      throw new Error('Invalid user id for a Locked key file');
    }
    return join(this.directory(), `${userId}.json`);
  }

  private async names() {
    try {
      return await fs.readdir(this.directory());
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
  }

  private async flush(directory: string) {
    const handle = await fs.open(directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

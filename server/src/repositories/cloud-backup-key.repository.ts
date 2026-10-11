import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type Stats, constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

const FINGERPRINT = /^[\dA-F]{4}-[\dA-F]{4}$/;
const MAX_KEY_BYTES = 16_384;
/** `link()` failures where the file system cannot hard-link (SMB/CIFS, FUSE, another device). */
const NO_HARD_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);

const exists = (path: string) =>
  lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });

const keyOf = (text: string): unknown => {
  try {
    return (JSON.parse(text) as { key?: unknown }).key;
  } catch {
    return undefined;
  }
};

/**
 * The cloud backup bucket key on disk (FL-160): one 0600 file per key under the identity directory,
 * next to this server's own key, named by the key's fingerprint (`cloud-backup-ABCD-1234.key`). The
 * file is the downloadable key file's JSON, so it also works for a restore from another machine.
 *
 * A key file is written once, atomically: a new file opened exclusively with 0600, synced, then linked
 * into place, which never replaces an existing file. On a mount that cannot hard-link (SMB/CIFS, FUSE),
 * it is renamed into place only when no file is there, as the identity key is. It is read back before
 * it counts as written. It is never overwritten here, and removed only by the setup that just created
 * it when the claim that needed it fails. Contents are never logged.
 */
@Injectable()
export class CloudBackupKeyRepository {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(CloudBackupKeyRepository.name);
  }

  fileName(fingerprint: string) {
    if (!FINGERPRINT.test(fingerprint)) {
      throw new Error('Invalid key fingerprint');
    }
    return `cloud-backup-${fingerprint}.key`;
  }

  /** The stored key file for this fingerprint, or null when there is none. */
  async read(directory: string, fingerprint: string): Promise<string | null> {
    const target = join(directory, this.fileName(fingerprint));
    let parent: Stats;
    let entry: Stats;
    try {
      parent = await this.privateDirectory(directory);
      entry = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    this.assertPrivate(entry);
    if (!entry.isFile() || entry.size > MAX_KEY_BYTES) throw new Error('Stored backup key is unavailable');
    // O_NONBLOCK prevents a replacement FIFO from blocking before its descriptor can be checked.
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      this.assertPrivate(before);
      if (
        !before.isFile() ||
        before.dev !== entry.dev ||
        before.ino !== entry.ino ||
        before.size !== entry.size ||
        before.mtimeMs !== entry.mtimeMs ||
        before.ctimeMs !== entry.ctimeMs ||
        before.size > MAX_KEY_BYTES
      )
        throw new Error('Stored backup key changed during capture');
      const buffer = Buffer.alloc(MAX_KEY_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const after = await file.stat();
      const current = await lstat(target);
      const currentParent = await this.privateDirectory(directory);
      if (
        length > MAX_KEY_BYTES ||
        length !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        after.dev !== current.dev ||
        after.ino !== current.ino ||
        after.ctimeMs !== current.ctimeMs ||
        parent.dev !== currentParent.dev ||
        parent.ino !== currentParent.ino
      )
        throw new Error('Stored backup key changed during capture');
      this.assertPrivate(after);
      return buffer.toString('utf8', 0, length);
    } finally {
      await file.close();
    }
  }

  /** Only stored backup keys, never instance credentials or other identity-directory contents. */
  async readAll(directory: string): Promise<Array<{ fingerprint: string; content: string }>> {
    try {
      await this.privateDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries = await readdir(directory);
    const keys = [];
    for (const name of entries.sort()) {
      const match = /^cloud-backup-([\dA-F]{4}-[\dA-F]{4})\.key$/.exec(name);
      if (!match) continue;
      const content = await this.read(directory, match[1]);
      if (content === null) throw new Error('Stored backup key changed during capture');
      keys.push({ fingerprint: match[1], content });
    }
    return keys;
  }

  /**
   * Store a key file (0600) and read it back. `created` says whether this call wrote it: a file already
   * there for this fingerprint is kept when it holds the same key, and a different key with the same
   * fingerprint is refused rather than written over it.
   */
  async write(directory: string, fingerprint: string, content: string): Promise<{ path: string; created: boolean }> {
    const target = join(directory, this.fileName(fingerprint));
    if (Buffer.byteLength(content, 'utf8') > MAX_KEY_BYTES || typeof keyOf(content) !== 'string')
      throw new Error('Invalid stored backup key');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.privateDirectory(directory);
    const temporary = join(directory, `.${this.fileName(fingerprint)}.${randomUUID()}.tmp`);
    let created: boolean;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.restrict(temporary);
      created = await this.place(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }

    const stored = await this.read(directory, fingerprint);
    if (stored === null || keyOf(stored) !== keyOf(content)) {
      if (created) {
        await rm(target, { force: true });
      }
      throw new Error(
        created
          ? 'The backup key file could not be read back as written'
          : 'A different backup key with the same fingerprint is already stored on this server',
      );
    }
    return { path: target, created };
  }

  /** Remove a key file this server just created, when the claim that needed it failed. */
  async remove(directory: string, fingerprint: string): Promise<void> {
    await rm(join(directory, this.fileName(fingerprint)), { force: true });
  }

  /** Put the staged file in place without replacing one that is there; answers whether it was placed. */
  private async place(temporary: string, target: string): Promise<boolean> {
    try {
      await link(temporary, target);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') {
        return false;
      }
      if (!NO_HARD_LINK.has(code)) {
        throw error;
      }
    }
    if (await exists(target)) {
      return false;
    }
    await rename(temporary, target);
    return true;
  }

  private assertPrivate(entry: Stats) {
    if ((entry.mode & 0o077) !== 0 || (process.geteuid && entry.uid !== process.geteuid()))
      throw new Error(
        'Backup keys need server-owned private storage (directory 0700, files 0600). Check the mount ACLs or migrate FRAMELEAF_IDENTITY_DIR; see the private backup storage guide.',
      );
  }

  private async privateDirectory(directory: string) {
    const entry = await lstat(directory);
    if (!entry.isDirectory()) throw new Error('Stored backup key directory must be a real private directory');
    this.assertPrivate(entry);
    return entry;
  }

  /** Verify reported ownership/mode even when a NAS refuses chmod; effective ACLs need a UID probe. */
  private async restrict(file: string) {
    await chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (!NO_HARD_LINK.has(error.code ?? '')) {
        throw error;
      }
      this.logger.warn(`Backup key mount refused chmod (${error.code}); verify its private ACLs with an unrelated UID`);
    });
    this.assertPrivate(await lstat(file));
  }
}

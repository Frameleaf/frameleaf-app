import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { access, chmod, link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

const FINGERPRINT = /^[\dA-F]{4}-[\dA-F]{4}$/;
/** `link()` failures where the file system cannot hard-link (SMB/CIFS, FUSE, another device). */
const NO_HARD_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);

const exists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false);

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
    try {
      return await readFile(join(directory, this.fileName(fingerprint)), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Store a key file (0600) and read it back. `created` says whether this call wrote it: a file already
   * there for this fingerprint is kept when it holds the same key, and a different key with the same
   * fingerprint is refused rather than written over it.
   */
  async write(directory: string, fingerprint: string, content: string): Promise<{ path: string; created: boolean }> {
    const target = join(directory, this.fileName(fingerprint));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${this.fileName(fingerprint)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    let created: boolean;
    try {
      await this.restrict(temporary);
      created = await this.place(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }

    const stored = await readFile(target, 'utf8');
    if (keyOf(stored) !== keyOf(content)) {
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

  /** Make a key file owner-only; a mount that refuses chmod (SMB/CIFS, FUSE) only gets a warning. */
  private async restrict(file: string) {
    await chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (!NO_HARD_LINK.has(error.code ?? '')) {
        throw error;
      }
      this.logger.warn(`Could not make ${file} readable by this server only (${error.code}); check the mount`);
    });
  }
}

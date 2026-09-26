import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const FINGERPRINT = /^[\dA-F]{4}-[\dA-F]{4}$/;

/**
 * The cloud backup bucket key on disk (FL-160): one 0600 file per key under the identity directory,
 * next to this server's own key, named by the key's fingerprint (`cloud-backup-ABCD-1234.key`). The
 * file is the downloadable key file's JSON, so it also works for a restore from another machine.
 *
 * A key file is written once, atomically (a new file opened exclusively with 0600, synced, then linked
 * into place, which never replaces an existing file) and never overwritten or removed here: a key that
 * was replaced still reads the backups made with it. Contents are never logged.
 */
@Injectable()
export class CloudBackupKeyRepository {
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
   * Store a key file (0600). A file already there for this fingerprint is kept when it holds the same
   * key; a different key with the same fingerprint is refused rather than written over it.
   */
  async write(directory: string, fingerprint: string, content: string): Promise<string> {
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
    try {
      await chmod(temporary, 0o600);
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const keyOf = (text: string) => (JSON.parse(text) as { key?: unknown }).key;
      if (keyOf(await readFile(target, 'utf8')) !== keyOf(content)) {
        throw new Error('A different backup key with the same fingerprint is already stored on this server');
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return target;
  }
}

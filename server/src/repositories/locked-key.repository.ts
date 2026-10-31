import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { LockedKeyFile } from '@frameleaf/locked-crypto';
import { StorageCore } from 'src/cores/storage.core.js';

const DIRECTORY = 'locked-keys';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * FL-721 (spec §4.2): the Locked key files, `<media root>/locked-keys/<userId>.json`, mode 0600. They
 * hold only the public key and the wrapped private key; they are the source of truth (the
 * `locked_encryption` table mirrors state only) and are self-contained for the recovery CLI.
 */
@Injectable()
export class LockedKeyRepository {
  async read(userId: string): Promise<LockedKeyFile | null> {
    try {
      return JSON.parse(await fs.readFile(this.path(userId), 'utf8')) as LockedKeyFile;
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  /** Atomic: a temporary file is written and flushed, renamed over the old one, then the folder is flushed. */
  async write(file: LockedKeyFile): Promise<void> {
    const path = this.path(file.userId);
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
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
      await handle.write(randomBytes(size), 0, size, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.unlink(path);
    await this.flush(this.directory());
  }

  async list(): Promise<LockedKeyFile[]> {
    const files: LockedKeyFile[] = [];
    for (const name of await this.names()) {
      const userId = name.slice(0, -'.json'.length);
      if (!name.endsWith('.json') || !UUID.test(userId)) {
        continue;
      }
      const file = await this.read(userId);
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

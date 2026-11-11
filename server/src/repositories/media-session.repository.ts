import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaDownloadSession } from 'src/repositories/media-downloader.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { decryptMediaSession, encryptMediaSession } from 'src/utils/media-import.js';

@Injectable()
export class MediaSessionRepository {
  private async key() {
    const directory = join(StorageCore.getMediaLocation(), '.frameleaf-media');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('Media credential directory must belong to the Library user and have mode 0700');
    const path = join(directory, 'session.key');
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const temporary = join(directory, randomUUID());
      const output = await open(temporary, 'wx', 0o600);
      try {
        await output.writeFile(randomBytes(32));
        await output.sync();
      } finally {
        await output.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        await unlink(temporary);
      }
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== 32 || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
        throw new Error('Media session key must belong to the Library user and have mode 0600');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  async encrypt(ownerId: string, id: string, session: MediaDownloadSession) {
    return encryptMediaSession(await this.key(), ownerId, id, session);
  }
  async decrypt(ownerId: string, id: string, ciphertext: string) {
    return decryptMediaSession(await this.key(), ownerId, id, ciphertext);
  }
}

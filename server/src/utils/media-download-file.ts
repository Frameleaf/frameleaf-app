import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class MediaDownloadFileError extends Error {
  constructor(public readonly code: 'incomplete' | 'too_large') {
    super(code);
  }
}

export async function copyMediaDownload(source: string, destination: string, limit: number, signal?: AbortSignal) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0) {
      throw new MediaDownloadFileError('incomplete');
    }
    if (stat.size > limit) {
      throw new MediaDownloadFileError('too_large');
    }
    const output = await open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    try {
      await pipeline(
        input.createReadStream(),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > limit) {
              callback(new MediaDownloadFileError('too_large'));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        output.createWriteStream(),
        { signal },
      );
      if (size !== stat.size) {
        throw new MediaDownloadFileError('incomplete');
      }
      return { size, sha256: hash.digest('hex') };
    } catch (error) {
      await output.close();
      await rm(destination, { force: true });
      throw error;
    }
  } finally {
    await input.close();
  }
}

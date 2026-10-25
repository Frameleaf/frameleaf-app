import { NotFoundException, StreamableFile } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { access, constants } from 'node:fs/promises';
import { basename, extname, parse } from 'node:path';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import sanitize from 'sanitize-filename';
import { CacheControl } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ReadStreamResponse } from 'src/repositories/storage.repository.js';
import { onRouteError } from 'src/utils/logger.js';

export const nextArchiveName = (paths: Map<string, number>, originalFileName: string) => {
  const base = sanitize(originalFileName) || 'unnamed';
  let filename = base;
  let count = paths.get(base) ?? 0;
  if (paths.has(filename)) {
    const parsedFilename = parse(base);
    do {
      filename = `${parsedFilename.name}+${++count}${parsedFilename.ext}`;
    } while (paths.has(filename));
  }
  paths.set(base, count);
  paths.set(filename, 0);
  return filename;
};

export function getFileNameWithoutExtension(path: string): string {
  return basename(path, getFilenameExtension(path));
}

export function getFilenameExtension(path: string) {
  const extension = extname(path);
  if (!extension && path.startsWith('.') && !path.includes('.', 1)) {
    return path;
  }
  return extension;
}

export function getLivePhotoMotionFilename(stillName: string, motionName: string) {
  return getFileNameWithoutExtension(stillName) + getFilenameExtension(motionName);
}

export class FileDownloadResponse {
  public readonly path!: string;
  public readonly contentType!: string;
  public readonly cacheControl!: CacheControl;
  public readonly fileName?: string;
  /** called once the file has been sent or the send failed, e.g. to let a temporary copy go (FL-54) */
  public readonly release?: () => void | Promise<void>;
  public readonly stream?: Readable;
  public readonly contentLength?: number;

  constructor(response: FileDownloadResponse) {
    Object.assign(this, response);
  }
}
type SendFile = Parameters<Response['sendFile']>;
type SendFileOptions = SendFile[1];

const cacheControlHeaders: Record<CacheControl, string | null> = {
  [CacheControl.PrivateWithCache]:
    'private, max-age=86400, no-transform, stale-while-revalidate=2592000, stale-if-error=2592000',
  [CacheControl.PrivateWithoutCache]: 'private, no-cache, no-transform',
  [CacheControl.None]: null, // falsy value to prevent adding Cache-Control header
};

export const sendFile = async (
  res: Response,
  next: NextFunction,
  handler: (signal: AbortSignal) => Promise<FileDownloadResponse> | FileDownloadResponse,
  logger: LoggingRepository,
): Promise<void> => {
  let file: FileDownloadResponse | undefined;
  const controller = new AbortController();
  const abandon = () => controller.abort();
  res.once('close', abandon);
  if (res.destroyed) abandon();
  try {
    controller.signal.throwIfAborted();
    file = await handler(controller.signal);
    controller.signal.throwIfAborted();

    if (!file.stream) await access(file.path, constants.R_OK);

    const cacheControlHeader = cacheControlHeaders[file.cacheControl];
    if (cacheControlHeader) {
      // set the header to Cache-Control
      res.header('Cache-Control', cacheControlHeader);
    }

    res.header('Content-Type', file.contentType);
    if (file.fileName) {
      res.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    }

    if (file.stream) {
      const length = file.contentLength;
      if (!Number.isSafeInteger(length) || length! < 0) throw new Error('file_stream_length_invalid');
      res.header('Accept-Ranges', 'bytes');
      const ranges =
        res.req.method === 'GET' && !res.req.get('If-Range') ? res.req.range(length!, { combine: true }) : undefined;
      if (ranges === -1) {
        res.status(416).header('Content-Range', `bytes */${length}`).header('Content-Length', '0').end();
        await finished(res);
        return;
      }
      const range = Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1 ? ranges[0] : undefined;
      let body = file.stream;
      if (range) {
        res.status(206).header('Content-Range', `bytes ${range.start}-${range.end}/${length}`);
        body = Readable.from(
          (async function* () {
            let position = 0;
            for await (const chunk of file!.stream!) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              const start = Math.max(0, range.start - position);
              const end = Math.min(bytes.length, range.end + 1 - position);
              if (start < end) yield bytes.subarray(start, end);
              position += bytes.length;
              if (position > range.end) break;
            }
          })(),
        );
      }
      res.header('Content-Length', String(range ? range.end - range.start + 1 : length));
      if (res.req.method === 'HEAD') {
        res.end();
        await finished(res);
      } else await pipeline(body, res);
      return;
    }

    const path = file.path;
    const options: SendFileOptions = { dotfiles: 'allow' };
    return await promisify<string, SendFileOptions>(res.sendFile).call(res, path, options);
  } catch (error: Error | any) {
    const { canWrite } = onRouteError(undefined, res, error, logger);
    if (canWrite) {
      next(new NotFoundException());
    }
  } finally {
    try {
      file?.stream?.destroy();
      await file?.release?.();
    } finally {
      res.removeListener('close', abandon);
    }
  }
};

export const asStreamableFile = ({ stream, type, disposition, length }: ReadStreamResponse) => {
  return new StreamableFile(stream, { type, disposition, length });
};

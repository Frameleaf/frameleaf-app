import { NotFoundException, StreamableFile } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { access, constants } from 'node:fs/promises';
import { basename, extname, parse } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import sanitize from 'sanitize-filename';
import { CacheControl } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ReadStreamResponse } from 'src/repositories/storage.repository.js';
import {
  LockedKeyUnavailableError,
  RangeNotSatisfiableError,
  assertLockedReadable,
  isLockedPath,
  lockedKeyHttpException,
  openLockedRead,
} from 'src/utils/locked-read.js';
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
  /**
   * FL-721: who the bytes are for, when the file is an encrypted Locked file (the key holder's
   * `canRead` decides whether they may use a loaded key). `null` is a worker reading for a job (render
   * worker, desktop worker). Left out, the request's signed-in person is used (never a shared link).
   */
  public readonly viewerId?: string | null;

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
  handler: () => Promise<FileDownloadResponse> | FileDownloadResponse,
  logger: LoggingRepository,
): Promise<void> => {
  let file: FileDownloadResponse | undefined;
  try {
    file = await handler();

    await access(file.path, constants.R_OK);

    const cacheControlHeader = cacheControlHeaders[file.cacheControl];
    if (cacheControlHeader) {
      // set the header to Cache-Control
      res.header('Cache-Control', cacheControlHeader);
    }

    res.header('Content-Type', file.contentType);
    if (file.fileName) {
      res.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    }

    const path = file.path;
    if (await isLockedPath(path)) {
      return await sendLockedFile(res, path, file.viewerId === undefined ? requestViewer(res) : file.viewerId);
    }
    const options: SendFileOptions = { dotfiles: 'allow' };
    return await promisify<string, SendFileOptions>(res.sendFile).call(res, path, options);
  } catch (error: Error | any) {
    if (error instanceof RangeNotSatisfiableError && !res.headersSent) {
      res.status(416).header('Content-Range', `bytes */${error.plaintextLength}`).end();
      return;
    }
    if (error instanceof LockedKeyUnavailableError && !res.headersSent) {
      // FL-721: the web app turns this into the PIN or passphrase prompt. The file's headers were
      // already set for the file; the 423 body is JSON.
      for (const name of ['Content-Type', 'Content-Disposition', 'Cache-Control', 'Accept-Ranges', 'Content-Length']) {
        res.removeHeader(name);
      }
      logger.debug('Locked key unavailable for an encrypted file');
      next(lockedKeyHttpException(error));
      return;
    }
    const { canWrite } = onRouteError(undefined, res, error, logger);
    if (canWrite) {
      next(new NotFoundException());
    }
  } finally {
    await file?.release?.();
  }
};

/** FL-721: `FileDownloadResponse.viewerId` for a request's auth; a shared link never reads an encrypted file. */
export const lockedViewerOf = (auth: { user: { id: string }; sharedLink?: unknown }): string | undefined =>
  auth.sharedLink ? undefined : auth.user.id;

/** The signed-in person of the request; a shared link never reads an encrypted file. */
const requestViewer = (res: Response): string | null | undefined => {
  const auth = (res.req as { user?: { user?: { id?: string }; sharedLink?: unknown } } | undefined)?.user;
  return auth?.sharedLink ? undefined : auth?.user?.id;
};

/**
 * One byte range of `size` bytes from a `Range` header: `bytes=a-b`, `bytes=a-` or `bytes=-n`. Null
 * means "send the whole file" (no header, another unit, several ranges or a malformed one, which RFC
 * 9110 lets a server ignore); a range that starts past the end throws RangeNotSatisfiable.
 */
export const parseSingleRange = (header: string | undefined, size: number): { start: number; end: number } | null => {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === '' && match[2] === '')) {
    return null;
  }
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) {
      throw new RangeNotSatisfiableError(size);
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (match[2] !== '' && Number(match[2]) < start) {
      return null;
    }
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
    throw new RangeNotSatisfiableError(size);
  }
  return { start, end };
};

/**
 * FL-721 (spec §8.1): an encrypted Locked file is decrypted as it is sent, so its plaintext is never
 * written anywhere. Range requests (video seeking) decrypt only the segments they cover.
 */
const sendLockedFile = async (res: Response, path: string, viewerId: string | null | undefined) => {
  if (viewerId === undefined) {
    throw new LockedKeyUnavailableError([], 'No signed-in person to read an encrypted Locked file for');
  }
  const { plaintextLength: size } = await assertLockedReadable(path, viewerId);
  const header = res.req?.headers.range;
  const range = size > 0 ? parseSingleRange(header, size) : null;
  if (!range && header && size === 0 && header.startsWith('bytes=')) {
    throw new RangeNotSatisfiableError(size);
  }
  const { stream } = await openLockedRead(path, viewerId, range ?? undefined);
  if (range) {
    res.status(206);
    res.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  }
  res.header('Accept-Ranges', 'bytes');
  res.header('Content-Length', String(range ? range.end - range.start + 1 : size));
  if (res.req?.method === 'HEAD') {
    (stream as Readable).destroy();
    res.end();
    return;
  }
  await pipeline(stream as Readable, res);
};

export const asStreamableFile = ({ stream, type, disposition, length }: ReadStreamResponse) => {
  return new StreamableFile(stream, { type, disposition, length });
};

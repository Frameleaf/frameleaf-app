import { NotFoundException } from '@nestjs/common';
import express, { type NextFunction, type Response } from 'express';
import { access, constants, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import { CacheControl } from 'src/enum.js';
import {
  FileDownloadResponse,
  getFileNameWithoutExtension,
  getFilenameExtension,
  getLivePhotoMotionFilename,
  sendFile,
} from 'src/utils/file.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: vi.fn(),
}));

const accessMock = vi.mocked(access);

const fixture = () => {
  const response = {
    headersSent: false,
    header: vi.fn(),
    sendFile: vi.fn((_path: string, _options: unknown, callback: (error?: Error) => void) => callback()),
  };
  const res = response as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  const logger = { debug: vi.fn(), error: vi.fn() };
  const release = vi.fn();
  const file = new FileDownloadResponse({
    path: '/media/test.jpg',
    contentType: 'image/jpeg',
    cacheControl: CacheControl.PrivateWithCache,
    release,
  });
  return { response, res, next, logger, release, file, log: logger as unknown as LoggingRepository };
};

beforeEach(() => {
  accessMock.mockReset().mockResolvedValue(undefined);
});

describe('file delivery', () => {
  it('retains private cache policies, type, filename encoding and receiver context', async () => {
    const policies: [CacheControl, string | null][] = [
      [
        CacheControl.PrivateWithCache,
        'private, max-age=86400, no-transform, stale-while-revalidate=2592000, stale-if-error=2592000',
      ],
      [CacheControl.PrivateWithoutCache, 'private, no-cache, no-transform'],
      [CacheControl.None, null],
    ];
    for (const [cacheControl, expected] of policies) {
      const f = fixture();
      const file = new FileDownloadResponse({ ...f.file, cacheControl, fileName: 'A snowy photo.jpg' });
      await sendFile(f.res, f.next, () => file, f.log);
      expect(accessMock).toHaveBeenLastCalledWith(file.path, constants.R_OK);
      expect(f.response.header).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
      expect(f.response.header).toHaveBeenCalledWith(
        'Content-Disposition',
        "inline; filename*=UTF-8''A%20snowy%20photo.jpg",
      );
      if (expected) expect(f.response.header).toHaveBeenCalledWith('Cache-Control', expected);
      else expect(f.response.header.mock.calls.some(([name]) => name === 'Cache-Control')).toBe(false);
      expect(f.response.sendFile).toHaveBeenCalledWith(file.path, { dotfiles: 'allow' }, expect.any(Function));
      expect(f.response.sendFile.mock.contexts).toEqual([f.res]);
      expect(f.release.mock.contexts).toEqual([file]);
      expect(f.next).not.toHaveBeenCalled();
    }
  });

  it('releases a temporary file only after its asynchronous transfer finishes', async () => {
    const f = fixture();
    const called = Promise.withResolvers<void>();
    let complete = () => {};
    f.response.sendFile.mockImplementation((_path, _options, callback) => {
      complete = callback;
      called.resolve();
    });
    const pending = sendFile(f.res, f.next, () => Promise.resolve(f.file), f.log);
    await called.promise;
    expect(f.release).not.toHaveBeenCalled();
    complete();
    await pending;
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('retains custom promisified transfers and their response receiver', async () => {
    const f = fixture();
    const custom = vi.fn(function (this: Response, path: string, options: unknown) {
      expect(this).toBe(f.res);
      expect(path).toBe(f.file.path);
      expect(options).toEqual({ dotfiles: 'allow' });
      return Promise.resolve();
    });
    Object.defineProperty(f.response.sendFile, promisify.custom, { value: custom });
    await sendFile(f.res, f.next, () => f.file, f.log);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(f.response.sendFile).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('maps denied file access to a generic 404 and releases without sending headers', async () => {
    const f = fixture();
    accessMock.mockRejectedValueOnce(new Error('private filesystem details'));
    await sendFile(f.res, f.next, () => f.file, f.log);
    expect(f.next).toHaveBeenCalledExactlyOnceWith(expect.any(NotFoundException));
    expect(f.response.header).not.toHaveBeenCalled();
    expect(f.response.sendFile).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.logger.error).toHaveBeenCalledExactlyOnceWith('Unknown route error\nError');
  });

  it('does not send a second response after headers or a client disconnect, but still releases', async () => {
    for (const headersSent of [false, true]) {
      const f = fixture();
      f.response.headersSent = headersSent;
      f.response.sendFile.mockImplementation((_path, _options, callback) =>
        callback(Object.assign(new Error('connection closed'), { code: 'ECONNABORTED' })),
      );
      await sendFile(f.res, f.next, () => f.file, f.log);
      expect(f.next).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.logger.debug).toHaveBeenCalledExactlyOnceWith('Client aborted request');
    }
  });

  it('retains synchronous send errors and release failures', async () => {
    const f = fixture();
    f.response.sendFile.mockImplementation(() => {
      throw new TypeError('private transfer details');
    });
    await sendFile(f.res, f.next, () => f.file, f.log);
    expect(f.next).toHaveBeenCalledExactlyOnceWith(expect.any(NotFoundException));
    expect(f.release).toHaveBeenCalledTimes(1);
    const other = fixture();
    const error = new Error('release failed');
    other.release.mockImplementation(() => {
      throw error;
    });
    await expect(sendFile(other.res, other.next, () => other.file, other.log)).rejects.toBe(error);
  });

  it('keeps real Express range delivery and temporary-file lifetime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-file-send-'));
    const path = join(directory, '.original.txt');
    try {
      await writeFile(path, 'abcdef');
      const released = Promise.withResolvers<void>();
      const release = vi.fn(() => released.resolve());
      const logger = { debug: vi.fn(), error: vi.fn() } as unknown as LoggingRepository;
      const app = express();
      app.get('/file', (req, res, next) =>
        sendFile(
          res,
          next,
          () =>
            new FileDownloadResponse({
              path,
              contentType: 'text/plain',
              cacheControl: CacheControl.PrivateWithoutCache,
              release,
            }),
          logger,
        ),
      );
      const result = await request(app).get('/file').set('Range', 'bytes=1-3').expect(206);
      await released.promise;
      expect(result.text).toBe('bcd');
      expect(result.headers['content-range']).toBe('bytes 1-3/6');
      expect(result.headers['cache-control']).toBe('private, no-cache, no-transform');
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves the response prototype and all enumerable descriptor properties', () => {
    const f = fixture();
    const source = { ...f.file, additional: 'retained' };
    const result = new FileDownloadResponse(source);
    expect(result).toBeInstanceOf(FileDownloadResponse);
    expect(Object.keys(result)).toEqual(Object.keys(source));
    expect(result).toEqual(source);
    expect(result.release).toBe(source.release);
  });
});

it('retains extension and paired-motion filename rules', () => {
  expect(getFilenameExtension('.hidden')).toBe('.hidden');
  expect(getFilenameExtension('/media/.hidden')).toBe('');
  expect(getFileNameWithoutExtension('/media/Photo.DNG')).toBe('Photo');
  expect(getLivePhotoMotionFilename('Photo.HEIC', 'motion.MOV')).toBe('Photo.MOV');
});

import { SEGMENT_SIZE, encryptFile, generateKeyPair } from '@frameleaf/locked-crypto';
import { NotFoundException } from '@nestjs/common';
import express, { type NextFunction, type Response } from 'express';
import { randomBytes } from 'node:crypto';
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
import { lockedKeys } from 'src/utils/locked-key-holder.js';

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

  it('waits for asynchronous file release before settling delivery', async () => {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    f.release.mockImplementation(() => {
      started.resolve();
      return cleanup.promise;
    });
    let settled = false;
    const delivery = sendFile(f.res, f.next, () => f.file, f.log).finally(() => {
      settled = true;
    });
    try {
      await started.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      cleanup.resolve();
      await delivery;
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      cleanup.resolve();
      await delivery;
    }
  });

  it('propagates asynchronous release failure through the delivery promise', async () => {
    const f = fixture();
    const error = new Error('cleanup refused');
    const failed = Promise.reject(error);
    void failed.catch(() => {});
    f.release.mockReturnValue(failed);
    await expect(sendFile(f.res, f.next, () => f.file, f.log)).rejects.toBe(error);
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

describe('sending an encrypted Locked file (FL-721)', () => {
  const OWNER = '00000000-0000-4000-8000-000000000001';
  let directory: string;
  let path: string;
  let plain: Buffer;
  let owner: ReturnType<typeof generateKeyPair>;

  const app = (...args: [viewerId?: string | null]) => {
    const viewerId = args.length > 0 ? args[0] : OWNER;
    const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as LoggingRepository;
    const server = express();
    server.get('/file', (_req, res, next) =>
      sendFile(
        res,
        next,
        () =>
          new FileDownloadResponse({
            path,
            contentType: 'image/jpeg',
            cacheControl: CacheControl.PrivateWithoutCache,
            viewerId,
          }),
        logger,
      ),
    );
    // the error handler Nest would install: HttpExceptions answer with their status and body
    server.use((error: any, _req: any, res: any, _next: any) =>
      res.status(error.getStatus?.() ?? 500).json(error.getResponse?.() ?? {}),
    );
    return server;
  };

  beforeEach(async () => {
    accessMock.mockImplementation(async (...args) => (await vi.importActual<any>('node:fs/promises')).access(...args));
    directory = await mkdtemp(join(tmpdir(), 'send-locked-'));
    owner = generateKeyPair();
    plain = randomBytes(SEGMENT_SIZE + 4000);
    await writeFile(join(directory, 'plain.jpg'), plain);
    path = join(directory, 'sealed.jpg');
    await encryptFile(join(directory, 'plain.jpg'), path, [{ publicKey: owner.publicKey }], {
      assetId: '00000000-0000-4000-8000-0000000000a1',
      kind: 'original',
      originalFileName: 'sealed.jpg',
      mime: 'image/jpeg',
    });
    lockedKeys.load(OWNER, owner.publicKey, Buffer.from(owner.privateKey), null);
  });

  afterEach(async () => {
    lockedKeys.clear();
    await rm(directory, { recursive: true, force: true });
  });

  it('Range: bytes=100-199 gives 206, Content-Range and exactly those bytes', async () => {
    const result = await request(app())
      .get('/file')
      .set('Range', 'bytes=100-199')
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(206);
    expect(result.headers['content-range']).toBe(`bytes 100-199/${plain.length}`);
    expect(result.headers['content-length']).toBe('100');
    expect(result.headers['accept-ranges']).toBe('bytes');
    expect(result.headers['content-type']).toMatch(/^image\/jpeg/);
    expect((result.body as Buffer).equals(plain.subarray(100, 200))).toBe(true);
  });

  it('sends the whole decrypted file with 200 without a range, and bytes=-500 as the last 500', async () => {
    const binary = (res: any, done: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('end', () => done(null, Buffer.concat(chunks)));
    };
    const whole = await request(app()).get('/file').buffer(true).parse(binary).expect(200);
    expect(whole.headers['content-length']).toBe(String(plain.length));
    expect((whole.body as Buffer).equals(plain)).toBe(true);
    const tail = await request(app()).get('/file').set('Range', 'bytes=-500').buffer(true).parse(binary).expect(206);
    expect(tail.headers['content-range']).toBe(`bytes ${plain.length - 500}-${plain.length - 1}/${plain.length}`);
    expect((tail.body as Buffer).equals(plain.subarray(-500))).toBe(true);
  });

  it('answers 416 for a range past the end', async () => {
    const result = await request(app()).get('/file').set('Range', `bytes=${plain.length}-`).expect(416);
    expect(result.headers['content-range']).toBe(`bytes */${plain.length}`);
  });

  it('answers 423 locked_key_unavailable without a key, and for a viewer without a grant', async () => {
    const other = await request(app('00000000-0000-4000-8000-000000000002')).get('/file').expect(423);
    expect(other.body.code).toBe('locked_key_unavailable');
    lockedKeys.clear();
    const none = await request(app()).get('/file').expect(423);
    expect(none.body.code).toBe('locked_key_unavailable');
  });

  it('refuses an encrypted file when no viewer is known', async () => {
    const result = await request(app(undefined)).get('/file').expect(423);
    expect(result.body.code).toBe('locked_key_unavailable');
  });

  it('a plain file still goes through res.sendFile', async () => {
    const f = fixture();
    const file = new FileDownloadResponse({ ...f.file, path: join(directory, 'plain.jpg') });
    await sendFile(f.res, f.next, () => file, f.log);
    expect(f.response.sendFile).toHaveBeenCalledWith(file.path, { dotfiles: 'allow' }, expect.any(Function));
  });
});

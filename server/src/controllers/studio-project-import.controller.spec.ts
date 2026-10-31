import { Readable, Writable } from 'node:stream';
import { type Observable, lastValueFrom, of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { StudioBundleService } from 'src/services/studio-bundle.service.js';
import {
  StudioProjectImportController,
  StudioProjectImportUploadInterceptor,
} from 'src/controllers/studio-project-import.controller.js';
import { STUDIO_IMPORT_MAX_BYTES } from 'src/utils/studio-imports.js';
import { KEY, LINEAGE } from 'test/fixtures/studio-import-retention.js';

const multer = vi.hoisted(() => ({
  intercept: vi.fn(),
  storage: null as {
    _handleFile: (request: unknown, file: Express.Multer.File, callback: (error: Error | null) => void) => void;
  } | null,
}));
const native = vi.hoisted(() => ({ createWriteStream: vi.fn(), mkdirSync: vi.fn(), unlink: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()), ...native }));
vi.mock('@nestjs/platform-express', () => ({
  FileInterceptor: vi.fn((_field, options) => {
    multer.storage = options.storage;
    return class {
      intercept = multer.intercept;
    };
  }),
}));

describe('StudioProjectImportUploadInterceptor', () => {
  const setup = () => {
    const request = {
      user: { user: { id: 'owner' }, session: {} },
      headers: { 'content-length': '123' },
      destroy: vi.fn(),
    };
    const service = {
      reserveUpload: vi.fn().mockResolvedValue({ id: 'reserved', path: '/private/reserved.zip' }),
      abortUpload: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    } as ExecutionContext;
    const next = { handle: vi.fn().mockReturnValue(of('done')) } as unknown as CallHandler;
    multer.intercept.mockImplementation((_context, handler) => Promise.resolve(handler.handle()));
    return {
      request,
      service,
      context,
      next,
      sut: new StudioProjectImportUploadInterceptor(service as unknown as StudioBundleService),
    };
  };
  afterEach(() => vi.useRealTimers());
  it('refuses quota admission before Multer writes any temporary bytes', async () => {
    const { sut, service, context, next } = setup();
    multer.intercept.mockClear();
    service.reserveUpload.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(sut.intercept(context, next)).rejects.toThrow('quota exceeded');
    expect(multer.intercept).not.toHaveBeenCalled();
    expect(next.handle).not.toHaveBeenCalled();
  });
  it('leaves post-body cleanup with the import service after validation or ambiguous commit fails', async () => {
    const { sut, service, request, context, next } = setup();
    next.handle = vi.fn().mockReturnValue(throwError(() => new Error('invalid import')));
    await expect(lastValueFrom(await sut.intercept(context, next))).rejects.toThrow('invalid import');
    expect(service.reserveUpload).toHaveBeenCalledWith(request.user, 123, 'import');
    expect(service.abortUpload).not.toHaveBeenCalled();
  });
  it('creates private request scratch exclusively without an overwrite path', async () => {
    const { sut, context, next } = setup();
    native.createWriteStream.mockReturnValue(
      Object.assign(
        new Writable({
          construct(this: Writable, callback) {
            this.emit('open');
            callback();
          },
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        { bytesWritten: 4 },
      ),
    );
    multer.intercept.mockImplementation(async (_context, handler) => {
      await new Promise<void>((resolve, reject) =>
        multer.storage!._handleFile({}, { stream: Readable.from(['test']) } as Express.Multer.File, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      return handler.handle();
    });
    await expect(lastValueFrom(await sut.intercept(context, next))).resolves.toBe('done');
    expect(native.createWriteStream).toHaveBeenCalledWith('/private/reserved.zip', {
      flags: 'wx',
      mode: 0o600,
      flush: true,
    });
  });
  it('keeps a foreign path intact when exclusive creation reports EEXIST', async () => {
    const { sut, service, request, context, next } = setup();
    native.unlink.mockClear();
    native.createWriteStream.mockReturnValue(
      new Writable({
        construct(this: Writable, callback) {
          callback(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }));
        },
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    );
    multer.intercept.mockImplementation(async (_context, handler) => {
      await new Promise<void>((resolve, reject) =>
        multer.storage!._handleFile({}, { stream: Readable.from(['test']) } as Express.Multer.File, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      return handler.handle();
    });
    await expect(sut.intercept(context, next)).rejects.toThrow('EEXIST');
    expect(service.abortUpload).toHaveBeenCalledWith(request.user, 'reserved', false);
    expect(native.unlink).not.toHaveBeenCalled();
  });
  it('rejects the direct import size limit before reservation', async () => {
    const { sut, service, request, context, next } = setup();
    request.headers['content-length'] = String(STUDIO_IMPORT_MAX_BYTES + 2 * 1024 ** 2);
    await expect(sut.intercept(context, next)).rejects.toThrow('too large');
    expect(service.reserveUpload).not.toHaveBeenCalled();
  });
  it('terminates a stalled body within the reservation lifetime', async () => {
    vi.useFakeTimers();
    const { sut, request, context, next } = setup();
    const { promise, resolve: finish } = Promise.withResolvers<Observable<unknown>>();
    multer.intercept.mockImplementation(() => promise);
    const pending = sut.intercept(context, next);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(request.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Studio bundle upload timed out' }),
    );
    finish(of('done'));
    await pending;
  });
});

describe('StudioProjectImportController upload reservation', () => {
  it('transfers the pre-body reservation into the import transaction', async () => {
    const service = { upload: vi.fn().mockResolvedValue({}) };
    const controller = new StudioProjectImportController(service as never, {} as never);
    const auth = { user: { id: 'owner' } } as never;
    const file = { path: '/private/reserved.zip' } as Express.Multer.File;
    await controller.importStudioProjectFile(auth, 'project', { id: 'import' }, file, {
      studioBundleUploadId: 'reserved',
    } as never);
    expect(service.upload).toHaveBeenCalledWith(auth, 'project', 'import', file, 'reserved', {
      publicationId: undefined,
      processingProvenance: undefined,
    });
  });
});

describe('canonical publication raw multipart boundary', () => {
  it.each([JSON.stringify(LINEAGE), '{malformed', LINEAGE, ['invalid'], null])(
    'forwards raw lineage unchanged for request-owned service validation: %j',
    async (processingProvenance) => {
      const service = { upload: vi.fn() };
      const controller = new StudioProjectImportController(service as never, {} as never);
      const auth = { user: { id: KEY.ownerId } } as never;
      const file = { path: '/private/request.upload' } as Express.Multer.File;
      await controller.importStudioProjectFile(
        auth,
        KEY.projectId,
        { id: KEY.importId, publicationId: KEY.publicationId, processingProvenance },
        file,
        { studioBundleUploadId: 'authenticated-reservation' } as never,
      );
      expect(service.upload).toHaveBeenCalledWith(
        auth,
        KEY.projectId,
        KEY.importId,
        file,
        'authenticated-reservation',
        { publicationId: KEY.publicationId, processingProvenance },
      );
    },
  );
});

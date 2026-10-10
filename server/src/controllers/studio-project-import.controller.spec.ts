import { type Observable, lastValueFrom, of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { StudioBundleService } from 'src/services/studio-bundle.service.js';
import {
  StudioProjectImportController,
  StudioProjectImportUploadInterceptor,
} from 'src/controllers/studio-project-import.controller.js';
import { STUDIO_IMPORT_MAX_BYTES } from 'src/utils/studio-imports.js';

const multer = vi.hoisted(() => ({ intercept: vi.fn() }));
vi.mock('@nestjs/platform-express', () => ({
  FileInterceptor: vi.fn(
    () =>
      class {
        intercept = multer.intercept;
      },
  ),
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
  it('cleans the reserved upload after validation fails', async () => {
    const { sut, service, request, context, next } = setup();
    next.handle = vi.fn().mockReturnValue(throwError(() => new Error('invalid import')));
    await expect(lastValueFrom(await sut.intercept(context, next))).rejects.toThrow('invalid import');
    expect(service.reserveUpload).toHaveBeenCalledWith(request.user, 123);
    expect(service.abortUpload).toHaveBeenCalledWith(request.user, 'reserved');
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
    expect(service.upload).toHaveBeenCalledWith(auth, 'project', 'import', file, 'reserved');
  });
});

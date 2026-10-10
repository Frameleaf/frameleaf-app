import { lastValueFrom, of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { StudioBundleService } from 'src/services/studio-bundle.service.js';
import { StudioBundleUploadInterceptor } from 'src/controllers/studio-bundle.controller.js';
import { STUDIO_BUNDLE_MAX_BYTES } from 'src/utils/studio-bundle.js';

describe(StudioBundleUploadInterceptor.name, () => {
  const setup = () => {
    const request = {
      user: { user: { id: 'owner' }, session: {} },
      headers: { 'content-length': '123' },
      destroy: vi.fn(),
    };
    const service = {
      reserveUpload: vi.fn().mockResolvedValue({ id: 'reservation', path: '/private/reserved.zip' }),
      abortUpload: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    } as ExecutionContext;
    const next = { handle: vi.fn().mockReturnValue(of('done')) } as unknown as CallHandler;
    return {
      request,
      service,
      context,
      next,
      sut: new StudioBundleUploadInterceptor(service as unknown as StudioBundleService),
    };
  };

  it('refuses admission before Multer or the handler can consume the body', async () => {
    const { service, sut, context, next } = setup();
    service.reserveUpload.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(sut.intercept(context, next)).rejects.toThrow('quota exceeded');
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('reserves the bounded body before the handler, and cleans it on downstream refusal', async () => {
    const { request, service, sut, context, next } = setup();
    next.handle = vi.fn().mockReturnValue(throwError(() => new Error('invalid ZIP')));
    const result = await sut.intercept(context, next);
    await expect(lastValueFrom(result)).rejects.toThrow('invalid ZIP');
    expect(service.reserveUpload).toHaveBeenCalledWith(request.user, 123);
    expect(service.abortUpload).toHaveBeenCalledWith(request.user, 'reservation');
  });

  it('rejects oversized bodies before allocating a reservation', async () => {
    const { request, service, sut, context, next } = setup();
    request.headers['content-length'] = String(STUDIO_BUNDLE_MAX_BYTES + 2 * 1024 ** 2);
    await expect(sut.intercept(context, next)).rejects.toThrow('too large');
    expect(service.reserveUpload).not.toHaveBeenCalled();
  });
});

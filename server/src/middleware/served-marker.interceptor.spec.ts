import { of } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { serverVersion } from 'src/constants.js';
import { ServedMarkerInterceptor } from 'src/middleware/served-marker.interceptor.js';

const context = (originalUrl: string, headers: Record<string, string> = {}) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ originalUrl, path: originalUrl, headers }) }),
  }) as unknown as ExecutionContext;

describe(ServedMarkerInterceptor.name, () => {
  const setup = (set = vi.fn().mockResolvedValue(undefined)) => {
    const logger = { setContext: vi.fn(), error: vi.fn() };
    const sut = new ServedMarkerInterceptor(
      { setServed: set } as unknown as SystemMetadataRepository,
      logger as unknown as LoggingRepository,
    );
    return { sut, set, logger, next: { handle: () => of('ok') } };
  };

  it('records the release once, on the first real request', () => {
    const { sut, set, next } = setup();
    sut.intercept(context('/api/server/ping'), next);
    sut.intercept(context('/api/server/version', { 'x-frameleaf-manager': 'token' }), next);
    expect(set).not.toHaveBeenCalled();

    sut.intercept(context('/api/assets?x=1'), next);
    sut.intercept(context('/api/albums'), next);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      version: serverVersion.toString(),
      servedAt: expect.any(String),
    });
  });

  it('never fails the request when the write fails, and retries on the next one', async () => {
    const { sut, set, logger, next } = setup(
      vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined),
    );
    expect(() => sut.intercept(context('/api/assets'), next)).not.toThrow();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    sut.intercept(context('/api/assets'), next);
    expect(set).toHaveBeenCalledTimes(2);
  });
});

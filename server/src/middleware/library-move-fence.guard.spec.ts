import { ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';
import { LibraryMoveFenceGuard } from 'src/middleware/library-move-fence.guard.js';
import { libraryMoveFence } from 'src/utils/frameleaf-library-move-fence.js';

const context = (method: string, originalUrl: string) => {
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn() });
  return {
    response,
    context: {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method, originalUrl, path: originalUrl }),
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext,
  };
};

describe(LibraryMoveFenceGuard.name, () => {
  const sut = new LibraryMoveFenceGuard();

  afterEach(() => libraryMoveFence.lower());

  it('counts an admitted upload until its response closes', () => {
    const { context: ctx, response } = context('POST', '/api/assets?key=x');
    expect(sut.canActivate(ctx)).toBe(true);
    expect(libraryMoveFence.writesInFlight).toBe(1);
    response.emit('close');
    response.emit('close');
    expect(libraryMoveFence.writesInFlight).toBe(0);
  });

  it('refuses an upload with 503 and Retry-After while a move holds the pause', () => {
    libraryMoveFence.raise();
    const { context: ctx, response } = context('POST', '/api/assets');
    expect(() => sut.canActivate(ctx)).toThrow(ServiceUnavailableException);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(libraryMoveFence.writesInFlight).toBe(0);
  });

  it('lets reads through while paused without counting them', () => {
    libraryMoveFence.raise();
    const { context: ctx } = context('GET', '/api/assets/1/thumbnail');
    expect(sut.canActivate(ctx)).toBe(true);
    expect(libraryMoveFence.writesInFlight).toBe(0);
  });

  it('ignores websocket and other non-HTTP contexts', () => {
    libraryMoveFence.raise();
    expect(sut.canActivate({ getType: () => 'ws' } as unknown as ExecutionContext)).toBe(true);
  });
});

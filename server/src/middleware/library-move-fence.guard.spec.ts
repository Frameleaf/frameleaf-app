import { ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { lastValueFrom, of } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';
import { LibraryMoveFenceGuard } from 'src/middleware/library-move-fence.guard.js';
import { libraryMoveFence } from 'src/utils/frameleaf-library-move-fence.js';

const context = (method: string, originalUrl: string) => {
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn() });
  const request = { method, originalUrl, path: originalUrl };
  return {
    response,
    context: {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => request,
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

  it('keeps a completed handler counted until its response closes', async () => {
    const { context: ctx, response } = context('POST', '/api/assets');
    sut.canActivate(ctx);
    await expect(lastValueFrom(sut.intercept(ctx, { handle: () => of('done') }))).resolves.toBe('done');
    expect(libraryMoveFence.writesInFlight).toBe(1);
    response.emit('close');
    expect(libraryMoveFence.writesInFlight).toBe(0);
  });

  it('does not start a handler after its response already closed', async () => {
    const { context: ctx, response } = context('POST', '/api/assets');
    sut.canActivate(ctx);
    response.emit('close');
    const handle = vi.fn(() => of('unexpected'));
    await expect(lastValueFrom(sut.intercept(ctx, { handle }))).rejects.toThrow('closed before processing');
    expect(handle).not.toHaveBeenCalled();
    expect(libraryMoveFence.writesInFlight).toBe(0);
  });

  it('releases a synchronously failed handler when its response closes', async () => {
    const { context: ctx, response } = context('POST', '/api/assets');
    const failure = new Error('handler admission failed');
    sut.canActivate(ctx);
    await expect(
      lastValueFrom(
        sut.intercept(ctx, {
          handle: () => {
            throw failure;
          },
        }),
      ),
    ).rejects.toBe(failure);
    expect(libraryMoveFence.writesInFlight).toBe(1);
    response.emit('close');
    expect(libraryMoveFence.writesInFlight).toBe(0);
  });

  it('ignores websocket and other non-HTTP contexts', () => {
    libraryMoveFence.raise();
    expect(sut.canActivate({ getType: () => 'ws' } as unknown as ExecutionContext)).toBe(true);
  });
});

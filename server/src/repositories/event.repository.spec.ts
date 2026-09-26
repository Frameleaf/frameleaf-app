import { ModuleRef, Reflector } from '@nestjs/core';
import { ImmichWorker } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { services } from 'src/services/index.js';

type Handler = (...args: unknown[]) => Promise<void>;

const setup = (event: string, handlers: Handler[]) => {
  const logger = { setContext: vi.fn(), error: vi.fn() };
  const sut = new EventRepository({} as never, {} as never, logger as unknown as LoggingRepository);
  (sut as unknown as { emitHandlers: Record<string, unknown[]> }).emitHandlers = {
    [event]: handlers.map((handler, index) => ({ event, handler, server: false, label: `Handler${index}` })),
  };
  return { sut, logger };
};

/** Registers the real services' handlers the way the app does, without constructing the services. */
const setupServices = (worker: ImmichWorker) => {
  const logger = { setContext: vi.fn(), error: vi.fn() };
  const reflector = new Reflector();
  const moduleRef = {
    get: (token: unknown) =>
      token === Reflector ? reflector : Object.create((token as { prototype: object }).prototype),
  };
  const configRepository = { getWorker: () => worker };
  const sut = new EventRepository(
    moduleRef as unknown as ModuleRef,
    configRepository as unknown as ConfigRepository,
    logger as unknown as LoggingRepository,
  );
  sut.setup({ services });
  const handlers = (sut as unknown as { emitHandlers: Record<string, Array<{ label: string }>> }).emitHandlers;
  return { labels: (event: string) => (handlers[event] ?? []).map(({ label }) => label) };
};

describe(EventRepository.name, () => {
  describe('setup', () => {
    // FL-179: Studio revocation is an access boundary, so its priority (-1) must place it ahead of every
    // other AssetDelete handler in the order the handlers are emitted, on every worker that runs them.
    it.each([ImmichWorker.Microservices, ImmichWorker.Api])(
      'registers Studio revocation first of the AssetDelete handlers on the %s worker',
      (worker) => {
        const { labels } = setupServices(worker);
        const assetDelete = labels('AssetDelete');

        expect(assetDelete[0]).toBe('StudioRevocationService.onAssetDelete');
        expect(assetDelete.filter((label) => label === 'StudioRevocationService.onAssetDelete')).toHaveLength(1);
        // the other cleanups are registered too, after it
        expect(assetDelete).toEqual(
          expect.arrayContaining([
            'StorageTemplateService.handleMoveHistoryCleanup',
            'AssetDevelopService.onAssetDelete',
            'AssetRestorationService.onAssetDelete',
          ]),
        );
        expect(assetDelete.length).toBeGreaterThan(1);
      },
    );
  });

  describe('AssetDelete (FL-169)', () => {
    it('runs every handler though an earlier one throws, and logs the failure', async () => {
      const revoke = vi.fn(async () => {});
      const cleanup = vi.fn(async () => {});
      const { sut, logger } = setup('AssetDelete', [
        vi.fn(async () => {
          throw new Error('move history unavailable');
        }),
        revoke,
        cleanup,
      ]);

      await expect(sut.emit('AssetDelete', { assetId: 'asset-1', userId: 'user-1' })).resolves.toBeUndefined();

      expect(revoke).toHaveBeenCalledWith({ assetId: 'asset-1', userId: 'user-1' });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('AssetDelete handler Handler0 failed'),
        expect.any(String),
      );
    });
  });

  it('still stops other events at the first failure and rethrows it', async () => {
    const next = vi.fn(async () => {});
    const { sut } = setup('AssetTrash', [
      vi.fn(async () => {
        throw new Error('handler failed');
      }),
      next,
    ]);

    await expect(sut.emit('AssetTrash', { assetId: 'asset-1', userId: 'user-1' })).rejects.toThrow('handler failed');

    expect(next).not.toHaveBeenCalled();
  });
});

import { ModuleRef, Reflector } from '@nestjs/core';
import { BootstrapEventPriority, ImmichWorker } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { services } from 'src/services/index.js';

type Handler = (...args: unknown[]) => Promise<void>;

const setup = (event: string, handlers: Handler[]) => {
  const logger = { setContext: vi.fn(), error: vi.fn(), debug: vi.fn() };
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
    it.each([ImmichWorker.Api, ImmichWorker.Microservices])(
      'publishes the restart notification before the %s worker exits',
      (worker) => {
        const restart = setupServices(worker).labels('AppRestart');
        expect(restart).toContain('NotificationService.onAppRestart');
        expect(restart).toContain('MaintenanceService.onRestart');
        expect(restart.indexOf('NotificationService.onAppRestart')).toBeLessThan(
          restart.indexOf('MaintenanceService.onRestart'),
        );
      },
    );
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

  describe('AppBootstrap order (FL-289)', () => {
    // Canonical database migrations run in DatabaseService's bootstrap step: the first AppBootstrap handler,
    // awaited before the queue workers start (QueueService) and before the API listens for HTTP
    // (configureExpress runs after NestFactory.create resolves module init).
    it.each([ImmichWorker.Api, ImmichWorker.Microservices])(
      'does not register automatic media-upgrade work on the %s worker',
      (worker) => {
        const { labels } = setupServices(worker);
        expect(services.map((service) => service.name)).not.toContain('StorageMigrationService');
        expect(labels('AppBootstrap')).not.toContain('PartnerCopyService.onBootstrap');
        expect(labels('AppBootstrap').some((label) => label.startsWith('StorageMigrationService.'))).toBe(false);
        expect(labels('StorageMigrationDone')).toEqual([]);
        // Ongoing storage-template cleanup and original protections remain registered.
        expect(labels('AssetDelete')).toContain('StorageTemplateService.handleMoveHistoryCleanup');
      },
    );

    it('runs the database bootstrap first and the queue workers after it on the API worker', () => {
      const { labels } = setupServices(ImmichWorker.Api);
      const bootstrap = labels('AppBootstrap');

      expect(bootstrap[0]).toBe('DatabaseService.onBootstrap');
      expect(bootstrap.indexOf('QueueService.onBootstrap')).toBeGreaterThan(0);
    });

    it('runs the canonical database bootstrap before queue workers on the microservices worker', () => {
      const { labels } = setupServices(ImmichWorker.Microservices);
      const bootstrap = labels('AppBootstrap');

      expect(bootstrap[0]).toBe('DatabaseService.onBootstrap');
      expect(bootstrap.indexOf('QueueService.onBootstrap')).toBeGreaterThan(0);
    });

    it('keeps the database bootstrap priority strictly below every other bootstrap priority', () => {
      const others = Object.entries(BootstrapEventPriority)
        .filter(([key, value]) => key !== 'DatabaseService' && typeof value === 'number')
        .map(([, value]) => value as number);

      expect(others.every((value) => value > BootstrapEventPriority.DatabaseService)).toBe(true);
    });

    it('awaits each bootstrap handler before starting the next one', async () => {
      const order: string[] = [];
      let release!: () => void;
      const first = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = () => {
              order.push('first done');
              resolve();
            };
          }),
      );
      const second = vi.fn(() => {
        order.push('second');
        return Promise.resolve();
      });
      const { sut } = setup('AppBootstrap', [first, second]);

      const emitting = sut.emit('AppBootstrap');
      await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
      expect(second).not.toHaveBeenCalled();
      release();
      await emitting;

      expect(order).toEqual(['first done', 'second']);
    });
  });

  describe('AssetDelete (FL-169)', () => {
    it('runs every handler though an earlier one throws, and logs the failure', async () => {
      const revoke = vi.fn(() => Promise.resolve());
      const cleanup = vi.fn(() => Promise.resolve());
      const { sut, logger } = setup('AssetDelete', [
        vi.fn(() => Promise.reject(new Error('move history unavailable'))),
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

  describe('AppShutdown (FL-299)', () => {
    it('logs how long each handler took at debug level, the failing one included', async () => {
      const { sut, logger } = setup('AppShutdown', [
        vi.fn(() => Promise.resolve()),
        vi.fn(() => Promise.reject(new Error('tick still running'))),
      ]);

      await expect(sut.emit('AppShutdown')).rejects.toThrow('tick still running');

      expect(logger.debug.mock.calls.map(([message]) => message)).toEqual([
        expect.stringMatching(/^AppShutdown handler Handler0 took \d+ ms$/),
        expect.stringMatching(/^AppShutdown handler Handler1 took \d+ ms$/),
      ]);
    });

    it('does not time the handlers of other events', async () => {
      const { sut, logger } = setup('AppBootstrap', [vi.fn(() => Promise.resolve())]);

      await sut.emit('AppBootstrap');

      expect(logger.debug).not.toHaveBeenCalled();
    });
  });

  it('still stops other events at the first failure and rethrows it', async () => {
    const next = vi.fn(() => Promise.resolve());
    const { sut } = setup('AssetTrash', [vi.fn(() => Promise.reject(new Error('handler failed'))), next]);

    await expect(sut.emit('AssetTrash', { assetId: 'asset-1', userId: 'user-1' })).rejects.toThrow('handler failed');

    expect(next).not.toHaveBeenCalled();
  });
});

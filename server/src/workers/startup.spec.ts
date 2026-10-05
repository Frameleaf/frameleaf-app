import { NestExpressApplication } from '@nestjs/platform-express';
import { configureExpress } from 'src/app.common.js';
import { MaintenanceWorkerService } from 'src/maintenance/maintenance-worker.service.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ApiService } from 'src/services/api.service.js';
import { DatabaseService } from 'src/services/database.service.js';
import { bootstrap } from 'src/workers/microservices.js';

const fixture = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('@nestjs/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nestjs/core')>()),
  NestFactory: { create: fixture.create },
}));
vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  isMainThread: true,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: () => false,
}));
vi.mock('src/app.module.js', () => ({ MicroservicesModule: class {} }));
vi.mock('src/middleware/websocket.adapter.js', () => ({ WebSocketAdapter: class {} }));
vi.mock('src/utils/misc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/misc.js')>()),
  useSwagger: vi.fn(),
}));
vi.mock('src/utils/shutdown.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/shutdown.js')>()),
  onStopRequest: vi.fn(),
}));

const setup = () => {
  const initialize = vi.fn<DatabaseService['initialize']>();
  const logger = { setContext: vi.fn(), log: vi.fn(), debug: vi.fn() };
  const providers = new Map<unknown, unknown>([
    [DatabaseService, { initialize }],
    [LoggingRepository, logger],
    [AppRepository, { setCloseFn: vi.fn(), stop: vi.fn() }],
    [JobRepository, { stopWorkers: vi.fn() }],
    [ApiService, { ssr: vi.fn() }],
    [MaintenanceWorkerService, { ssr: vi.fn() }],
    [
      ConfigRepository,
      {
        isDev: () => false,
        getEnv: () => ({
          environment: 'testing',
          port: 0,
          helmet: {},
          resourcePaths: { web: { root: '/unused-web-root' } },
          network: { trustedProxies: [] },
          frameleafCloud: { edge: { secret: '' } },
        }),
      },
    ],
  ]);
  const get = vi.fn((token: unknown) => {
    if (!providers.has(token)) throw new Error('Unexpected startup provider');
    return providers.get(token);
  });
  const useWebSocketAdapter = vi.fn();
  const listen = vi.fn().mockResolvedValue({});
  const app = {
    get,
    resolve: (token: unknown) => Promise.resolve(get(token)),
    useLogger: vi.fn(),
    set: vi.fn(),
    use: vi.fn(),
    setGlobalPrefix: vi.fn(),
    useWebSocketAdapter,
    listen,
    getUrl: vi.fn().mockResolvedValue('http://localhost'),
  } as unknown as NestExpressApplication;
  fixture.create.mockResolvedValue(app);
  return { app, initialize, providers, useWebSocketAdapter, listen };
};

describe('PostgreSQL readiness before gateway startup', () => {
  const starters = [
    { worker: 'API', start: (app: NestExpressApplication) => configureExpress(app, { ssr: ApiService }) },
    { worker: 'microservices', start: (_app: NestExpressApplication) => bootstrap() },
  ];

  it.each(starters)('keeps $worker gateways detached until database readiness resolves', async ({ start }) => {
    const { app, initialize, useWebSocketAdapter, listen } = setup();
    const entered = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    initialize.mockImplementation(() => {
      entered.resolve();
      return ready.promise;
    });
    const starting = start(app);
    await Promise.race([entered.promise, starting]);
    expect(initialize).toHaveBeenCalledExactlyOnceWith();
    expect(useWebSocketAdapter).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    ready.resolve();
    await starting;
    expect(initialize).toHaveBeenCalledExactlyOnceWith();
    expect(useWebSocketAdapter).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledOnce();
    expect(useWebSocketAdapter.mock.invocationCallOrder[0]).toBeLessThan(listen.mock.invocationCallOrder[0]);
  });

  it.each(starters)('refuses $worker startup when the import activation gate rejects', async ({ start }) => {
    const { app, initialize, useWebSocketAdapter, listen } = setup();
    initialize.mockRejectedValue(new Error('Import must be activated before startup'));
    await expect(start(app)).rejects.toThrow('Import must be activated before startup');
    expect(initialize).toHaveBeenCalledExactlyOnceWith();
    expect(useWebSocketAdapter).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('keeps maintenance startup available without the normal database gate', async () => {
    const { app, providers, initialize, useWebSocketAdapter, listen } = setup();
    providers.delete(DatabaseService);
    await configureExpress(app, { permitSwaggerWrite: false, ssr: MaintenanceWorkerService });
    expect(initialize).not.toHaveBeenCalled();
    expect(useWebSocketAdapter).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledOnce();
  });
});

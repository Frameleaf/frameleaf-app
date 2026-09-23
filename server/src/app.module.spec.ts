import { getQueueToken } from '@nestjs/bullmq';
import { ModuleRef, Reflector } from '@nestjs/core';
import { ImmichAdminModule } from 'src/app.module.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobName, QueueName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository, getForkSchemaBackfillJobOptions } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { CliService } from 'src/services/cli.service.js';
import { services } from 'src/services/index.js';
import { StorageService } from 'src/services/storage.service.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { newTestService } from 'test/utils.js';

it('initializes admin job routing before enqueueing a fork backfill without starting workers', async () => {
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const reflector = new Reflector();
  const instances = new Map(services.map((Service) => [Service, Object.create(Service.prototype)]));
  const moduleRef = {
    get: vi.fn((token) => {
      if (token === Reflector) {
        return reflector;
      }
      if (token === getQueueToken(QueueName.BackgroundTask)) {
        return queue;
      }
      return instances.get(token);
    }),
  } as unknown as ModuleRef;
  const logger = { setContext: vi.fn(), verbose: vi.fn(), error: vi.fn() } as unknown as LoggingRepository;
  const jobs = new JobRepository(moduleRef, {} as ConfigRepository, {} as EventRepository, logger);
  const startWorkers = vi.spyOn(jobs, 'startWorkers');
  const watchWorkers = vi.spyOn(jobs, 'watchWorkers');
  const { sut: storage, mocks } = newTestService(StorageService);
  mocks.config.getEnv.mockReturnValue(
    mockEnvData({ storage: { mediaLocation: '/admin-media', ignoreMountCheckErrors: false, importRoots: [] } }),
  );
  const bootstrap = vi.spyOn(storage, 'onBootstrap');
  const admin = new ImmichAdminModule({} as CliService, jobs, storage);

  admin.onModuleInit();
  const data = { kind: 'privacy' as const, batchSize: 1 };
  await jobs.queue({ name: JobName.ForkSchemaBackfill, data });

  expect(queue.add).toHaveBeenCalledWith(JobName.ForkSchemaBackfill, data, getForkSchemaBackfillJobOptions('privacy'));
  expect(StorageCore.getMediaLocation()).toBe('/admin-media');
  expect(bootstrap).not.toHaveBeenCalled();
  expect(startWorkers).not.toHaveBeenCalled();
  expect(watchWorkers).not.toHaveBeenCalled();
});

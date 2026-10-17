import { ImmichAdminModule } from 'src/app.module.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { CliService } from 'src/services/cli.service.js';
import { DatabaseService } from 'src/services/database.service.js';
import { services } from 'src/services/index.js';
import { StorageService } from 'src/services/storage.service.js';

it('prepares a fresh offline import without starting media workers', async () => {
  const initialize = vi.fn().mockResolvedValue(undefined);
  const setup = vi.fn();
  const startWorkers = vi.fn();
  const initializeMediaLocation = vi.fn();
  const admin = new ImmichAdminModule(
    {} as CliService,
    { initialize } as unknown as DatabaseService,
    { setup, startWorkers } as unknown as JobRepository,
    { initializeMediaLocation } as unknown as StorageService,
  );
  const previous = process.argv;
  process.argv = ['node', 'immich-admin', 'import-immich', 'preflight'];
  try {
    await admin.onModuleInit();
  } finally {
    process.argv = previous;
  }
  expect(initialize).toHaveBeenCalledWith({ allowInactiveImport: true });
  expect(initializeMediaLocation).toHaveBeenCalledOnce();
  expect(setup).toHaveBeenCalledWith(services);
  expect(startWorkers).not.toHaveBeenCalled();
});

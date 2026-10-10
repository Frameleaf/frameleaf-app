import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { clearConfigCache } from 'src/utils/config.js';

export const newSystemMetadataRepositoryMock = (): Mocked<RepositoryInterface<SystemMetadataRepository>> => {
  clearConfigCache();
  const repository = {
    withConfigTransaction: vitest.fn(),
    getEffectiveConfigEpoch: vitest.fn().mockResolvedValue(null),
    get: vitest.fn() as any,
    set: vitest.fn(),
    startIntegrityRun: vitest.fn(),
    updateIntegrityRun: vitest.fn(),
    completeIntegrityRun: vitest.fn(),
    delete: vitest.fn(),
    readFile: vitest.fn(),
  } as Mocked<RepositoryInterface<SystemMetadataRepository>>;
  repository.withConfigTransaction.mockImplementation((callback) => callback(repository as never, undefined as never));
  return repository;
};

import { Reflector } from '@nestjs/core';
import { Kysely } from 'kysely';
import { Mocked } from 'vitest';
import { JobConfig } from 'src/decorators.js';
import { JobName, MetadataKey, QueueName } from 'src/enum.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { getMethodNames } from 'src/utils/misc.js';

/**
 * Opt in to real source guards, destination pinning and durable SQL selections while keeping
 * execution mocked. These methods retain their production queue-context behavior; this helper
 * neither starts workers nor replaces a guard with a no-op. Selection routes come from the actual
 * service decorators, and an unregistered handler still fails closed.
 */
export const useRealJobPublication = (
  database: Kysely<DB>,
  jobs: Pick<Mocked<JobRepository>, 'guardAssetSource' | 'pinDestination' | 'queueSelection'>,
  services: object[] = [],
) => {
  const repository = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), database);
  const reflector = new Reflector();
  const handlers: Partial<Record<JobName, { queueName: QueueName }>> = {};
  for (const service of services) {
    for (const name of getMethodNames(service)) {
      const handler = (service as Record<string, (...args: never[]) => unknown>)[name];
      const config = reflector.get<JobConfig>(MetadataKey.JobConfig, handler);
      if (config) {
        handlers[config.name] = { queueName: config.queue };
      }
    }
  }
  // The real intent builder needs routing metadata; no executor is installed or started here.
  Object.assign(repository, { handlers });
  jobs.guardAssetSource.mockImplementation(repository.guardAssetSource.bind(repository));
  jobs.pinDestination.mockImplementation(repository.pinDestination.bind(repository));
  jobs.queueSelection.mockImplementation(repository.queueSelection.bind(repository));
};

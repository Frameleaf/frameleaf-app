import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';

export const newMetadataRepositoryMock = (): Mocked<RepositoryInterface<MetadataRepository>> => {
  return {
    setMaxConcurrency: vitest.fn(),
    teardown: vitest.fn(),
    readTags: vitest.fn(),
    writeTags: vitest.fn(),
    extractBinaryTag: vitest.fn(),
    inspectLocation: vitest.fn(),
    sweepLocationFree: vitest.fn(),
    writeLocationFreeCopy: vitest.fn(),
    acquireLocationFreeOriginal: vitest.fn(),
  };
};

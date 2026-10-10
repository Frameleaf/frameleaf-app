import { Mocked, vitest } from 'vitest';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { RepositoryInterface } from 'src/types.js';

export const newForkSchemaRepositoryMock = (): Mocked<RepositoryInterface<AssetChecksumRepository>> => ({
  recordAssetChecksums: vitest.fn(),
  recordExternalScanChecksums: vitest.fn(),
  hasAssetChecksum: vitest.fn((_ownerId: string, _sha1: Buffer, _sha256: Buffer) => Promise.resolve(false)),
  getChecksumTranslations: vitest.fn((_ownerId: string, _sha1Checksums: Buffer[]) => Promise.resolve([])),
});

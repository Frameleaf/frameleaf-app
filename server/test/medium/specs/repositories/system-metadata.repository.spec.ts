import { Kysely } from 'kysely';
import { IntegrityReport, SystemMetadataKey } from 'src/enum.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SystemMetadataRepository.name, () => {
  describe('merge (FL-81 integrity check runs)', () => {
    it('creates the value, then merges fields without dropping the others', async () => {
      const sut = new SystemMetadataRepository(defaultDatabase);
      await sut.delete(SystemMetadataKey.IntegrityCheckRuns);

      await sut.merge(SystemMetadataKey.IntegrityCheckRuns, {
        [IntegrityReport.MissingFile]: { lastRunAt: '2026-09-20T10:00:00.000Z' },
      });
      await Promise.all([
        sut.merge(SystemMetadataKey.IntegrityCheckRuns, {
          [IntegrityReport.UntrackedFile]: { lastRunAt: '2026-09-21T10:00:00.000Z' },
        }),
        sut.merge(SystemMetadataKey.IntegrityCheckRuns, {
          [IntegrityReport.ChecksumFail]: { lastRunAt: '2026-09-22T10:00:00.000Z' },
        }),
      ]);
      await sut.merge(SystemMetadataKey.IntegrityCheckRuns, {
        [IntegrityReport.MissingFile]: { lastRunAt: '2026-09-23T10:00:00.000Z' },
      });

      await expect(sut.get(SystemMetadataKey.IntegrityCheckRuns)).resolves.toEqual({
        [IntegrityReport.MissingFile]: { lastRunAt: '2026-09-23T10:00:00.000Z' },
        [IntegrityReport.UntrackedFile]: { lastRunAt: '2026-09-21T10:00:00.000Z' },
        [IntegrityReport.ChecksumFail]: { lastRunAt: '2026-09-22T10:00:00.000Z' },
      });
    });
  });
});

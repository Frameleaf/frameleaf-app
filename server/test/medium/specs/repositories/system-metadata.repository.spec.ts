import { Kysely } from 'kysely';
import { IntegrityReport, SystemMetadataKey } from 'src/enum.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const run = (runId: string) => ({ runId, startedAt: '2026-09-24T10:00:00.000Z', batches: null, done: 0 });

describe(SystemMetadataRepository.name, () => {
  describe('integrity check runs (FL-81)', () => {
    it('counts concurrent batches without losing one, and completes a run once', async () => {
      const sut = new SystemMetadataRepository(defaultDatabase);
      await sut.delete(SystemMetadataKey.IntegrityCheckRuns);

      await sut.startIntegrityRun(IntegrityReport.MissingFile, run('m1'));
      await sut.startIntegrityRun(IntegrityReport.UntrackedFile, run('u1'));

      // Batches finish before and while the queueing records how many there are.
      await Promise.all(
        Array.from({ length: 8 }, () => sut.updateIntegrityRun(IntegrityReport.MissingFile, 'm1', { finished: 1 })),
      );
      const queued = await sut.updateIntegrityRun(IntegrityReport.MissingFile, 'm1', { batches: 10 });
      expect(queued).toEqual({ ...run('m1'), batches: 10, done: 8 });
      await sut.updateIntegrityRun(IntegrityReport.MissingFile, 'm1', { finished: 1 });
      const last = await sut.updateIntegrityRun(IntegrityReport.MissingFile, 'm1', { finished: 1 });
      expect(last).toEqual({ ...run('m1'), batches: 10, done: 10 });

      const at = new Date('2026-09-24T11:00:00.000Z');
      await expect(sut.completeIntegrityRun(IntegrityReport.MissingFile, 'm1', at)).resolves.toBe(true);
      await expect(sut.completeIntegrityRun(IntegrityReport.MissingFile, 'm1', new Date())).resolves.toBe(false);
      await expect(sut.updateIntegrityRun(IntegrityReport.MissingFile, 'm1', { finished: 1 })).resolves.toBeUndefined();

      await expect(sut.get(SystemMetadataKey.IntegrityCheckRuns)).resolves.toEqual({
        [IntegrityReport.MissingFile]: { lastRunAt: at.toISOString() },
        [IntegrityReport.UntrackedFile]: { current: run('u1') },
      });
    });

    it('keeps the last completed run when a new run starts, and ignores batches of a replaced run', async () => {
      const sut = new SystemMetadataRepository(defaultDatabase);
      await sut.delete(SystemMetadataKey.IntegrityCheckRuns);
      const at = new Date('2026-09-20T09:00:00.000Z');

      await sut.startIntegrityRun(IntegrityReport.ChecksumFail, run('c1'));
      await sut.completeIntegrityRun(IntegrityReport.ChecksumFail, 'c1', at);
      await sut.startIntegrityRun(IntegrityReport.ChecksumFail, run('c2'));
      await sut.startIntegrityRun(IntegrityReport.ChecksumFail, run('c3'));

      await expect(
        sut.updateIntegrityRun(IntegrityReport.ChecksumFail, 'c2', { finished: 1 }),
      ).resolves.toBeUndefined();
      await expect(sut.get(SystemMetadataKey.IntegrityCheckRuns)).resolves.toEqual({
        [IntegrityReport.ChecksumFail]: { lastRunAt: at.toISOString(), current: run('c3') },
      });
    });
  });
});

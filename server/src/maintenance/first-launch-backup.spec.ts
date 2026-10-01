import { DateTime } from 'luxon';
import { Mocked } from 'vitest';
import type { Stats } from 'node:fs';
import { StorageCore } from 'src/cores/storage.core.js';
import { FirstLaunchBackup, FirstLaunchBackupError, RECENT_BACKUP_HOURS } from 'src/maintenance/first-launch-backup.js';
import { DatabaseBackupService, DatabaseBackupVerificationError } from 'src/services/database-backup.service.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const NOW = DateTime.fromObject({ year: 2026, month: 10, day: 1, hour: 12 });
const GIB = 1024 ** 3;

/** A routine backup name taken `hours` before NOW (local time, as the server writes it). */
const backupAt = (hours: number, label = '') =>
  `immich-db-backup-${NOW.minus({ hours }).toFormat("yyyyLLdd'T'HHmmss")}${label}-v3.1.0-pg14.19.sql.gz`;

describe(FirstLaunchBackup.name, () => {
  let mocks: ServiceMocks;
  let backups: Mocked<Pick<DatabaseBackupService, 'createDatabaseBackup' | 'verifyDatabaseBackup'>>;
  let sut: FirstLaunchBackup;

  beforeEach(() => {
    mocks = getMocks();
    backups = {
      createDatabaseBackup: vi.fn().mockResolvedValue(`/data/backups/${backupAt(0, '-pre-upgrade')}`),
      verifyDatabaseBackup: vi.fn().mockResolvedValue(undefined),
    };
    sut = new FirstLaunchBackup(
      {
        logger: mocks.logger as never,
        database: mocks.database as never,
        storage: mocks.storage as never,
        config: mocks.config,
      },
      backups as unknown as DatabaseBackupService,
      { now: () => NOW.toJSDate() },
    );

    mocks.database.isFirstLaunchOnOfficialLibrary.mockResolvedValue(true);
    mocks.database.getDumpSizeEstimate.mockResolvedValue(1 * GIB);
    mocks.storage.checkDiskUsage.mockResolvedValue({ available: 10 * GIB, free: 10 * GIB, total: 20 * GIB });
    mocks.storage.readdir.mockResolvedValue([]);
    mocks.storage.stat.mockResolvedValue({ mtime: NOW.minus({ days: 30 }).toJSDate(), size: 100 } as Stats);
  });

  it('waits 24 hours before a backup is too old to skip the copy', () => {
    expect(RECENT_BACKUP_HOURS).toBe(24);
  });

  describe('when it applies', () => {
    it('does nothing on a fresh install or an already-adopted library', async () => {
      mocks.database.isFirstLaunchOnOfficialLibrary.mockResolvedValue(false);

      await expect(sut.run()).resolves.toEqual({ kind: 'not-needed' });

      expect(mocks.storage.readdir).not.toHaveBeenCalled();
      expect(backups.createDatabaseBackup).not.toHaveBeenCalled();
    });

    it('asks the database whether this is the first start on an official library', async () => {
      await expect(sut.isNeeded()).resolves.toBe(true);
      mocks.database.isFirstLaunchOnOfficialLibrary.mockResolvedValue(false);
      await expect(sut.isNeeded()).resolves.toBe(false);
    });
  });

  describe('the skip rule', () => {
    it('takes the copy when there is no earlier backup', async () => {
      const outcome = await sut.run();

      expect(outcome).toEqual({
        kind: 'created',
        backup: { filename: backupAt(0, '-pre-upgrade'), takenAt: expect.any(String) },
      });
      expect(backups.createDatabaseBackup).toHaveBeenCalledWith('', { label: 'pre-upgrade', verify: true });
    });

    it('skips the copy when the newest backup is 23 hours old and complete, and says which one', async () => {
      mocks.storage.readdir.mockResolvedValue([backupAt(30), backupAt(23), 'immich-db-backup-1.sql.gz.tmp']);

      const outcome = await sut.run();

      expect(outcome).toEqual({
        kind: 'skipped',
        backup: { filename: backupAt(23), takenAt: NOW.minus({ hours: 23 }).toISO() },
      });
      expect(backups.verifyDatabaseBackup).toHaveBeenCalledWith(`/data/backups/${backupAt(23)}`);
      expect(backups.createDatabaseBackup).not.toHaveBeenCalled();
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining(backupAt(23)));
    });

    it('takes the copy when the newest backup is 25 hours old', async () => {
      mocks.storage.readdir.mockResolvedValue([backupAt(25), backupAt(40)]);

      await expect(sut.run()).resolves.toMatchObject({ kind: 'created' });

      expect(backups.createDatabaseBackup).toHaveBeenCalledTimes(1);
    });

    it('takes the copy when the newest backup is not a complete dump, without trying older ones', async () => {
      mocks.storage.readdir.mockResolvedValue([backupAt(2), backupAt(3)]);
      backups.verifyDatabaseBackup.mockRejectedValueOnce(new DatabaseBackupVerificationError('truncated'));

      await expect(sut.run()).resolves.toMatchObject({ kind: 'created' });

      expect(backups.verifyDatabaseBackup).toHaveBeenCalledTimes(1);
      expect(backups.verifyDatabaseBackup).toHaveBeenCalledWith(`/data/backups/${backupAt(2)}`);
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining(backupAt(2)));
    });

    it('never counts an unfinished (.tmp) backup, a restore point or an upload', async () => {
      mocks.storage.readdir.mockResolvedValue([
        `${backupAt(1)}.tmp`,
        `restore-point-${backupAt(1)}`,
        `uploaded-${backupAt(1)}`,
        `cloud-backup-${backupAt(1)}`,
      ]);

      await expect(sut.run()).resolves.toMatchObject({ kind: 'created' });

      expect(backups.verifyDatabaseBackup).not.toHaveBeenCalled();
    });

    it('counts an earlier pre-upgrade copy of the last 24 hours, so a restart after a failed upgrade does not copy again', async () => {
      mocks.storage.readdir.mockResolvedValue([backupAt(1, '-pre-upgrade')]);

      await expect(sut.run()).resolves.toMatchObject({ kind: 'skipped' });
    });

    it('falls back to the modification time when the name has no usable timestamp', async () => {
      mocks.storage.readdir.mockResolvedValue(['immich-db-backup-20261399T999999-v3.1.0-pg14.sql.gz']);
      mocks.storage.stat.mockResolvedValue({ mtime: NOW.minus({ hours: 2 }).toJSDate(), size: 100 } as Stats);

      await expect(sut.run()).resolves.toMatchObject({
        kind: 'skipped',
        backup: { takenAt: NOW.minus({ hours: 2 }).toISO() },
      });
    });

    it('falls back to the modification time when the name says the future', async () => {
      mocks.storage.readdir.mockResolvedValue([backupAt(-5)]);
      mocks.storage.stat.mockResolvedValue({ mtime: NOW.minus({ hours: 30 }).toJSDate(), size: 100 } as Stats);

      await expect(sut.run()).resolves.toMatchObject({ kind: 'created' });
    });

    it('reads old-style names with epoch milliseconds', async () => {
      mocks.storage.readdir.mockResolvedValue([`immich-db-backup-${NOW.minus({ hours: 3 }).toMillis()}.sql.gz`]);

      await expect(sut.run()).resolves.toMatchObject({ kind: 'skipped' });
    });

    it('treats a missing backups folder as no backups', async () => {
      mocks.storage.readdir.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      await expect(sut.run()).resolves.toMatchObject({ kind: 'created' });

      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith('/data/backups');
    });
  });

  describe('taking the copy', () => {
    it('removes an unfinished copy a restart interrupted before starting over', async () => {
      mocks.storage.readdir.mockResolvedValue([`${backupAt(1, '-pre-upgrade')}.tmp`, `${backupAt(1)}.tmp`]);

      await sut.run();

      expect(mocks.storage.unlink).toHaveBeenCalledWith(`/data/backups/${backupAt(1, '-pre-upgrade')}.tmp`);
      // a routine backup's leftovers are the routine cleanup's business
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(`/data/backups/${backupAt(1)}.tmp`);
      expect(mocks.storage.unlink.mock.invocationCallOrder[0]).toBeLessThan(
        backups.createDatabaseBackup.mock.invocationCallOrder[0],
      );
    });

    it('checks the free space first and refuses when the copy would not fit', async () => {
      mocks.database.getDumpSizeEstimate.mockResolvedValue(8 * GIB);
      mocks.storage.checkDiskUsage.mockResolvedValue({ available: 4 * GIB, free: 4 * GIB, total: 20 * GIB });

      const error = await sut.run().catch((error: unknown) => error);

      expect(error).toBeInstanceOf(FirstLaunchBackupError);
      expect(error).toMatchObject({ reason: 'disk-space', availableBytes: 4 * GIB });
      expect((error as FirstLaunchBackupError).requiredBytes).toBeGreaterThan(8 * GIB);
      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledWith('/data/backups');
      expect(backups.createDatabaseBackup).not.toHaveBeenCalled();
    });

    it('reports a dump that ran out of space as a space problem', async () => {
      backups.createDatabaseBackup.mockRejectedValue(
        Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
      );

      await expect(sut.run()).rejects.toMatchObject({ reason: 'disk-space' });
    });

    it('reports any other dump failure as a failed backup', async () => {
      backups.createDatabaseBackup.mockRejectedValue(new Error('pg_dump non-zero exit code (1)'));

      const error = await sut.run().catch((error: unknown) => error);

      expect(error).toBeInstanceOf(FirstLaunchBackupError);
      expect(error).toMatchObject({ reason: 'backup-failed' });
      expect((error as Error).message).toContain('pg_dump non-zero exit code (1)');
    });

    it('reports a copy that failed verification as a failed backup', async () => {
      backups.createDatabaseBackup.mockRejectedValue(new DatabaseBackupVerificationError('truncated'));

      await expect(sut.run()).rejects.toMatchObject({ reason: 'backup-failed' });
    });

    it('reports progress while the copy is made', async () => {
      const progress: string[] = [];

      await sut.run({
        onProgress: (state) => {
          progress.push(state);
        },
      });

      expect(progress).toEqual(['checking', 'backing-up']);
    });

    it('sets the media location when the server has not yet', async () => {
      StorageCore.reset();
      StorageCore.setMediaLocation(undefined as unknown as string);
      mocks.config.getEnv.mockReturnValue({
        ...mocks.config.getEnv(),
        storage: { ...mocks.config.getEnv().storage, mediaLocation: '/srv/library' },
      });

      await sut.run();

      expect(mocks.storage.readdir).toHaveBeenCalledWith('/srv/library/backups');
      StorageCore.setMediaLocation('/data');
    });
  });
});

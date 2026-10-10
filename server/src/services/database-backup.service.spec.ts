import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Duplex, PassThrough, Readable } from 'node:stream';
import { createGunzip, createGzip, gzipSync } from 'node:zlib';
import type { Stats } from 'node:fs';
import type { QueueExecution } from 'src/queue/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { ImmichWorker, JobStatus, StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { MaintenanceHealthRepository } from 'src/maintenance/maintenance-health.repository.js';
import { queueExecution } from 'src/queue/context.js';
import { DatabaseBackupService, restoreVerificationDue } from 'src/services/database-backup.service.js';
import { isValidDatabaseRoutineBackupName } from 'src/utils/database-backups.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { AutoMocked, ServiceMocks, automock, getMocks, mockDuplex, mockSpawn } from 'test/utils.js';

describe(DatabaseBackupService.name, () => {
  let sut: DatabaseBackupService;
  let mocks: ServiceMocks;
  let maintenanceHealthRepositoryMock: AutoMocked<MaintenanceHealthRepository>;

  beforeEach(() => {
    mocks = getMocks();
    maintenanceHealthRepositoryMock = automock(MaintenanceHealthRepository, {
      args: [mocks.logger],
      strict: false,
    });
    sut = new DatabaseBackupService(
      mocks.logger as never,
      mocks.storage as never,
      mocks.config,
      mocks.systemMetadata as never,
      mocks.process,
      mocks.database as never,
      mocks.user as never,
      mocks.cron as never,
      mocks.job as never,
      maintenanceHealthRepositoryMock as never,
    );
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onBootstrapEvent', () => {
    it('should init cron job and handle config changes', async () => {
      mocks.database.tryLock.mockResolvedValue(true);
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.backupEnabled as SystemConfig });

      expect(mocks.cron.create).toHaveBeenCalled();
    });

    it('should not initialize backup database cron job when lock is taken', async () => {
      mocks.database.tryLock.mockResolvedValue(false);

      await sut.onConfigInit({ newConfig: systemConfigStub.backupEnabled as SystemConfig });

      expect(mocks.cron.create).not.toHaveBeenCalled();
    });

    it('should not initialise backup database job when running on microservices', async () => {
      mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
      await sut.onConfigInit({ newConfig: systemConfigStub.backupEnabled as SystemConfig });

      expect(mocks.cron.create).not.toHaveBeenCalled();
    });
  });

  describe('onConfigUpdateEvent', () => {
    beforeEach(async () => {
      mocks.database.tryLock.mockResolvedValue(true);
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: defaults });
    });

    it('should update cron job if backup is enabled', () => {
      mocks.cron.update.mockResolvedValue();

      sut.onConfigUpdate({
        oldConfig: defaults,
        newConfig: {
          backup: {
            database: {
              enabled: true,
              cronExpression: '0 1 * * *',
            },
          },
        } as SystemConfig,
      });

      expect(mocks.cron.update).toHaveBeenCalledWith({ name: 'backupDatabase', expression: '0 1 * * *', start: true });
      expect(mocks.cron.update).toHaveBeenCalled();
    });

    it('should do nothing if instance does not have the backup database lock', async () => {
      mocks.database.tryLock.mockResolvedValue(false);
      await sut.onConfigInit({ newConfig: defaults });
      sut.onConfigUpdate({ newConfig: systemConfigStub.backupEnabled as SystemConfig, oldConfig: defaults });
      expect(mocks.cron.update).not.toHaveBeenCalled();
    });
  });

  describe('cleanupDatabaseBackups', () => {
    it('should do nothing if not reached keepLastAmount', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
      mocks.storage.readdir.mockResolvedValue(['frameleaf-db-backup-1.sql.gz']);
      await sut.cleanupDatabaseBackups();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should remove failed backup files', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
      //`frameleaf-db-backup-${DateTime.now().toFormat("yyyyLLdd'T'HHmmss")}-v${serverVersion.toString()}-pg${databaseVersion.split(' ')[0]}.sql.gz.tmp`,
      mocks.storage.readdir.mockResolvedValue([
        'frameleaf-db-backup-123.sql.gz.tmp',
        `frameleaf-db-backup-${DateTime.fromISO('2025-07-25T11:02:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg19.1.sql.gz.tmp`,
        `frameleaf-db-backup-${DateTime.fromISO('2025-07-27T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg19.1.sql.gz`,
        `frameleaf-db-backup-${DateTime.fromISO('2025-07-29T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg19.1.sql.gz.tmp`,
      ]);
      await sut.cleanupDatabaseBackups();
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(3);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/frameleaf-db-backup-123.sql.gz.tmp`,
      );
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/frameleaf-db-backup-20250725T110216-v1.234.5-pg19.1.sql.gz.tmp`,
      );
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/frameleaf-db-backup-20250729T110116-v1.234.5-pg19.1.sql.gz.tmp`,
      );
    });

    it('should remove old backup files over keepLastAmount', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
      mocks.storage.readdir.mockResolvedValue(['frameleaf-db-backup-1.sql.gz', 'frameleaf-db-backup-2.sql.gz']);
      await sut.cleanupDatabaseBackups();
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(1);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/frameleaf-db-backup-1.sql.gz`,
      );
    });

    it('should remove old backup files over keepLastAmount and failed backups', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
      mocks.storage.readdir.mockResolvedValue([
        `frameleaf-db-backup-${DateTime.fromISO('2025-07-25T11:02:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg19.1.sql.gz.tmp`,
        `frameleaf-db-backup-${DateTime.fromISO('2025-07-27T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg19.1.sql.gz`,
        'frameleaf-db-backup-1753789649000.sql.gz',
        `frameleaf-db-backup-${DateTime.fromISO('2025-07-29T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg19.1.sql.gz`,
      ]);
      await sut.cleanupDatabaseBackups();
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(3);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/frameleaf-db-backup-1753789649000.sql.gz`,
      );
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/frameleaf-db-backup-20250725T110216-v1.234.5-pg19.1.sql.gz.tmp`,
      );
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/frameleaf-db-backup-20250727T110116-v1.234.5-pg19.1.sql.gz`,
      );
    });
  });

  describe('handleBackupDatabase / createDatabaseBackup', () => {
    const completeDump =
      '--\n-- PostgreSQL database dump\n--\nCREATE TABLE a ();\n--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict abc\n';

    // FL-298: the backups folder is a real temporary directory, so a test can prove which files a backup leaves.
    let folder: string;
    const local = (file: string) => join(folder, basename(file));
    const leftFiles = () => readdir(folder);

    beforeEach(async () => {
      folder = await mkdtemp(join(tmpdir(), 'fl298-backups-'));
      mocks.storage.readdir.mockResolvedValue([]);
      mocks.process.spawn.mockReturnValue(mockSpawn(0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementation((command) =>
        command === 'gzip' ? createGzip() : mockDuplex()('pg_dump', 0, completeDump, ''),
      );
      mocks.storage.createWriteStream.mockImplementation((file) => createWriteStream(local(file)));
      mocks.storage.rename.mockImplementation((from, to) => rename(local(from), local(to)));
      mocks.storage.unlink.mockImplementation((file) => unlink(local(file)));
      mocks.storage.stat.mockImplementation((file) => stat(local(file)));
      mocks.storage.createPlainReadStream.mockImplementation((file) => createReadStream(local(file)));
      mocks.storage.createGunzip.mockImplementation(() => createGunzip());
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
    });

    afterEach(async () => {
      await rm(folder, { recursive: true, force: true });
    });

    it('waits for a cancelled dump to close before cleanup or returning a retryable failure', async () => {
      const { promise: reading, resolve: readStarted } = Promise.withResolvers<void>();
      const { promise: destroying, resolve: destroyStarted } = Promise.withResolvers<void>();
      const { promise: canClose, resolve: close } = Promise.withResolvers<void>();
      const dump = new Duplex({
        read() {
          readStarted();
        },
        write(_chunk, _encoding, done) {
          done();
        },
        destroy(error, done) {
          destroyStarted();
          void canClose.then(() => done(error));
        },
      });
      mocks.process.spawnDuplexStream.mockImplementation((command) => (command === 'gzip' ? createGzip() : dump));
      const controller = new AbortController();
      let returned = false;
      const task = sut.createDatabaseBackup('', { signal: controller.signal }).finally(() => {
        returned = true;
      });
      const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' });
      await reading;
      controller.abort();
      await destroying;
      expect(returned).toBe(false);
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
      close();
      await rejection;
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(await leftFiles()).toEqual([]);
      expect(mocks.process.spawnDuplexStream.mock.calls.every((call) => call[2]?.signal === controller.signal)).toBe(
        true,
      );
    });

    it('keeps a verified backup and no temporary file on success (FL-298)', async () => {
      const path = await sut.createDatabaseBackup();

      expect(await leftFiles()).toEqual([basename(path)]);
      expect(path).toMatch(/\/frameleaf-db-backup-\d{8}T\d{6}-v[\d.]+-pg19(?:beta\d+|rc\d+|[\d.]+)\.sql\.gz$/);
    });

    it('keeps distinct verified queued attempts in the same second and rotates them as routine backups', async () => {
      const now = DateTime.now();
      vi.spyOn(DateTime, 'now').mockReturnValue(now);
      try {
        await sut.handleBackupDatabase();
        const [first] = await leftFiles();
        await sut.handleBackupDatabase();
        const files = await leftFiles();
        expect(files).toHaveLength(2);
        expect(files).toContain(first);
        expect(files.every((file) => !!isValidDatabaseRoutineBackupName(file))).toBe(true);
        for (const file of files) await expect(sut.verifyDatabaseBackup(local(file))).resolves.toBeUndefined();
        // keepLastAmount=1 must include the new unique routine names, not exempt them as safety copies.
        mocks.storage.readdir.mockResolvedValue(files);
        await sut.cleanupDatabaseBackups();
        expect(await leftFiles()).toHaveLength(1);
      } finally {
        vi.mocked(DateTime.now).mockRestore();
      }
    });

    it('verifies every routine backup before renaming it (FL-298)', async () => {
      const order: string[] = [];
      mocks.storage.createPlainReadStream.mockImplementation((file) => {
        order.push(`verify ${basename(file)}`);
        return createReadStream(local(file));
      });
      mocks.storage.rename.mockImplementation((from, to) => {
        order.push(`rename ${basename(from)}`);
        return rename(local(from), local(to));
      });

      const path = await sut.createDatabaseBackup();

      expect(order).toEqual([`verify ${basename(path)}.tmp`, `rename ${basename(path)}.tmp`]);
    });

    it('fails and leaves no backup file when the compressor exits 0 with no output (FL-298)', async () => {
      // Apple gzip rejects --rsyncable, prints its usage and exits 0 without compressing anything
      mocks.process.spawnDuplexStream.mockImplementation((command) =>
        command === 'gzip'
          ? mockDuplex()('gzip', 0, '', 'gzip: unrecognized option `--rsyncable`')
          : mockDuplex()('pg_dump', 0, completeDump, ''),
      );

      await expect(sut.handleBackupDatabase()).rejects.toThrow('is empty');

      expect(await leftFiles()).toEqual([]);
      expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('Database Backup Failure'));
    });

    it('fails and leaves no backup file when the compressor fails (FL-298)', async () => {
      mocks.process.spawnDuplexStream.mockImplementation((command) =>
        command === 'gzip'
          ? mockDuplex()('gzip', 1, '', 'gzip: unrecognized option')
          : mockDuplex()('pg_dump', 0, completeDump, ''),
      );

      await expect(sut.handleBackupDatabase()).rejects.toThrow('gzip non-zero exit code (1)');

      expect(await leftFiles()).toEqual([]);
      expect(mocks.storage.rename).not.toHaveBeenCalled();
    });

    it('fails and leaves no backup file when the compressor is stopped by a signal (FL-298)', async () => {
      mocks.process.spawnDuplexStream.mockImplementation((command) =>
        command === 'gzip'
          ? mockDuplex()('gzip', 0, '', '', new Error('gzip was stopped by signal SIGKILL'))
          : mockDuplex()('pg_dump', 0, completeDump, ''),
      );

      await expect(sut.handleBackupDatabase()).rejects.toThrow('gzip was stopped by signal SIGKILL');

      expect(await leftFiles()).toEqual([]);
    });

    it('fails and leaves no backup file when the dump fails (FL-298)', async () => {
      mocks.process.spawnDuplexStream.mockImplementation((command) =>
        command === 'gzip' ? createGzip() : mockDuplex()('pg_dump', 1, '', 'pg_dump: error: connection refused'),
      );

      await expect(sut.handleBackupDatabase()).rejects.toThrow('pg_dump non-zero exit code (1)');

      expect(await leftFiles()).toEqual([]);
      expect(mocks.storage.rename).not.toHaveBeenCalled();
    });

    it('fails and leaves no backup file when the dump stops before its end (FL-298)', async () => {
      mocks.process.spawnDuplexStream.mockImplementation((command) =>
        command === 'gzip'
          ? createGzip()
          : mockDuplex()('pg_dump', 0, '--\n-- PostgreSQL database dump\n--\nCREATE TABLE a ();\n', ''),
      );

      await expect(sut.handleBackupDatabase()).rejects.toThrow('does not finish like a complete dump');

      expect(await leftFiles()).toEqual([]);
    });

    it('should sanitize DB_URL (remove uselibpqcompat) before calling pg_dumpall', async () => {
      // create a service instance with a URL connection that includes libpqcompat
      const dbUrl = 'postgresql://postgres:pwd@host:5432/immich?sslmode=require&uselibpqcompat=true';
      const configMock = {
        getEnv: () => ({ database: { config: { connectionType: 'url', url: dbUrl }, skipMigrations: false } }),
        getWorker: () => ImmichWorker.Api,
        isDev: () => false,
      } as unknown as any;

      sut = new DatabaseBackupService(
        mocks.logger as never,
        mocks.storage as never,
        configMock as never,
        mocks.systemMetadata as never,
        mocks.process,
        mocks.database as never,
        mocks.user as never,
        mocks.cron as never,
        mocks.job as never,
        void 0 as never,
      );

      mocks.database.getPostgresVersion.mockResolvedValue('19.0');

      await sut.handleBackupDatabase();

      expect(mocks.process.spawnDuplexStream).toHaveBeenCalled();
      const call = mocks.process.spawnDuplexStream.mock.calls[0];
      const args = call[1] as string[];
      expect(args).toMatchInlineSnapshot(`
        [
          "postgresql://postgres:pwd@host:5432/immich?sslmode=require",
          "--clean",
          "--if-exists",
        ]
      `);
    });

    it('should run a database backup successfully', async () => {
      const result = await sut.handleBackupDatabase();
      expect(result).toBe(JobStatus.Success);
      expect(mocks.storage.createWriteStream).toHaveBeenCalled();
    });

    it('should rename file on success', async () => {
      const result = await sut.handleBackupDatabase();
      expect(result).toBe(JobStatus.Success);
      expect(mocks.storage.rename).toHaveBeenCalled();
    });

    it('should fail if pg_dump fails', async () => {
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('pg_dump', 1, '', 'error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('pg_dump non-zero exit code (1)');
    });

    it('should not rename file if pgdump fails and gzip succeeds', async () => {
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('pg_dump', 1, '', 'error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('pg_dump non-zero exit code (1)');
      expect(mocks.storage.rename).not.toHaveBeenCalled();
    });

    it('should fail if gzip fails', async () => {
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('pg_dump', 0, 'data', ''));
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('gzip', 1, '', 'error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('gzip non-zero exit code (1)');
    });

    it('should fail if write stream fails', async () => {
      mocks.storage.createWriteStream.mockImplementation(() => {
        throw new Error('error');
      });
      await expect(sut.handleBackupDatabase()).rejects.toThrow('error');
    });

    it('should destroy the spawned processes if the write stream fails', async () => {
      const spawned: Duplex[] = [];
      mocks.process.spawnDuplexStream.mockImplementation(() => {
        const duplex = mockDuplex()('command', 0, 'data', '');
        spawned.push(duplex);
        return duplex;
      });
      mocks.storage.createWriteStream.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      await expect(sut.handleBackupDatabase()).rejects.toThrow('ENOENT');

      expect(spawned).toHaveLength(2);
      for (const stream of spawned) {
        expect(stream.destroyed).toBe(true);
      }
    });

    it('should fail if rename fails', async () => {
      mocks.storage.rename.mockRejectedValue(new Error('error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('error');
    });

    it('should ignore unlink failing and still return failed job status', async () => {
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('pg_dump', 1, '', 'error'));
      mocks.storage.unlink.mockRejectedValue(new Error('error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('pg_dump non-zero exit code (1)');
      expect(mocks.storage.unlink).toHaveBeenCalled();
    });

    it.each`
      postgresVersion                           | expectedVersion
      ${'19beta4 (Debian 19~beta4-1.pgdg12+1)'} | ${19}
      ${'19rc1'}                                | ${19}
      ${'19.0'}                                 | ${19}
      ${'19.2'}                                 | ${19}
    `(
      `should use pg_dump $expectedVersion with postgres version $postgresVersion`,
      async ({ postgresVersion, expectedVersion }) => {
        mocks.database.getPostgresVersion.mockResolvedValue(postgresVersion);
        await sut.handleBackupDatabase();
        expect(mocks.process.spawnDuplexStream).toHaveBeenCalledWith(
          `/usr/lib/postgresql/${expectedVersion}/bin/pg_dump`,
          expect.any(Array),
          expect.any(Object),
        );
      },
    );
    it.each`
      postgresVersion
      ${'13.99.99'}
      ${'18.0.0'}
      ${'20.0.0'}
    `(`should fail if postgres version $postgresVersion is not supported`, async ({ postgresVersion }) => {
      mocks.database.getPostgresVersion.mockResolvedValue(postgresVersion);
      const result = await sut.handleBackupDatabase();
      expect(mocks.process.spawn).not.toHaveBeenCalled();
      expect(result).toBe(JobStatus.Failed);
    });
  });

  describe('buildPostgresLaunchArguments', () => {
    describe('default config', () => {
      it('should generate pg_dump arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('pg_dump')).resolves.toMatchInlineSnapshot(`
        {
          "args": [
            "--username",
            "postgres",
            "--host",
            "database",
            "--port",
            "5432",
            "frameleaf",
            "--clean",
            "--if-exists",
          ],
          "bin": "/usr/lib/postgresql/19/bin/pg_dump",
          "databaseMajorVersion": 19,
          "databasePassword": "postgres",
          "databaseUsername": "postgres",
          "databaseVersion": "19beta4 (Debian 19~beta4-1.pgdg12+1)",
        }
      `);
      });

      it('should generate psql arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('psql')).resolves.toMatchInlineSnapshot(`
        {
          "args": [
            "--username",
            "postgres",
            "--host",
            "database",
            "--port",
            "5432",
            "--dbname",
            "frameleaf",
            "--echo-all",
            "--output=/dev/null",
          ],
          "bin": "/usr/lib/postgresql/19/bin/psql",
          "databaseMajorVersion": 19,
          "databasePassword": "postgres",
          "databaseUsername": "postgres",
          "databaseVersion": "19beta4 (Debian 19~beta4-1.pgdg12+1)",
        }
      `);
      });

      it('should generate psql (single transaction) arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('psql', { singleTransaction: true })).resolves
          .toMatchInlineSnapshot(`
        {
          "args": [
            "--username",
            "postgres",
            "--host",
            "database",
            "--port",
            "5432",
            "--dbname",
            "frameleaf",
            "--single-transaction",
            "--set",
            "ON_ERROR_STOP=on",
            "--echo-all",
            "--output=/dev/null",
          ],
          "bin": "/usr/lib/postgresql/19/bin/psql",
          "databaseMajorVersion": 19,
          "databasePassword": "postgres",
          "databaseUsername": "postgres",
          "databaseVersion": "19beta4 (Debian 19~beta4-1.pgdg12+1)",
        }
      `);
      });
    });

    describe('using custom parts', () => {
      beforeEach(() => {
        const configMock = {
          getEnv: () => ({
            database: {
              config: {
                connectionType: 'parts',
                host: 'myhost',
                port: 1234,
                username: 'mypg',
                password: 'mypwd',
                database: 'myimmich',
              },
              skipMigrations: false,
            },
          }),
          getWorker: () => ImmichWorker.Api,
          isDev: () => false,
        } as unknown as any;

        sut = new DatabaseBackupService(
          mocks.logger as never,
          mocks.storage as never,
          configMock as never,
          mocks.systemMetadata as never,
          mocks.process,
          mocks.database as never,
          mocks.user as never,
          mocks.cron as never,
          mocks.job as never,
          void 0 as never,
        );
      });

      it('should generate pg_dump arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('pg_dump')).resolves.toMatchInlineSnapshot(`
          {
            "args": [
              "--username",
              "mypg",
              "--host",
              "myhost",
              "--port",
              "1234",
              "myimmich",
              "--clean",
              "--if-exists",
            ],
            "bin": "/usr/lib/postgresql/19/bin/pg_dump",
            "databaseMajorVersion": 19,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "19beta4 (Debian 19~beta4-1.pgdg12+1)",
          }
        `);
      });

      it('should generate psql (single transaction) arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('psql', { singleTransaction: true })).resolves
          .toMatchInlineSnapshot(`
          {
            "args": [
              "--username",
              "mypg",
              "--host",
              "myhost",
              "--port",
              "1234",
              "--dbname",
              "myimmich",
              "--single-transaction",
              "--set",
              "ON_ERROR_STOP=on",
              "--echo-all",
              "--output=/dev/null",
            ],
            "bin": "/usr/lib/postgresql/19/bin/psql",
            "databaseMajorVersion": 19,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "19beta4 (Debian 19~beta4-1.pgdg12+1)",
          }
        `);
      });
    });

    describe('using URL', () => {
      beforeEach(() => {
        const dbUrl = 'postgresql://mypg:mypwd@myhost:1234/myimmich?sslmode=require&uselibpqcompat=true';
        const configMock = {
          getEnv: () => ({ database: { config: { connectionType: 'url', url: dbUrl }, skipMigrations: false } }),
          getWorker: () => ImmichWorker.Api,
          isDev: () => false,
        } as unknown as any;

        sut = new DatabaseBackupService(
          mocks.logger as never,
          mocks.storage as never,
          configMock as never,
          mocks.systemMetadata as never,
          mocks.process,
          mocks.database as never,
          mocks.user as never,
          mocks.cron as never,
          mocks.job as never,
          void 0 as never,
        );
      });

      it('should generate pg_dump arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('pg_dump')).resolves.toMatchInlineSnapshot(`
          {
            "args": [
              "postgresql://mypg:mypwd@myhost:1234/myimmich?sslmode=require",
              "--clean",
              "--if-exists",
            ],
            "bin": "/usr/lib/postgresql/19/bin/pg_dump",
            "databaseMajorVersion": 19,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "19beta4 (Debian 19~beta4-1.pgdg12+1)",
          }
        `);
      });

      it('should generate psql (single transaction) arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('psql', { singleTransaction: true })).resolves
          .toMatchInlineSnapshot(`
          {
            "args": [
              "--dbname",
              "postgresql://mypg:mypwd@myhost:1234/myimmich?sslmode=require",
              "--single-transaction",
              "--set",
              "ON_ERROR_STOP=on",
              "--echo-all",
              "--output=/dev/null",
            ],
            "bin": "/usr/lib/postgresql/19/bin/psql",
            "databaseMajorVersion": 19,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "19beta4 (Debian 19~beta4-1.pgdg12+1)",
          }
        `);
      });
    });

    describe('using bad URL', () => {
      beforeEach(() => {
        const dbUrl = 'post://gresql://mypg:myp@wd@myhos:t:1234/myimmich?sslmode=require&uselibpqcompat=true';
        const configMock = {
          getEnv: () => ({ database: { config: { connectionType: 'url', url: dbUrl }, skipMigrations: false } }),
          getWorker: () => ImmichWorker.Api,
          isDev: () => false,
        } as unknown as any;

        sut = new DatabaseBackupService(
          mocks.logger as never,
          mocks.storage as never,
          configMock as never,
          mocks.systemMetadata as never,
          mocks.process,
          mocks.database as never,
          mocks.user as never,
          mocks.cron as never,
          mocks.job as never,
          void 0 as never,
        );
      });

      it('should fallback to reasonable defaults', async () => {
        await expect(sut.buildPostgresLaunchArguments('psql')).resolves.toMatchInlineSnapshot(`
          {
            "args": [
              "--dbname",
              "post://gresql//mypg:myp@wd@myhos:t:1234/myimmich?sslmode=require",
              "--echo-all",
              "--output=/dev/null",
            ],
            "bin": "/usr/lib/postgresql/19/bin/psql",
            "databaseMajorVersion": 19,
            "databasePassword": "",
            "databaseUsername": "postgres",
            "databaseVersion": "19beta4 (Debian 19~beta4-1.pgdg12+1)",
          }
        `);
      });
    });

    describe('using an unparsable URL', () => {
      beforeEach(() => {
        // unix domain socket URLs cannot be parsed by `new URL`
        const dbUrl = 'socket://mypg:mypwd@/var/run/postgresql?db=myimmich';
        const configMock = {
          getEnv: () => ({ database: { config: { connectionType: 'url', url: dbUrl }, skipMigrations: false } }),
          getWorker: () => ImmichWorker.Api,
          isDev: () => false,
        } as unknown as any;

        sut = new DatabaseBackupService(
          mocks.logger as never,
          mocks.storage as never,
          configMock as never,
          mocks.systemMetadata as never,
          mocks.process,
          mocks.database as never,
          mocks.user as never,
          mocks.cron as never,
          mocks.job as never,
          void 0 as never,
        );
      });

      it('should fallback to reasonable defaults', async () => {
        await expect(sut.buildPostgresLaunchArguments('pg_dump')).resolves.toMatchInlineSnapshot(`
          {
            "args": [
              "socket://mypg:mypwd@/var/run/postgresql?db=myimmich",
              "--clean",
              "--if-exists",
            ],
            "bin": "/usr/lib/postgresql/19/bin/pg_dump",
            "databaseMajorVersion": 19,
            "databasePassword": "",
            "databaseUsername": "postgres",
            "databaseVersion": "19beta4 (Debian 19~beta4-1.pgdg12+1)",
          }
        `);
      });
    });
  });

  describe('uploadBackup', () => {
    it('should reject invalid file names', async () => {
      await expect(sut.uploadBackup({ originalname: 'invalid backup' } as never)).rejects.toThrowError(
        new BadRequestException('Invalid backup name!'),
      );
    });

    it('should write file', async () => {
      await sut.uploadBackup({ originalname: 'path.sql.gz', buffer: 'buffer' } as never);
      expect(mocks.storage.createOrOverwriteFile).toBeCalledWith('/data/backups/uploaded-path.sql.gz', 'buffer');
    });
  });

  describe('downloadBackup', () => {
    it('should reject invalid file names', () => {
      expect(() => sut.downloadBackup('invalid backup')).toThrowError(new BadRequestException('Invalid backup name!'));
    });

    it('should get backup path', () => {
      expect(sut.downloadBackup('hello.sql.gz')).toEqual(
        expect.objectContaining({
          path: '/data/backups/hello.sql.gz',
        }),
      );
    });
  });

  describe('FL-295 pre-upgrade copy and verification', () => {
    const completeDump =
      '--\n-- PostgreSQL database dump\n--\nCREATE TABLE a ();\n--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict abc\n';
    const gzipped = (text: string) => Readable.from([gzipSync(Buffer.from(text))]);

    beforeEach(() => {
      mocks.storage.readdir.mockResolvedValue([]);
      mocks.process.spawnDuplexStream.mockImplementation(() => mockDuplex()('command', 0, 'data', ''));
      mocks.storage.rename.mockResolvedValue();
      mocks.storage.unlink.mockResolvedValue();
      mocks.storage.createWriteStream.mockReturnValue(new PassThrough());
      mocks.storage.createGunzip.mockImplementation(() => createGunzip());
      mocks.storage.stat.mockResolvedValue({ size: 100 } as Stats);
    });

    it('names the copy pre-upgrade, in the backups folder, with the routine timestamp and versions', async () => {
      mocks.database.getPostgresVersion.mockResolvedValue('19.1 (Debian 19.1-1.pgdg12+1)');
      mocks.storage.createPlainReadStream.mockImplementation(() => gzipped(completeDump));

      const path = await sut.createDatabaseBackup('', { label: 'pre-upgrade', verify: true });

      expect(path).toMatch(
        new RegExp(
          String.raw`^${StorageCore.getBaseFolder(StorageFolder.Backups)}/frameleaf-db-backup-\d{8}T\d{6}-pre-upgrade-v[\d.]+-pg19\.1\.sql\.gz$`,
        ),
      );
      expect(mocks.storage.createWriteStream).toHaveBeenCalledWith(`${path}.tmp`);
      expect(mocks.storage.rename).toHaveBeenCalledWith(`${path}.tmp`, path);
    });

    it('verifies the temporary file before renaming it', async () => {
      const order: string[] = [];
      mocks.storage.createPlainReadStream.mockImplementation((file: string) => {
        order.push(`verify ${file}`);
        return gzipped(completeDump);
      });
      mocks.storage.rename.mockImplementation((from: string) => {
        order.push(`rename ${from}`);
        return Promise.resolve();
      });

      const path = await sut.createDatabaseBackup('', { label: 'pre-upgrade', verify: true });

      expect(order).toEqual([`verify ${path}.tmp`, `rename ${path}.tmp`]);
    });

    it.each([
      ['an empty file', () => Readable.from([]), 0, 'empty'],
      ['a file that is not gzip', () => Readable.from([Buffer.from('plain text')]), 10, 'gzip'],
      ['a truncated gzip file', () => Readable.from([gzipSync(Buffer.from(completeDump)).subarray(0, 20)]), 20, 'gzip'],
      [
        'a dump that did not finish',
        () => gzipped('--\n-- PostgreSQL database dump\n--\nCREATE TABLE a ();\n'),
        50,
        'finish',
      ],
      ['a gzip file with no SQL in it', () => gzipped(''), 20, 'empty'],
    ])('refuses %s, removes the temporary file and keeps no copy', async (_, stream, size, reason) => {
      mocks.storage.stat.mockResolvedValue({ size } as Stats);
      mocks.storage.createPlainReadStream.mockImplementation(stream);

      await expect(sut.createDatabaseBackup('', { label: 'pre-upgrade', verify: true })).rejects.toThrow(reason);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledWith(expect.stringMatching(/-pre-upgrade-.*\.sql\.gz\.tmp$/));
    });

    it('verifies routine backups too (FL-298) and leaves them unlabelled', async () => {
      mocks.storage.createPlainReadStream.mockImplementation(() => gzipped(completeDump));

      const path = await sut.createDatabaseBackup();

      expect(path).toMatch(/\/frameleaf-db-backup-\d{8}T\d{6}-v[\d.]+-pg/);
      expect(mocks.storage.createPlainReadStream).toHaveBeenCalledWith(`${path}.tmp`);
    });

    it('accepts a complete database dump and refuses a cluster dump', async () => {
      mocks.storage.createPlainReadStream.mockImplementation(() => gzipped(completeDump));
      await expect(sut.verifyDatabaseBackup('/data/backups/a.sql.gz')).resolves.toBeUndefined();

      mocks.storage.createPlainReadStream.mockImplementation(() =>
        gzipped('-- PostgreSQL database cluster dump\n\n--\n-- PostgreSQL database cluster dump complete\n--\n\n'),
      );
      await expect(sut.verifyDatabaseBackup('/data/backups/b.sql.gz')).rejects.toThrow('does not finish');
    });

    it('never rotates the pre-upgrade copy away, however many routine backups there are', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
      mocks.storage.readdir.mockResolvedValue([
        'frameleaf-db-backup-20250101T000000-pre-upgrade-v3.2.0-pg19.1.sql.gz',
        'frameleaf-db-backup-20250725T110216-v1.234.5-pg19.1.sql.gz',
        'frameleaf-db-backup-20250727T110116-v1.234.5-pg19.1.sql.gz',
        'frameleaf-db-backup-20250729T110116-v1.234.5-pg19.1.sql.gz',
      ]);

      await sut.cleanupDatabaseBackups();

      // keepLastAmount is 1: the two older routine backups go, the pre-upgrade copy stays
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(2);
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(expect.stringContaining('pre-upgrade'));
    });

    it('lists the pre-upgrade copy with the other backups', async () => {
      mocks.storage.readdir.mockResolvedValue([
        'frameleaf-db-backup-20250101T000000-pre-upgrade-v3.2.0-pg19.1.sql.gz',
        'frameleaf-db-backup-20250725T110216-v1.234.5-pg19.1.sql.gz',
      ]);

      const { backups } = await sut.listBackups();

      expect(backups.map(({ filename }) => filename)).toContain(
        'frameleaf-db-backup-20250101T000000-pre-upgrade-v3.2.0-pg19.1.sql.gz',
      );
    });
  });

  describe('listBackups', () => {
    it('should give us all backups', async () => {
      mocks.storage.readdir.mockResolvedValue([
        `frameleaf-db-backup-${DateTime.fromISO('2025-07-25T11:02:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg19.1.sql.gz.tmp`,
        `frameleaf-db-backup-${DateTime.fromISO('2025-07-27T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg19.1.sql.gz`,
        'frameleaf-db-backup-1753789649000.sql.gz',
        `frameleaf-db-backup-${DateTime.fromISO('2025-07-29T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg19.1.sql.gz`,
        // FL-160: a cloud backup run's leftover dump is not a restore point
        'cloud-backup-frameleaf-db-backup-20250730T110116-v1.234.5-pg19.1.sql.gz',
      ]);
      mocks.storage.stat.mockResolvedValue({ size: 1024 } as any);

      await expect(sut.listBackups()).resolves.toMatchObject({
        backups: [
          { filename: 'frameleaf-db-backup-20250729T110116-v1.234.5-pg19.1.sql.gz', filesize: 1024 },
          { filename: 'frameleaf-db-backup-20250727T110116-v1.234.5-pg19.1.sql.gz', filesize: 1024 },
          { filename: 'frameleaf-db-backup-1753789649000.sql.gz', filesize: 1024 },
        ],
      });
    });

    // FL-81: a server that never made a backup has no backups folder yet; that is an empty list,
    // not an error that hides the Maintenance area or the emergency restore flow.
    it('should list no backups when the backups folder does not exist yet', async () => {
      mocks.storage.readdir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      await expect(sut.listBackups()).resolves.toEqual({ backups: [] });
    });

    it('should still fail when the backups folder cannot be read', async () => {
      mocks.storage.readdir.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

      await expect(sut.listBackups()).rejects.toThrow('EACCES');
    });
  });

  describe('deleteBackup', () => {
    it('should reject invalid file names', async () => {
      await expect(sut.deleteBackup(['filename'])).rejects.toThrowError(
        new BadRequestException('Invalid backup name!'),
      );
    });

    it('should unlink the target file', async () => {
      await sut.deleteBackup(['filename.sql']);
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(1);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/filename.sql`,
      );
    });
  });

  describe('restoreDatabaseBackup', () => {
    beforeEach(() => {
      mocks.storage.readdir.mockResolvedValue([]);
      mocks.process.spawn.mockReturnValue(mockSpawn(0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementation(() => mockDuplex()('command', 0, 'data', ''));
      mocks.process.fork.mockImplementation(() => mockSpawn(0, 'Frameleaf Server is listening', ''));
      mocks.storage.rename.mockResolvedValue();
      mocks.storage.unlink.mockResolvedValue();
      mocks.storage.createPlainReadStream.mockImplementation(() => Readable.from(mockData()));
      mocks.storage.createWriteStream.mockReturnValue(new PassThrough());
      mocks.storage.createGzip.mockReturnValue(new PassThrough());
      mocks.storage.createGunzip.mockImplementation(() => new PassThrough());

      const configMock = {
        getEnv: () => ({
          database: {
            config: {
              connectionType: 'parts',
              host: 'myhost',
              port: 1234,
              username: 'mypg',
              password: 'mypwd',
              database: 'myimmich',
            },
            skipMigrations: false,
          },
        }),
        getWorker: () => ImmichWorker.Api,
        isDev: () => false,
      } as unknown as any;

      sut = new DatabaseBackupService(
        mocks.logger as never,
        mocks.storage as never,
        configMock as never,
        mocks.systemMetadata as never,
        mocks.process,
        mocks.database as never,
        mocks.user as never,
        mocks.cron as never,
        mocks.job as never,
        maintenanceHealthRepositoryMock,
      );
      // FL-298: the restore point's own checks are covered under createDatabaseBackup and below
      vi.spyOn(sut, 'verifyDatabaseBackup').mockResolvedValue();
    });

    it('verifies the restore point and stops before the restore when it is not a complete dump (FL-298)', async () => {
      vi.mocked(sut.verifyDatabaseBackup).mockRestore();
      mocks.storage.stat.mockResolvedValue({ size: 0 } as Stats);

      await expect(sut.restoreDatabaseBackup('development-filename.sql')).rejects.toThrow(
        'The backup is not a complete dump',
      );

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledWith(expect.stringMatching(/restore-point-.*\.sql\.gz\.tmp$/));
      // only the restore point's pg_dump and gzip ran; psql never did
      expect(mocks.process.spawnDuplexStream).toHaveBeenCalledTimes(2);
      expect(mocks.process.spawnDuplexStream).not.toHaveBeenCalledWith(
        expect.stringContaining('psql'),
        expect.anything(),
        expect.anything(),
      );
    });
    describe('safety backup', () => {
      const restorePoint = expect.stringContaining('restore-point-');

      it('keeps the restore point by default', async () => {
        mocks.user.hasAdmin.mockResolvedValue(true);

        await sut.restoreDatabaseBackup('development-filename.sql');

        expect(mocks.storage.unlink).not.toHaveBeenCalledWith(restorePoint);
      });

      it('removes the restore point after a successful restore when it is not to be kept', async () => {
        mocks.user.hasAdmin.mockResolvedValue(true);

        await sut.restoreDatabaseBackup('development-filename.sql', undefined, { keepSafetyBackup: false });

        expect(mocks.storage.unlink).toHaveBeenCalledWith(restorePoint);
      });

      it('keeps the restore point after a failed restore even when it was not to be kept', async () => {
        mocks.user.hasAdmin.mockResolvedValue(false);

        await expect(
          sut.restoreDatabaseBackup('development-filename.sql', undefined, { keepSafetyBackup: false }),
        ).rejects.toThrow('Server health check failed, no admin exists.');

        expect(mocks.storage.unlink).not.toHaveBeenCalledWith(restorePoint);
      });
    });

    it('refuses a backup from a newer server before changing anything (FL-81)', async () => {
      await expect(
        sut.restoreDatabaseBackup('frameleaf-db-backup-20260101T000000-v999.0.0-pg19.1.sql.gz'),
      ).rejects.toThrow('This backup was made by a newer server (v999.0.0)');

      expect(mocks.process.spawnDuplexStream).not.toHaveBeenCalled();
      expect(mocks.storage.createWriteStream).not.toHaveBeenCalled();
    });

    it.each([
      [
        'an Immich ledger',
        '-- Dumped from database version 19beta4\nCREATE TABLE public.kysely_migrations (name text);\n-- PostgreSQL database dump complete\n',
      ],
      [
        'a legacy sidecar',
        '-- Dumped from database version 19beta4\nCREATE SCHEMA immich_fork;\nCREATE TABLE public.frameleaf_migrations (name text);\n-- PostgreSQL database dump complete\n',
      ],
      [
        'an older PostgreSQL dump',
        '-- Dumped from database version 18.4\nCREATE TABLE public.frameleaf_migrations (name text);\n-- PostgreSQL database dump complete\n',
      ],
      [
        'a truncated dump',
        '-- Dumped from database version 19beta4\nCREATE TABLE public.frameleaf_migrations (name text);\n',
      ],
      [
        'a cluster dump',
        '-- Dumped from database version 19beta4\nCREATE TABLE public.frameleaf_migrations (name text);\n-- PostgreSQL database cluster dump complete\n',
      ],
    ])('rejects %s before creating a safety backup or executing restore SQL', async (_name, dump) => {
      mocks.storage.createPlainReadStream.mockImplementation(() => Readable.from([dump]));

      await expect(sut.restoreDatabaseBackup('candidate.sql')).rejects.toThrow();

      expect(mocks.process.spawnDuplexStream).not.toHaveBeenCalled();
      expect(mocks.database.runMigrations).not.toHaveBeenCalled();
      expect(mocks.database.resetTransientExecutionState).not.toHaveBeenCalled();
    });

    it('runs the sole Frameleaf migration provider and resets execution leases before checking API health', async () => {
      const order: string[] = [];
      mocks.user.hasAdmin.mockResolvedValue(true);
      mocks.database.runMigrations.mockImplementation(() => {
        order.push('migrations');
        return Promise.resolve();
      });
      mocks.database.resetTransientExecutionState.mockImplementation(() => {
        order.push('leases');
        return Promise.resolve();
      });
      maintenanceHealthRepositoryMock.checkApiHealth.mockImplementation(() => {
        order.push('health');
        return Promise.resolve();
      });

      await sut.restoreDatabaseBackup('candidate.sql');

      expect(order).toEqual(['migrations', 'leases', 'health']);
      expect(mocks.database.runMigrations).toHaveBeenCalledOnce();
      expect(mocks.database.resetTransientExecutionState).toHaveBeenCalledOnce();
    });

    it('reports a compressed source read error and stops before executing any SQL', async () => {
      const file = new Readable({
        read() {
          // eslint-disable-next-line unicorn/no-this-outside-of-class -- Node Readable read callback is bound to the stream.
          this.destroy(new Error('backup disk read failed'));
        },
      });
      mocks.storage.createPlainReadStream.mockReturnValue(file);
      mocks.storage.createGunzip.mockImplementation(() => createGunzip());

      await expect(sut.restoreDatabaseBackup('candidate.sql.gz')).rejects.toThrow('backup disk read failed');

      expect(file.destroyed).toBe(true);
      expect(mocks.process.spawnDuplexStream).not.toHaveBeenCalled();
    });

    it('does not open the restore input while its initial SQL fence is pending, then propagates disk failure', async () => {
      const pending = Promise.withResolvers<void>();
      const checked = Promise.withResolvers<void>();
      const failure = new Error('restore disk read failed');
      const input = new Readable({
        read() {
          // eslint-disable-next-line unicorn/no-this-outside-of-class -- Node Readable read callback is bound to the stream.
          this.destroy(failure);
        },
      });
      mocks.storage.createPlainReadStream
        .mockImplementationOnce(() => Readable.from(mockData()))
        .mockReturnValue(input);
      vi.spyOn(sut, 'createDatabaseBackup').mockResolvedValue('restore-point.sql.gz');
      const assert = vi
        .fn()
        .mockResolvedValue(undefined)
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => {
          checked.resolve();
          await pending.promise;
        });

      const result = sut.restoreDatabaseBackup('candidate.sql.gz', undefined, { fence: { backendPid: 7123, assert } });
      const rejected = expect(result).rejects.toThrow(failure);
      await checked.promise;
      expect(mocks.storage.createPlainReadStream).toHaveBeenCalledTimes(1);
      expect(input.readableDidRead).toBe(false);
      pending.resolve();
      await rejected;
      expect(input.destroyed).toBe(true);
      expect(mocks.database.runMigrations).not.toHaveBeenCalled();
    });

    it('closes the unopened input after losing the SQL fence without reading the restore file', async () => {
      vi.spyOn(sut, 'createDatabaseBackup').mockResolvedValue('restore-point.sql.gz');
      const assert = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('restore lock lost'));
      await expect(
        sut.restoreDatabaseBackup('candidate.sql.gz', undefined, { fence: { backendPid: 7123, assert } }),
      ).rejects.toThrow('restore lock lost');
      // The one read is the completed preflight. SQL did not reopen or consume the file.
      expect(mocks.storage.createPlainReadStream).toHaveBeenCalledTimes(1);
      expect(mocks.database.runMigrations).not.toHaveBeenCalled();
    });

    it.each(['candidate.sql', 'candidate.sql.gz'])('cancels a stalled inner read of %s', async (filename) => {
      const started = Promise.withResolvers<void>();
      const file = new Readable({
        read() {
          started.resolve();
        },
      });
      mocks.storage.createPlainReadStream.mockReturnValue(file);
      mocks.storage.createGunzip.mockImplementation(() => createGunzip());
      const abort = new AbortController();
      const result = queueExecution.run({ signal: abort.signal } as QueueExecution, () =>
        sut.restoreDatabaseBackup(filename),
      );
      const rejected = expect(result).rejects.toThrow('Cancelled stalled backup input');
      await started.promise;
      abort.abort(new Error('Cancelled stalled backup input'));
      await rejected;
      expect(file.destroyed).toBe(true);
      expect(mocks.process.spawnDuplexStream).not.toHaveBeenCalled();
      expect(mocks.database.resetTransientExecutionState).not.toHaveBeenCalled();
    });

    it('fails before mutating the destination when a compressed dump is corrupt', async () => {
      mocks.storage.createPlainReadStream.mockImplementation(() => Readable.from([Buffer.from('invalid gzip')]));
      mocks.storage.createGunzip.mockImplementation(() => createGunzip());

      await expect(sut.restoreDatabaseBackup('candidate.sql.gz')).rejects.toThrow();

      expect(mocks.process.spawnDuplexStream).not.toHaveBeenCalled();
      expect(mocks.database.resetTransientExecutionState).not.toHaveBeenCalled();
    });

    it('restores a backup from an older server (FL-81)', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);

      await expect(
        sut.restoreDatabaseBackup('frameleaf-db-backup-20260101T000000-v2.5.0-pg19.1.sql.gz'),
      ).resolves.toBeUndefined();
    });

    it('should fail to restore invalid backup', async () => {
      await expect(sut.restoreDatabaseBackup('filename')).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Error: Invalid backup file format!]`,
      );
    });

    it('should successfully restore a backup', async () => {
      let writtenToPsql = '';

      mocks.user.hasAdmin.mockResolvedValue(true);

      mocks.process.spawnDuplexStream.mockImplementationOnce(() => mockDuplex()('command', 0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementationOnce(() => mockDuplex()('command', 0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementationOnce(() => {
        return mockDuplex((chunk) => (writtenToPsql += chunk))('command', 0, 'data', '');
      });

      const progress = vitest.fn();
      await sut.restoreDatabaseBackup('development-filename.sql', progress);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
      expect(progress).toHaveBeenCalledWith('migrations', 0.9);

      expect(maintenanceHealthRepositoryMock.checkApiHealth).toHaveBeenCalled();
      expect(mocks.process.spawnDuplexStream).toHaveBeenCalledTimes(3);

      expect(mocks.process.spawnDuplexStream).toHaveBeenLastCalledWith(
        expect.stringMatching('/bin/psql'),
        [
          '--username',
          'mypg',
          '--host',
          'myhost',
          '--port',
          '1234',
          '--dbname',
          'myimmich',
          '--single-transaction',
          '--set',
          'ON_ERROR_STOP=on',
          '--echo-all',
          '--output=/dev/null',
        ],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: expect.any(String),
            PGPASSWORD: 'mypwd',
          }),
        }),
      );

      expect(writtenToPsql).toMatchInlineSnapshot(`
        "
          -- drop all other database connections
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid();

          -- re-create the default schema
          DROP SCHEMA public CASCADE;
          CREATE SCHEMA public;

          -- restore access to schema
          GRANT ALL ON SCHEMA public TO "mypg";
          GRANT ALL ON SCHEMA public TO public;
        -- Dumped from database version 19beta4
        CREATE TABLE public.frameleaf_migrations (name text, timestamp text);
        SELECT 1;
        -- PostgreSQL database dump complete
        "
      `);
    });

    it('should fail if backup creation fails', async () => {
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('pg_dump', 1, '', 'error'));

      const progress = vitest.fn();
      await expect(sut.restoreDatabaseBackup('development-filename.sql', progress)).rejects
        .toThrowErrorMatchingInlineSnapshot(`
        [Error: pg_dump non-zero exit code (1)
        error]
      `);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
    });

    it('should fail if restore itself fails', async () => {
      mocks.process.spawnDuplexStream
        .mockReturnValueOnce(mockDuplex()('pg_dump', 0, 'data', ''))
        .mockReturnValueOnce(mockDuplex()('gzip', 0, 'data', ''))
        .mockReturnValueOnce(mockDuplex()('psql', 1, '', 'error'));

      const progress = vitest.fn();
      await expect(sut.restoreDatabaseBackup('development-filename.sql', progress)).rejects
        .toThrowErrorMatchingInlineSnapshot(`
        [Error: psql non-zero exit code (1)
        error]
      `);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
    });

    it('should rollback if database migrations fail', async () => {
      mocks.database.runMigrations.mockRejectedValue(new Error('Migrations Error'));

      const progress = vitest.fn();
      await expect(
        sut.restoreDatabaseBackup('development-filename.sql', progress),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: Migrations Error]`);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
      expect(progress).toHaveBeenCalledWith('migrations', 0.9);

      expect(maintenanceHealthRepositoryMock.checkApiHealth).toHaveBeenCalledTimes(0);
      expect(mocks.process.spawnDuplexStream).toHaveBeenCalledTimes(4);
    });

    it('should rollback if there is no admin user', async () => {
      mocks.user.hasAdmin.mockResolvedValue(false);

      const progress = vitest.fn();
      await expect(
        sut.restoreDatabaseBackup('development-filename.sql', progress),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: Server health check failed, no admin exists.]`);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
      expect(progress).toHaveBeenCalledWith('migrations', 0.9);
      expect(progress).toHaveBeenCalledWith('rollback', 0);

      expect(mocks.user.hasAdmin).toHaveBeenCalled();
      expect(mocks.process.spawnDuplexStream).toHaveBeenCalledTimes(4);
    });

    it('should rollback if API healthcheck fails', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);
      maintenanceHealthRepositoryMock.checkApiHealth.mockRejectedValue(new Error('Health Error'));

      const progress = vitest.fn();
      await expect(
        sut.restoreDatabaseBackup('development-filename.sql', progress),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: Health Error]`);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
      expect(progress).toHaveBeenCalledWith('migrations', 0.9);
      expect(progress).toHaveBeenCalledWith('rollback', 0);

      expect(mocks.user.hasAdmin).toHaveBeenCalled();
      expect(maintenanceHealthRepositoryMock.checkApiHealth).toHaveBeenCalled();
      expect(mocks.process.spawnDuplexStream).toHaveBeenCalledTimes(4);
    });
  });

  describe('restore verification (FL-71 CC-9)', () => {
    const day = 24 * 60 * 60 * 1000;
    const now = new Date('2026-09-24T12:00:00.000Z');

    it('is due at once while either part has never been proved', () => {
      expect(restoreVerificationDue({}, now)).toEqual({ dueAt: null, overdue: true });
      expect(restoreVerificationDue({ metadataVerifiedAt: now.toISOString() }, now)).toEqual({
        dueAt: null,
        overdue: true,
      });
    });

    it('is due 90 days after the older of the two tests', () => {
      const recent = new Date(now.getTime() - 10 * day).toISOString();
      const older = new Date(now.getTime() - 80 * day).toISOString();
      expect(restoreVerificationDue({ metadataVerifiedAt: recent, originalsVerifiedAt: older }, now)).toEqual({
        dueAt: new Date(now.getTime() + 10 * day).toISOString(),
        overdue: false,
      });
      const stale = new Date(now.getTime() - 91 * day).toISOString();
      expect(restoreVerificationDue({ metadataVerifiedAt: recent, originalsVerifiedAt: stale }, now).overdue).toBe(
        true,
      );
    });

    it('reports the record with the administrator who made it', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        metadataVerifiedAt: '2026-09-20T10:00:00.000Z',
        originalsVerifiedAt: null,
        verifiedBy: 'admin-id',
      });
      mocks.user.get.mockResolvedValue({ id: 'admin-id', name: 'Ada' } as never);

      await expect(sut.getRestoreVerification()).resolves.toEqual({
        metadataVerifiedAt: '2026-09-20T10:00:00.000Z',
        originalsVerifiedAt: null,
        verifiedBy: { id: 'admin-id', name: 'Ada' },
        overdue: true,
        dueAt: null,
        intervalDays: 90,
      });
    });

    it('records the tested parts now and keeps the untested part', async () => {
      mocks.database.withLock.mockImplementation((_lock, fn) => fn());
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          (key === SystemMetadataKey.BackupRestoreVerification
            ? { metadataVerifiedAt: '2026-01-01T00:00:00.000Z' }
            : null) as never,
        ),
      );
      mocks.user.get.mockResolvedValue(undefined as never);

      await sut.recordRestoreVerification(authStub.admin, { metadata: false, originals: true });

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.BackupRestoreVerification, {
        metadataVerifiedAt: '2026-01-01T00:00:00.000Z',
        originalsVerifiedAt: expect.any(String),
        verifiedBy: authStub.admin.user.id,
      });
      // FL-71 (CC-10): the review lands in the change history as "Reviewed: Recovery readiness".
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.SystemConfigHistory, {
        entries: [
          expect.objectContaining({
            kind: 'review',
            title: 'Reviewed: Recovery readiness',
            actorId: authStub.admin.user.id,
            changes: [],
          }),
        ],
      });
    });
  });
});

function* mockData() {
  yield '-- Dumped from database version 19beta4\nCREATE TABLE public.frameleaf_migrations (name text, timestamp text);\nSELECT 1;\n-- PostgreSQL database dump complete\n';
}

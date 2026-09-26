import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { Duplex, PassThrough, Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { DatabaseLock, ImmichWorker, JobStatus, StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { MaintenanceHealthRepository } from 'src/maintenance/maintenance-health.repository.js';
import { DatabaseBackupService, restoreVerificationDue } from 'src/services/database-backup.service.js';
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
      mocks.storage.readdir.mockResolvedValue(['immich-db-backup-1.sql.gz']);
      await sut.cleanupDatabaseBackups();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should remove failed backup files', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
      //`immich-db-backup-${DateTime.now().toFormat("yyyyLLdd'T'HHmmss")}-v${serverVersion.toString()}-pg${databaseVersion.split(' ')[0]}.sql.gz.tmp`,
      mocks.storage.readdir.mockResolvedValue([
        'immich-db-backup-123.sql.gz.tmp',
        `immich-db-backup-${DateTime.fromISO('2025-07-25T11:02:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz.tmp`,
        `immich-db-backup-${DateTime.fromISO('2025-07-27T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz`,
        `immich-db-backup-${DateTime.fromISO('2025-07-29T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz.tmp`,
      ]);
      await sut.cleanupDatabaseBackups();
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(3);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/immich-db-backup-123.sql.gz.tmp`,
      );
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/immich-db-backup-20250725T110216-v1.234.5-pg14.5.sql.gz.tmp`,
      );
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/immich-db-backup-20250729T110116-v1.234.5-pg14.5.sql.gz.tmp`,
      );
    });

    it('should remove old backup files over keepLastAmount', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
      mocks.storage.readdir.mockResolvedValue(['immich-db-backup-1.sql.gz', 'immich-db-backup-2.sql.gz']);
      await sut.cleanupDatabaseBackups();
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(1);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/immich-db-backup-1.sql.gz`,
      );
    });

    it('should remove old backup files over keepLastAmount and failed backups', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
      mocks.storage.readdir.mockResolvedValue([
        `immich-db-backup-${DateTime.fromISO('2025-07-25T11:02:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz.tmp`,
        `immich-db-backup-${DateTime.fromISO('2025-07-27T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz`,
        'immich-db-backup-1753789649000.sql.gz',
        `immich-db-backup-${DateTime.fromISO('2025-07-29T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz`,
      ]);
      await sut.cleanupDatabaseBackups();
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(3);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/immich-db-backup-1753789649000.sql.gz`,
      );
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/immich-db-backup-20250725T110216-v1.234.5-pg14.5.sql.gz.tmp`,
      );
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        `${StorageCore.getBaseFolder(StorageFolder.Backups)}/immich-db-backup-20250727T110116-v1.234.5-pg14.5.sql.gz`,
      );
    });
  });

  describe('handleBackupDatabase / createDatabaseBackup', () => {
    beforeEach(() => {
      mocks.storage.readdir.mockResolvedValue([]);
      mocks.process.spawn.mockReturnValue(mockSpawn(0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementation(() => mockDuplex()('command', 0, 'data', ''));
      mocks.storage.rename.mockResolvedValue();
      mocks.storage.unlink.mockResolvedValue();
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
      mocks.storage.createWriteStream.mockReturnValue(new PassThrough());
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

      mocks.storage.readdir.mockResolvedValue([]);
      mocks.process.spawnDuplexStream.mockImplementation(() => mockDuplex()('command', 0, 'data', ''));
      mocks.storage.rename.mockResolvedValue();
      mocks.storage.unlink.mockResolvedValue();
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
      mocks.storage.createWriteStream.mockReturnValue(new PassThrough());
      mocks.database.getPostgresVersion.mockResolvedValue('14.10');

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
      postgresVersion                       | expectedVersion
      ${'14.10'}                            | ${14}
      ${'14.10.3'}                          | ${14}
      ${'14.10 (Debian 14.10-1.pgdg120+1)'} | ${14}
      ${'15.3.3'}                           | ${15}
      ${'16.4.2'}                           | ${16}
      ${'17.15.1'}                          | ${17}
      ${'18.0.0'}                           | ${18}
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
      ${'19.0.0'}
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
            "immich",
            "--clean",
            "--if-exists",
          ],
          "bin": "/usr/lib/postgresql/14/bin/pg_dump",
          "databaseMajorVersion": 14,
          "databasePassword": "postgres",
          "databaseUsername": "postgres",
          "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
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
            "immich",
            "--echo-all",
            "--output=/dev/null",
          ],
          "bin": "/usr/lib/postgresql/14/bin/psql",
          "databaseMajorVersion": 14,
          "databasePassword": "postgres",
          "databaseUsername": "postgres",
          "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
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
            "immich",
            "--single-transaction",
            "--set",
            "ON_ERROR_STOP=on",
            "--echo-all",
            "--output=/dev/null",
          ],
          "bin": "/usr/lib/postgresql/14/bin/psql",
          "databaseMajorVersion": 14,
          "databasePassword": "postgres",
          "databaseUsername": "postgres",
          "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
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
            "bin": "/usr/lib/postgresql/14/bin/pg_dump",
            "databaseMajorVersion": 14,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
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
            "bin": "/usr/lib/postgresql/14/bin/psql",
            "databaseMajorVersion": 14,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
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
            "bin": "/usr/lib/postgresql/14/bin/pg_dump",
            "databaseMajorVersion": 14,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
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
            "bin": "/usr/lib/postgresql/14/bin/psql",
            "databaseMajorVersion": 14,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
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
            "bin": "/usr/lib/postgresql/14/bin/psql",
            "databaseMajorVersion": 14,
            "databasePassword": "",
            "databaseUsername": "postgres",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
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
            "bin": "/usr/lib/postgresql/14/bin/pg_dump",
            "databaseMajorVersion": 14,
            "databasePassword": "",
            "databaseUsername": "postgres",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
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

  describe('listBackups', () => {
    it('should give us all backups', async () => {
      mocks.storage.readdir.mockResolvedValue([
        `immich-db-backup-${DateTime.fromISO('2025-07-25T11:02:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz.tmp`,
        `immich-db-backup-${DateTime.fromISO('2025-07-27T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz`,
        'immich-db-backup-1753789649000.sql.gz',
        `immich-db-backup-${DateTime.fromISO('2025-07-29T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz`,
      ]);
      mocks.storage.stat.mockResolvedValue({ size: 1024 } as any);

      await expect(sut.listBackups()).resolves.toMatchObject({
        backups: [
          { filename: 'immich-db-backup-20250729T110116-v1.234.5-pg14.5.sql.gz', filesize: 1024 },
          { filename: 'immich-db-backup-20250727T110116-v1.234.5-pg14.5.sql.gz', filesize: 1024 },
          { filename: 'immich-db-backup-1753789649000.sql.gz', filesize: 1024 },
        ],
      });
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
      mocks.process.fork.mockImplementation(() => mockSpawn(0, 'Immich Server is listening', ''));
      mocks.storage.rename.mockResolvedValue();
      mocks.storage.unlink.mockResolvedValue();
      mocks.storage.createPlainReadStream.mockReturnValue(Readable.from(mockData()));
      mocks.storage.createWriteStream.mockReturnValue(new PassThrough());
      mocks.storage.createGzip.mockReturnValue(new PassThrough());
      mocks.storage.createGunzip.mockReturnValue(new PassThrough());
      mocks.database.detectMigrationMode.mockResolvedValue('legacy');

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
        sut.restoreDatabaseBackup('immich-db-backup-20260101T000000-v999.0.0-pg14.19.sql.gz'),
      ).rejects.toThrow('This backup was made by a newer server (v999.0.0)');

      expect(mocks.process.spawnDuplexStream).not.toHaveBeenCalled();
      expect(mocks.storage.createWriteStream).not.toHaveBeenCalled();
    });

    it('restores a backup from an older server (FL-81)', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);

      await expect(
        sut.restoreDatabaseBackup('immich-db-backup-20260101T000000-v2.5.0-pg14.19.sql.gz'),
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

          -- The fork's sidecar schema lives outside public, so dropping public alone
          -- would leave a stale immich_fork behind: its rows would no longer match the
          -- restored public tables, and its surviving migration ledger would make the
          -- half-wiped database look 'isolated' to detectMigrationMode — routing the
          -- restore to the certified official migrator, which omits the migrations
          -- that create the fork's public tables. A fork backup carries immich_fork in
          -- the same dump, so it is restored alongside public; restoring an official
          -- backup correctly yields a fork-free database that runForkMigrations
          -- re-initialises.
          DROP SCHEMA IF EXISTS immich_fork CASCADE;

          -- restore access to schema
          GRANT ALL ON SCHEMA public TO "mypg";
          GRANT ALL ON SCHEMA public TO public;
        SELECT 1;"
      `);
    });

    it.each(['legacy', 'fresh'] as const)(
      'runs the combined then isolated fork migrator when restoring a %s database',
      async (mode) => {
        const migrationOrder: string[] = [];
        mocks.user.hasAdmin.mockResolvedValue(true);
        mocks.database.detectMigrationMode.mockResolvedValue(mode);
        mocks.database.runMigrations.mockImplementation(() => {
          migrationOrder.push('combined');
          return Promise.resolve();
        });
        mocks.database.runForkMigrations.mockImplementation(() => {
          migrationOrder.push('fork');
          return Promise.resolve();
        });

        await sut.restoreDatabaseBackup('development-filename.sql');

        expect(mocks.database.detectMigrationMode).toHaveBeenCalledOnce();
        expect(migrationOrder).toEqual(['combined', 'fork']);
        expect(mocks.database.runOfficialMigrations).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['isolated', ['official', 'frameleaf', 'fork']],
      ['official-origin', ['official', 'fork']],
    ] as const)('runs official then fork migrations when restoring a %s database', async (mode, expected) => {
      const migrationOrder: string[] = [];
      mocks.user.hasAdmin.mockResolvedValue(true);
      mocks.database.detectMigrationMode.mockResolvedValue(mode);
      mocks.database.runOfficialMigrations.mockImplementation(() => {
        migrationOrder.push('official');
        return Promise.resolve();
      });
      mocks.database.applyIsolatedFrameleafMigrations.mockImplementation(() => {
        migrationOrder.push('frameleaf');
        return Promise.resolve({ applied: [], pending: [], skipped: null });
      });
      mocks.database.runForkMigrations.mockImplementation(() => {
        migrationOrder.push('fork');
        return Promise.resolve();
      });

      await sut.restoreDatabaseBackup('development-filename.sql');

      expect(migrationOrder).toEqual(expected);
      expect(mocks.database.runMigrations).not.toHaveBeenCalled();
    });

    it('applies newer Frameleaf migrations under the migrations lock when restoring a library past the cutover (FL-180)', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);
      mocks.database.detectMigrationMode.mockResolvedValue('isolated');

      await sut.restoreDatabaseBackup('development-filename.sql');

      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.Migrations, expect.any(Function));
      expect(mocks.database.applyIsolatedFrameleafMigrations).toHaveBeenCalledExactlyOnceWith('startup');
    });

    it('guards an inactive schema version 2 restore before either migration provider runs', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);
      mocks.database.detectMigrationMode.mockResolvedValue('isolated');
      mocks.database.isCertifiedReturnStartup.mockResolvedValue(true);
      mocks.database.assertCertifiedReturnLedger.mockRejectedValue(new Error('certified v3.0.3 ledger rejected'));

      await expect(sut.restoreDatabaseBackup('development-filename.sql')).rejects.toThrow(
        'certified v3.0.3 ledger rejected',
      );

      expect(mocks.database.assertCertifiedReturnLedger).toHaveBeenCalledOnce();
      expect(mocks.database.assertCertifiedReturnLedger.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.database.detectMigrationMode.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(mocks.database.runOfficialMigrations).not.toHaveBeenCalled();
      expect(mocks.database.runForkMigrations).not.toHaveBeenCalled();
    });

    it('should generate pg_dumpall specific SQL instructions', async () => {
      let writtenToPsql = '';

      mocks.user.hasAdmin.mockResolvedValue(true);

      mocks.process.spawnDuplexStream.mockImplementationOnce(() => mockDuplex()('command', 0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementationOnce(() => mockDuplex()('command', 0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementationOnce(() => {
        return mockDuplex((chunk) => (writtenToPsql += chunk))('command', 0, 'data', '');
      });

      const progress = vitest.fn();
      await sut.restoreDatabaseBackup('development-v2.4.0-.sql', progress);

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

      expect(writtenToPsql).toMatchInlineSnapshot(String.raw`
        "
          -- drop all other database connections
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid();

                \c postgres
              SELECT 1;"
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
  yield 'SELECT 1;';
}

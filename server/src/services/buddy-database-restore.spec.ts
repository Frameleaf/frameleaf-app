import { PassThrough, Readable, Transform } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';

describe('Buddy database recovery fence', () => {
  beforeEach(() => StorageCore.setMediaLocation('/tmp/buddy-fence-media'));
  afterEach(() => StorageCore.reset());
  const candidate = (healthy = true) => {
    const statements: string[] = [];
    const logger = { setContext() {}, debug() {}, log() {}, error() {}, warn() {} };
    const storage = {
      stat: vi.fn(),
      createPlainReadStream: () =>
        Readable.from([
          '-- Dumped from database version 19beta4\nCREATE TABLE public.frameleaf_migrations (name text, timestamp text);\nSELECT 1;\n-- PostgreSQL database dump complete\n',
        ]),
      createGunzip: () => new PassThrough(),
    };
    const database = {
      runMigrations: vi.fn(),
      resetTransientExecutionState: vi.fn(),
    };
    const process = {
      spawnDuplexStream: () => {
        const index = statements.length;
        statements.push('');
        return new Transform({
          transform(chunk, _encoding, callback) {
            statements[index] += chunk;
            callback(null, chunk);
          },
        });
      },
    };
    const service = new DatabaseBackupService(
      logger as never,
      storage as never,
      {} as never,
      {} as never,
      process as never,
      database as never,
      { hasAdmin: () => Promise.resolve(healthy) } as never,
      undefined as never,
      undefined as never,
      { checkApiHealth: vi.fn() } as never,
    );
    vi.spyOn(service, 'createDatabaseBackup').mockResolvedValue('/tmp/restore-point.sql.gz');
    vi.spyOn(service as any, 'buildPostgresLaunchArguments').mockResolvedValue({
      bin: 'psql',
      args: [],
      databaseUsername: 'owner',
      databasePassword: '',
      databaseMajorVersion: 19,
    });
    return { service, statements, database };
  };

  it.each([true, false])('exempts the reserved session during restore and rollback (healthy=%s)', async (healthy) => {
    const { service, statements } = candidate(healthy);
    const assert = vi.fn().mockResolvedValue(undefined);
    const restore = service.restoreDatabaseBackup('development-filename.sql', undefined, {
      fence: { backendPid: 7310, assert },
    });
    if (healthy) await restore;
    else await expect(restore).rejects.toThrow('no admin exists');
    expect(statements).toHaveLength(healthy ? 1 : 2);
    for (const statement of statements) expect(statement).toContain('pid <> pg_backend_pid() AND pid <> 7310');
    expect(assert.mock.calls.length).toBeGreaterThan(2);
  });

  it('aborts on lock loss before migrations or rollback can mutate again', async () => {
    const { service, database } = candidate();
    let checks = 0;
    const assert = () => {
      if (++checks >= 4) return Promise.reject(new Error('maintenance lock lost'));
      return Promise.resolve();
    };
    await expect(
      service.restoreDatabaseBackup('development-filename.sql', undefined, { fence: { backendPid: 7310, assert } }),
    ).rejects.toThrow('maintenance lock lost');
    expect(database.runMigrations).not.toHaveBeenCalled();
  });
});

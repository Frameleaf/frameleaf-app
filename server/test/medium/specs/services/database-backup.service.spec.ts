import { Kysely, sql } from 'kysely';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobStatus, StorageFolder } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ProcessRepository } from 'src/repositories/process.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DB } from 'src/schema/index.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-298: a routine database backup runs a real `pg_dump` into a real compressor and writes the file
 * through the real storage and process repositories. A compressor or dump that fails, is killed, or
 * stops early (Apple gzip prints its usage and exits 0 on `--rsyncable`) fails the backup and leaves
 * neither a backup nor a `.tmp` file. `pg_dump` comes from PATH (any version that can read the test
 * database) in place of the image's `/usr/lib/postgresql/<major>/bin/pg_dump`.
 */
const ROUTINE = /^frameleaf-db-backup-\d{8}T\d{6}-v[\d.]+-pg\d+(?:\.\d+)*(?:(?:alpha|beta|rc)\d+)?\.sql\.gz$/;

const currentDatabase = async (db: Kysely<DB>) =>
  (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows[0]!.name;

const urlFor = (database: string) => canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, database);

const gunzipText = async (file: string) => {
  let text = '';
  await pipeline(
    createReadStream(file),
    createGunzip(),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        text += chunk.toString('utf8');
        callback();
      },
    }),
  );
  return text;
};

type Substitute = (command: string, args: readonly string[]) => { command: string; args: readonly string[] };

describe('routine database backup with a real dump (FL-298)', { timeout: 120_000 }, () => {
  let db: Kysely<DB>;
  let database: string;
  let mediaLocation: string;
  let backupsFolder: string;
  let config: ConfigRepository;
  let processRepository: ProcessRepository;
  let substitute: Substitute | undefined;
  let sut: DatabaseBackupService;

  const pointAt = (url: string) => {
    const env = new ConfigRepository().getEnv();
    vi.spyOn(config, 'getEnv').mockReturnValue({
      ...env,
      database: { ...env.database, config: { connectionType: 'url', url } },
      storage: { ...env.storage, mediaLocation },
    });
  };

  beforeAll(async () => {
    db = await getKyselyDB('fl298_backup');
    database = await currentDatabase(db);
    await sql`CREATE TABLE fl298_sentinel (note text)`.execute(db);

    await sql`INSERT INTO fl298_sentinel VALUES ('kept by the backup')`.execute(db);

    mediaLocation = await mkdtemp(join(tmpdir(), 'frameleaf-fl298-'));
    config = new ConfigRepository();

    // The image's pg_dump path stands in for the host's; its GNU gzip takes --rsyncable, which a macOS
    // host gzip does not, so the host run drops it unless a test keeps it on purpose.
    processRepository = new ProcessRepository();
    const spawnDuplexStream = processRepository.spawnDuplexStream.bind(processRepository);
    vi.spyOn(processRepository, 'spawnDuplexStream').mockImplementation((command, args = [], options) => {
      const host = substitute?.(command, args) ?? {
        command: command.endsWith('/pg_dump') ? 'pg_dump' : command,
        args: command === 'gzip' && process.platform === 'darwin' ? args.filter((arg) => arg !== '--rsyncable') : args,
      };
      return spawnDuplexStream(host.command, host.args, { ...options, env: { ...process.env, ...options?.env } });
    });

    const logger = LoggingRepository.create();
    sut = new DatabaseBackupService(
      logger,
      new StorageRepository(logger),
      config,
      {} as never,
      processRepository,
      new DatabaseRepository(db, logger, config),
      {} as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  });

  beforeEach(async () => {
    pointAt(urlFor(database));
    substitute = undefined;
    StorageCore.reset();
    StorageCore.setMediaLocation(mediaLocation);
    backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);
    await rm(backupsFolder, { recursive: true, force: true });
    await mkdir(backupsFolder, { recursive: true });
  });

  afterAll(async () => {
    await db.destroy();
    await rm(mediaLocation, { recursive: true, force: true });
  });

  it('writes a complete, verified dump and no temporary file', async () => {
    const path = await sut.createDatabaseBackup();

    const files = await readdir(backupsFolder);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(ROUTINE);
    expect(join(backupsFolder, files[0])).toBe(path);

    const text = await gunzipText(path);
    expect(text).toContain('CREATE TABLE public.fl298_sentinel');
    expect(text).toContain('kept by the backup');
    expect(text).toMatch(/-- PostgreSQL database dump complete/);
  });

  it('fails and keeps nothing when the compressor exits 0 without reading the dump', async () => {
    // what Apple gzip does with --rsyncable, on any host
    substitute = (command, args) =>
      command === 'gzip'
        ? { command: 'bash', args: ['-c', 'echo "gzip: unrecognized option --rsyncable" >&2; exit 0'] }
        : { command: 'pg_dump', args };

    await expect(sut.handleBackupDatabase()).rejects.toThrow(/exited before reading all of its input|is empty/);

    await expect(readdir(backupsFolder)).resolves.toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('fails and keeps nothing with the host gzip given --rsyncable', async () => {
    substitute = (command, args) => (command === 'gzip' ? { command, args } : { command: 'pg_dump', args });

    await expect(sut.createDatabaseBackup()).rejects.toThrow(/exited before reading all of its input|is empty/);

    await expect(readdir(backupsFolder)).resolves.toEqual([]);
  });

  it('fails and keeps nothing when the compressor fails', async () => {
    substitute = (command, args) =>
      command === 'gzip'
        ? { command: 'bash', args: ['-c', 'head -c 100 >/dev/null; echo "gzip: no space left" >&2; exit 1'] }
        : { command: 'pg_dump', args };

    await expect(sut.createDatabaseBackup()).rejects.toThrow(/bash non-zero exit code \(1\)\ngzip: no space left/);

    await expect(readdir(backupsFolder)).resolves.toEqual([]);
  });

  it('fails and keeps nothing when the compressor is killed mid-stream', async () => {
    substitute = (command, args) =>
      command === 'gzip'
        ? { command: 'bash', args: ['-c', 'head -c 100 | gzip; kill -KILL $$'] }
        : { command: 'pg_dump', args };

    await expect(sut.createDatabaseBackup()).rejects.toThrow('bash was stopped by signal SIGKILL');

    await expect(readdir(backupsFolder)).resolves.toEqual([]);
  });

  it('fails and keeps nothing when the dump fails', async () => {
    pointAt(urlFor('fl298_no_such_database'));

    await expect(sut.handleBackupDatabase()).rejects.toThrow(/pg_dump non-zero exit code \(1\)[\s\S]*does not exist/);

    await expect(readdir(backupsFolder)).resolves.toEqual([]);
  });

  it('fails and keeps nothing when the dump is killed before its end', async () => {
    substitute = (command, args) =>
      command.endsWith('/pg_dump')
        ? { command: 'bash', args: ['-c', 'pg_dump "$@" | head -c 2000; kill -KILL $$', 'pg_dump', ...args] }
        : { command, args: args.filter((arg) => arg !== '--rsyncable') };

    await expect(sut.createDatabaseBackup()).rejects.toThrow('bash was stopped by signal SIGKILL');

    await expect(readdir(backupsFolder)).resolves.toEqual([]);
  });

  it('fails and keeps nothing when the dump exits 0 before its end', async () => {
    substitute = (command, args) =>
      command.endsWith('/pg_dump')
        ? { command: 'bash', args: ['-c', 'pg_dump "$@" | head -c 2000; exit 0', 'pg_dump', ...args] }
        : { command, args: args.filter((arg) => arg !== '--rsyncable') };

    await expect(sut.createDatabaseBackup()).rejects.toThrow('does not finish like a complete dump');

    await expect(readdir(backupsFolder)).resolves.toEqual([]);
  });

  it('marks the backup job failed rather than successful', async () => {
    substitute = (command, args) =>
      command === 'gzip' ? { command: 'bash', args: ['-c', 'exit 0'] } : { command: 'pg_dump', args };

    const outcome = await sut.handleBackupDatabase().catch(() => JobStatus.Failed);

    expect(outcome).toBe(JobStatus.Failed);
    await expect(readdir(backupsFolder)).resolves.toEqual([]);
  });
});

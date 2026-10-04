import { createPostgres } from '@immich/sql-tools';
import { Kysely, sql } from 'kysely';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { StorageCore } from 'src/cores/storage.core.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ProcessRepository } from 'src/repositories/process.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { DatabaseService } from 'src/services/database.service.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { restoreOfficialPublicSchema } from 'test/medium/specs/fork-schema/official-schema-fixture.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-295: the first Frameleaf start on a library the official server created takes a safety copy of
 * the database before anything changes it. This runs the real boot step (DatabaseService.onBootstrap:
 * extensions, migrations, adoption) on the exact official v3.1.0 schema, with a real `pg_dump`, and
 * proves the copy holds the library as it was before the upgrade by restoring it into an empty
 * database. `pg_dump` and `psql` come from PATH (any version that can read PostgreSQL 14).
 */
const PRE_UPGRADE = /^immich-db-backup-\d{8}T\d{6}-pre-upgrade-v[\d.]+-pg[\d.]+\.sql\.gz$/;

const urlFor = (database: string) => process.env.IMMICH_TEST_POSTGRES_URL!.replace('/mich', () => `/${database}`);

const currentDatabase = async (db: Kysely<DB>) =>
  (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows[0]!.name;

const ledger = async (db: Kysely<DB>) =>
  (await sql<{ name: string }>`SELECT name FROM public.kysely_migrations ORDER BY name`.execute(db)).rows.map(
    ({ name }) => name,
  );

const schemaFacts = async (db: Kysely<DB>) => {
  const { rows } = await sql<{ fork: boolean; physicalFile: boolean; assets: number }>`
    SELECT
      to_regnamespace('immich_fork') IS NOT NULL AS fork,
      to_regclass('public.physical_file') IS NOT NULL AS "physicalFile",
      (SELECT count(*)::int FROM public.asset) AS assets
  `.execute(db);
  return rows[0]!;
};

/** Runs a host tool with a gzipped file on stdin. */
const run = (command: string, args: string[], input?: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`))));
    if (input) {
      void pipeline(createReadStream(input), createGunzip(), child.stdin!).catch(reject);
    }
  });

describe('first-launch safety copy before the upgrade (FL-295)', { timeout: 120_000 }, () => {
  let db: Kysely<DB>;
  let mediaLocation: string;
  let backupsFolder: string;
  let config: ConfigRepository;
  let processRepository: ProcessRepository;
  let pgDumpBinary: string;

  const boot = async () => {
    const { sut } = newMediumService(DatabaseService, {
      database: db,
      real: [DatabaseRepository, StorageRepository, SystemMetadataRepository, UserRepository, LoggingRepository],
      mock: [],
    });
    Object.assign(sut as object, { configRepository: config, processRepository });
    // the schema drift check opens its own connection from the configuration
    Object.assign((sut as unknown as { databaseRepository: object }).databaseRepository, { configRepository: config });
    await sut.onBootstrap();
  };

  beforeAll(async () => {
    db = await getKyselyDB('first_launch_backup');
    const database = await currentDatabase(db);
    mediaLocation = await mkdtemp(join(tmpdir(), 'frameleaf-first-launch-'));
    backupsFolder = join(mediaLocation, 'backups');

    // The server's own configuration, pointed at this test database and a temporary media location.
    config = new ConfigRepository();
    const env = config.getEnv();
    vi.spyOn(config, 'getEnv').mockReturnValue({
      ...env,
      database: { ...env.database, skipMigrations: false, config: { connectionType: 'url', url: urlFor(database) } },
      storage: { ...env.storage, mediaLocation },
    });

    // The server runs the pg_dump that matches the database in its image (/usr/lib/postgresql/<major>/bin);
    // here the host's pg_dump stands in for it, on the same arguments. The image's GNU gzip takes
    // --rsyncable; a host gzip without it (macOS) compresses the same stream without that option.
    pgDumpBinary = 'pg_dump';
    processRepository = new ProcessRepository();
    const spawnDuplexStream = processRepository.spawnDuplexStream.bind(processRepository);
    vi.spyOn(processRepository, 'spawnDuplexStream').mockImplementation((command, args, options) => {
      const host =
        command === 'gzip' && process.platform === 'darwin'
          ? { command, args: (args ?? []).filter((arg) => arg !== '--rsyncable') }
          : { command: command.endsWith('/pg_dump') ? pgDumpBinary : command, args };
      return spawnDuplexStream(host.command, host.args, { ...options, env: { ...process.env, ...options?.env } });
    });
  });

  beforeEach(async () => {
    StorageCore.reset();
    // DatabaseService runs before the storage service would set it; the copy sets it itself
    StorageCore.setMediaLocation(undefined as unknown as string);
    await rm(backupsFolder, { recursive: true, force: true });
    await restoreOfficialPublicSchema(db);
    pgDumpBinary = 'pg_dump';
  });

  afterAll(async () => {
    await db.destroy();
    await rm(mediaLocation, { recursive: true, force: true });
  });

  it('copies the official library before any migration; the copy restores to the pre-upgrade schema', async () => {
    const before = { ledger: await ledger(db), facts: await schemaFacts(db) };
    expect(before.facts.fork).toBe(false);
    expect(before.facts.physicalFile).toBe(false);
    // An unfinished copy an interrupted start left behind never counts and goes.
    await mkdir(backupsFolder, { recursive: true });
    const leftover = 'immich-db-backup-20260101T000000-pre-upgrade-v3.2.0-pg14.19.sql.gz.tmp';
    await writeFile(join(backupsFolder, leftover), 'partial');

    await boot();

    // The boot upgraded the live library ...
    const after = await schemaFacts(db);
    expect(after.fork).toBe(true);
    expect((await ledger(db)).length).toBeGreaterThan(before.ledger.length);

    // ... and the copy taken before it holds the library exactly as the official server left it.
    const files = await readdir(backupsFolder);
    const copies = files.filter((name) => PRE_UPGRADE.test(name));
    expect(copies).toHaveLength(1);
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);

    const restoreName = 'immich_first_launch_backup_restore';
    const admin = createPostgres({ maxConnections: 1, connection: { connectionType: 'url', url: urlFor('postgres') } });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${restoreName}`);
      await admin.unsafe(`CREATE DATABASE ${restoreName} WITH TEMPLATE template0 OWNER postgres`);
    } finally {
      await admin.end();
    }
    await run(
      'psql',
      ['--quiet', '--set', 'ON_ERROR_STOP=1', '--dbname', urlFor(restoreName), '--file', '-'],
      join(backupsFolder, copies[0]),
    );

    const restored = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: urlFor(restoreName) }));
    try {
      await expect(ledger(restored)).resolves.toEqual(before.ledger);
      await expect(schemaFacts(restored)).resolves.toEqual(before.facts);
    } finally {
      await restored.destroy();
    }
  });

  it('finds that copy at the next first start of an official library and does not copy again', async () => {
    await boot();
    const copy = (await readdir(backupsFolder)).find((name) => PRE_UPGRADE.test(name));
    expect(copy).toBeDefined();

    // The same official library again (an upgrade put back from that copy, or a second server).
    await restoreOfficialPublicSchema(db);
    StorageCore.setMediaLocation(undefined as unknown as string);
    await boot();

    expect((await readdir(backupsFolder)).filter((name) => PRE_UPGRADE.test(name))).toEqual([copy]);
    await expect(schemaFacts(db)).resolves.toMatchObject({ fork: true });
  });

  it('leaves the library untouched and keeps no partial copy when the dump fails', async () => {
    const before = { ledger: await ledger(db), facts: await schemaFacts(db) };
    pgDumpBinary = 'false';

    await expect(boot()).rejects.toThrow('The safety copy failed');

    await expect(ledger(db)).resolves.toEqual(before.ledger);
    await expect(schemaFacts(db)).resolves.toEqual(before.facts);
    await expect(readdir(backupsFolder)).resolves.toEqual([]);
  });

  it('leaves a fresh install alone', async () => {
    const fresh = await getKyselyDB('first_launch_backup_fresh');
    try {
      const repository = new DatabaseRepository(fresh, LoggingRepository.create(), new ConfigRepository());
      // the medium template is a Frameleaf library: already past the first start
      await expect(repository.isFirstLaunchOnOfficialLibrary()).resolves.toBe(false);
      await sql`DROP SCHEMA immich_fork CASCADE`.execute(fresh);
      await sql`DROP SCHEMA public CASCADE`.execute(fresh);
      await sql`CREATE SCHEMA public`.execute(fresh);
      // an empty database: a fresh install
      await expect(repository.detectMigrationMode()).resolves.toBe('fresh');
      await expect(repository.isFirstLaunchOnOfficialLibrary()).resolves.toBe(false);
    } finally {
      await fresh.destroy();
    }
  });

  it('applies to an official library a first boot set up but did not adopt', async () => {
    const repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
    await expect(repository.isFirstLaunchOnOfficialLibrary()).resolves.toBe(true);
    await repository.runOfficialMigrations();
    await repository.runForkMigrations();
    await expect(repository.isAwaitingOfficialAdoption()).resolves.toBe(true);
    await expect(repository.isFirstLaunchOnOfficialLibrary()).resolves.toBe(true);
    await expect(repository.getDumpSizeEstimate()).resolves.toBeGreaterThan(0);
  });
});

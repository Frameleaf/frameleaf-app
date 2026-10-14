import { Kysely, sql } from 'kysely';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { ProcessRepository } from 'src/repositories/process.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { canonicalDatabaseUrl, seedCanonicalAsset } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('landmarks after a real database backup and restore (FL-382)', () => {
  it(
    'rehydrates the bundled pack at startup without losing the restored item matches',
    { timeout: 120_000 },
    async () => {
      const source = await getKyselyDB();
      const restored = await getKyselyDB();
      const mediaLocation = await mkdtemp(join(tmpdir(), 'frameleaf-landmark-restore-'));
      const logger = LoggingRepository.create();
      const config = new ConfigRepository();
      const env = config.getEnv();
      const geodata = {
        ...env.resourcePaths.geodata,
        dateFile: join(mediaLocation, 'geodata-date.txt'),
        landmarks: resolve('base-image/geodata/landmarks/landmarks.ndjson.gz'),
      };
      await writeFile(geodata.dateFile, '2026-10-11');
      const databaseUrl = async (db: Kysely<DB>) => {
        const { rows } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
        return canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name);
      };

      try {
        vi.spyOn(config, 'getEnv').mockReturnValue({
          ...env,
          resourcePaths: { ...env.resourcePaths, geodata },
          database: { ...env.database, config: { connectionType: 'url', url: await databaseUrl(source) } },
          storage: { ...env.storage, mediaLocation },
        });
        await new SystemMetadataRepository(source).set(SystemMetadataKey.ReverseGeocodingState, {
          lastUpdate: '2026-10-11',
          lastImportFileName: 'cities500.zip',
        });
        const map = (db: Kysely<DB>) =>
          new MapRepository(config, new SystemMetadataRepository(db), logger, db as never);
        await expect(map(source).init()).resolves.toBe(true);
        const asset = await seedCanonicalAsset(source, { ownerId: '00000000-0000-4000-8000-000000000382' });
        await source
          .insertInto('asset_exif')
          .values({ assetId: asset.id, latitude: 33.8121, longitude: -117.919 })
          .execute();
        const matches = await new SearchRepository(source).getAssetLandmarks(asset.id);
        expect(matches.map(({ id }) => id)).toContain('Q181185');
        const places = await source.selectFrom('landmark').selectAll().orderBy('id').execute();
        const areas = await source.selectFrom('landmark_area').select(['landmarkId', 'area']).orderBy('id').execute();
        expect(places.length).toBeGreaterThan(20_000);
        expect(areas.length).toBeGreaterThan(5000);

        const processRepository = new ProcessRepository();
        const spawn = processRepository.spawnDuplexStream.bind(processRepository);
        vi.spyOn(processRepository, 'spawnDuplexStream').mockImplementation((command, args = [], options) =>
          spawn(
            command.endsWith('/pg_dump') ? 'pg_dump' : command,
            command === 'gzip' && process.platform === 'darwin' ? args.filter((arg) => arg !== '--rsyncable') : args,
            { ...options, env: { ...process.env, ...options?.env } },
          ),
        );
        const backup = new DatabaseBackupService(
          logger,
          new StorageRepository(logger),
          config,
          {} as never,
          processRepository,
          new DatabaseRepository(source, logger, config),
          {} as never,
          undefined as never,
          undefined as never,
        );
        StorageCore.reset();
        StorageCore.setMediaLocation(mediaLocation);
        await mkdir(StorageCore.getBaseFolder(StorageFolder.Backups), { recursive: true });
        const dump = gunzipSync(await readFile(await backup.createDatabaseBackup()));

        // Only this test's disposable clone is replaced; the source remains available for comparison.
        await sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public`.execute(restored);
        execFileSync('psql', ['--dbname', await databaseUrl(restored), '--set', 'ON_ERROR_STOP=1'], {
          input: dump,
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        await expect(restored.selectFrom('landmark').select('id').execute()).resolves.toEqual([]);
        await expect(restored.selectFrom('landmark_area').select('landmarkId').execute()).resolves.toEqual([]);
        const before = await restored
          .selectFrom('asset_landmark')
          .select('landmarkId')
          .where('assetId', '=', asset.id)
          .execute();
        expect(before.map(({ landmarkId }) => landmarkId).sort()).toEqual(matches.map(({ id }) => id).sort());
        await expect(new SearchRepository(restored).getAssetLandmarks(asset.id)).resolves.toEqual([]);

        // A fresh repository runs the same init invoked by the microservices worker on restart.
        await expect(map(restored).init()).resolves.toBe(true);
        await expect(restored.selectFrom('landmark').selectAll().orderBy('id').execute()).resolves.toEqual(places);
        await expect(
          restored.selectFrom('landmark_area').select(['landmarkId', 'area']).orderBy('id').execute(),
        ).resolves.toEqual(areas);
        await expect(new SearchRepository(restored).getAssetLandmarks(asset.id)).resolves.toEqual(matches);
        await expect(map(restored).init()).resolves.toBe(false);
      } finally {
        await Promise.all([source.destroy(), restored.destroy()]);
        await rm(mediaLocation, { recursive: true, force: true });
        StorageCore.reset();
      }
    },
  );
});

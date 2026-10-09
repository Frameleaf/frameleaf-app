import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { BuddySettingsSchema } from 'src/dtos/buddy-backup.dto.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository, clearEnvCache } from 'src/repositories/config.repository.js';
import { BuddyBackupCaptureService } from 'src/services/buddy-backup-capture.service.js';
import { createBuddyKeyring, decryptBuddyBlock } from 'src/utils/buddy-backup-crypto.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  statfs: () =>
    Promise.resolve({
      type: 0,
      bsize: 4096,
      blocks: 1_000_000_000,
      bfree: 1_000_000_000,
      bavail: 1_000_000_000,
      files: 1_000_000,
      ffree: 1_000_000,
    }),
}));

describe('Buddy effective configuration file capture', () => {
  let directory: string;
  let db: Kysely<DB>;
  let service: BuddyBackupCaptureService;
  let configPath: string;
  let dumpPath: string;
  let referencePaths: unknown[];
  let environment: NodeJS.ProcessEnv;
  const plaintext = Buffer.from('{"oauth":{"clientSecret":"synthetic-config-secret"}}');
  const ring = createBuddyKeyring(randomUUID());

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'buddy-config-capture-')));
    configPath = join(directory, 'effective-settings.json');
    dumpPath = join(directory, 'synthetic-database.sql.gz');
    await mkdir(join(directory, 'host'));
    await mkdir(join(directory, 'identity', 'buddy'), { recursive: true });
    await writeFile(configPath, plaintext);
    await writeFile(dumpPath, 'synthetic database dump');
    environment = process.env;
    process.env = { TZ: 'UTC' };
    clearEnvCache();
    vi.stubEnv('FRAMELEAF_CONFIG_FILE', undefined);
    vi.stubEnv('IMMICH_CONFIG_FILE', undefined);
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(join(directory, 'media'));
    referencePaths = [];
    class CaptureDriver extends DummyDriver {
      override async acquireConnection(): Promise<DatabaseConnection> {
        const connection = await super.acquireConnection();
        return {
          ...connection,
          executeQuery: <R>(query: CompiledQuery) => {
            if (query.sql.includes('buddy_backup_reference')) referencePaths.push(...query.parameters);
            return Promise.resolve({
              rows: query.sql.includes('pg_export_snapshot') ? [{ snapshot: 'synthetic-snapshot' } as R] : [],
            });
          },
          streamQuery: connection.streamQuery.bind(connection),
        };
      }
    }
    db = new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new CaptureDriver(),
        createIntrospector: (database) => new PostgresIntrospector(database),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const repository = new BuddyBackupRepository(db, {} as never);
    vi.spyOn(repository, 'root').mockReturnValue(join(directory, 'identity', 'buddy'));
    service = new BuddyBackupCaptureService(
      repository,
      { createDatabaseBackup: () => Promise.resolve(dumpPath) } as never,
      {} as never,
      { readAll: () => Promise.resolve([]) } as unknown as CloudBackupKeyRepository,
    );
  });

  const capture = (runId: string, configurationFiles: string[] = []) =>
    service.capture({
      runId,
      instanceId: randomUUID(),
      sequence: 1,
      previous: null,
      ring,
      settings: BuddySettingsSchema.parse({
        directory: join(directory, 'host'),
        quotaBytes: 20 * 1024 ** 3,
        timezone: 'UTC',
        configurationFiles,
      }),
      checkpoint: () => Promise.resolve(),
    });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.env = environment;
    clearEnvCache();
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['legacy only', undefined, true, false],
    ['canonical only', 'selected', false, false],
    ['empty canonical with legacy', '', true, false],
    ['both names with the same path', 'selected', true, false],
    ['explicit allowlist deduplication', 'selected', false, true],
  ] as const)('captures encrypted effective settings for %s', async (_name, canonical, legacy, explicit) => {
    vi.stubEnv('FRAMELEAF_CONFIG_FILE', canonical === 'selected' ? configPath : canonical);
    vi.stubEnv('IMMICH_CONFIG_FILE', legacy ? configPath : undefined);
    expect(new ConfigRepository().getEnv().configFile).toBe(configPath);
    const runId = randomUUID();
    const captured = await capture(runId, explicit ? [configPath, configPath] : []);
    const sha256 = createHash('sha256').update(plaintext).digest('hex');
    expect(captured.manifest.configurationFiles).toEqual([
      expect.objectContaining({ path: configPath, role: 'configuration', sha256, size: plaintext.length }),
    ]);
    expect(referencePaths).toContainEqual([configPath]);
    const content = captured.manifest.contents[sha256];
    expect(content.blocks).toHaveLength(1);
    const id = content.blocks[0];
    const sealed = await readFile(service.blockPath(id, runId));
    expect(sealed.includes(plaintext)).toBe(false);
    expect(
      decryptBuddyBlock(
        Buffer.from(ring.keys[ring.current], 'base64url'),
        { vaultId: ring.vaultId, id, keyVersion: ring.current },
        sealed,
      ),
    ).toEqual(plaintext);
  });

  it.each(['host', 'identity'])('rejects effective configuration inside the %s boundary', async (location) => {
    const forbidden = join(directory, location, 'settings.json');
    await writeFile(forbidden, plaintext);
    vi.stubEnv('IMMICH_CONFIG_FILE', forbidden);
    const runId = randomUUID();
    await expect(capture(runId)).rejects.toThrow('A backup contains a Buddy vault or server identity files');
    expect(await service.readCapture(runId)).toBeNull();
  });

  it('refuses a missing effective configuration instead of publishing an incomplete snapshot', async () => {
    vi.stubEnv('IMMICH_CONFIG_FILE', join(directory, 'missing-settings.json'));
    const runId = randomUUID();
    await expect(capture(runId)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await service.readCapture(runId)).toBeNull();
  });
});

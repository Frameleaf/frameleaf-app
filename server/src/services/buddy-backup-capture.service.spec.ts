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
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { DB } from 'src/schema/index.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { BuddySettingsSchema } from 'src/dtos/buddy-backup.dto.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository, clearEnvCache } from 'src/repositories/config.repository.js';
import { BuddyBackupCaptureService } from 'src/services/buddy-backup-capture.service.js';
import { createBuddyKeyring, decryptBuddyBlock } from 'src/utils/buddy-backup-crypto.js';
import { cloudNativeWorkStopped } from 'src/utils/cloud-native-work.js';
import { KEY, LINEAGE } from 'test/fixtures/studio-import-retention.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

vi.mock('src/utils/disk-usage.js', () => ({
  getDiskUsage: () =>
    Promise.resolve({ total: 4096 * 1_000_000_000, free: 4096 * 1_000_000_000, available: 4096 * 1_000_000_000 }),
}));

describe('Buddy effective configuration file capture', () => {
  let directory: string;
  let db: Kysely<DB>;
  let service: BuddyBackupCaptureService;
  let configPath: string;
  let dumpPath: string;
  let referencePaths: unknown[];
  let environment: NodeJS.ProcessEnv;
  let studioProject: Record<string, unknown> | undefined;
  let studioImport: Record<string, unknown> | undefined;
  let queries: string[];
  const retained: FileHandle[] = [];
  const plaintext = Buffer.from('{"oauth":{"clientSecret":"synthetic-config-secret"}}');
  const ring = createBuddyKeyring(randomUUID());

  beforeEach(async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockReset().mockImplementation(fs.open);
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
    studioProject = undefined;
    studioImport = undefined;
    queries = [];
    class CaptureDriver extends DummyDriver {
      override async acquireConnection(): Promise<DatabaseConnection> {
        const connection = await super.acquireConnection();
        return {
          ...connection,
          executeQuery: <R>(query: CompiledQuery) => {
            queries.push(query.sql);
            if (query.sql.includes('buddy_backup_reference')) referencePaths.push(...query.parameters);
            if (studioProject && query.sql.startsWith('SELECT to_jsonb(project)'))
              return Promise.resolve({ rows: [{ record: studioProject } as R] });
            if (studioImport && query.sql.includes('FROM "public"."studio_project_import" item'))
              return Promise.resolve({ rows: [{ record: studioImport } as R] });
            if (studioImport && query.sql.startsWith('SELECT path FROM public.studio_project_import'))
              return Promise.resolve({ rows: [{ path: studioImport.path } as R] });
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

  const capture = (
    runId: string,
    configurationFiles: string[] = [],
    checkpoint: () => Promise<void> = () => Promise.resolve(),
  ) =>
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
      checkpoint,
    });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(retained.splice(0).map((file) => file.close()));
    vi.unstubAllEnvs();
    process.env = environment;
    clearEnvCache();
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('refuses cleanup while a capture owns local file work', async () => {
    const runId = randomUUID();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const pending = capture(runId, [], () => {
      entered.resolve();
      return release.promise;
    });
    await entered.promise;
    try {
      await expect(service.release(runId)).rejects.toThrow('still owned by unfinished work');
      expect(await cloudNativeWorkStopped(service.runDirectory(runId))).toBe(false);
    } finally {
      release.resolve();
      await pending;
    }
    expect(await cloudNativeWorkStopped(service.runDirectory(runId))).toBe(true);
    await service.release(runId);
  });

  it('does not let database reconciliation remove an active filesystem producer', async () => {
    const runId = randomUUID();
    await mkdir(service.runDirectory(runId), { recursive: true });
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const pending = capture(runId, [], () => {
      entered.resolve();
      return release.promise;
    });
    await entered.promise;
    try {
      await service.reconcile();
      expect(await cloudNativeWorkStopped(service.runDirectory(runId))).toBe(false);
    } finally {
      release.resolve();
      await pending;
    }
    await service.reconcile();
    expect(await cloudNativeWorkStopped(service.runDirectory(runId))).toBe(true);
  });

  it('retains the database dump and ownership when a capture descriptor cannot confirm close', async () => {
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await real.open(...args);
      if (String(args[0]) !== dumpPath) return file;
      retained.push(file);
      return new Proxy(file, {
        get(target, key) {
          if (key === 'close') return () => Promise.reject(new Error('synthetic close failure'));
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    const runId = randomUUID();
    await expect(capture(runId)).rejects.toThrow('buddy_file_close_unconfirmed');
    expect(await readFile(dumpPath, 'utf8')).toBe('synthetic database dump');
    expect(await cloudNativeWorkStopped(service.runDirectory(runId))).toBe(false);
    await expect(service.release(runId)).rejects.toThrow('still owned by unfinished work');
  });

  it('captures ready import lineage and its pinned bytes without operational journal records', async () => {
    const path = join(directory, 'retained.mp4');
    const bytes = Buffer.from('synthetic ready media');
    await writeFile(path, bytes);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    studioProject = {
      id: KEY.projectId,
      ownerId: KEY.ownerId,
      name: 'Retained project',
      currentRevision: 0,
      createdAt: new Date(0).toISOString(),
      archivedAt: null,
      thumbnailAssetId: null,
      duplicatedFromId: null,
      importedFromDigest: null,
    };
    studioImport = {
      id: KEY.importId,
      projectId: KEY.projectId,
      ownerId: KEY.ownerId,
      createdAt: new Date(0).toISOString(),
      contentType: 'video/mp4',
      checksum,
      sizeBytes: bytes.length,
      path,
      fileName: 'retained.mp4',
      externalReferences: null,
      processingProvenance: { ...LINEAGE, outputSha256: checksum },
    };
    const captured = await capture(randomUUID());
    expect(captured.manifest.studio?.projects[KEY.projectId].imports).toEqual([studioImport]);
    expect(referencePaths).toContainEqual([path]);
    expect(captured.manifest.studio?.projects[KEY.projectId].files).toEqual([
      expect.objectContaining({ path, sha256: checksum, size: bytes.length }),
    ]);
    expect(queries.some((query) => query.includes('studio_import_publication'))).toBe(false);
    expect(JSON.stringify(captured.manifest.studio)).not.toMatch(/publicationId|stagedPath|stagedIdentity/);
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

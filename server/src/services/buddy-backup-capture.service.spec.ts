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
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FileHandle } from 'node:fs/promises';
import type { DB } from 'src/schema/index.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { BuddySettingsSchema } from 'src/dtos/buddy-backup.dto.js';
import { AssetType, ChecksumAlgorithm } from 'src/enum.js';
import { AssetLocalEffectRepository, type SourceEpoch } from 'src/repositories/asset-local-effect.repository.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository, clearEnvCache } from 'src/repositories/config.repository.js';
import { BuddyBackupCaptureService } from 'src/services/buddy-backup-capture.service.js';
import { BUDDY_BLOCK_BYTES, createBuddyKeyring, decryptBuddyBlock } from 'src/utils/buddy-backup-crypto.js';
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
  let referenceAsset: Record<string, unknown> | undefined;
  const sourceStreams: Readable[] = [];
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
    referenceAsset = undefined;
    class CaptureDriver extends DummyDriver {
      override async acquireConnection(): Promise<DatabaseConnection> {
        const connection = await super.acquireConnection();
        return {
          ...connection,
          executeQuery: <R>(query: CompiledQuery) => {
            queries.push(query.sql);
            if (query.sql.includes('buddy_backup_reference')) referencePaths.push(...query.parameters);
            if (referenceAsset && query.sql.includes('from "asset"'))
              return Promise.resolve({ rows: [referenceAsset as R] });
            if (
              referenceAsset &&
              query.sql.startsWith('SELECT "originalPath" AS path') &&
              !query.sql.includes('WHERE "isOffline"')
            )
              return Promise.resolve({ rows: [{ path: referenceAsset.originalPath } as R] });
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
      claimToken: randomUUID(),
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
    for (const stream of sourceStreams.splice(0)) stream.destroy();
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

  describe('independent reference originals', () => {
    const setup = (bytes = Buffer.from('independent synthetic original')) => {
      const assetId = randomUUID();
      const ownerId = randomUUID();
      const sourcePath = `frameleaf-source://${randomUUID()}/${'ef'.repeat(32)}`;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const epoch: SourceEpoch = {
        assetId,
        ownerId,
        epoch: '0',
        reference: { resourceId: randomUUID(), version: '12'.repeat(32), sha256 },
      };
      referenceAsset = {
        id: assetId,
        ownerId,
        originalPath: sourcePath,
        checksum: Buffer.alloc(20, 7),
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
        type: AssetType.Image,
        livePhotoVideoId: null,
        libraryId: randomUUID(),
        isExternal: true,
      };
      const proof = vi.spyOn(AssetLocalEffectRepository, 'sourceEpochs').mockResolvedValue([epoch]);
      vi.spyOn(CloudBackupIndexRepository.prototype, 'listAssets')
        .mockResolvedValue([])
        .mockResolvedValueOnce([
          {
            ...referenceAsset,
            files: [],
            sha256: null,
            checksumSize: null,
            verifiedAt: null,
            checksumPathVerified: false,
          } as never,
        ]);
      vi.spyOn(CloudBackupIndexRepository.prototype, 'getAssetDetails').mockResolvedValue(
        new Map([
          [
            assetId,
            {
              record: { originalFileName: 'reference.jpg', type: AssetType.Image },
              details: { albums: [], faces: [], edits: [], tags: [] },
            } as never,
          ],
        ]),
      );
      const stream = Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]);
      sourceStreams.push(stream);
      const settled = new Promise<void>((resolve) => stream.once('close', resolve));
      const input = {
        stream,
        settled,
        localPath: '/private/source-cache/borrowed.artifact',
        resourceId: epoch.reference!.resourceId,
        resourceVersion: epoch.reference!.version,
        verifiedSha256: sha256,
        byteLength: bytes.length,
        signal: new AbortController().signal,
        check: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(async () => {
          stream.destroy();
          await settled;
        }),
      };
      const open = vi.fn(async (_id: string, _reader: unknown, authorize: () => Promise<void>) => {
        await authorize();
        return input;
      });
      Object.assign(service, { sourceOriginalService: { open } });
      return { assetId, ownerId, sourcePath, sha256, epoch, proof, input, open, bytes };
    };

    it('encrypts exact bytes across block boundaries and resumes independently of the source', async () => {
      const original = Buffer.alloc(BUDDY_BLOCK_BYTES + 3, 7);
      original.fill(9, BUDDY_BLOCK_BYTES);
      const { assetId, ownerId, sha256, proof, input, open, bytes, epoch } = setup(original);
      const runId = randomUUID();
      const captured = await capture(runId);
      expect(open).toHaveBeenCalledWith(
        assetId,
        expect.objectContaining({ kind: 'http' }),
        expect.any(Function),
        undefined,
        undefined,
        { operationId: runId, claimToken: expect.any(String) },
      );
      expect(captured.manifest.version).toBe(2);
      expect(captured.manifest.referenceOriginals?.[assetId].sourceEpoch).toEqual(epoch);
      expect(captured.manifest.library.assets[assetId]).toMatchObject({
        owner: ownerId,
        files: [{ role: 'original', sha256, size: bytes.length }],
      });
      expect(JSON.stringify(captured.manifest)).not.toContain(input.localPath);
      expect(JSON.stringify(referencePaths)).not.toMatch(/frameleaf-source:|borrowed[.]artifact/);
      expect(input.release).toHaveBeenCalledTimes(1);
      const content = captured.manifest.contents[sha256];
      expect(content.blocks).toHaveLength(2);
      const key = Buffer.from(ring.keys[ring.current], 'base64url');
      const restored = await Promise.all(
        content.blocks.map(async (id) =>
          decryptBuddyBlock(
            key,
            { vaultId: ring.vaultId, id, keyVersion: ring.current },
            await readFile(service.blockPath(id, runId)),
          ),
        ),
      );
      expect(Buffer.concat(restored).equals(bytes)).toBe(true);
      expect(proof.mock.calls.some(([database]) => database.isTransaction)).toBe(true);
      expect(proof.mock.calls.some(([database]) => !database.isTransaction)).toBe(true);
      open.mockClear();
      proof.mockResolvedValue([]);
      expect((await capture(runId)).manifest).toEqual(captured.manifest);
      expect(open).not.toHaveBeenCalled();
    });

    it.each(['resourceId', 'resourceVersion', 'verifiedSha256', 'byteLength'] as const)(
      'rejects a changed delivered %s',
      async (field) => {
        const { input } = setup();
        if (field === 'byteLength') input.byteLength++;
        else input[field] = 'changed';
        const runId = randomUUID();
        await expect(capture(runId)).rejects.toThrow();
        expect(input.release).toHaveBeenCalledTimes(1);
        await expect(lstat(join(service.runDirectory(runId), 'capture.json'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      },
    );

    it('refuses live source revocation before opening any original', async () => {
      const { proof, epoch, open } = setup();
      proof.mockImplementation((database) => Promise.resolve(database.isTransaction ? [epoch] : []));
      await expect(capture(randomUUID())).rejects.toThrow('Buddy source original changed');
      expect(open).not.toHaveBeenCalled();
    });

    it('refuses a capture whose paged inventory omitted a frozen reference original', async () => {
      const { open } = setup();
      vi.mocked(CloudBackupIndexRepository.prototype.listAssets).mockReset().mockResolvedValue([]);
      await expect(capture(randomUUID())).rejects.toThrow('Buddy source original inventory is incomplete');
      expect(open).not.toHaveBeenCalled();
    });

    it('hashes the actual copied stream rather than trusting its verified header', async () => {
      const { bytes, input } = setup();
      bytes[0] ^= 0xff;
      const runId = randomUUID();
      await expect(capture(runId)).rejects.toThrow('Buddy source original bytes changed');
      expect(input.release).toHaveBeenCalledTimes(1);
      await expect(lstat(join(service.runDirectory(runId), 'capture.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await service.release(runId);
    });

    it('rechecks the job checkpoint after a live source query before opening the original', async () => {
      const { epoch, proof, open } = setup();
      let owned = true;
      proof.mockImplementation((database) => {
        if (!database.isTransaction) owned = false;
        return Promise.resolve([epoch]);
      });
      await expect(
        capture(randomUUID(), [], () => {
          if (!owned) throw new Error('synthetic claim lost');
          return Promise.resolve();
        }),
      ).rejects.toThrow('synthetic claim lost');
      expect(open).not.toHaveBeenCalled();
    });

    it('does not finalize metadata when source authority changes during input cleanup', async () => {
      const { epoch, proof, input } = setup();
      input.release.mockImplementationOnce(async () => {
        input.stream.destroy();
        await input.settled;
        proof.mockImplementation((database) => Promise.resolve(database.isTransaction ? [epoch] : []));
      });
      const runId = randomUUID();
      await expect(capture(runId)).rejects.toThrow('Buddy source original changed');
      expect(input.release).toHaveBeenCalledTimes(1);
      await expect(lstat(join(service.runDirectory(runId), 'capture.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps the capture owner when source input closure is unconfirmed', async () => {
      const { input } = setup();
      input.release.mockRejectedValueOnce(new Error('artifact_close_unconfirmed'));
      const runId = randomUUID();
      await expect(capture(runId)).rejects.toThrow('artifact_close_unconfirmed');
      await expect(service.release(runId)).rejects.toThrow('Buddy capture files are still owned');
      await service.reconcile();
      expect((await lstat(service.runDirectory(runId))).isDirectory()).toBe(true);
    });
  });

  it('keeps capture staging and pins owned while the exported snapshot producer is in flight', async () => {
    const entered = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<string>();
    Object.assign(service, {
      backups: {
        createDatabaseBackup: () => {
          entered.resolve();
          return stopped.promise;
        },
      },
    });
    const runId = randomUUID();
    const task = capture(runId);
    await entered.promise;
    try {
      await expect(service.release(runId)).rejects.toThrow('Buddy capture files are still owned');
      expect(queries.some((query) => query.startsWith('SELECT path FROM public.buddy_backup_reference'))).toBe(false);
    } finally {
      stopped.resolve(dumpPath);
      await task;
    }
    await service.release(runId);
    await expect(lstat(service.runDirectory(runId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains an unknown writer across missing SQL ownership and refuses another capture attempt', async () => {
    Object.assign(service, {
      backups: { createDatabaseBackup: () => Promise.reject(new Error('buddy_file_close_unconfirmed')) },
    });
    const runId = randomUUID();
    await expect(capture(runId)).rejects.toThrow('buddy_file_close_unconfirmed');
    await expect(service.release(runId)).rejects.toThrow('Buddy capture files are still owned');
    await service.reconcile();
    expect((await lstat(service.runDirectory(runId))).isDirectory()).toBe(true);
    await expect(capture(runId)).rejects.toThrow('Buddy capture files are still owned');
    expect(queries.some((query) => query.startsWith('SELECT path FROM public.buddy_backup_reference'))).toBe(false);
  });

  it('refuses an interrupted metadata-only reference capture before resuming publication', async () => {
    const runId = randomUUID();
    const captured = await capture(runId);
    captured.manifest.library.assets[randomUUID()] = {
      owner: randomUUID(),
      files: [
        {
          role: 'original',
          path: `frameleaf-source://${randomUUID()}/${'ab'.repeat(32)}`,
          sha256: 'cd'.repeat(32),
          size: 5,
          mtime: null,
        },
      ],
    };
    await writeFile(join(service.runDirectory(runId), 'capture.json'), JSON.stringify(captured));
    await expect(capture(runId)).rejects.toThrow('Buddy reference original');
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

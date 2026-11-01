import {
  type LockedKeyFile,
  decryptFile,
  encryptFile,
  generateKeyPair,
  generateRecoveryKey,
  unwrapKey,
  wrapKey,
} from '@frameleaf/locked-crypto';
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
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository, clearEnvCache } from 'src/repositories/config.repository.js';
import { BuddyBackupCaptureService } from 'src/services/buddy-backup-capture.service.js';
import { createBuddyKeyring, decryptBuddyBlock } from 'src/utils/buddy-backup-crypto.js';
import { EMPTY_DETAILS } from 'src/utils/cloud-backup-details.js';
import { KEY, LINEAGE } from 'test/fixtures/studio-import-retention.js';

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
  let rowsFor: (sql: string) => unknown[] | undefined;
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
    studioProject = undefined;
    studioImport = undefined;
    queries = [];
    rowsFor = () => {};
    class CaptureDriver extends DummyDriver {
      override async acquireConnection(): Promise<DatabaseConnection> {
        const connection = await super.acquireConnection();
        return {
          ...connection,
          executeQuery: <R>(query: CompiledQuery) => {
            queries.push(query.sql);
            if (query.sql.includes('buddy_backup_reference')) referencePaths.push(...query.parameters);
            const rows = rowsFor(query.sql);
            if (rows) return Promise.resolve({ rows: rows as R[] });
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

  describe('Locked key files (FL-721)', () => {
    const OWNER = '00000000-0000-4000-8000-000000000001';
    const PASSPHRASE = 'correct horse battery staple';
    const keyText = Buffer.from('{"format":"frameleaf-locked-key/1","wraps":"wrapped-secret-material"}');
    let keyPath: string;

    beforeEach(async () => {
      await mkdir(join(directory, 'media', 'locked-keys'), { recursive: true, mode: 0o700 });
      keyPath = join(directory, 'media', 'locked-keys', `${OWNER}.json`);
      await writeFile(keyPath, keyText, { mode: 0o600 });
      await writeFile(
        join(directory, 'media', 'locked-keys', `${OWNER}.json.0b6e5c7e-3f0b-4c8e-9a51-2f1f3c4d5e6f.tmp`),
        'x',
      );
    });

    it('Buddy capture includes locked-keys/*.json', async () => {
      const runId = randomUUID();
      const captured = await capture(runId);

      const sha256 = createHash('sha256').update(keyText).digest('hex');
      expect(captured.manifest.library.lockedKeys).toEqual({
        [OWNER]: expect.objectContaining({ role: 'locked-key', path: keyPath, sha256, size: keyText.length }),
      });
      expect(captured.manifest.library.profiles).toEqual({});
      // copied as it is, inside the snapshot's own encryption
      const [id] = captured.manifest.contents[sha256].blocks;
      const sealed = await readFile(service.blockPath(id, runId));
      expect(sealed.includes(keyText)).toBe(false);
      expect(
        decryptBuddyBlock(
          Buffer.from(ring.keys[ring.current], 'base64url'),
          { vaultId: ring.vaultId, id, keyVersion: ring.current },
          sealed,
        ),
      ).toEqual(keyText);
    });

    /** An Advanced-mode key file for OWNER and an original sealed to it, with its plaintext SHA-1 on record. */
    const sealedLibrary = async (partnerCopy?: { id: string; ownerId: string }) => {
      const recoveryKey = generateRecoveryKey();
      const pair = generateKeyPair();
      const now = new Date().toISOString();
      let file: Omit<LockedKeyFile, 'wraps'> & { wraps?: LockedKeyFile['wraps'] } = {
        format: 'frameleaf-locked-key/1',
        userId: OWNER,
        label: 'Taylor',
        publicKey: pair.publicKey.toString('base64'),
        mode: 'advanced',
        encrypting: false,
        createdAt: now,
        updatedAt: now,
      };
      file = await wrapKey(file, pair.privateKey, 'passphrase', PASSPHRASE);
      file = await wrapKey(file, pair.privateKey, 'recovery', recoveryKey);
      await writeFile(keyPath, JSON.stringify(file), { mode: 0o600 });

      const assetId = randomUUID();
      const folder = join(directory, 'media', 'library', OWNER);
      await mkdir(folder, { recursive: true });
      const plain = Buffer.from('the photo, in plain, long enough to be a photo');
      const plainPath = join(directory, 'plain.jpg');
      await writeFile(plainPath, plain);
      const original = join(folder, 'IMG_1.jpg');
      await encryptFile(plainPath, original, [{ publicKey: pair.publicKey }], {
        assetId,
        kind: 'original',
        originalFileName: 'IMG_1.jpg',
        mime: 'image/jpeg',
      });
      // the checksum on record stays the plaintext's after a seal
      const checksum = createHash('sha1').update(plain).digest();
      rowsFor = (text) => {
        if (text.includes('SELECT "originalPath" AS path FROM public.asset') && !text.includes('isOffline'))
          return [{ path: original }];
        if (text.includes('"livePhotoVideoId"'))
          return ids.map((id) => ({
            id,
            checksum,
            checksumAlgorithm: 'sha1',
            livePhotoVideoId: null,
            libraryId: null,
            isExternal: false,
          }));
        // each asset's fidelity source, in capture order
        if (text.includes('"checksumAlgorithm", "type"')) {
          const { id, ownerId } = assets[sources++ % assets.length];
          return [{ id, ownerId, checksum, checksumAlgorithm: 'sha1', type: 'IMAGE' }];
        }
      };
      let sources = 0;
      // a partner copy points at the owner's file (FL-721 C1)
      const assets = [{ id: assetId, ownerId: OWNER }, ...(partnerCopy ? [partnerCopy] : [])];
      const ids = assets.map(({ id }) => id);
      vi.spyOn(CloudBackupIndexRepository.prototype, 'listAssets')
        .mockResolvedValueOnce(
          assets.map(({ id, ownerId }) => ({
            id,
            ownerId,
            originalPath: original,
            sha256: null,
            checksumSize: null,
            verifiedAt: null,
            checksumPathVerified: false,
            files: [],
          })) as never,
        )
        .mockResolvedValue([]);
      vi.spyOn(CloudBackupIndexRepository.prototype, 'getAssetDetails').mockResolvedValue(
        new Map(ids.map((id) => [id, { record: {}, details: EMPTY_DETAILS }])) as never,
      );
      return { assetId, original, plain, recoveryKey };
    };

    it('captures an encrypted original as it is, and the snapshot opens with the passphrase and with the recovery key', async () => {
      const { assetId, original, plain, recoveryKey } = await sealedLibrary();
      const runId = randomUUID();

      const captured = await capture(runId);

      const key = Buffer.from(ring.keys[ring.current], 'base64url');
      const contentOf = async (sha256: string) =>
        Buffer.concat(
          await Promise.all(
            captured.manifest.contents[sha256].blocks.map(async (id) =>
              decryptBuddyBlock(
                key,
                { vaultId: ring.vaultId, id, keyVersion: ring.current },
                await readFile(service.blockPath(id, runId)),
              ),
            ),
          ),
        );
      const [file] = captured.manifest.library.assets[assetId].files;
      expect(file).toMatchObject({ role: 'original', path: original });
      // the ciphertext, byte for byte, never decrypted on the way
      const backedUp = await contentOf(file.sha256);
      expect(backedUp).toEqual(await readFile(original));
      expect(backedUp.includes(plain)).toBe(false);

      const keyFile = JSON.parse(
        (await contentOf(captured.manifest.library.lockedKeys![OWNER].sha256)).toString(),
      ) as LockedKeyFile;
      const restored = join(directory, 'restored.jpg');
      await writeFile(restored, backedUp);
      for (const [kind, secret] of [
        ['passphrase', PASSPHRASE],
        ['recovery', recoveryKey],
      ] as const) {
        const out = join(directory, `opened-${kind}.jpg`);
        await decryptFile(restored, out, await unwrapKey(keyFile, kind, secret));
        expect(await readFile(out)).toEqual(plain);
      }
    });

    it('refuses a snapshot whose encrypted files have no key file from its start', async () => {
      await sealedLibrary();
      // encryption changed during the run: no key file when the capture started
      await rm(keyPath);

      await expect(capture(randomUUID())).rejects.toThrow('whose key file was not there when it started');
    });

    it('a partner copy of an encrypted item needs the owner’s key file, never the partner’s', async () => {
      // the partner never set a Locked PIN: no key file of theirs
      const partnerCopy = { id: randomUUID(), ownerId: randomUUID() };
      const { assetId } = await sealedLibrary(partnerCopy);

      const captured = await capture(randomUUID());

      expect(captured.manifest.library.assets[assetId]).toBeDefined();
      expect(captured.manifest.library.assets[partnerCopy.id]).toMatchObject({ owner: partnerCopy.ownerId });
      expect(Object.keys(captured.manifest.library.lockedKeys ?? {})).toEqual([OWNER]);
    });

    it('a file with a .fllk.tmp sibling is left for the next run', async () => {
      const assetId = randomUUID();
      const folder = join(directory, 'media', 'library', OWNER);
      await mkdir(folder, { recursive: true });
      const original = join(folder, 'IMG_1.jpg');
      await writeFile(original, 'plain');
      await writeFile(`${original}.0b6e5c7e-3f0b-4c8e-9a51-2f1f3c4d5e6f.fllk.tmp`, 'half sealed');
      rowsFor = (text) => {
        if (text.includes('SELECT "originalPath" AS path FROM public.asset') && !text.includes('isOffline'))
          return [{ path: original }];
        if (text.includes('"livePhotoVideoId"'))
          return [
            {
              id: assetId,
              checksum: Buffer.alloc(20),
              checksumAlgorithm: 'sha1-path',
              livePhotoVideoId: null,
              libraryId: null,
              isExternal: false,
            },
          ];
      };
      vi.spyOn(CloudBackupIndexRepository.prototype, 'listAssets')
        .mockResolvedValueOnce([
          {
            id: assetId,
            ownerId: OWNER,
            originalPath: original,
            sha256: null,
            checksumSize: null,
            verifiedAt: null,
            checksumPathVerified: false,
            files: [],
          },
        ] as never)
        .mockResolvedValue([]);
      vi.spyOn(CloudBackupIndexRepository.prototype, 'getAssetDetails').mockResolvedValue(
        new Map([[assetId, { record: {}, details: EMPTY_DETAILS }]]) as never,
      );

      const captured = await capture(randomUUID());

      expect(captured.manifest.library.assets[assetId]).toBeUndefined();
      expect(Object.values(captured.manifest.library.lockedKeys ?? {})).toHaveLength(1);
    });
  });
});

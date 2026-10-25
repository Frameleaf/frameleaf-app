import { type Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import type { BuddyRecovery } from 'src/utils/buddy-backup-recovery.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetStatus, ChecksumAlgorithm, PhysicalFileType } from 'src/enum.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { BuddyBackupFidelityRepository } from 'src/repositories/buddy-backup-fidelity.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SourceResourceCacheRepository } from 'src/repositories/source-resource-cache.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { BuddyRecoveryFiles, buddyFileHash, readBuddyRecovery } from 'src/utils/buddy-backup-recovery.js';
import { type BuddyReferenceAdoption, adoptBuddyReferenceOriginal } from 'src/utils/buddy-reference-adoption.js';
import { referenceOriginalPath } from 'src/utils/buddy-reference-originals.js';
import { recoverBuddyReferenceOriginals } from 'src/utils/buddy-reference-recovery.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { resetSourceResourcesAfterRestore } from 'src/utils/source-resource-restore.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe('Buddy independent reference recovery in stopped-server maintenance', () => {
  let db: Kysely<DB>;
  let root: string;
  let owners: string[];
  beforeAll(async () => {
    db = await getKyselyDB();
  }, 30_000);
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(async () => {
    owners = [];
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-reference-recovery-')));
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(root);
  });
  afterEach(async () => {
    await db.deleteFrom('user').where('id', 'in', owners).execute();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  const fixture = async (trashed = false) => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    owners.push(user.id);
    const device = (await new DesktopDeviceRepository(db).enroll({
      userId: user.id,
      installationId: randomUUID(),
      publicKey: randomBytes(32).toString('base64'),
      name: 'Offline desktop',
      platform: 'linux',
      architecture: 'x86_64',
      mode: 'client-worker',
      state: 'revoked',
    }))!;
    const source = await db
      .insertInto('photo_source')
      .values({
        ownerId: user.id,
        deviceId: device.id,
        photoSessionId: randomUUID(),
        kind: 'folder',
        mode: 'copy',
        name: 'Offline source',
        scopeFingerprint: 'a'.repeat(64),
        revokedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await sql`UPDATE photo_source SET mode='reference' WHERE id=${source.id}::uuid`.execute(db);
    const run = await db
      .insertInto('photo_source_run')
      .values({ sourceId: source.id, maxBytes: 100, maxItems: 2 })
      .returningAll()
      .executeTakeFirstOrThrow();
    const library = await new LibraryRepository(db).create({
      ownerId: user.id,
      name: 'Offline reference library',
      readOnly: true,
      importPaths: [],
      exclusionPatterns: [],
    });
    const sourcePath = `frameleaf-source://${source.id}/${'b'.repeat(64)}`;
    const checksum = createHash('sha1').update(sourcePath).digest();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      libraryId: library.id,
      isExternal: true,
      isOffline: true,
      originalPath: sourcePath,
      originalFileName: 'original.CR2',
      checksum,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      status: trashed ? AssetStatus.Trashed : AssetStatus.Active,
      deletedAt: trashed ? new Date() : null,
      isFavorite: true,
    });
    const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
    const bytes = Buffer.from('hello');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const resource = await db
      .insertInto('photo_source_resource')
      .values({
        runId: run.id,
        resourceKey: 'b'.repeat(64),
        version: 'c'.repeat(64),
        checksum: Buffer.from(sha256, 'hex'),
        bytes: bytes.length,
        assetId: asset.id,
        state: 'verified',
        verifiedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('source_original')
      .values({
        assetId: asset.id,
        resourceId: resource.id,
        scopeFingerprint: source.scopeFingerprint,
        authorizationEpoch: device.authorizationEpoch,
      })
      .execute();
    await db.updateTable('user').set({ quotaUsageInBytes: 100 }).where('id', '=', user.id).execute();
    // The actual recovery transaction has already revoked all restored sessions.
    await db.deleteFrom('session').execute();
    const path = referenceOriginalPath(root, user.id, asset.id, asset.originalFileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const file = { path, sha256, size: bytes.length, role: 'original', mtime: null };
    const state = await new BuddyBackupFidelityRepository(db).capture(asset.id, sha256, [], []);
    const plan = {
      version: 1,
      scope: 'server',
      mode: 'replace',
      files: [file],
      manifest: {
        version: 2,
        storageRoot: root,
        storageRoots: [root],
        library: {
          assets: {
            [asset.id]: { owner: user.id, type: asset.type, originalFileName: asset.originalFileName, files: [file] },
          },
        },
        contents: { [sha256]: { bytes: bytes.length, keyVersion: 1, blocks: ['d'.repeat(64)] } },
        referenceOriginals: {
          [asset.id]: {
            version: 1,
            sourcePath,
            sourceEpoch: {
              assetId: asset.id,
              ownerId: user.id,
              epoch: '0',
              reference: { resourceId: resource.id, version: resource.version, sha256 },
            },
          },
        },
        assetFidelity: { [asset.id]: state },
      },
    } as unknown as BuddyRecovery;
    return { ctx, user, asset, album, source, resource, plan, file };
  };
  it('revokes restored grants and read claims while retaining cache writer and reader ownership', async () => {
    const f = await fixture();
    const session = await db
      .insertInto('session')
      .values({ userId: f.user.id, token: randomBytes(32) })
      .returningAll()
      .executeTakeFirstOrThrow();
    const grant = await db
      .insertInto('source_resource_grant')
      .values({
        sourceId: f.source.id,
        photoSessionId: session.id,
        tokenHash: randomBytes(32),
        scopeFingerprint: f.source.scopeFingerprint,
        authorizationEpoch: 1,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const read = await db
      .insertInto('source_resource_read')
      .values({
        assetId: f.asset.id,
        resourceId: f.resource.id,
        sourceId: f.source.id,
        ownerId: f.user.id,
        deviceId: f.source.deviceId,
        scopeFingerprint: f.source.scopeFingerprint,
        authorizationEpoch: 1,
        state: 'claimed',
        claimFence: 1,
        claimTokenHash: randomBytes(32),
        claimCredentialHash: randomBytes(32),
        leaseUntil: new Date(Date.now() + 60_000),
        deadline: new Date(Date.now() + 600_000),
        backupOperationId: null,
        backupClaimTokenHash: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const cache = await db
      .insertInto('source_resource_cache')
      .values({
        readId: read.id,
        claimFence: 1,
        assetId: f.asset.id,
        resourceId: f.resource.id,
        sourceId: f.source.id,
        ownerId: f.user.id,
        deviceId: f.source.deviceId,
        scopeFingerprint: f.source.scopeFingerprint,
        authorizationEpoch: 1,
        resourceKey: f.resource.resourceKey,
        version: f.resource.version,
        sha256: f.resource.checksum,
        bytes: f.resource.bytes,
        writerId: randomUUID(),
        writerOwnerId: randomUUID(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const lease = await db
      .insertInto('source_resource_cache_lease')
      .values({ cacheId: cache.id, readerId: randomUUID(), readerOwnerId: randomUUID(), kind: 'http' })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db.transaction().execute(resetSourceResourcesAfterRestore);
    expect(
      (
        await db
          .selectFrom('source_resource_grant')
          .select('revokedAt')
          .where('id', '=', grant.id)
          .executeTakeFirstOrThrow()
      ).revokedAt,
    ).not.toBeNull();
    expect(
      await db
        .selectFrom('source_resource_read')
        .select(['state', 'claimTokenHash', 'claimCredentialHash', 'leaseUntil'])
        .where('id', '=', read.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'unavailable', claimTokenHash: null, claimCredentialHash: null, leaseUntil: null });
    expect(
      await db.selectFrom('source_resource_cache').selectAll().where('id', '=', cache.id).executeTakeFirstOrThrow(),
    ).toEqual({ ...cache, restoreHeld: true });
    expect(
      await db
        .selectFrom('source_resource_cache_lease')
        .selectAll()
        .where('id', '=', lease.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(lease);
    expect(await new SourceResourceCacheRepository(db).claimRemoval(cache.id)).toBeUndefined();
  });

  const restore = (plan: BuddyRecovery) =>
    db.transaction().execute((trx) => recoverBuddyReferenceOriginals(trx, plan, async () => {}));

  const interrupted = async (status: AssetDevelopRevisionStatus.Queued | AssetDevelopRevisionStatus.Rendering) => {
    const f = await fixture();
    const source = {
      assetId: f.asset.id,
      path: f.asset.originalPath,
      checksum: f.asset.checksum.toString('hex'),
      reference: { resourceId: f.resource.id, version: f.resource.version, sha256: f.file.sha256 },
    };
    const recipe = defaultDevelopRecipe();
    const { rows } = await sql<{ id: string }>`INSERT INTO public.asset_develop_revision
      ("assetId","ownerId",revision,recipe,status,"sourceAssetId","sourceBinding","sourceChecksum",
        "renderAttemptId","renderGenerationId",progress,attempts,"cancelRequested")
      VALUES (${f.asset.id}::uuid,${f.user.id}::uuid,1,${JSON.stringify(recipe)}::text::jsonb,${status},
        ${f.asset.id}::uuid,${JSON.stringify({ kind: 'bound', parent: source, input: source })}::text::jsonb,
        ${Buffer.from(f.file.sha256, 'hex')},${randomUUID()}::uuid,${randomUUID()}::uuid,70,3,true) RETURNING id`.execute(
      db,
    );
    f.plan.manifest.assetFidelity![f.asset.id] = await new BuddyBackupFidelityRepository(db).capture(
      f.asset.id,
      f.file.sha256,
      [],
      [],
    );
    const revisions = new AssetDevelopRepository(db);
    const previous = (await revisions.get(rows[0].id))!;
    return { ...f, recipe, revisions, previous };
  };

  it.each([AssetDevelopRevisionStatus.Queued, AssetDevelopRevisionStatus.Rendering] as const)(
    'recovers an interrupted %s recipe as saved without reviving its execution',
    async (status) => {
      const f = await interrupted(status);
      await restore(f.plan);
      const recovered = (await f.revisions.get(f.previous.id))!;
      expect(recovered).toMatchObject({
        recipe: f.recipe,
        status: AssetDevelopRevisionStatus.Saved,
        progress: 0,
        attempts: 0,
        cancelRequested: false,
        renderAttemptId: null,
        renderGenerationId: null,
        isCurrent: false,
      });
      const source = { assetId: f.asset.id, path: f.file.path, checksum: f.file.sha256, reference: null };
      expect(recovered.sourceBinding).toEqual({ kind: 'bound', parent: source, input: source });
      expect((await f.revisions.listUnfinished()).some((revision) => revision.id === f.previous.id)).toBe(false);
      expect(await f.revisions.progressAttempt(f.previous, 99)).toBe(false);
      await f.revisions.settleAttempt(f.previous, {
        status: AssetDevelopRevisionStatus.Failed,
        error: 'Late old worker',
      });
      expect((await f.revisions.get(f.previous.id))?.status).toBe(AssetDevelopRevisionStatus.Saved);
      await restore(f.plan);
      expect((await f.revisions.get(f.previous.id))?.status).toBe(AssetDevelopRevisionStatus.Saved);
    },
  );

  it('rolls back interrupted-render normalization when recovery authority ends', async () => {
    const f = await interrupted(AssetDevelopRevisionStatus.Rendering);
    await expect(
      db.transaction().execute((trx) =>
        recoverBuddyReferenceOriginals(trx, f.plan, async () => {
          const { rows } = await sql<{ status: string }>`SELECT status FROM public.asset_develop_revision
        WHERE id=${f.previous.id}::uuid`.execute(trx);
          if (rows[0].status === AssetDevelopRevisionStatus.Saved) throw new Error('recovery authority lost');
        }),
      ),
    ).rejects.toThrow('recovery authority lost');
    expect(await f.revisions.get(f.previous.id)).toEqual(f.previous);
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', f.asset.id).executeTakeFirstOrThrow())
        .originalPath,
    ).toBe(f.asset.originalPath);
  });

  it('still refuses a busy edit in ordinary scoped metadata publication', async () => {
    const f = await interrupted(AssetDevelopRevisionStatus.Rendering);
    await expect(
      db.transaction().execute((trx) =>
        new BuddyBackupFidelityRepository(trx).publish({
          state: f.plan.manifest.assetFidelity![f.asset.id],
          ownerId: f.user.id,
          mode: 'replace',
          originalSha256: f.file.sha256,
          paths: new Map(),
          verify: async () => {},
        }),
      ),
    ).rejects.toThrow('An edit is changing');
    expect(await f.revisions.get(f.previous.id)).toEqual(f.previous);
  });

  it('publishes the prepared offline original and converts the restored SQL identity with no source session', async () => {
    const { user, asset, plan, file } = await fixture();
    const recoveryId = randomUUID();
    const recoveryRoot = join(root, 'recovered');
    const directory = join(recoveryRoot, 'recovery', recoveryId);
    await mkdir(join(directory, 'objects'), { recursive: true });
    await writeFile(join(directory, 'objects', file.sha256), await readFile(file.path));
    await rm(file.path);
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    const prepared = await readBuddyRecovery(recoveryRoot, recoveryId);
    const publisher = new BuddyRecoveryFiles(recoveryRoot, recoveryId, async () => {});
    await publisher.publish(prepared, [root], []);
    expect(await readFile(file.path, 'utf8')).toBe('hello');
    await restore(prepared);
    await publisher.verify(prepared, [root], []);
    expect(
      await db
        .selectFrom('asset')
        .select(['id', 'ownerId', 'originalPath', 'isExternal', 'libraryId'])
        .where('id', '=', asset.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ id: asset.id, ownerId: user.id, originalPath: file.path, isExternal: false, libraryId: null });
    expect(await db.selectFrom('source_original').select('assetId').where('assetId', '=', asset.id).execute()).toEqual(
      [],
    );
  });

  it.each([true, false])('rebinds a saved recipe only when its source pixels match: %s', async (matching) => {
    const { user, asset, plan, file, resource } = await fixture();
    const source = {
      assetId: asset.id,
      path: asset.originalPath,
      checksum: asset.checksum.toString('hex'),
      reference: {
        resourceId: resource.id,
        version: resource.version,
        sha256: matching ? file.sha256 : 'e'.repeat(64),
      },
    };
    const binding = { kind: 'bound', parent: source, input: source };
    await sql`INSERT INTO public.asset_develop_revision
      ("assetId","ownerId",revision,recipe,status,"sourceAssetId","sourceBinding","sourceChecksum")
      VALUES (${asset.id}::uuid,${user.id}::uuid,1,${JSON.stringify(defaultDevelopRecipe())}::text::jsonb,'saved',
        ${asset.id}::uuid,${JSON.stringify(binding)}::text::jsonb,${Buffer.from(file.sha256, 'hex')})`.execute(db);
    plan.manifest.assetFidelity![asset.id] = await new BuddyBackupFidelityRepository(db).capture(
      asset.id,
      file.sha256,
      [],
      [],
    );
    await restore(plan);
    const { rows } = await sql<{ binding: unknown; status: string }>`SELECT "sourceBinding" AS binding,status
      FROM public.asset_develop_revision WHERE "assetId"=${asset.id}::uuid`.execute(db);
    const managed = { assetId: asset.id, path: file.path, checksum: file.sha256, reference: null };
    expect(rows).toEqual([
      { binding: matching ? { kind: 'bound', parent: managed, input: managed } : binding, status: 'saved' },
    ]);
    await restore(plan);
  });

  it('preserves omitted offline reference metadata without reviving provider authority', async () => {
    const { ctx, user, plan } = await fixture();
    const path = `frameleaf-source://${randomUUID()}/${'f'.repeat(64)}`;
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalPath: path,
      isExternal: true,
      isOffline: true,
      deletedAt: new Date(),
    });
    await restore(plan);
    expect(
      await db
        .selectFrom('asset')
        .select(['originalPath', 'isOffline', 'deletedAt'])
        .where('id', '=', asset.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ originalPath: path, isOffline: true, deletedAt: asset.deletedAt });
  });

  it('refuses an uncaptured reference and rolls back the whole conversion', async () => {
    const { ctx, user, asset, plan } = await fixture();
    await ctx.newAsset({ ownerId: user.id, originalPath: `frameleaf-source://${randomUUID()}/${'f'.repeat(64)}` });
    await expect(restore(plan)).rejects.toThrow('uncaptured original');
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirstOrThrow())
        .originalPath,
    ).toBe(asset.originalPath);
  });

  const adoption = (f: Awaited<ReturnType<typeof fixture>>): BuddyReferenceAdoption => ({
    assetId: f.asset.id,
    ownerId: f.user.id,
    type: f.asset.type,
    source: f.plan.manifest.referenceOriginals![f.asset.id],
    file: f.file,
    physicalFileId: randomUUID(),
  });
  const adopt = (intent: BuddyReferenceAdoption) =>
    db.transaction().execute((trx) =>
      adoptBuddyReferenceOriginal(trx, intent, async () => {
        const actual = await buddyFileHash(intent.file.path);
        expect(actual).toEqual({ sha256: intent.file.sha256, size: intent.file.size });
      }),
    );

  it('reconciles committed physical identity after a lost response without charging twice', async () => {
    const f = await fixture();
    const intent = adoption(f);
    await expect(
      (async () => {
        await adopt(intent);
        throw new Error('commit response lost');
      })(),
    ).rejects.toThrow('commit response lost');
    const current = await db
      .selectFrom('asset')
      .select('physicalOriginalFileId')
      .where('id', '=', f.asset.id)
      .executeTakeFirstOrThrow();
    expect(current.physicalOriginalFileId).toBe(intent.physicalFileId);
    await expect(adopt(structuredClone(intent))).resolves.toBe('verified');
    await expect(adopt({ ...intent, physicalFileId: randomUUID() })).rejects.toThrow('physical original changed');
    expect(
      Number(
        (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', f.user.id).executeTakeFirstOrThrow())
          .quotaUsageInBytes,
      ),
    ).toBe(105);
  });

  it('does not turn an uncommitted intent into adoption authority', async () => {
    const f = await fixture();
    const intent = adoption(f);
    await expect(
      db.transaction().execute(async (trx) => {
        await adoptBuddyReferenceOriginal(trx, intent, async () => {
          await buddyFileHash(intent.file.path);
        });
        throw new Error('metadata rolled back');
      }),
    ).rejects.toThrow('metadata rolled back');
    expect(await db.selectFrom('physical_file').select('id').where('id', '=', intent.physicalFileId).execute()).toEqual(
      [],
    );
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', f.asset.id).executeTakeFirstOrThrow())
        .originalPath,
    ).toBe(f.asset.originalPath);
    expect(
      Number(
        (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', f.user.id).executeTakeFirstOrThrow())
          .quotaUsageInBytes,
      ),
    ).toBe(100);
    await expect(adopt(intent)).resolves.toBe('adopted');
  });

  it.each(['older independent original', ''])(
    'adopts explicitly selected archived bytes while fencing the current reference: %j',
    async (bytes) => {
      const f = await fixture();
      const intent = adoption(f);
      await writeFile(intent.file.path, bytes);
      const incoming = await buddyFileHash(intent.file.path);
      intent.file = { ...intent.file, ...incoming };
      await expect(adopt(intent)).resolves.toBe('adopted');
      const current = await db
        .selectFrom('asset')
        .select(['id', 'checksum', 'checksumAlgorithm'])
        .where('id', '=', f.asset.id)
        .executeTakeFirstOrThrow();
      expect(current).toEqual({
        id: f.asset.id,
        checksum: Buffer.from(incoming.sha256, 'hex'),
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
      });
    },
  );

  it('refuses a changed current version before adopting independently archived bytes', async () => {
    const f = await fixture();
    const intent = adoption(f);
    await db
      .updateTable('photo_source_resource')
      .set({ version: 'e'.repeat(64) })
      .where('id', '=', f.resource.id)
      .execute();
    await expect(adopt(intent)).rejects.toThrow('source provenance changed');
    expect(await db.selectFrom('physical_file').select('id').where('id', '=', intent.physicalFileId).execute()).toEqual(
      [],
    );
  });

  it.each(['algorithm', 'digest'] as const)('refuses a corrupt reference path identity: %s', async (change) => {
    const f = await fixture();
    await db
      .updateTable('asset')
      .set(
        change === 'algorithm' ? { checksumAlgorithm: ChecksumAlgorithm.sha1File } : { checksum: Buffer.alloc(20, 9) },
      )
      .where('id', '=', f.asset.id)
      .execute();
    await expect(restore(f.plan)).rejects.toThrow('Reference recovery source provenance changed');
    expect(await db.selectFrom('physical_file').select('id').where('path', '=', f.file.path).execute()).toEqual([]);
  });

  it('refuses changed managed byte accounting on adoption replay', async () => {
    const f = await fixture();
    await restore(f.plan);
    await db.updateTable('asset_exif').set({ fileSizeInByte: 99 }).where('assetId', '=', f.asset.id).execute();
    await expect(restore(f.plan)).rejects.toThrow('Reference recovery physical original changed');
  });

  it('refuses a changed physical record on retry', async () => {
    const { plan, file } = await fixture();
    await restore(plan);
    await db.updateTable('physical_file').set({ sizeInBytes: 99 }).where('path', '=', file.path).execute();
    await expect(restore(plan)).rejects.toThrow('physical original changed');
  });

  it.each([false, true])(
    'restores without a live provider, preserves identity/organization/trash, and retries without charging again: trash=%s',
    async (trashed) => {
      const { user, asset, album, resource, plan, file } = await fixture(trashed);
      await restore(plan);
      const restored = await db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow();
      expect(restored).toMatchObject({
        id: asset.id,
        ownerId: user.id,
        originalPath: file.path,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
        isExternal: false,
        isOffline: false,
        libraryId: null,
        isFavorite: true,
        status: asset.status,
        deletedAt: asset.deletedAt,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
      });
      expect(restored.checksum.toString('hex')).toBe(file.sha256);
      expect(await db.selectFrom('album_asset').selectAll().where('assetId', '=', asset.id).execute()).toEqual([
        expect.objectContaining({ albumId: album.id }),
      ]);
      expect(await db.selectFrom('source_original').selectAll().where('assetId', '=', asset.id).execute()).toEqual([]);
      expect(
        await db.selectFrom('photo_source_resource').select('assetId').where('id', '=', resource.id).executeTakeFirst(),
      ).toEqual({ assetId: asset.id });
      const physical = await db
        .selectFrom('physical_file')
        .selectAll()
        .where('id', '=', restored.physicalOriginalFileId!)
        .executeTakeFirstOrThrow();
      expect(physical).toMatchObject({ canonicalAssetId: asset.id, path: file.path, type: 'original' });
      expect(physical.checksum.toString('hex')).toBe(file.sha256);
      expect(Number(physical.sizeInBytes)).toBe(file.size);
      await restore(plan);
      expect(
        Number(
          (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', user.id).executeTakeFirstOrThrow())
            .quotaUsageInBytes,
        ),
      ).toBe(105);
    },
  );

  it.each(['owner', 'epoch', 'resource', 'bytes', 'closure', 'duplicate', 'physical', 'session'] as const)(
    'refuses %s conflicts atomically',
    async (kind) => {
      const { ctx, user, asset, plan, file, resource } = await fixture();
      switch (kind) {
        case 'owner': {
          const other = await ctx.newUser();
          owners.push(other.user.id);
          await db.updateTable('asset').set({ ownerId: other.user.id }).where('id', '=', asset.id).execute();
          break;
        }
        case 'epoch': {
          plan.manifest.referenceOriginals![asset.id].sourceEpoch.epoch = '1';
          break;
        }
        case 'resource': {
          await db
            .updateTable('photo_source_resource')
            .set({ version: 'e'.repeat(64) })
            .where('id', '=', resource.id)
            .execute();
          break;
        }
        case 'bytes': {
          await writeFile(file.path, 'wrong');
          break;
        }
        case 'closure': {
          plan.files = [];
          break;
        }
        case 'duplicate': {
          await ctx.newAsset({
            ownerId: user.id,
            checksum: Buffer.from(file.sha256, 'hex'),
            checksumAlgorithm: ChecksumAlgorithm.sha256File,
          });
          break;
        }
        case 'physical': {
          await db
            .insertInto('physical_file')
            .values({
              path: file.path,
              checksum: Buffer.from(file.sha256, 'hex'),
              sizeInBytes: 5,
              type: PhysicalFileType.Original,
              canonicalAssetId: null,
            })
            .execute();
          break;
        }
        case 'session': {
          await db
            .insertInto('session')
            .values({ userId: user.id, token: randomBytes(32) })
            .execute();
          break;
        }
      }
      await expect(restore(plan)).rejects.toThrow(/Reference recovery/);
      expect(
        (await db.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirstOrThrow())
          .originalPath,
      ).toBe(asset.originalPath);
      expect(
        await db.selectFrom('source_original').select('assetId').where('assetId', '=', asset.id).executeTakeFirst(),
      ).toEqual({ assetId: asset.id });
    },
  );

  it('rolls conversion and quota back if recovery authority is lost before commit', async () => {
    const { user, asset, plan, file } = await fixture();
    await expect(
      db.transaction().execute((trx) =>
        recoverBuddyReferenceOriginals(trx, plan, async () => {
          const current = await trx
            .selectFrom('asset')
            .select('originalPath')
            .where('id', '=', asset.id)
            .executeTakeFirstOrThrow();
          if (current.originalPath === file.path) throw new Error('recovery authority lost');
        }),
      ),
    ).rejects.toThrow('recovery authority lost');
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirstOrThrow())
        .originalPath,
    ).toBe(asset.originalPath);
    expect(await db.selectFrom('physical_file').select('id').where('path', '=', file.path).execute()).toEqual([]);
    expect(
      Number(
        (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', user.id).executeTakeFirstOrThrow())
          .quotaUsageInBytes,
      ),
    ).toBe(100);
  });
});

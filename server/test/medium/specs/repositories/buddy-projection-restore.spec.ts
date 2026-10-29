import { type Kysely, type Transaction, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import type { CloudBackupManifestFile } from 'src/utils/cloud-backup.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetFileType, ChecksumAlgorithm, JobName, MediaOperationStatus, StorageFolder } from 'src/enum.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { BuddyBackupFidelityRepository } from 'src/repositories/buddy-backup-fidelity.repository.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { BuddyBackupRestoreService, retargetBuddyOwnerPath } from 'src/services/buddy-backup-restore.service.js';
import {
  CloudBackupDetailsService,
  type OwnerRestoreDetailsContext,
} from 'src/services/cloud-backup-details.service.js';
import { buddyFidelityFiles } from 'src/utils/buddy-backup-fidelity.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { type MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

describe('Buddy photo projection publication and deferred jobs', () => {
  let db: Kysely<DB>;
  let ctx: MediumTestContext;
  let directory: string;
  beforeAll(async () => {
    db = await getActiveForkKyselyDB();
  }, 30_000);
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'buddy-projection-restore-')));
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(directory);
    await mkdir(StorageCore.getBaseFolder(StorageFolder.Thumbnails));
    ({ ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    { recreate: false, retained: true, replacement: false },
    { recreate: true, retained: true, replacement: false },
    { recreate: false, retained: false, replacement: false },
    { recreate: true, retained: false, replacement: true },
    { recreate: true, retained: true, replacement: true },
    { recreate: true, retained: true, replacement: true, conflict: true },
  ])('restores retained work and jobs: %j', async ({ recreate, retained, replacement, conflict }) => {
    const { user } = await ctx.newUser();
    const targetOwner = replacement ? (await ctx.newUser()).user : user;
    const bytes = new Map<string, Buffer>();
    const inventory = new Map<string, CloudBackupManifestFile>();
    const sourceFile = async (name: string, role: string): Promise<CloudBackupManifestFile> => {
      const data = Buffer.from(name);
      const file = { path: join(directory, name), role, sha256: hash(data), size: data.length, mtime: null };
      bytes.set(file.sha256, data);
      inventory.set(file.path, file);
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, data);
      return file;
    };
    const source = await sourceFile(replacement ? join('upload', user.id, 'original.jpg') : 'original.jpg', 'original');
    const master = await sourceFile('captured-master.jpg', 'full-size');
    const preview = await sourceFile('captured-preview.jpg', 'preview');
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalPath: source.path,
      originalFileName: 'original.jpg',
      checksum: Buffer.from(source.sha256, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const recipe = [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }];
    const projection = retained
      ? [master, preview].map((file, index) => ({
          path: file.path,
          type: index === 0 ? AssetFileType.FullSize : AssetFileType.Preview,
          isEdited: true as const,
          isProgressive: false,
          isTransparent: false,
        }))
      : [];
    const collisionId = randomUUID();
    if (conflict) {
      const artifact = await sourceFile('mask.png', 'project');
      await db
        .insertInto('develop_export')
        .values({ assetId: asset.id, ownerId: user.id, sourceChecksum: asset.checksum, fileName: 'original.jpg' })
        .execute();
      await sql`INSERT INTO public.asset_develop_artifact ("assetId",id,"ownerId",kind,path,bytes,width,height)
        VALUES (${asset.id}::uuid,${artifact.sha256},${user.id}::uuid,'mask',${artifact.path},${artifact.size},1,1)`.execute(
        db,
      );
      const developRecipe = {
        ...defaultDevelopRecipe(),
        masks: [{ id: randomUUID(), kind: 'brush', artifact: artifact.sha256 }],
      };
      await sql`INSERT INTO public.asset_develop_revision (id,"assetId","ownerId",revision,recipe,status,"isCurrent")
        VALUES (${collisionId}::uuid,${asset.id}::uuid,${user.id}::uuid,1,${JSON.stringify(developRecipe)}::text::jsonb,'saved',true)`.execute(
        db,
      );
    }
    const fidelity = new BuddyBackupFidelityRepository(db);
    const state = await fidelity.capture(asset.id, source.sha256, projection, recipe);
    fidelity.bindFiles(state, inventory);
    const index = new CloudBackupIndexRepository(db);
    const original = (await index.getAssetDetails([asset.id])).get(asset.id)!;
    const manifest = {
      snapshotId: randomUUID(),
      library: {
        version: 2,
        assets: {
          [asset.id]: {
            ...original.record,
            owner: user.id,
            files: [source],
            details: { ...original.details, edits: recipe },
          },
        },
        albums: {},
        people: {},
        profiles: {},
      },
      assetFidelity: { [asset.id]: state },
      assetLinks: {},
      assetFiles: {},
      contents: Object.fromEntries([...bytes].map(([sha256, data]) => [sha256, { bytes: data.length }])),
    } as unknown as BuddyManifest;
    const signedManifest = JSON.stringify(manifest);
    if (replacement) {
      // Model a fresh database, including immutable history that survives an asset's removal.
      for (const table of ['asset_develop_revision', 'asset_develop_artifact', 'develop_export'] as const)
        await sql`DELETE FROM ${sql.table(`public.${table}`)} WHERE "assetId"=${asset.id}::uuid`.execute(db);
      await db.deleteFrom('user').where('id', '=', user.id).execute();
    } else if (recreate) await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    else
      await new AssetEditRepository(db).replaceAll(asset.id, [
        { action: AssetEditAction.Rotate, parameters: { angle: 180 } },
      ]);

    let foreignRevision: unknown;
    if (conflict) {
      const foreign = (await ctx.newUser()).user;
      const foreignAsset = (await ctx.newAsset({ ownerId: foreign.id })).asset;
      await sql`INSERT INTO public.asset_develop_revision (id,"assetId","ownerId",revision,recipe,status,"isCurrent")
        VALUES (${collisionId}::uuid,${foreignAsset.id}::uuid,${foreign.id}::uuid,1,${JSON.stringify(defaultDevelopRecipe())}::text::jsonb,'saved',true)`.execute(
        db,
      );
      foreignRevision = (
        await sql`SELECT * FROM public.asset_develop_revision WHERE id=${collisionId}::uuid`.execute(db)
      ).rows[0];
    }
    const quotaBefore = await db
      .selectFrom('user')
      .select('quotaUsageInBytes')
      .where('id', '=', targetOwner.id)
      .executeTakeFirstOrThrow();
    const operation = {
      id: randomUUID(),
      ownerId: targetOwner.id,
      claimToken: 'token' as string | null,
      status: MediaOperationStatus.Rendering,
      result: {},
      snapshot: {
        request: {
          snapshotId: manifest.snapshotId,
          scope: replacement ? 'library' : 'asset',
          assetIds: [asset.id],
          mode: replacement ? 'keep' : 'replace',
        },
        owner: { current: {} },
        ...(replacement ? { owners: { [user.id]: targetOwner.id } } : {}),
        admin: true,
        manifestHash: hash(JSON.stringify(manifest)),
      },
    };
    const emitted: OwnerRestoreDetailsContext['jobs'] = [];
    const processed: string[] = [];
    const queueAll = vi.fn(async (jobs: OwnerRestoreDetailsContext['jobs']) => {
      emitted.push(...jobs);
      // Model the downstream renderer's destructive replacement. The service regression must
      // never dispatch it after selecting retained outputs, including after an interrupted attempt.
      for (const job of jobs) {
        processed.push(job.name);
        if (job.name !== JobName.AssetEditThumbnailGeneration) continue;
        const files = await db
          .selectFrom('asset_file')
          .select('path')
          .where('assetId', '=', asset.id)
          .where('isEdited', '=', true)
          .execute();
        await db.deleteFrom('asset_file').where('assetId', '=', asset.id).where('isEdited', '=', true).execute();
        for (const file of files) await rm(file.path);
      }
    });
    const details = Object.assign(Object.create(CloudBackupDetailsService.prototype), {
      logger: ctx.getMock(LoggingRepository),
      getConfig: () => Promise.resolve({ physicalDeduplication: { enabled: false } }),
    });
    const complete = vi.fn(() => {
      operation.status = MediaOperationStatus.Completed;
      operation.claimToken = null;
      return Promise.resolve(true);
    });
    const fail = vi.fn();
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      repository: { db, root: () => join(directory, 'buddy') },
      crypto: new CryptoRepository(),
      storage: new StorageRepository(ctx.getMock(LoggingRepository)),
      logger: ctx.getMock(LoggingRepository),
      details,
      jobs: { queueAll },
      binding: async () => {},
      // Authorization/path guards have separate tests. Keep the real metadata transaction,
      // file publisher, fidelity repository, completion journal and outbox in this regression.
      guarded: (
        _operation: unknown,
        _token: string,
        _job: unknown,
        _manifest: unknown,
        _snapshot: unknown,
        _file: unknown,
        action: (trx: Transaction<DB>, ownerId: string) => Promise<unknown>,
      ) => db.transaction().execute((trx) => action(trx, targetOwner.id)),
      index: {
        getOwnerRestoreIdentities: (ids: string[]) => index.getOwnerRestoreIdentities(ids),
        getOwnerRestoreAuth: () => Promise.resolve({ auth: { user: { isAdmin: true } } }),
      },
      operations: {
        getOfKind: () => Promise.resolve(operation),
        reportProgress: () => Promise.resolve(true),
        setBulkResult: () => Promise.resolve(true),
        beginValidation: () => Promise.resolve(true),
        complete,
        fail,
      },
      open: () =>
        Promise.resolve({
          manifest,
          reader: {
            download: async (_manifest: unknown, sha256: string, path: string) => {
              const data = bytes.get(sha256)!;
              await writeFile(path, data);
              return { sha256, size: data.length };
            },
          },
        }),
    });
    // Simulate an attempt that committed changed edits and persisted jobs before losing its lease.
    await service.saveRestoreJobs(operation.id, asset.id, [
      { name: JobName.AssetEditThumbnailGeneration, data: { id: asset.id } },
      { name: JobName.AssetExtractMetadata, data: { id: asset.id } },
    ]);
    const published = vi.spyOn(BuddyBackupFidelityRepository.prototype, 'publish');
    await service.run(operation, 'token');
    expect(published).toHaveBeenCalledOnce();
    if (conflict) {
      await expect(published.mock.results[0].value).rejects.toThrow(/identity conflicts|immutable version/);
      expect(fail).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();
      expect(queueAll).not.toHaveBeenCalled();
      for (const table of [
        'develop_export',
        'asset_develop_artifact',
        'asset_develop_revision',
        'asset_restoration',
        'video_edit_selection',
      ] as const) {
        expect(
          (await sql`SELECT * FROM ${sql.table(`public.${table}`)} WHERE "assetId"=${asset.id}::uuid`.execute(db)).rows,
        ).toEqual([]);
      }
      expect(
        await db
          .selectFrom('asset_file')
          .selectAll()
          .where('assetId', '=', asset.id)
          .where('isEdited', '=', true)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('user')
          .select('quotaUsageInBytes')
          .where('id', '=', targetOwner.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(quotaBefore);
      expect(
        (await sql`SELECT * FROM public.asset_develop_revision WHERE id=${collisionId}::uuid`.execute(db)).rows[0],
      ).toEqual(foreignRevision);
      expect(JSON.stringify(manifest)).toBe(signedManifest);
      return;
    }
    await expect(published.mock.results[0].value).resolves.toBe('restored');
    expect(fail).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(manifest)).toBe(signedManifest);
    expect(await db.selectFrom('asset').select('ownerId').where('id', '=', asset.id).executeTakeFirstOrThrow()).toEqual(
      { ownerId: targetOwner.id },
    );
    expect(processed).toContain(JobName.AssetExtractMetadata);
    expect(emitted.some((job) => job.name === JobName.AssetEditThumbnailGeneration)).toBe(!retained);
    expect(await new AssetEditRepository(db).getAll(asset.id)).toMatchObject(recipe);
    const selected = await db
      .selectFrom('asset_file')
      .select(['path', 'type'])
      .where('assetId', '=', asset.id)
      .where('isEdited', '=', true)
      .execute();
    if (retained) {
      const files = buddyFidelityFiles(manifest, asset.id).map((file) => ({
        ...file,
        target: replacement ? retargetBuddyOwnerPath(file.target, user.id, targetOwner) : file.target,
      }));
      expect(selected.map((file) => file.path).sort()).toEqual(files.map((file) => file.target).sort());
      for (const file of files) expect(hash(await readFile(file.target))).toBe(file.sha256);
    } else expect(selected).toEqual([]);
    await service.drainRestoreJobs();
    expect(queueAll).toHaveBeenCalledTimes(1);
  });
});

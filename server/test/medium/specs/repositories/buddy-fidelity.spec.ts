import { type Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import type { CloudBackupManifestFile } from 'src/utils/cloud-backup.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, AssetType, ChecksumAlgorithm, StorageFolder } from 'src/enum.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetRestorationRepository } from 'src/repositories/asset-restoration.repository.js';
import { BuddyBackupFidelityRepository } from 'src/repositories/buddy-backup-fidelity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { BaseService } from 'src/services/base.service.js';
import {
  type BuddyAssetFidelity,
  buddyFidelityFiles,
  buddyRestoreChecksum,
  readBuddyAssetFidelity,
} from 'src/utils/buddy-backup-fidelity.js';
import { assertOwnerRestorePath } from 'src/utils/cloud-backup-owner-path.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { getEditedMasterLineagePath } from 'src/utils/media-policy.js';
import { type MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
describe('Buddy retained per-asset work', () => {
  let db: Kysely<DB>;
  let ctx: MediumTestContext;
  let root: string;
  let ownerId: string;
  let inventory: Map<string, CloudBackupManifestFile>;
  beforeAll(async () => {
    db = await getKyselyDB();
  }, 30_000);
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-fidelity-')));
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(root);
    await mkdir(StorageCore.getBaseFolder(StorageFolder.Thumbnails));
    ({ ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }));
    ownerId = (await ctx.newUser()).user.id;
    inventory = new Map();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  const file = async (name: string, bytes = Buffer.from(name)): Promise<CloudBackupManifestFile> => {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const record = { role: 'project', path, sha256: hash(bytes), size: bytes.length, mtime: null };
    inventory.set(path, record);
    return record;
  };
  const original = async (type = AssetType.Image, legacy = false) => {
    const source = await file(`${randomUUID()}.original`);
    const checksum = legacy
      ? createHash('sha1')
          .update(await readFile(source.path))
          .digest()
      : Buffer.from(source.sha256, 'hex');
    const { asset } = await ctx.newAsset({
      ownerId,
      type,
      originalPath: source.path,
      checksum,
      checksumAlgorithm: legacy ? ChecksumAlgorithm.sha1File : ChecksumAlgorithm.sha256File,
    });
    return { asset, source };
  };
  const capture = async (
    assetId: string,
    source: CloudBackupManifestFile,
    projection: BuddyAssetFidelity['projection'] = [],
    edits: BuddyAssetFidelity['edits'] = [],
  ) => {
    const repository = new BuddyBackupFidelityRepository(db);
    const state = await repository.capture(assetId, source.sha256, projection, edits);
    repository.bindFiles(state, inventory);
    const manifest = {
      snapshotId: randomUUID(),
      library: { assets: { [assetId]: { owner: ownerId, files: [{ ...source, role: 'original' }] } } },
      assetFidelity: { [assetId]: state },
      contents: Object.fromEntries(inventory.values().map((file) => [file.sha256, { bytes: file.size }])),
    } as unknown as BuddyManifest;
    expect(readBuddyAssetFidelity(manifest, assetId)).toEqual(state);
    return { state, manifest };
  };
  const stage = async (manifest: BuddyManifest, state: BuddyAssetFidelity) => {
    const files = buddyFidelityFiles(manifest, state.assetId);
    const paths = new Map<string, string>();
    for (const [index, entry] of files.entries()) {
      await assertOwnerRestorePath([StorageCore.getBaseFolder(StorageFolder.Thumbnails)], entry.target);
      await mkdir(dirname(entry.target), { recursive: true });
      await writeFile(entry.target, await readFile(state.files[index].path));
      paths.set(state.files[index].path, entry.target);
    }
    return paths;
  };
  const publish = (
    state: BuddyAssetFidelity,
    paths: ReadonlyMap<string, string>,
    mode: 'keep' | 'replace' = 'replace',
    originalSha256 = state.source.sha256,
    actingOwner = ownerId,
  ) =>
    db.transaction().execute((trx) =>
      new BuddyBackupFidelityRepository(trx).publish({
        state,
        paths,
        mode,
        ownerId: actingOwner,
        originalSha256,
        verify: async () => {
          for (const source of state.files) expect(hash(await readFile(paths.get(source.path)!))).toBe(source.sha256);
        },
      }),
    );

  it('restores video history, selection, recipes and lineage with a translated legacy checksum, then safely replays', async () => {
    const { asset, source } = await original(AssetType.Video, true);
    const edits = [{ action: 'rotate', parameters: { angle: 90 } }];
    const createVersion = async (name: string) => {
      const master = await file(`${name}.mp4`);
      const proxy = await file(`${name}-proxy.mp4`);
      await file(
        `${name}.mp4.lineage.json`,
        Buffer.from(JSON.stringify({ assetId: asset.id, sourceChecksum: asset.checksum.toString('hex') })),
      );
      const projection = [
        {
          path: proxy.path,
          type: AssetFileType.EncodedVideo,
          isEdited: true as const,
          isProgressive: false,
          isTransparent: false,
        },
      ];
      const result = await sql<{ id: string }>`INSERT INTO public.video_edit_version
        ("assetId","ownerId","sourcePath","sourceChecksum",recipe,purpose,status,"masterPath","proxyPath",files)
        VALUES (${asset.id}::uuid,${ownerId}::uuid,${source.path},${asset.checksum},${JSON.stringify(edits)}::text::jsonb,
          'save','ready',${master.path},${proxy.path},${JSON.stringify(projection)}::text::jsonb) RETURNING id`.execute(
        db,
      );
      return { id: result.rows[0].id, master, proxy, projection };
    };
    const versions = [await createVersion('first'), await createVersion('second')];
    await sql`INSERT INTO public.video_edit_selection ("assetId","ownerId","requestedVersionId","currentVersionId")
      VALUES (${asset.id}::uuid,${ownerId}::uuid,${versions[1].id}::uuid,${versions[1].id}::uuid)`.execute(db);
    const { state, manifest } = await capture(asset.id, source, versions[1].projection, edits);
    const paths = await stage(manifest, state);
    const newer = randomUUID();
    await sql`INSERT INTO public.video_edit_version
      (id,"assetId","ownerId","sourcePath","sourceChecksum",recipe,purpose,status,"masterPath","proxyPath",files)
      SELECT ${newer}::uuid,"assetId","ownerId","sourcePath","sourceChecksum",recipe,purpose,status,"masterPath","proxyPath",files
      FROM public.video_edit_version WHERE id=${versions[1].id}::uuid`.execute(db);
    await sql`UPDATE public.video_edit_selection SET "currentVersionId"=${newer}::uuid,
      "requestedVersionId"=${newer}::uuid WHERE "assetId"=${asset.id}::uuid`.execute(db);
    const identity = await db
      .selectFrom('asset')
      .select(['checksum', 'checksumAlgorithm'])
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('asset')
      .set(buddyRestoreChecksum(state, identity, source.sha256))
      .where('id', '=', asset.id)
      .execute();
    await publish(state, paths, 'keep');
    const kept = (await new AssetEditRepository(db).listVideoVersions(asset.id, ownerId)).find((row) => row.isCurrent)!;
    expect(kept.id).toBe(newer);
    expect(kept.sourceChecksum).toEqual(asset.checksum);
    await sql`DELETE FROM public.video_edit_selection WHERE "assetId"=${asset.id}::uuid`.execute(db);
    await sql`DELETE FROM public.video_edit_version WHERE "assetId"=${asset.id}::uuid`.execute(db);
    await db
      .updateTable('asset')
      .set({ checksum: Buffer.from(source.sha256, 'hex'), checksumAlgorithm: ChecksumAlgorithm.sha256File })
      .where('id', '=', asset.id)
      .execute();
    await expect(publish(state, paths)).resolves.toBe('restored');
    await expect(publish(state, paths)).resolves.toBe('restored');
    const restored = await new AssetEditRepository(db).listVideoVersions(asset.id, ownerId);
    expect(restored).toHaveLength(2);
    expect(restored.find((row) => row.isCurrent)?.id).toBe(versions[1].id);
    expect(restored.every((row) => row.sourceChecksum.toString('hex') === source.sha256)).toBe(true);
    expect(await new AssetEditRepository(db).getAll(asset.id)).toMatchObject(edits);
    const first = restored.find((row) => row.id === versions[0].id)!;
    expect(await readFile(getEditedMasterLineagePath(first.masterPath!), 'utf8')).toContain(asset.id);
    const unlink = vi.fn().mockResolvedValue(undefined);
    expect((await new PhysicalFileRepository(db).deleteUnreferencedPath(first.masterPath!, unlink)).deleted).toBe(
      false,
    );
    expect(unlink).not.toHaveBeenCalled();
    expect(hash(await readFile(source.path))).toBe(source.sha256);
    const currentFile = await db
      .selectFrom('asset_file')
      .select('path')
      .where('assetId', '=', asset.id)
      .where('isEdited', '=', true)
      .executeTakeFirstOrThrow();
    expect(currentFile.path).toBe(paths.get(versions[1].proxy.path));

    await db.transaction().execute(async (trx) => {
      await sql`UPDATE public.video_edit_selection SET "currentVersionId"=${versions[0].id}::uuid,
        "requestedVersionId"=${versions[0].id}::uuid WHERE "assetId"=${asset.id}::uuid`.execute(trx);
    });
    await publish(state, paths, 'keep');
    expect(
      (await new AssetEditRepository(db).listVideoVersions(asset.id, ownerId)).find((row) => row.isCurrent)?.id,
    ).toBe(versions[0].id);
    const changed = structuredClone(state);
    changed.videoVersions[0].recipe = [{ action: 'rotate', parameters: { angle: 180 } }];
    await expect(publish(changed, paths)).rejects.toThrow('immutable version');
    expect(
      (await new AssetEditRepository(db).listVideoVersions(asset.id, ownerId)).find((row) => row.isCurrent)?.id,
    ).toBe(versions[0].id);
  });

  it('keeps external Develop work, charged artifacts, export identity and finished restoration results without historical jobs', async () => {
    const { asset, source } = await original();
    const master = await file('external.tif');
    const preview = await file('external-preview.jpg');
    const mask = await file('mask.png');
    const result = await file('restored.tif');
    const resultPreview = await file('restored-preview.jpg');
    const exportId = randomUUID();
    await db
      .insertInto('develop_export')
      .values({ id: exportId, assetId: asset.id, ownerId, sourceChecksum: asset.checksum, fileName: 'original.tif' })
      .execute();
    const recipe = { ...defaultDevelopRecipe(), masks: [{ id: randomUUID(), kind: 'brush', artifact: mask.sha256 }] };
    await sql`INSERT INTO public.asset_develop_artifact ("assetId",id,"ownerId",kind,path,bytes,width,height)
      VALUES (${asset.id}::uuid,${mask.sha256},${ownerId}::uuid,'mask',${mask.path},${mask.size},32,32)`.execute(db);
    await sql`INSERT INTO public.asset_develop_revision ("assetId","ownerId",revision,recipe,kind,status,
      "sourceChecksum","renditionChecksum","exportId","masterPath","previewPath","isCurrent")
      VALUES (${asset.id}::uuid,${ownerId}::uuid,1,${JSON.stringify(recipe)}::text::jsonb,'external','rendered',
        ${asset.checksum},${Buffer.from(master.sha256, 'hex')},${exportId}::uuid,${master.path},${preview.path},true)`.execute(
      db,
    );
    await db
      .insertInto('asset_restoration')
      .values({
        assetId: asset.id,
        ownerId,
        revision: 1,
        status: 'restored',
        mode: 'faithful',
        workload: 'restoration-faithful',
        destinationKind: 'local',
        destinationName: 'Local',
        sourceType: 'image',
        sourceChecksum: asset.checksum,
        sourceWidth: 32,
        sourceHeight: 32,
        previewRegion: {},
        resultPath: result.path,
        resultPreviewPath: resultPreview.path,
        isCurrent: true,
        provenance: { model: 'retained-model' },
      })
      .execute();
    await db
      .insertInto('asset_restoration')
      .values({
        assetId: asset.id,
        ownerId,
        revision: 2,
        status: 'preview_queued',
        mode: 'faithful',
        workload: 'restoration-faithful',
        destinationKind: 'local',
        destinationName: 'Local',
        sourceType: 'image',
        sourceChecksum: asset.checksum,
        sourceWidth: 32,
        sourceHeight: 32,
        previewRegion: {},
      })
      .execute();
    const { state, manifest } = await capture(asset.id, source);
    expect(state.restorations).toHaveLength(1);
    expect(Object.hasOwn(state.restorations[0], 'fullOperationId')).toBe(false);
    expect(Object.hasOwn(state.restorations[0], 'destinationId')).toBe(false);
    const paths = await stage(manifest, state);
    await sql`DELETE FROM public.asset_develop_revision WHERE "assetId"=${asset.id}::uuid`.execute(db);
    await sql`DELETE FROM public.asset_develop_artifact WHERE "assetId"=${asset.id}::uuid`.execute(db);
    await db.deleteFrom('develop_export').where('assetId', '=', asset.id).execute();
    await db.deleteFrom('asset_restoration').where('assetId', '=', asset.id).execute();
    await db
      .updateTable('user')
      .set({ quotaSizeInBytes: mask.size - 1 })
      .where('id', '=', ownerId)
      .execute();
    await expect(publish(state, paths)).rejects.toThrow('storage quota');
    expect(await new AssetDevelopRepository(db).listByAsset(asset.id)).toEqual([]);
    await db.updateTable('user').set({ quotaSizeInBytes: null }).where('id', '=', ownerId).execute();
    await publish(state, paths);
    await publish(state, paths, 'keep');
    const develop = await new AssetDevelopRepository(db).getCurrent(asset.id);
    expect(develop).toMatchObject({
      kind: 'external',
      exportId,
      recipe,
      masterPath: paths.get(master.path),
      previewPath: paths.get(preview.path),
    });
    const restoration = await new AssetRestorationRepository(db).getCurrent(asset.id);
    expect(restoration).toMatchObject({
      status: 'restored',
      resultPath: paths.get(result.path),
      resultPreviewPath: paths.get(resultPreview.path),
      fullOperationId: null,
      previewOperationId: null,
      destinationId: null,
      provenance: { model: 'retained-model' },
    });
    const usage = await db
      .selectFrom('user')
      .select('quotaUsageInBytes')
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(Number(usage.quotaUsageInBytes)).toBe(mask.size);
    expect((await new AssetDevelopRepository(db).getArtifacts(asset.id, [mask.sha256]))[0].path).toBe(
      paths.get(mask.path),
    );
    for (const source of state.files) expect(hash(await readFile(paths.get(source.path)!))).toBe(source.sha256);
    const missing = structuredClone(manifest);
    missing.assetFidelity![asset.id].artifacts = [];
    missing.assetFidelity![asset.id].files = state.files.filter((file) => file.path !== mask.path);
    expect(() => readBuddyAssetFidelity(missing, asset.id)).toThrow('recipe artifact closure');
  });

  it('refuses foreign identities and incomplete closure, preserves a changed original, and honors the handoff fence', async () => {
    const { asset, source } = await original();
    const { state, manifest } = await capture(asset.id, source);
    const paths = await stage(manifest, state);
    await expect(publish(state, paths, 'keep', hash('newer original'))).resolves.toBe('preserved-source');
    await expect(publish(state, paths, 'replace', hash('newer original'))).rejects.toThrow(
      'original has not been restored',
    );
    await expect(publish(state, paths, 'replace', source.sha256, randomUUID())).rejects.toThrow('ownership');
    const foreign = structuredClone(manifest);
    foreign.assetFidelity![asset.id].ownerId = randomUUID();
    expect(() => readBuddyAssetFidelity(foreign, asset.id)).toThrow('binding');
    const missing = structuredClone(manifest);
    missing.assetFidelity![asset.id].projection.push({
      path: '/not-captured',
      type: AssetFileType.FullSize,
      isEdited: true,
      isProgressive: false,
      isTransparent: false,
    });
    expect(() => readBuddyAssetFidelity(missing, asset.id)).toThrow('closure');
  });

  it('retains an unfinished Develop recipe without restarting its job or replacing a later render in keep mode', async () => {
    const { asset, source } = await original();
    const recipe = defaultDevelopRecipe();
    const { rows } = await sql<{ id: string }>`INSERT INTO public.asset_develop_revision
      ("assetId","ownerId",revision,recipe,status,progress,"cancelRequested",attempts)
      VALUES (${asset.id}::uuid,${ownerId}::uuid,1,${JSON.stringify(recipe)}::text::jsonb,'rendering',70,true,3)
      RETURNING id`.execute(db);
    const { state, manifest } = await capture(asset.id, source);
    const paths = await stage(manifest, state);
    await sql`DELETE FROM public.asset_develop_revision WHERE id=${rows[0].id}::uuid`.execute(db);
    await publish(state, paths);
    expect((await new AssetDevelopRepository(db).listByAsset(asset.id))[0]).toMatchObject({
      id: rows[0].id,
      recipe,
      status: 'saved',
      progress: 0,
      cancelRequested: false,
      attempts: 0,
      masterPath: null,
    });
    const later = await file('later-render.jpg');
    await sql`UPDATE public.asset_develop_revision SET status='rendered',"isCurrent"=true,
      "masterPath"=${later.path},"sourceChecksum"=${asset.checksum},"renditionChecksum"=${Buffer.from(later.sha256, 'hex')}
      WHERE id=${rows[0].id}::uuid`.execute(db);
    await publish(state, paths, 'keep');
    expect(await new AssetDevelopRepository(db).getCurrent(asset.id)).toMatchObject({
      id: rows[0].id,
      status: 'rendered',
      masterPath: later.path,
    });
    expect(hash(await readFile(later.path))).toBe(later.sha256);
  });

  it('leaves unedited videos on the normal original renderer without a synthetic version selection', async () => {
    const { asset, source } = await original(AssetType.Video);
    const { state, manifest } = await capture(asset.id, source);
    await publish(state, await stage(manifest, state));
    await expect(new AssetEditRepository(db).getRequestedVideoVersion(asset.id)).resolves.toBeUndefined();
  });

  it('refuses a symlink below the managed mount before staging a private retained file', async () => {
    const { asset, source } = await original();
    const edited = await file('edited.jpg');
    const { state, manifest } = await capture(asset.id, source, [
      { path: edited.path, type: AssetFileType.FullSize, isEdited: true, isProgressive: false, isTransparent: false },
    ]);
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, StorageCore.getFolderLocation(StorageFolder.Thumbnails, ownerId));
    await expect(stage(manifest, state)).rejects.toThrow('destination unavailable');
  });
});

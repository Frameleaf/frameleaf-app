import { type Kysely, type Transaction, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import type { CloudBackupManifestFile } from 'src/utils/cloud-backup.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AssetLockReason,
  AssetType,
  ChecksumAlgorithm,
  JobName,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  StorageFolder,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BuddyBackupStudioRepository } from 'src/repositories/buddy-backup-studio.repository.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioExportRepository } from 'src/repositories/studio-export.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';
import { StudioExportService } from 'src/services/studio-export.service.js';
import { StudioProjectImportService, studioImportProjectFolder } from 'src/services/studio-project-import.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { buddyStudioFiles, buddyStudioProjectIds, readBuddyStudioProject } from 'src/utils/buddy-backup-studio.js';
import {
  studioExportLibraryPath,
  studioExportProjectPath,
  studioExportStagingFolder,
} from 'src/utils/studio-export.js';
import { checkStudioEnvelope, studioEnvelopeDigest } from 'src/utils/studio-project.js';
import { StudioResourceKind } from 'src/utils/studio-resources.js';
import { type MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const caption = '1\n00:00:00,000 --> 00:00:01,000\nOriginal words\n';
// Only the capacity report is relaxed; all project bytes, hashes and database transactions are real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    statfs: async (path: Parameters<typeof fs.statfs>[0]) => {
      const stats = await fs.statfs(path);
      return { ...stats, bavail: Math.max(stats.bavail, Math.ceil((2 * 1024 ** 3) / stats.bsize)) };
    },
  };
});

describe('Buddy Studio library fidelity', () => {
  let db: Kysely<DB>;
  let ctx: MediumTestContext;
  let resources: StudioResourceService;
  let root: string;
  let ownerId: string;
  let sessionId: string;
  let inventory: Map<string, CloudBackupManifestFile>;
  beforeEach(async () => {
    db = await getKyselyDB();
    ({ sut: resources, ctx } = newMediumService(StudioResourceService, {
      database: db,
      real: [AccessRepository, AssetRepository, CryptoRepository, IntegrityRepository],
      mock: [LoggingRepository],
    }));
    ownerId = (await ctx.newUser({ isAdmin: true })).user.id;
    sessionId = (await ctx.newSession({ userId: ownerId, pinExpiresAt: new Date(Date.now() + 300_000) })).session.id;
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-studio-')));
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(root);
    await mkdir(StorageCore.getBaseFolder(StorageFolder.Exports));
    inventory = new Map();
  }, 30_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const file = async (name: string, content: string) => {
    const path = join(root, name);
    await writeFile(path, content);
    const item = { path, role: 'project', sha256: hash(content), size: Buffer.byteLength(content), mtime: null };
    inventory.set(path, item);
    return item;
  };
  const revision = async (projectId: string, revision: number, graph: unknown) => {
    const envelope = { schemaVersion: 1, engine: 'freecut', engineRevision: 'fixture', graph };
    const checked = checkStudioEnvelope(envelope);
    if (!checked.ok) throw new Error(checked.detail);
    return db
      .insertInto('studio_project_revision')
      .values({
        projectId,
        revision,
        authorId: ownerId,
        envelope,
        digest: studioEnvelopeDigest(envelope),
        graphBytes: checked.graphBytes,
        summary: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  };
  const seed = async (content = caption, contentType = 'application/x-subrip') => {
    const project = await db
      .insertInto('studio_project')
      .values({ ownerId, name: 'Own retained project', currentRevision: 1 })
      .returningAll()
      .executeTakeFirstOrThrow();
    const imported = await file('captions.srt', content);
    const importId = randomUUID();
    const graph =
      contentType === 'application/x-subrip'
        ? { captionsImportId: importId }
        : { $resource: { kind: StudioResourceKind.Lut, id: importId, lutSource: 'import' } };
    const saved = await revision(project.id, 1, graph);
    await sql`INSERT INTO public.studio_project_import
      ("projectId",id,"ownerId","contentType",checksum,"sizeBytes",path,"fileName","externalReferences")
      VALUES (${project.id}::uuid,${importId}::uuid,${ownerId}::uuid,${contentType},${imported.sha256},
        ${imported.size},${imported.path},'retained import',NULL)`.execute(db);
    return { project, imported, importId, saved };
  };
  const capture = async () => {
    const repository = new BuddyBackupStudioRepository(db);
    const studio = await repository.capture();
    for (const project of Object.values(studio.projects)) repository.bindFiles(project, inventory);
    return {
      snapshotId: randomUUID(),
      frameleafVersion: serverVersion.toString(),
      studio,
      library: { version: 2, assets: {}, profiles: {}, albums: {}, people: {} },
      assetFidelity: {},
      assetFiles: {},
      assetLinks: {},
      contents: Object.fromEntries(inventory.values().map((file) => [file.sha256, { bytes: file.size }])),
    } as unknown as BuddyManifest;
  };
  const worker = async (manifest: BuddyManifest, mode: 'keep' | 'replace' = 'replace') => {
    const operations = new MediaOperationRepository(db);
    const request = { snapshotId: manifest.snapshotId, scope: 'library', assetIds: [], mode };
    const operation = await operations.create({
      ownerId,
      kind: MediaOperationKind.BuddyRestore,
      destination: MediaOperationDestination.Local,
      label: 'Studio restore fixture',
      settings: {},
      snapshot: {
        request,
        admin: true,
        sessionId,
        owner: { ownerId, sessionId, current: {}, assetHashes: {} },
        manifestHash: hash(JSON.stringify(manifest)),
      },
    });
    const claimed = (await operations.claimNext({
      kinds: [MediaOperationKind.BuddyRestore],
      workerId: 'studio-fixture',
      leaseMs: 300_000,
    }))!;
    expect(claimed.operation.id).toBe(operation.id);
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      repository: { db, root: () => join(root, 'buddy') },
      crypto: new CryptoRepository(),
      storage: new StorageRepository(ctx.getMock(LoggingRepository)),
      logger: ctx.getMock(LoggingRepository),
      index: new CloudBackupIndexRepository(db),
      operations,
      jobs: { queue: vi.fn().mockResolvedValue(undefined), queueAll: vi.fn().mockResolvedValue(undefined) },
      studioResources: resources,
      binding: async () => {},
      open: () =>
        Promise.resolve({
          manifest,
          reader: {
            download: async (_manifest: unknown, sha256: string, target: string) => {
              const source = inventory.values().find((file) => file.sha256 === sha256)!;
              await writeFile(target, await readFile(source.path));
              return { sha256, size: source.size };
            },
          },
        }),
    });
    return {
      service,
      operation,
      token: claimed.claimToken,
      operations,
      run: () => service.run(claimed.operation, claimed.claimToken),
    };
  };

  const retainedExport = async () => {
    const project = await db
      .insertInto('studio_project')
      .values({ ownerId, name: 'Promoted result', currentRevision: 1 })
      .returningAll()
      .executeTakeFirstOrThrow();
    const saved = await revision(project.id, 1, { title: 'Captured cut', tracks: [] });
    const id = randomUUID();
    const content = 'Verified retained export bytes';
    const output = {
      path: studioExportProjectPath(ownerId, id, '.mp4'),
      role: 'project',
      sha256: hash(content),
      size: Buffer.byteLength(content),
      mtime: null,
    };
    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, content);
    inventory.set(output.path, output);
    const exported = await db
      .insertInto('studio_export_version')
      .values({
        id,
        ownerId,
        projectId: project.id,
        revision: 1,
        revisionDigest: saved.digest,
        state: StudioExportVersionState.Published,
        version: 1,
        scope: StudioExportScope.Project,
        destination: MediaOperationDestination.Local,
        settings: {},
        outputPath: output.path,
        outputChecksum: Buffer.from(output.sha256, 'hex'),
        outputSizeInBytes: output.size,
        outputContentType: 'video/mp4',
        publishedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { project, saved, output, exported };
  };

  const promoteExport = async ({ output, exported }: Awaited<ReturnType<typeof retainedExport>>, duplicate = false) => {
    const path = studioExportLibraryPath(ownerId, exported.id, '.mp4');
    await mkdir(dirname(path), { recursive: true });
    // The old file remains the fixture's immutable backup reader; promotion adopts a real copy.
    await writeFile(path, await readFile(output.path));
    let duplicateId: string | null = null;
    if (duplicate) {
      const originalPath = studioExportLibraryPath(ownerId, randomUUID(), '.mp4');
      await mkdir(dirname(originalPath), { recursive: true });
      await writeFile(originalPath, await readFile(output.path));
      duplicateId = (
        await ctx.newAsset({
          ownerId,
          originalPath,
          checksum: Buffer.from(output.sha256, 'hex'),
          checksumAlgorithm: ChecksumAlgorithm.sha256File,
          type: AssetType.Video,
        })
      ).asset.id;
    }
    const repository = new StudioExportRepository(db, new DerivativePrivacyRepository(db));
    const promoted = await repository.saveToLibrary({
      versionId: exported.id,
      ownerId,
      sources: [],
      nsfwHiding: true,
      path,
      checksum: Buffer.from(output.sha256, 'hex'),
      sizeInBytes: output.size,
      contentType: 'video/mp4',
      assetType: AssetType.Video,
      originalFileName: 'Promoted result.mp4',
    });
    expect(promoted.version).toMatchObject({
      scope: StudioExportScope.Library,
      resultAssetId: duplicate ? duplicateId : promoted.createdAssetId,
      outputPath: duplicate ? null : path,
    });
    if (duplicate) {
      expect(promoted.reusedAssetId).toBe(duplicateId);
      await rm(path); // The normal save service removes this unreferenced duplicate copy.
    }
    return promoted.version;
  };

  it.each([
    ['keep', false],
    ['replace', false],
    ['keep', true],
    ['replace', true],
  ] as const)('%s preserves a verified Save to library promotion (deduplicated: %s)', async (mode, duplicate) => {
    const fixture = await retainedExport();
    const manifest = await capture();
    const promoted = await promoteExport(fixture, duplicate);
    const asset = await db
      .selectFrom('asset')
      .selectAll()
      .where('id', '=', promoted.resultAssetId!)
      .executeTakeFirstOrThrow();
    const newer = await revision(fixture.project.id, 2, { title: 'Current cut', tracks: [] });
    await db.updateTable('studio_project').set({ currentRevision: 2 }).where('id', '=', fixture.project.id).execute();
    const job = await worker(manifest, mode);
    await job.run();
    expect((await job.operations.getOfKind(job.operation.id, MediaOperationKind.BuddyRestore))?.status).toBe(
      MediaOperationStatus.Completed,
    );
    const version = await db
      .selectFrom('studio_export_version')
      .selectAll()
      .where('id', '=', promoted.id)
      .executeTakeFirstOrThrow();
    expect(version).toMatchObject({
      id: promoted.id,
      ownerId,
      projectId: fixture.project.id,
      revision: promoted.revision,
      revisionDigest: promoted.revisionDigest,
      version: promoted.version,
      scope: StudioExportScope.Library,
      resultAssetId: asset.id,
      outputPath: promoted.outputPath,
      outputChecksum: promoted.outputChecksum,
      outputSizeInBytes: promoted.outputSizeInBytes,
      outputContentType: promoted.outputContentType,
      outputRemovedAt: promoted.outputRemovedAt,
      privacy: promoted.privacy,
    });
    expect(await db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow()).toEqual(
      asset,
    );
    expect(hash(await readFile(asset.originalPath))).toBe(fixture.output.sha256);
    expect(job.service.jobs.queue).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: JobName.FileDelete,
        data: expect.objectContaining({ files: expect.arrayContaining([asset.originalPath]) }),
      }),
    );
    const history = await db
      .selectFrom('studio_project_revision')
      .selectAll()
      .where('projectId', '=', fixture.project.id)
      .orderBy('revision')
      .execute();
    expect(history.slice(0, 2)).toEqual([fixture.saved, newer]);
    expect(history).toHaveLength(mode === 'keep' ? 2 : 3);
    if (mode === 'replace')
      expect(history[2]).toMatchObject({
        revision: 3,
        restoredFromRevision: 1,
        digest: fixture.saved.digest,
        envelope: fixture.saved.envelope,
      });
    expect(
      (
        await db
          .selectFrom('studio_project')
          .select('currentRevision')
          .where('id', '=', fixture.project.id)
          .executeTakeFirstOrThrow()
      ).currentRevision,
    ).toBe(mode === 'keep' ? 2 : 3);
  });

  it.each([
    ['keep', 'unrelated'],
    ['replace', 'unrelated'],
    ['keep', 'foreign'],
    ['replace', 'foreign'],
    ['keep', 'privacy'],
    ['replace', 'privacy'],
  ] as const)('%s refuses a promoted result with %s evidence', async (mode, mismatch) => {
    const fixture = await retainedExport();
    const manifest = await capture();
    const promoted = await promoteExport(fixture);
    if (mismatch === 'privacy') {
      await db
        .updateTable('studio_export_version')
        .set({ privacy: { ...promoted.privacy, lockReason: AssetLockReason.Marked } })
        .where('id', '=', promoted.id)
        .execute();
    } else {
      const resultOwner = mismatch === 'foreign' ? (await ctx.newUser()).user.id : ownerId;
      const bytes =
        mismatch === 'foreign' ? await readFile(fixture.output.path) : Buffer.from('Unrelated result bytes');
      const originalPath = studioExportLibraryPath(resultOwner, randomUUID(), '.mp4');
      await mkdir(dirname(originalPath), { recursive: true });
      await writeFile(originalPath, bytes);
      const { asset } = await ctx.newAsset({
        ownerId: resultOwner,
        originalPath,
        checksum: Buffer.from(hash(bytes), 'hex'),
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
        type: AssetType.Video,
      });
      await db
        .updateTable('studio_export_version')
        .set({ resultAssetId: asset.id })
        .where('id', '=', promoted.id)
        .execute();
    }
    const before = await db
      .selectFrom('studio_export_version')
      .selectAll()
      .where('id', '=', promoted.id)
      .executeTakeFirstOrThrow();
    const job = await worker(manifest, mode);
    await job.run();
    expect((await job.operations.getOfKind(job.operation.id, MediaOperationKind.BuddyRestore))?.status).toBe(
      MediaOperationStatus.Failed,
    );
    expect(
      await db.selectFrom('studio_export_version').selectAll().where('id', '=', promoted.id).executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(hash(await readFile(promoted.outputPath!))).toBe(fixture.output.sha256);
    expect(job.service.jobs.queue).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: JobName.FileDelete,
        data: expect.objectContaining({ files: expect.arrayContaining([promoted.outputPath]) }),
      }),
    );
  });

  it('restores an unanchored project archive with comments, imports, generated files and exports; keep and replace preserve immutable history', async () => {
    const { project, imported, importId, saved } = await seed();
    const generated = await file('waveform.json', '{"samples":[1,2]}');
    const generatedId = 'waveform-own';
    await sql`INSERT INTO public.studio_generated_resource
      ("projectId",id,"ownerId","sourceRevision",producer,checksum,path,"derivedFrom")
      VALUES (${project.id}::uuid,${generatedId},${ownerId}::uuid,1,'waveform',${generated.sha256},${generated.path},
        ${JSON.stringify([`project-import:${importId}`])}::text::jsonb)`.execute(db);
    const comment = await db
      .insertInto('studio_project_comment')
      .values({
        projectId: project.id,
        authorId: ownerId,
        revision: 1,
        timeNum: '9007199254740993',
        timeDen: 30_000,
        text: 'Keep this exact frame',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const output = await file('published.mp4', 'published retained bytes');
    const exported = await db
      .insertInto('studio_export_version')
      .values({
        ownerId,
        projectId: project.id,
        revision: 1,
        revisionDigest: saved.digest,
        state: StudioExportVersionState.Published,
        version: 1,
        scope: StudioExportScope.Project,
        destination: MediaOperationDestination.Local,
        settings: {},
        outputPath: output.path,
        outputChecksum: Buffer.from(output.sha256, 'hex'),
        outputSizeInBytes: output.size,
        outputContentType: 'video/mp4',
        publishedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('studio_export_version_source')
      .values({
        versionId: exported.id,
        key: `project-import:${importId}`,
        kind: StudioResourceKind.ProjectImport,
        resourceId: importId,
        assetId: null,
        ownerId,
        checksum: imported.sha256,
        sourceAccess: 'project',
        locked: false,
        sensitive: false,
      })
      .execute();
    const manifest = await capture();
    expect(manifest.studio!.projects[project.id].comments[0].timeNum).toBe('9007199254740993');
    expect(Object.keys(manifest.library.assets)).toEqual([]);
    expect(buddyStudioProjectIds(manifest, 'asset')).toEqual([]);
    expect(buddyStudioProjectIds(manifest, 'album')).toEqual([]);
    await db.deleteFrom('studio_project').where('id', '=', project.id).execute();
    const first = await worker(manifest);
    await first.run();
    expect((await first.operations.getOfKind(first.operation.id, MediaOperationKind.BuddyRestore))?.status).toBe(
      MediaOperationStatus.Completed,
    );
    const restored = await db
      .selectFrom('studio_project')
      .selectAll()
      .where('id', '=', project.id)
      .executeTakeFirstOrThrow();
    expect(restored).toMatchObject({
      ownerId,
      currentRevision: 2,
      spaceId: null,
      leaseHolderId: null,
      leaseClientId: null,
      leaseExpiresAt: null,
      importOperationId: null,
    });
    const restoredComment = await sql<{ timeNum: string; text: string }>`SELECT "timeNum"::text AS "timeNum", text
      FROM public.studio_project_comment WHERE id=${comment.id}::uuid`.execute(db);
    expect(restoredComment.rows[0]).toEqual({ timeNum: '9007199254740993', text: comment.text });
    const versions = await db
      .selectFrom('studio_project_revision')
      .selectAll()
      .where('projectId', '=', project.id)
      .orderBy('revision')
      .execute();
    expect(versions[0]).toMatchObject({ id: saved.id, envelope: saved.envelope, digest: saved.digest });
    expect(versions[1]).toMatchObject({ restoredFromRevision: 1, digest: saved.digest });
    const restoredExport = await db
      .selectFrom('studio_export_version')
      .selectAll()
      .where('id', '=', exported.id)
      .executeTakeFirstOrThrow();
    expect(restoredExport).toMatchObject({
      projectId: project.id,
      renderOperationId: null,
      publishOperationId: null,
      outputRemoteRef: null,
      resultAssetId: null,
      version: 1,
    });
    expect(hash(await readFile(restoredExport.outputPath!))).toBe(output.sha256);
    for (const file of buddyStudioFiles(manifest, project.id))
      expect(hash(await readFile(file.target))).toBe(file.sha256);
    const unlinked = vi.fn().mockResolvedValue(undefined);
    const importedCopy = buddyStudioFiles(manifest, project.id).find((file) => file.sha256 === imported.sha256)!;
    expect((await new PhysicalFileRepository(db).deleteUnreferencedPath(importedCopy.target, unlinked)).deleted).toBe(
      false,
    );
    expect(unlinked).not.toHaveBeenCalled();
    const newer = await revision(project.id, 3, { title: 'My newer cut', tracks: [] });
    await db.updateTable('studio_project').set({ currentRevision: 3 }).where('id', '=', project.id).execute();
    await (await worker(manifest, 'keep')).run();
    expect(
      (
        await db
          .selectFrom('studio_project')
          .select('currentRevision')
          .where('id', '=', project.id)
          .executeTakeFirstOrThrow()
      ).currentRevision,
    ).toBe(3);
    await (await worker(manifest, 'replace')).run();
    const history = await db
      .selectFrom('studio_project_revision')
      .selectAll()
      .where('projectId', '=', project.id)
      .orderBy('revision')
      .execute();
    expect(history).toHaveLength(4);
    expect(history[2]).toMatchObject({ id: newer.id, digest: newer.digest, envelope: newer.envelope });
    expect(history[3]).toMatchObject({ revision: 4, restoredFromRevision: 1, digest: saved.digest });
  });

  it('counts and restores a real empty project without requiring an arbitrary library asset', async () => {
    const project = await db
      .insertInto('studio_project')
      .values({ ownerId, name: 'Unstarted edit' })
      .returningAll()
      .executeTakeFirstOrThrow();
    const manifest = await capture();
    await db.deleteFrom('studio_project').where('id', '=', project.id).execute();
    const job = await worker(manifest);
    const auth = (await new CloudBackupIndexRepository(db).getOwnerRestoreAuth({ ownerId, sessionId })).auth;
    const preview = await job.service.prepare(
      auth,
      { snapshotId: manifest.snapshotId, scope: 'library', mode: 'replace', confirm: false },
      true,
    );
    expect(preview).toMatchObject({ items: 1, bytes: 0, conflicts: 0, state: 'preview' });
    await job.run();
    expect((await job.operations.getOfKind(job.operation.id, MediaOperationKind.BuddyRestore))?.status).toBe(
      MediaOperationStatus.Completed,
    );
    expect(
      await db
        .selectFrom('studio_project')
        .select(['name', 'currentRevision'])
        .where('id', '=', project.id)
        .executeTakeFirst(),
    ).toEqual({ name: 'Unstarted edit', currentRevision: 0 });
    expect(await db.selectFrom('asset').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('studio_project_revision').select('id').execute()).toEqual([]);
  });

  it.each([
    ['application/x-subrip', `${caption}\n2\nnot a timestamp --> broken\nLater malformed cue\n`],
    ['text/x-cube-lut', `TITLE "Backup"\nLUT_3D_SIZE 2\n${'# padding\n'.repeat(130)}0 0 0\n`],
  ])('rejects the complete malformed %s file before publishing its project', async (type, content) => {
    const { project } = await seed(content, type);
    const manifest = await capture();
    await db.deleteFrom('studio_project').where('id', '=', project.id).execute();
    const job = await worker(manifest);
    await job.run();
    expect((await job.operations.getOfKind(job.operation.id, MediaOperationKind.BuddyRestore))?.status).toBe(
      MediaOperationStatus.Failed,
    );
    expect(
      await db.selectFrom('studio_project').select('id').where('id', '=', project.id).executeTakeFirst(),
    ).toBeUndefined();
  });

  it('rejects incomplete and foreign dependencies, quota excess and immutable revision collisions', async () => {
    const { project, saved } = await seed();
    const manifest = await capture();
    const missing = structuredClone(manifest);
    missing.studio!.projects[project.id].files = [];
    expect(() => readBuddyStudioProject(missing, project.id)).toThrow('closure');
    const foreign = structuredClone(manifest);
    const other = (await ctx.newUser()).user.id;
    foreign.studio!.projects[project.id].imports[0].ownerId = other;
    expect(() => readBuddyStudioProject(foreign, project.id)).toThrow('ownership');
    await db.deleteFrom('studio_project').where('id', '=', project.id).execute();
    await sql`DELETE FROM public.studio_project_import WHERE "projectId"=${project.id}::uuid`.execute(db);
    await db.updateTable('user').set({ quotaSizeInBytes: 1 }).where('id', '=', ownerId).execute();
    const quota = await worker(manifest);
    await quota.run();
    expect((await quota.operations.getOfKind(quota.operation.id, MediaOperationKind.BuddyRestore))?.status).toBe(
      MediaOperationStatus.Failed,
    );
    expect(
      await db.selectFrom('studio_project').select('id').where('id', '=', project.id).executeTakeFirst(),
    ).toBeUndefined();
    await db.updateTable('user').set({ quotaSizeInBytes: null }).where('id', '=', ownerId).execute();
    await db
      .insertInto('studio_project')
      .values({ id: project.id, ownerId, name: 'Existing', currentRevision: 1 })
      .execute();
    const collision = await revision(project.id, 1, { title: 'Different immutable history' });
    expect(collision.id).not.toBe(saved.id);
    const job = await worker(manifest);
    await job.run();
    expect((await job.operations.getOfKind(job.operation.id, MediaOperationKind.BuddyRestore))?.status).toBe(
      MediaOperationStatus.Failed,
    );
    expect(
      (
        await db
          .selectFrom('studio_project_revision')
          .select('digest')
          .where('id', '=', collision.id)
          .executeTakeFirstOrThrow()
      ).digest,
    ).toBe(collision.digest);
  });

  it('rechecks PIN, worker lease, project writer and path references before each publication', async () => {
    const { project } = await seed();
    const manifest = await capture();
    const job = await worker(manifest);
    await job.operations.reportProgress(job.operation.id, job.token, {
      status: MediaOperationStatus.Rendering,
      processedUnits: 0,
      totalUnits: null,
      progress: 0,
    });
    const state = readBuddyStudioProject(manifest, project.id);
    const repository = new BuddyBackupStudioRepository(db);
    const callback = vi.fn().mockResolvedValue('allowed');
    const guarded = () =>
      repository.guarded(
        {
          project: state,
          actorId: ownerId,
          sessionId,
          operationId: job.operation.id,
          claimToken: job.token,
          authorize: async () => {},
        },
        callback,
      );
    await db
      .updateTable('studio_project')
      .set({ leaseHolderId: ownerId, leaseClientId: 'active-editor', leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where('id', '=', project.id)
      .execute();
    await expect(guarded()).rejects.toThrow('editor lease');
    await db.updateTable('studio_project').set({ leaseExpiresAt: null }).where('id', '=', project.id).execute();
    await db.updateTable('session').set({ pinExpiresAt: null }).where('id', '=', sessionId).execute();
    await expect(guarded()).rejects.toThrow('authorization');
    await db
      .updateTable('session')
      .set({ pinExpiresAt: new Date(Date.now() + 60_000) })
      .where('id', '=', sessionId)
      .execute();
    await db
      .updateTable('media_operation')
      .set({ claimToken: randomUUID() })
      .where('id', '=', job.operation.id)
      .execute();
    await expect(guarded()).rejects.toThrow('authorization');
    expect(callback).not.toHaveBeenCalled();
    await db.updateTable('media_operation').set({ claimToken: job.token }).where('id', '=', job.operation.id).execute();
    await expect(
      repository.guarded(
        {
          project: state,
          actorId: ownerId,
          sessionId,
          operationId: job.operation.id,
          claimToken: job.token,
          authorize: async () => {},
        },
        async (trx) => {
          await trx
            .updateTable('session')
            .set({ pinExpiresAt: new Date(0) })
            .where('id', '=', sessionId)
            .execute();
        },
      ),
    ).rejects.toThrow('expired during publication');
    const planned = buddyStudioFiles(manifest, project.id)[0];
    await mkdir(dirname(planned.target), { recursive: true });
    await writeFile(planned.target, caption);
    await sql`INSERT INTO public.buddy_backup_reference ("runId",path)
      VALUES (${randomUUID()}::uuid,${planned.target})`.execute(db);
    await expect(
      db
        .transaction()
        .execute((trx) =>
          new PhysicalFileRepository(trx).withStudioRestorePath(
            planned.target,
            project.id,
            ownerId,
            planned.sha256,
            callback,
          ),
        ),
    ).rejects.toThrow('pinned');
    expect(callback).not.toHaveBeenCalled();
  });

  it('keeps orphan import cleanup durable across capture pins, post-unlink crashes and concurrent project recreation', async () => {
    const { project, imported, importId } = await seed();
    const folder = studioImportProjectFolder(ownerId, project.id);
    const ordinaryPath = join(folder, `${importId}.srt`);
    const restoredId = randomUUID();
    const restoredPath = join(
      StorageCore.getFolderLocation(StorageFolder.Exports, ownerId),
      'buddy-projects',
      project.id,
      randomUUID(),
      `${hash('retained original path')}.srt`,
    );
    await mkdir(folder, { recursive: true });
    await mkdir(dirname(restoredPath), { recursive: true });
    await writeFile(ordinaryPath, caption);
    await writeFile(restoredPath, caption);
    const unknownPath = join(root, 'unknown.srt');
    await writeFile(unknownPath, caption);
    const unregisteredPath = join(folder, 'personal-note.txt');
    await writeFile(unregisteredPath, 'Unregistered files must survive');
    await sql`UPDATE public.studio_project_import SET path=${ordinaryPath}
      WHERE "projectId"=${project.id}::uuid AND id=${importId}::uuid`.execute(db);
    for (const [id, path] of [
      [restoredId, restoredPath],
      [randomUUID(), unknownPath],
    ])
      await sql`INSERT INTO public.studio_project_import
        ("projectId",id,"ownerId","contentType",checksum,"sizeBytes",path,"fileName","externalReferences")
        VALUES (${project.id}::uuid,${id}::uuid,${ownerId}::uuid,'application/x-subrip',${imported.sha256},
          ${imported.size},${path},'retained.srt',NULL)`.execute(db);
    await db.deleteFrom('studio_project').where('id', '=', project.id).execute();
    const runId = randomUUID();
    for (const path of [ordinaryPath, restoredPath])
      await sql`INSERT INTO public.buddy_backup_reference ("runId",path)
      VALUES (${runId}::uuid,${path})`.execute(db);
    const logger = ctx.getMock(LoggingRepository);
    const storage = new StorageRepository(logger);
    const projects = new StudioProjectRepository(db);
    const sweeper = new StudioProjectImportService(
      logger,
      projects,
      storage,
      new CryptoRepository(),
      {} as never,
      {} as never,
    );
    const recorded = async () =>
      (
        await sql<{ id: string; path: string }>`SELECT id,path FROM public.studio_project_import
      WHERE "projectId"=${project.id}::uuid ORDER BY path`.execute(db)
      ).rows;
    await sweeper.sweep();
    expect(await recorded()).toHaveLength(3);
    for (const path of [ordinaryPath, restoredPath]) expect(await readFile(path, 'utf8')).toBe(caption);
    expect(
      (
        await sql<{ requested: boolean }>`SELECT bool_and("deleteRequested") AS requested
      FROM public.buddy_backup_reference WHERE "runId"=${runId}::uuid`.execute(db)
      ).rows[0].requested,
    ).toBe(true);

    // Capture release's queued generic cleanup still sees the import row. The row survives a
    // lost/failed queue delivery and makes the next lifecycle sweep a durable retry.
    await sql`UPDATE public.buddy_backup_reference SET released=true WHERE "runId"=${runId}::uuid`.execute(db);
    const genericUnlink = vi.fn().mockResolvedValue(undefined);
    expect((await new PhysicalFileRepository(db).deleteUnreferencedPath(restoredPath, genericUnlink)).deleted).toBe(
      false,
    );
    expect(genericUnlink).not.toHaveBeenCalled();
    const unlink = storage.unlink.bind(storage);
    let interrupted = false;
    vi.spyOn(storage, 'unlink').mockImplementation(async (path) => {
      await unlink(path);
      if (path === restoredPath && !interrupted) {
        interrupted = true;
        throw new Error('Simulated crash after unlink');
      }
    });
    await sweeper.sweep();
    expect((await recorded()).some((row) => row.id === restoredId)).toBe(true);
    await expect(readFile(restoredPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await sweeper.sweep();
    expect((await recorded()).map((row) => row.path)).toEqual([unknownPath]);
    await expect(readFile(ordinaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unknownPath, 'utf8')).toBe(caption);
    expect(await readFile(unregisteredPath, 'utf8')).toBe('Unregistered files must survive');

    await writeFile(ordinaryPath, caption);
    await sql`INSERT INTO public.studio_project_import
      ("projectId",id,"ownerId","contentType",checksum,"sizeBytes",path,"fileName","externalReferences")
      VALUES (${project.id}::uuid,${importId}::uuid,${ownerId}::uuid,'application/x-subrip',${imported.sha256},
        ${imported.size},${ordinaryPath},'retained.srt',NULL)`.execute(db);
    await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`buddy-studio:${project.id}`},0))`.execute(trx);
      await sweeper.sweep();
      expect(await readFile(ordinaryPath, 'utf8')).toBe(caption);
      await trx
        .insertInto('studio_project')
        .values({ id: project.id, ownerId, name: 'Restored concurrently' })
        .execute();
    });
    await sweeper.sweep();
    expect((await recorded()).some((row) => row.id === importId)).toBe(true);
    expect(await readFile(ordinaryPath, 'utf8')).toBe(caption);
  });

  it('requires durable cleanup acceptance before rebinding an import and keeps the old file through a capture pin', async () => {
    const { project, importId, imported } = await seed();
    const oldPath = join(studioImportProjectFolder(ownerId, project.id), `${importId}.srt`);
    await mkdir(dirname(oldPath), { recursive: true });
    await writeFile(oldPath, caption);
    await sql`UPDATE public.studio_project_import SET path=${oldPath}
      WHERE "projectId"=${project.id}::uuid AND id=${importId}::uuid`.execute(db);
    inventory.delete(imported.path);
    inventory.set(oldPath, { ...imported, path: oldPath });
    const manifest = await capture();
    const runId = randomUUID();
    await sql`INSERT INTO public.buddy_backup_reference ("runId",path) VALUES (${runId}::uuid,${oldPath})`.execute(db);
    const currentPath = async () =>
      (
        await sql<{ path: string }>`SELECT path FROM public.studio_project_import
      WHERE "projectId"=${project.id}::uuid AND id=${importId}::uuid`.execute(db)
      ).rows[0].path;
    const interrupted = await worker(manifest);
    interrupted.service.jobs.queue.mockRejectedValueOnce(new Error('Queue unavailable'));
    await interrupted.run();
    expect(
      (await interrupted.operations.getOfKind(interrupted.operation.id, MediaOperationKind.BuddyRestore))?.status,
    ).toBe(MediaOperationStatus.Failed);
    expect(await currentPath()).toBe(oldPath);
    expect(await readFile(oldPath, 'utf8')).toBe(caption);
    const resumed = await worker(manifest);
    await resumed.run();
    expect((await resumed.operations.getOfKind(resumed.operation.id, MediaOperationKind.BuddyRestore))?.status).toBe(
      MediaOperationStatus.Completed,
    );
    expect(resumed.service.jobs.queue).toHaveBeenCalledWith({ name: JobName.FileDelete, data: { files: [oldPath] } });
    expect(await currentPath()).toBe(buddyStudioFiles(manifest, project.id)[0].target);
    const storage = new StorageRepository(ctx.getMock(LoggingRepository));
    const physical = new PhysicalFileRepository(db);
    expect((await physical.deleteUnreferencedPath(oldPath, () => storage.unlink(oldPath))).deleted).toBe(false);
    expect(await readFile(oldPath, 'utf8')).toBe(caption);
    await sql`UPDATE public.buddy_backup_reference SET released=true WHERE "runId"=${runId}::uuid`.execute(db);
    expect((await physical.deleteUnreferencedPath(oldPath, () => storage.unlink(oldPath))).deleted).toBe(true);
    await expect(readFile(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(await currentPath(), 'utf8')).toBe(caption);
  });

  it('serializes detached export cleanup before restore without holding the export row while waiting for its path', async () => {
    const { project, output, exported } = await retainedExport();
    const manifest = await capture();
    await db.deleteFrom('studio_project').where('id', '=', project.id).execute();
    const job = await worker(manifest);
    const repository = new StudioExportRepository(db, new DerivativePrivacyRepository(db));
    const storage = new StorageRepository(ctx.getMock(LoggingRepository));
    const held = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    // Pause the real cleanup immediately after PostgreSQL grants its path lock, before its
    // export-row lookup. All lock acquisition, row validation and unlink work remain real.
    const physical = PhysicalFileRepository.prototype as unknown as {
      lockPath: (trx: Transaction<DB>, path: string) => Promise<void>;
    };
    const lockPath = physical.lockPath;
    const pause = vi.spyOn(physical, 'lockPath').mockImplementationOnce(async function (
      this: PhysicalFileRepository,
      trx,
      path,
    ) {
      await lockPath.call(this, trx, path);
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      held.resolve(rows[0].pid);
      await release.promise;
    });
    const cleaning = repository.markOutputRemoved(exported.id, (version) => storage.unlink(version.outputPath!));
    let restoring: Promise<unknown> | undefined;
    try {
      const cleanupPid = await Promise.race([
        held.promise,
        cleaning.then(() => {
          throw new Error('Cleanup did not pause at its path lock');
        }),
      ]);
      restoring = Promise.resolve(job.run());
      void restoring.catch(() => {});
      await vi.waitFor(
        async () => {
          const { rows } = await sql<{ waiting: boolean }>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory'
            AND pg_blocking_pids(pid) @> ARRAY[${cleanupPid}]::integer[]
        ) AS waiting`.execute(db);
          expect(rows[0].waiting).toBe(true);
        },
        { timeout: 5000 },
      );
      // Restore has staged its bytes and is waiting for cleanup's old path. If it already
      // held this row, cleanup would wait in reverse order and PostgreSQL would deadlock.
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('studio_export_version')
          .select('id')
          .where('id', '=', exported.id)
          .forUpdate()
          .noWait()
          .executeTakeFirstOrThrow();
      });
    } finally {
      release.resolve();
      await Promise.allSettled([cleaning, restoring]);
      pause.mockRestore();
    }
    await expect(cleaning).resolves.toBe(true);
    expect(restoring).toBeDefined();
    await restoring;
    expect((await job.operations.getOfKind(job.operation.id, MediaOperationKind.BuddyRestore))?.status).toBe(
      MediaOperationStatus.Completed,
    );
    const target = buddyStudioFiles(manifest, project.id)[0].target;
    expect(
      await db.selectFrom('studio_export_version').selectAll().where('id', '=', exported.id).executeTakeFirstOrThrow(),
    ).toMatchObject({
      projectId: project.id,
      ownerId,
      state: StudioExportVersionState.Published,
      scope: StudioExportScope.Project,
      resultAssetId: null,
      outputPath: target,
      outputRemovedAt: null,
      outputChecksum: exported.outputChecksum,
      outputSizeInBytes: output.size,
    });
    expect(hash(await readFile(target))).toBe(output.sha256);
    await expect(readFile(output.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await repository.listRemovableOutputs()).toEqual([]);
    const unlink = vi.fn();
    expect(await repository.markOutputRemoved(exported.id, unlink)).toBe(false);
    expect(unlink).not.toHaveBeenCalled();
    expect(hash(await readFile(target))).toBe(output.sha256);
  }, 10_000);

  it('defers a retained export through capture pins and failed unlink without erasing its retry intent or staging neighbours', async () => {
    const project = await db
      .insertInto('studio_project')
      .values({ ownerId, name: 'Retained export', currentRevision: 1 })
      .returningAll()
      .executeTakeFirstOrThrow();
    const saved = await revision(project.id, 1, { tracks: [] });
    const operation = await new MediaOperationRepository(db).create({
      ownerId,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Local,
      label: 'Finished render fixture',
      settings: {},
      snapshot: {},
    });
    await db
      .updateTable('media_operation')
      .set({ status: MediaOperationStatus.Completed })
      .where('id', '=', operation.id)
      .execute();
    const versionId = randomUUID();
    const path = studioExportProjectPath(ownerId, versionId, '.mp4');
    const neighbour = join(studioExportStagingFolder(ownerId, operation.id), 'unknown-retained.bin');
    await mkdir(dirname(path), { recursive: true });
    await mkdir(dirname(neighbour), { recursive: true });
    await writeFile(path, 'Retained export bytes');
    await writeFile(neighbour, 'A file this cleanup does not own');
    await db
      .insertInto('studio_export_version')
      .values({
        id: versionId,
        ownerId,
        projectId: project.id,
        revision: 1,
        revisionDigest: saved.digest,
        renderOperationId: operation.id,
        state: StudioExportVersionState.Published,
        version: 1,
        scope: StudioExportScope.Project,
        destination: MediaOperationDestination.Local,
        settings: {},
        outputPath: path,
        outputChecksum: Buffer.from(hash('Retained export bytes'), 'hex'),
        outputSizeInBytes: Buffer.byteLength('Retained export bytes'),
        outputContentType: 'video/mp4',
        publishedAt: new Date(),
      })
      .execute();
    await db.deleteFrom('studio_project').where('id', '=', project.id).execute();
    const runId = randomUUID();
    await sql`INSERT INTO public.buddy_backup_reference ("runId",path) VALUES (${runId}::uuid,${path})`.execute(db);
    const repository = new StudioExportRepository(db, new DerivativePrivacyRepository(db));
    const storage = new StorageRepository(ctx.getMock(LoggingRepository));
    const service = Object.assign(Object.create(StudioExportService.prototype), {
      repository,
      storage,
      crypto: new CryptoRepository(),
      logger: ctx.getMock(LoggingRepository),
      lastSweepAt: 0,
    });
    let clock = Date.now();
    const sweep = () => service.sweep(new Date((clock += 60_000)));
    const stored = () =>
      db
        .selectFrom('studio_export_version')
        .select(['outputPath', 'outputRemovedAt'])
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow();
    await sweep();
    expect(await stored()).toEqual({ outputPath: path, outputRemovedAt: null });
    expect(await readFile(path, 'utf8')).toBe('Retained export bytes');
    await sql`UPDATE public.buddy_backup_reference SET released=true WHERE "runId"=${runId}::uuid`.execute(db);
    const unlink = vi.spyOn(storage, 'unlink').mockRejectedValueOnce(new Error('EIO'));
    await sweep();
    expect(await stored()).toEqual({ outputPath: path, outputRemovedAt: null });
    expect(await readFile(path, 'utf8')).toBe('Retained export bytes');
    unlink.mockRestore();
    await sweep();
    expect(await stored()).toEqual({ outputPath: null, outputRemovedAt: expect.any(Date) });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(neighbour, 'utf8')).toBe('A file this cleanup does not own');
    expect(await repository.listRemovableOutputs()).toEqual([]);
  });
});

import { type Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus, StorageFolder } from 'src/enum.js';
import { BuddyBackupStudioRepository } from 'src/repositories/buddy-backup-studio.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { buddyStudioFiles, readBuddyStudioProject } from 'src/utils/buddy-backup-studio.js';
import { assertOwnerRestorePath } from 'src/utils/cloud-backup-owner-path.js';
import { LINEAGE } from 'test/fixtures/studio-import-retention.js';
import { getLibraryQueueDB } from 'test/medium/library-queue-database.js';
import { type MediumTestContext, newMediumService } from 'test/medium.factory.js';

// Actual PostgreSQL JSONB and guarded repository restore; no publication/storage durability qualification.
describe('Buddy retained processing provenance persistence', () => {
  let db: Kysely<DB>;
  let ctx: MediumTestContext;
  let root: string;
  let ownerId: string;
  let sessionId: string;
  const bytes = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const provenance = { ...LINEAGE, outputSha256: checksum };

  beforeEach(async () => {
    db = await getLibraryQueueDB();
    ({ ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }));
    ownerId = (await ctx.newUser({ isAdmin: true })).user.id;
    sessionId = (await ctx.newSession({ userId: ownerId, pinExpiresAt: new Date(Date.now() + 300_000) })).session.id;
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-retention-')));
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(root);
    await mkdir(StorageCore.getBaseFolder(StorageFolder.Exports));
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const seed = async (lineage: typeof provenance | null = provenance) => {
    const project = await db
      .insertInto('studio_project')
      .values({ ownerId, name: 'Buddy retention' })
      .returningAll()
      .executeTakeFirstOrThrow();
    const id = randomUUID();
    const path = join(
      StorageCore.getFolderLocation(StorageFolder.Exports, ownerId),
      'studio-imports',
      project.id,
      `${id}.mp4`,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
    await sql`INSERT INTO public.studio_project_import
      (id,"projectId","ownerId","contentType",checksum,"sizeBytes",path,"fileName","externalReferences","processingProvenance")
      VALUES (${id}::uuid,${project.id}::uuid,${ownerId}::uuid,'video/mp4',${checksum},${bytes.length},${path},'retained.mp4',NULL,
        ${lineage === null ? sql`NULL` : sql`${JSON.stringify(lineage)}::text::jsonb`})`.execute(db);
    return { project, id, path };
  };

  const capture = async (projectId: string) => {
    const repository = new BuddyBackupStudioRepository(db);
    const studio = await repository.capture();
    const project = studio.projects[projectId];
    repository.bindFiles(
      project,
      new Map(
        project.imports.map((row) => [
          row.path,
          {
            path: row.path,
            role: 'project',
            sha256: row.checksum,
            size: row.sizeBytes,
            mtime: null,
          },
        ]),
      ),
    );
    return JSON.parse(
      JSON.stringify({
        snapshotId: randomUUID(),
        studio: { version: 1, projects: { [projectId]: project } },
        library: { version: 2, assets: {}, profiles: {}, albums: {}, people: {} },
        contents: { [checksum]: { bytes: bytes.length } },
      }),
    ) as BuddyManifest;
  };

  const restore = async (manifest: BuddyManifest, projectId: string, mode: 'keep' | 'replace' = 'replace') => {
    const project = readBuddyStudioProject(manifest, projectId);
    const files = buddyStudioFiles(manifest, projectId);
    for (const file of files) {
      await mkdir(dirname(file.target), { recursive: true });
      await assertOwnerRestorePath([StorageCore.getBaseFolder(StorageFolder.Exports)], file.target);
      await writeFile(file.target, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    const verify = async () => {
      for (const file of files) {
        const actual = await readFile(file.target);
        expect(createHash('sha256').update(actual).digest('hex')).toBe(file.sha256);
        expect(actual.length).toBe(file.size);
      }
    };
    const operations = new MediaOperationRepository(db);
    const operation = await operations.create({
      ownerId,
      kind: MediaOperationKind.BuddyRestore,
      destination: MediaOperationDestination.Local,
      label: 'Buddy retention fixture',
      settings: {},
      snapshot: {},
    });
    const claimed = (await operations.claimNext({
      kinds: [MediaOperationKind.BuddyRestore],
      workerId: 'retention-fixture',
      leaseMs: 300_000,
    }))!;
    expect(claimed.operation.id).toBe(operation.id);
    await operations.reportProgress(operation.id, claimed.claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: 0,
      totalUnits: null,
      progress: 0,
    });
    await new BuddyBackupStudioRepository(db).guarded(
      {
        project,
        actorId: ownerId,
        sessionId,
        operationId: operation.id,
        claimToken: claimed.claimToken,
        authorize: async () => {},
      },
      async (trx) => {
        for (const file of files)
          await new PhysicalFileRepository(trx).withStudioRestorePath(
            file.target,
            projectId,
            project.ownerId,
            file.sha256,
            async () => {},
          );
        await new BuddyBackupStudioRepository(trx).publish({
          manifest,
          projectId,
          actorId: ownerId,
          operationId: operation.id,
          mode,
          paths: new Map(project.files.map((source, index) => [source.path, files[index].target])),
          verify,
          validateResources: async () => {},
          retireFile: async () => {},
        });
      },
    );
    return files;
  };

  const stored = async (projectId: string, id: string) =>
    (
      await sql<{
        path: string;
        processingProvenance: typeof provenance | null;
        jsonType: string | null;
      }>`SELECT path,"processingProvenance",jsonb_typeof("processingProvenance") AS "jsonType"
    FROM public.studio_project_import WHERE "projectId"=${projectId}::uuid AND id=${id}::uuid`.execute(db)
    ).rows[0];

  it.each(['keep', 'replace'] as const)(
    '%s preserves actual JSONB lineage through capture, guarded restore and recapture',
    async (mode) => {
      const fixture = await seed();
      expect((await stored(fixture.project.id, fixture.id)).jsonType).toBe('object');
      const manifest = await capture(fixture.project.id);
      expect(manifest.studio!.projects[fixture.project.id].imports[0].processingProvenance).toEqual(provenance);
      await sql`DELETE FROM public.studio_project_import WHERE id=${fixture.id}::uuid`.execute(db);
      const files = await restore(manifest, fixture.project.id, mode);
      const row = await stored(fixture.project.id, fixture.id);
      expect(row.processingProvenance).toEqual(provenance);
      expect(row.jsonType).toBe('object');
      expect(row.path).toBe(files[0].target);
      expect(row.path).toContain(join('buddy-projects', fixture.project.id, manifest.snapshotId));
      expect(
        (await capture(fixture.project.id)).studio!.projects[fixture.project.id].imports[0].processingProvenance,
      ).toEqual(provenance);
      await restore(manifest, fixture.project.id, mode);
      expect((await stored(fixture.project.id, fixture.id)).processingProvenance).toEqual(provenance);
      expect(
        (
          await sql`SELECT id FROM public.studio_import_publication WHERE "projectId"=${fixture.project.id}::uuid`.execute(
            db,
          )
        ).rows,
      ).toEqual([]);
    },
  );

  it('restores legacy absent provenance as SQL NULL without inferring lineage from labels or bytes', async () => {
    const fixture = await seed(null);
    const manifest = await capture(fixture.project.id);
    const imported = manifest.studio!.projects[fixture.project.id].imports[0];
    delete (imported as Partial<typeof imported>).processingProvenance;
    await sql`DELETE FROM public.studio_project_import WHERE id=${fixture.id}::uuid`.execute(db);
    await restore(manifest, fixture.project.id);
    expect(await stored(fixture.project.id, fixture.id)).toMatchObject({ processingProvenance: null, jsonType: null });
  });

  it.each(['keep', 'replace'] as const)(
    '%s refuses differing same-byte lineage and null enrichment without rebinding',
    async (mode) => {
      const fixture = await seed();
      const manifest = await capture(fixture.project.id);
      manifest.studio!.projects[fixture.project.id].imports[0].processingProvenance = {
        ...provenance,
        variant: 'liveAction',
      };
      await expect(restore(manifest, fixture.project.id, mode)).rejects.toThrow('provenance_conflict');
      expect(await stored(fixture.project.id, fixture.id)).toMatchObject({
        path: fixture.path,
        processingProvenance: provenance,
      });
      await sql`UPDATE public.studio_project_import SET "processingProvenance"=NULL WHERE id=${fixture.id}::uuid`.execute(
        db,
      );
      await expect(restore(manifest, fixture.project.id, mode)).rejects.toThrow('provenance_conflict');
      expect(await stored(fixture.project.id, fixture.id)).toMatchObject({
        path: fixture.path,
        processingProvenance: null,
        jsonType: null,
      });
    },
  );

  it('refuses legacy absence rather than clearing existing lineage', async () => {
    const fixture = await seed();
    const manifest = await capture(fixture.project.id);
    const imported = manifest.studio!.projects[fixture.project.id].imports[0];
    delete (imported as Partial<typeof imported>).processingProvenance;
    await expect(restore(manifest, fixture.project.id)).rejects.toThrow('immutable identity');
    expect((await stored(fixture.project.id, fixture.id)).processingProvenance).toEqual(provenance);
  });

  it('rejects tampered output hashes on capture and restore and foreign child ownership/project identity', async () => {
    const fixture = await seed();
    const manifest = await capture(fixture.project.id);
    const corrupted = structuredClone(manifest);
    corrupted.studio!.projects[fixture.project.id].imports[0].processingProvenance!.outputSha256 = 'cd'.repeat(32);
    await expect(restore(corrupted, fixture.project.id)).rejects.toThrow('provenance checksum');
    for (const key of ['ownerId', 'projectId'] as const) {
      const foreign = structuredClone(manifest);
      foreign.studio!.projects[fixture.project.id].imports[0][key] = randomUUID();
      await expect(restore(foreign, fixture.project.id)).rejects.toThrow(
        key === 'ownerId' ? 'ownership' : 'child identity',
      );
    }
    await sql`UPDATE public.studio_project_import SET "processingProvenance"=${JSON.stringify({ ...provenance, outputSha256: 'cd'.repeat(32) })}::text::jsonb WHERE id=${fixture.id}::uuid`.execute(
      db,
    );
    await expect(new BuddyBackupStudioRepository(db).capture()).rejects.toThrow('provenance checksum');
    expect((await stored(fixture.project.id, fixture.id)).path).toBe(fixture.path);
  });

  it('captures ready rows only even with registered, preparing and aborted journals', async () => {
    const fixture = await seed();
    for (const state of ['registered', 'preparing', 'aborted']) {
      const pending = state === 'preparing';
      await sql`WITH stamp AS (SELECT clock_timestamp() AS at) INSERT INTO public.studio_import_publication
        (id,"ownerId","projectId","importId",state,"createdAt","expiresAt","stagedPath","targetPath",declaration,"stagedIdentity")
        SELECT ${randomUUID()}::uuid,${ownerId}::uuid,${fixture.project.id}::uuid,${randomUUID()}::uuid,${state},at,at+interval '6 hours',
          ${pending ? join(root, 'partial.stage') : null},${pending ? join(root, 'partial.mp4') : null},
          ${pending ? JSON.stringify({ checksum, processingProvenance: provenance }) : null}::text::jsonb,
          ${pending ? JSON.stringify({ dev: '1', ino: '2', size: bytes.length }) : null}::text::jsonb FROM stamp`.execute(
        db,
      );
    }
    const manifest = await capture(fixture.project.id);
    expect(manifest.studio!.projects[fixture.project.id].imports.map((row) => row.id)).toEqual([fixture.id]);
    expect(JSON.stringify(manifest.studio)).not.toMatch(
      /partial\.stage|partial\.mp4|stagedPath|stagedIdentity|publicationId/,
    );
    await expect(restore(manifest, fixture.project.id)).rejects.toThrow('cleanup is pending');
    expect(
      (
        await sql`SELECT id FROM public.studio_import_publication WHERE "projectId"=${fixture.project.id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(3);
  });

  it('keeps restored bytes while ready references or capture pins remain and rechecks the PIN', async () => {
    const fixture = await seed();
    const manifest = await capture(fixture.project.id);
    const files = await restore(manifest, fixture.project.id);
    const path = files[0].target;
    const physical = new PhysicalFileRepository(db);
    const unlink = vi.fn().mockResolvedValue(undefined);
    expect((await physical.deleteUnreferencedPath(path, unlink)).deleted).toBe(false);
    const runId = randomUUID();
    await sql`INSERT INTO public.buddy_backup_reference ("runId",path) VALUES (${runId}::uuid,${path})`.execute(db);
    await expect(restore(manifest, fixture.project.id)).rejects.toThrow('pinned');
    await sql`DELETE FROM public.studio_project_import WHERE id=${fixture.id}::uuid`.execute(db);
    expect((await physical.deleteUnreferencedPath(path, unlink)).deleted).toBe(false);
    expect(unlink).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(bytes);
    await sql`UPDATE public.buddy_backup_reference SET released=true WHERE "runId"=${runId}::uuid`.execute(db);
    await db.updateTable('session').set({ pinExpiresAt: null }).where('id', '=', sessionId).execute();
    await expect(restore(manifest, fixture.project.id)).rejects.toThrow('authorization');
    expect(await stored(fixture.project.id, fixture.id)).toBeUndefined();
    expect(await readFile(path)).toEqual(bytes);
  });
});

import { Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  AssetLockReason,
  AssetStatus,
  AssetType,
  MediaOperationCheckpointState,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { type StudioExportPublication, StudioExportRepository } from 'src/repositories/studio-export.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { openRenderArtifact, receiveRenderArtifact } from 'src/utils/render-artifact.js';
import { sealStudioSidecar } from 'src/utils/studio-subtitle-sidecar.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const folders: string[] = [];
beforeAll(async () => {
  db = await getKyselyDB();
});
afterEach(async () => {
  await db.deleteFrom('media_operation').execute();
  const owned = [...folders];
  folders.length = 0;
  await Promise.all(owned.map((folder) => rm(folder, { recursive: true, force: true })));
});
const deferred = () => Promise.withResolvers<void>();
/** Real migrated storage and real streamed bytes; this fixture does not attest a GPU worker. */
const fixture = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const workers = new RenderWorkerRepository(db);
  const worker = await workers.createWorker({
    name: 'paired fixture',
    destination: MediaOperationDestination.Local,
    kinds: [MediaOperationKind.StudioExport],
    enrolmentSecret: randomBytes(32),
    engineDigest: 'c'.repeat(64),
    conformanceMaxAgeMs: 86_400_000,
    maxConcurrentOperations: 1,
    maxWallClockMs: null,
    maxOutputBytes: null,
    gpuMemoryBytes: null,
    createdBy: null,
  });
  const session = await workers.createSession({
    workerId: worker.id,
    token: randomBytes(32),
    scopes: [MediaOperationKind.StudioExport],
    gpuMemoryBytes: null,
    engineDigest: worker.engineDigest,
    conformanceReportedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const seal = sealStudioSidecar(
    {
      metadata: { fps: 24 },
      timeline: {
        tracks: [{ id: 'v', order: 0, visible: true }],
        items: [{ id: 'image', type: 'image', trackId: 'v', from: 0, durationInFrames: 24 }],
      },
    },
    { revisionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), engineDigest: 'c'.repeat(64) },
  );
  const operations = new MediaOperationRepository(db);
  const operation = await operations.create({
    ownerId: user.id,
    kind: MediaOperationKind.StudioExport,
    destination: MediaOperationDestination.Local,
    label: 'Paired authority fixture',
    settings: { subtitleMode: 'sidecar', subtitleSeal: seal },
    snapshot: { sourceEpochs: [] },
  });
  const claim = await operations.claimNext({
    kinds: [MediaOperationKind.StudioExport],
    workerId: worker.id,
    leaseMs: 60_000,
  });
  expect(claim?.operation.id).toBe(operation.id);
  const binding = {
    operationId: operation.id,
    claimToken: claim!.claimToken,
    workerId: worker.id,
    sessionId: session.id,
    chunkKey: 'paired',
    inputDigest: 'd'.repeat(64),
  };
  await operations.upsertCheckpoint(operation.id, binding.claimToken, {
    operationId: operation.id,
    sequence: 0,
    chunkKey: binding.chunkKey,
    inputDigest: binding.inputDigest,
    historyDigest: 'h',
    configDigest: 'c',
    seed: null,
    timebase: '1/24',
    startTicks: '0',
    endTicks: '24',
    requiresSequentialContext: false,
  });
  const folder = await mkdtemp(join(tmpdir(), 'paired-upload-'));
  folders.push(folder);
  const upload = (role: 'media' | 'subtitle', bytes: Buffer, check = async () => {}) =>
    operations.withExportArtifact(binding, async (_row, install) =>
      receiveRenderArtifact(
        folder,
        Readable.from([bytes]),
        { checksum: createHash('sha256').update(bytes).digest('hex'), sizeInBytes: String(bytes.length) },
        check,
        (artifact) => install(role, artifact, check),
        { allowEmpty: role === 'subtitle' && seal.zeroCue },
      ),
    );
  return { operations, binding, folder, upload, worker };
};
describe('paired whole-export authority under canonical migrations', () => {
  it('empty sealed subtitle stays pending until separately streamed media; both stored files rehash', async () => {
    const f = await fixture();
    expect(await f.upload('subtitle', Buffer.alloc(0))).toBe(true);
    let [row] = await f.operations.getCheckpoints(f.binding.operationId);
    expect(row.state).toBe(MediaOperationCheckpointState.Pending);
    expect(row.completedAt).toBeNull();
    expect(row.outputPath).toBeNull();
    expect(String(row.subtitleSizeInBytes)).toBe('0');
    const bytes = Buffer.from('independent media fixture bytes');
    expect(await f.upload('media', bytes)).toBe(true);
    [row] = await f.operations.getCheckpoints(f.binding.operationId);
    expect(row.state).toBe(MediaOperationCheckpointState.Complete);
    for (const [outputPath, outputChecksum, sizeInBytes, expected] of [
      [row.outputPath, row.outputChecksum, row.sizeInBytes, bytes],
      [row.subtitlePath, row.subtitleChecksum, row.subtitleSizeInBytes, Buffer.alloc(0)],
    ] as const) {
      const stream = await openRenderArtifact(
        f.folder,
        { outputPath: outputPath!, outputChecksum: outputChecksum!, sizeInBytes: Number(sizeInBytes) },
        async () => {},
      );
      expect(Buffer.concat(await Array.fromAsync(stream))).toEqual(expected);
    }
    expect(await f.upload('subtitle', Buffer.alloc(0))).toBe(true);
    expect(await readdir(f.folder)).toHaveLength(2);
  });
  it('serializes both roles while input is held, without completing either sibling alone', async () => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred();
    const first = f.upload('media', Buffer.from('media'), async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let secondEntered = false;
    const second = f.upload('subtitle', Buffer.alloc(0), () => {
      secondEntered = true;
      return Promise.resolve();
    });
    try {
      await expect
        .poll(async () => {
          const { rows } = await sql<{
            waiting: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND wait_event_type='Lock') AS waiting`.execute(
            db,
          );
          return rows[0].waiting;
        })
        .toBe(true);
      expect(secondEntered).toBe(false);
    } finally {
      release.resolve();
    }
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect((await f.operations.getCheckpoints(f.binding.operationId))[0].state).toBe(
      MediaOperationCheckpointState.Complete,
    );
  });
  it.each(['cancel', 'pause', 'expired', 'replacement'] as const)(
    'refuses %s after body arrival and removes uncommitted bytes',
    async (condition) => {
      const f = await fixture();
      const arrived = deferred(),
        release = deferred();
      let checks = 0;
      const pending = f.upload('media', Buffer.from('uncommitted bytes'), async () => {
        if (++checks !== 1) {
          return;
        }

        arrived.resolve();
        await release.promise;
      });
      await arrived.promise;
      try {
        await db
          .updateTable('media_operation')
          .set(
            condition === 'cancel'
              ? { cancelRequestedAt: new Date() }
              : condition === 'pause'
                ? { pauseRequestedAt: new Date() }
                : condition === 'expired'
                  ? { claimExpiresAt: new Date(0) }
                  : { claimToken: randomUUID() },
          )
          .where('id', '=', f.binding.operationId)
          .execute();
      } finally {
        release.resolve();
      }
      expect(await pending).toBe(false);
      const [row] = await f.operations.getCheckpoints(f.binding.operationId);
      expect(row.state).toBe(MediaOperationCheckpointState.Pending);
      expect(row.outputPath).toBeNull();
      expect(await readdir(f.folder)).toEqual([]);
    },
  );
});

/** Actual file moves and canonical repository publication, independent of encoder qualification. */
describe('paired file publication and private reads', () => {
  const staged = async (withSource = false) => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id, pinExpiresAt: new Date(Date.now() + 60_000) });
    const project = await new StudioProjectRepository(db).create({ ownerId: user.id, name: 'Real paired publication' });
    const graph = {
      metadata: { fps: 24 },
      timeline: {
        tracks: [{ id: 'v', order: 0, visible: true }],
        items: [{ id: 'image', type: 'image', trackId: 'v', from: 0, durationInFrames: 24 }],
      },
    };
    const seal = sealStudioSidecar(graph, {
      revisionDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      engineDigest: 'c'.repeat(64),
    });
    const repo = new StudioExportRepository(db, new DerivativePrivacyRepository(db));
    const asset = withSource ? (await ctx.newAsset({ ownerId: user.id })).asset : null;
    const epochs = asset ? await AssetLocalEffectRepository.sourceEpochs(db, [asset.id]) : [];
    const sources = asset
      ? [
          {
            key: `library-asset:${asset.id}`,
            kind: 'library-asset',
            resourceId: asset.id,
            assetId: asset.id,
            ownerId: user.id,
            checksum: asset.checksum.toString('base64'),
            sourceAccess: 'owner' as const,
            sourceEpoch: epochs[0].epoch,
          },
        ]
      : [];
    const operationDto = {
      ownerId: user.id,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Local,
      label: 'Real pair fixture',
      projectId: project.id,
      revisionId: 'a'.repeat(64),
      settings: { subtitleMode: 'sidecar', subtitleSeal: seal },
      snapshot: { sourceEpochs: epochs },
    };
    const { operation } = await repo.createWithRender(operationDto, {
      ownerId: user.id,
      projectId: project.id,
      revision: 1,
      revisionDigest: 'a'.repeat(64),
      destination: MediaOperationDestination.Local,
      settings: operationDto.settings,
    });
    await repo.recordRenderClaim(operation.id, {
      workerId: 'private-fixture',
      engineDigest: seal.engineDigest,
      sources,
    });
    const token = randomUUID();
    await db
      .updateTable('media_operation')
      .set({
        claimToken: token,
        status: MediaOperationStatus.Validating,
        claimExpiresAt: new Date(Date.now() + 60_000),
      })
      .where('id', '=', operation.id)
      .execute();
    const folder = await mkdtemp(join(tmpdir(), 'paired-publication-'));
    folders.push(folder);
    const media = Buffer.from('actual media transport fixture; not an encoder witness');
    const checksum = createHash('sha256').update(media).digest();
    const before = [join(folder, 'media.artifact'), join(folder, 'subtitle.artifact')];
    const after = [join(folder, 'published.mp4'), join(folder, randomUUID() + '.srt')];
    await writeFile(before[0], media);
    await writeFile(before[1], Buffer.alloc(0));
    const subtitle = {
      outputPath: before[1],
      outputChecksum: Buffer.from(seal.expectedSrtSha256, 'hex'),
      sizeInBytes: 0,
    };
    const staged = await repo.stage(
      operation.id,
      token,
      { path: before[0], checksum, sizeInBytes: media.length, contentType: 'video/mp4', remoteRef: null, subtitle },
      () => ({ ...operationDto, kind: MediaOperationKind.StudioExportPublish }),
    );
    expect(staged).toBeDefined();
    await db
      .updateTable('media_operation')
      .set({
        claimToken: token,
        status: MediaOperationStatus.Validating,
        claimExpiresAt: new Date(Date.now() + 60_000),
      })
      .where('id', '=', staged!.operation.id)
      .execute();
    let moved = 0;
    const failure = { second: false };
    const input: StudioExportPublication = {
      versionId: staged!.version.id,
      operationId: staged!.operation.id,
      claimToken: token,
      ownerId: user.id,
      sources,
      expectedScope: StudioExportScope.Project,
      retainInProject: true,
      nsfwHiding: false,
      path: after[0],
      checksum,
      sizeInBytes: media.length,
      contentType: 'video/mp4',
      assetType: AssetType.Video,
      originalFileName: 'pair.mp4',
      subtitle: { ...subtitle, outputPath: after[1] },
      files: {
        paths: [...before, ...after],
        move: async () => {
          for (let i = 0; i < 2; i++) {
            if (i === 1 && failure.second) throw new Error('second move refused');
            await rename(before[i], after[i]);
            moved++;
          }
        },
        rollback: async () => {
          while (moved > 0) {
            --moved;
            await rename(after[moved], before[moved]);
          }
        },
      },
    };
    return {
      repo,
      input,
      user,
      session,
      before,
      after,
      media,
      version: staged!.version,
      operation: staged!.operation,
      failure,
      asset,
      ctx,
    };
  };
  it('atomically publishes both actual files and an identical replay never moves them again', async () => {
    const f = await staged();
    const result = await f.repo.publish(f.input);
    expect(result.version.state).toBe(StudioExportVersionState.Published);
    expect(result.version.subtitlePath).toBe(f.after[1]);
    expect(String(result.version.subtitleSizeInBytes)).toBe('0');
    expect(await readFile(f.after[0])).toEqual(f.media);
    expect(await readFile(f.after[1])).toEqual(Buffer.alloc(0));
    const replay = {
      ...f.input,
      files: {
        ...f.input.files!,
        move: () => Promise.reject(new Error('replay must not move')),
      },
    };
    expect((await f.repo.publish(replay)).version).toEqual(result.version);
    await expect(
      f.repo.publish({ ...replay, subtitle: { ...replay.subtitle!, outputChecksum: randomBytes(32) } }),
    ).rejects.toThrow();
    expect(
      await f.repo.withSubtitleAccess(f.version.id, f.user.id, f.session.id, (v) => Promise.resolve(v.subtitlePath)),
    ).toBe(f.after[1]);
    const { user: foreign } = await newMediumService(BaseService, {
      database: db,
      real: [],
      mock: [LoggingRepository],
    }).ctx.newUser();
    await expect(
      f.repo.withSubtitleAccess(f.version.id, foreign.id, f.session.id, () => Promise.resolve(true)),
    ).rejects.toThrow();
    await db
      .updateTable('session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', f.session.id)
      .execute();
    await expect(
      f.repo.withSubtitleAccess(f.version.id, f.user.id, f.session.id, () => Promise.resolve(true)),
    ).rejects.toThrow();
  });
  it.each(['project', 'result'] as const)(
    'refuses a pinned subtitle immediately after its %s parent is purged',
    async (parent) => {
      const f = await staged();
      const publication = await f.repo.publish({
        ...f.input,
        retainInProject: parent === 'project',
        expectedScope: parent === 'project' ? StudioExportScope.Project : StudioExportScope.Library,
      });
      const pin = randomUUID();
      await sql`INSERT INTO buddy_backup_reference ("runId",path) VALUES (${pin}::uuid,${f.after[1]})`.execute(db);
      if (parent === 'project') await db.deleteFrom('studio_project').where('id', '=', f.version.projectId!).execute();
      else await db.deleteFrom('asset').where('id', '=', publication.version.resultAssetId!).execute();
      expect(await readFile(f.after[1])).toEqual(Buffer.alloc(0));
      const action = vi.fn().mockResolvedValue(true);
      await expect(f.repo.withSubtitleAccess(f.version.id, f.user.id, f.session.id, action)).rejects.toThrow(
        'Subtitle unavailable',
      );
      expect(action).not.toHaveBeenCalled();
    },
  );
  it('refuses a result identity replaced while subtitle access waits on the original result lock', async () => {
    const f = await staged();
    const published = await f.repo.publish({
      ...f.input,
      retainInProject: false,
      expectedScope: StudioExportScope.Library,
    });
    const { asset: replacement } = await f.ctx.newAsset({ ownerId: f.user.id });
    const held = deferred(),
      release = deferred();
    const locker = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('asset')
        .select('id')
        .where('id', '=', published.version.resultAssetId!)
        .forUpdate()
        .execute();
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const action = vi.fn().mockResolvedValue(true);
    const refused = expect(f.repo.withSubtitleAccess(f.version.id, f.user.id, f.session.id, action)).rejects.toThrow(
      'Subtitle unavailable',
    );
    try {
      await expect
        .poll(async () => {
          const { rows } = await sql<{
            blocked: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0) AS blocked`.execute(
            db,
          );
          return rows[0].blocked;
        })
        .toBe(true);
      await db
        .updateTable('studio_export_version')
        .set({ resultAssetId: replacement.id })
        .where('id', '=', f.version.id)
        .execute();
    } finally {
      release.resolve();
      await locker;
    }
    await refused;
    expect(action).not.toHaveBeenCalled();
  });
  it('second move failure restores the first file and leaves the complete pair staged', async () => {
    const f = await staged();
    f.failure.second = true;
    await expect(f.repo.publish(f.input)).rejects.toThrow('second move refused');
    expect(await readFile(f.before[0])).toEqual(f.media);
    expect(await readFile(f.before[1])).toEqual(Buffer.alloc(0));
    expect(
      (
        await db
          .selectFrom('studio_export_version')
          .selectAll()
          .where('id', '=', f.version.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe(StudioExportVersionState.Staged);
    expect(await readdir(f.after[0].slice(0, f.after[0].lastIndexOf('/')))).toHaveLength(2);
  });
  it('notification failure rolls back both files, receipt and durable publication followups', async () => {
    const f = await staged();
    await expect(
      f.repo.publish(f.input, undefined, () => Promise.reject(new Error('durable notification admission failed'))),
    ).rejects.toThrow('durable notification admission failed');
    expect(await readFile(f.before[0])).toEqual(f.media);
    expect(await readFile(f.before[1])).toEqual(Buffer.alloc(0));
    const version = await db
      .selectFrom('studio_export_version')
      .selectAll()
      .where('id', '=', f.version.id)
      .executeTakeFirstOrThrow();
    expect(version.state).toBe(StudioExportVersionState.Staged);
    expect(version.publishedAt).toBeNull();
    const operation = await db
      .selectFrom('media_operation')
      .select('result')
      .where('id', '=', f.operation.id)
      .executeTakeFirstOrThrow();
    expect(operation.result).toBeNull();
  });
  it('fresh source access refuses an expired PIN after the actual Locked source row wait', async () => {
    const f = await staged(true);
    await f.repo.publish(f.input);
    await db.insertInto('asset_lock').values({ assetId: f.asset!.id, reason: AssetLockReason.Marked }).execute();
    expect(await f.repo.withSubtitleAccess(f.version.id, f.user.id, f.session.id, () => Promise.resolve(true))).toBe(
      true,
    );
    const held = deferred(),
      release = deferred();
    const locker = db.transaction().execute(async (tx) => {
      await tx.selectFrom('asset').select('id').where('id', '=', f.asset!.id).forUpdate().execute();
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const pending = f.repo.withSubtitleAccess(f.version.id, f.user.id, f.session.id, () => Promise.resolve(true));
    const rejected = expect(pending).rejects.toThrow();
    try {
      await expect
        .poll(async () => {
          const { rows } = await sql<{
            blocked: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0) AS blocked`.execute(
            db,
          );
          return rows[0].blocked;
        })
        .toBe(true);
      await db
        .updateTable('session')
        .set({ pinExpiresAt: new Date(0) })
        .where('id', '=', f.session.id)
        .execute();
    } finally {
      release.resolve();
      await locker;
    }
    await rejected;
  });
  it('a current-source epoch change revokes the old subtitle even while the original bytes remain', async () => {
    const f = await staged(true);
    await f.repo.publish(f.input);
    await db.transaction().execute(async (tx) => {
      await tx.selectFrom('asset').select('id').where('id', '=', f.asset!.id).forUpdate().execute();
      await AssetLocalEffectRepository.lockStreamHead(tx, f.user.id);
      await tx
        .updateTable('asset')
        .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
        .where('id', '=', f.asset!.id)
        .execute();
      await new AssetLocalEffectRepository(db).append(tx, f.user.id, randomUUID(), {
        origin: { kind: 'trash' },
        assets: [{ assetId: f.asset!.id, status: AssetStatus.Trashed, revoke: true }],
        stacks: [],
      });
      await tx
        .updateTable('asset')
        .set({ status: AssetStatus.Active, deletedAt: null })
        .where('id', '=', f.asset!.id)
        .execute();
      await new AssetLocalEffectRepository(db).append(tx, f.user.id, randomUUID(), {
        origin: { kind: 'restore' },
        assets: [{ assetId: f.asset!.id, status: AssetStatus.Active, revoke: false }],
        stacks: [],
      });
    });
    expect(await readFile(f.after[0])).toEqual(f.media);
    await expect(
      f.repo.withSubtitleAccess(f.version.id, f.user.id, f.session.id, () => Promise.resolve(true)),
    ).rejects.toThrow();
  });

  it('the orphan subtitle deletion remains pinned, then releases only that exact role without deleting media', async () => {
    const f = await staged();
    await f.repo.publish(f.input);
    const pin = randomUUID();
    await sql`INSERT INTO buddy_backup_reference ("runId",path) VALUES (${pin}::uuid,${f.after[1]})`.execute(db);
    await db.deleteFrom('studio_project').where('id', '=', f.version.projectId!).execute();
    const physical = new PhysicalFileRepository(db);
    let removed = 0;
    const remove = async () => {
      removed++;
      await rm(f.after[1]);
    };
    const options = {
      retiredStudioExport: {
        id: f.version.id,
        ownerId: f.user.id,
        checksum: f.input.subtitle!.outputChecksum,
        sizeBytes: 0,
        role: 'subtitle' as const,
      },
    };
    expect((await physical.deleteUnreferencedPath(f.after[1], remove, options)).deleted).toBe(false);
    expect(removed).toBe(0);
    expect(await readFile(f.after[1])).toEqual(Buffer.alloc(0));
    await sql`UPDATE buddy_backup_reference SET released=true WHERE "runId"=${pin}::uuid`.execute(db);
    expect((await physical.deleteUnreferencedPath(f.after[1], remove, options)).deleted).toBe(true);
    expect(removed).toBe(1);
    expect(await readFile(f.after[0])).toEqual(f.media);
    const version = await db
      .selectFrom('studio_export_version')
      .selectAll()
      .where('id', '=', f.version.id)
      .executeTakeFirstOrThrow();
    expect(version.subtitlePath).toBeNull();
    expect(version.subtitleChecksum).toBeNull();
    expect(version.subtitleSizeInBytes).toBeNull();
    expect(version.subtitleRemovedAt).not.toBeNull();
    expect(version.outputPath).toBe(f.after[0]);
  });

  it('a render claim that expires behind a real row lock cannot stage either sibling', async () => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const project = await new StudioProjectRepository(db).create({ ownerId: user.id, name: 'Expired staging barrier' });
    const seal = sealStudioSidecar(
      {
        metadata: { fps: 24 },
        timeline: {
          tracks: [{ id: 'v', order: 0, visible: true }],
          items: [{ id: 'title', type: 'text', trackId: 'v', from: 0, durationInFrames: 24, text: 'Title' }],
        },
      },
      { revisionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), engineDigest: 'c'.repeat(64) },
    );
    const repo = new StudioExportRepository(db, new DerivativePrivacyRepository(db));
    const dto = {
      ownerId: user.id,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Local,
      projectId: project.id,
      label: 'Staging expiry barrier',
      snapshot: { sourceEpochs: [] },
      settings: { subtitleMode: 'sidecar', subtitleSeal: seal },
    };
    const { operation } = await repo.createWithRender(dto, {
      ownerId: user.id,
      projectId: project.id,
      revision: 1,
      revisionDigest: 'a'.repeat(64),
      destination: MediaOperationDestination.Local,
      settings: dto.settings,
    });
    const token = randomUUID();
    await db
      .updateTable('media_operation')
      .set({
        claimToken: token,
        status: MediaOperationStatus.Validating,
        claimExpiresAt: sql<Date>`clock_timestamp()+interval '500 milliseconds'`,
      })
      .where('id', '=', operation.id)
      .execute();
    const held = deferred(),
      release = deferred();
    const locker = db.transaction().execute(async (tx) => {
      await tx.selectFrom('media_operation').select('id').where('id', '=', operation.id).forUpdate().execute();
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const pending = repo.stage(
      operation.id,
      token,
      {
        path: '/owned-fixture/media.artifact',
        checksum: randomBytes(32),
        sizeInBytes: 1,
        contentType: 'video/mp4',
        remoteRef: null,
        subtitle: {
          outputPath: '/owned-fixture/subtitle.artifact',
          outputChecksum: Buffer.from(seal.expectedSrtSha256, 'hex'),
          sizeInBytes: 0,
        },
      },
      () => ({ ...dto, kind: MediaOperationKind.StudioExportPublish }),
      true,
    );
    try {
      await expect
        .poll(async () => {
          const { rows } = await sql<{
            blocked: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0) AS blocked`.execute(
            db,
          );
          return rows[0].blocked;
        })
        .toBe(true);
      await expect
        .poll(async () => {
          const { rows } = await sql<{
            expired: boolean;
          }>`SELECT "claimExpiresAt"<=clock_timestamp() AS expired FROM media_operation WHERE id=${operation.id}::uuid`.execute(
            db,
          );
          return rows[0].expired;
        })
        .toBe(true);
    } finally {
      release.resolve();
      await locker;
    }
    expect(await pending).toBeUndefined();
    expect(
      await db
        .selectFrom('media_operation')
        .select('id')
        .where('kind', '=', MediaOperationKind.StudioExportPublish)
        .where('projectId', '=', project.id)
        .execute(),
    ).toEqual([]);
  });
});

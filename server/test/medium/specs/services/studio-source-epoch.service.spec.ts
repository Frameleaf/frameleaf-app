import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AssetLockReason,
  AssetStatus,
  AssetType,
  JobName,
  MediaOperationDestination,
  MediaOperationKind,
  QueueName,
  StudioPreviewQuality,
  StudioPreviewStatus,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioPreviewRepository } from 'src/repositories/studio-preview.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { DB } from 'src/schema/index.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { StudioDestination } from 'src/utils/studio-resources.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});

it.each(['owner', 'shared'] as const)(
  'C2 RED: old %s source grant remains revoked after identical-byte restore; fresh admission remains valid',
  async (audience) => {
    const { sut, ctx } = newMediumService(StudioResourceService, {
      database: db,
      real: [AccessRepository, AssetRepository, CryptoRepository, IntegrityRepository],
      mock: [LoggingRepository],
    });
    const { user: owner } = await ctx.newUser();
    const { user: viewer } = audience === 'owner' ? { user: owner } : await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id, type: AssetType.Image });
    if (audience === 'shared') await new ItemShareRepository(db).add(owner.id, [asset.id], [viewer.id]);
    const auth = factory.auth({ user: viewer });
    const context = {
      projectId: randomUUID(),
      ownerId: viewer.id,
      revision: 1,
      graph: { id: 'sequence', tracks: [{ id: 'video', kind: 'video', clips: [{ assetId: asset.id }] }] },
      destination: StudioDestination.Local,
    };
    const before = (await sut.resolveProjectResources(auth, context)).manifest;
    expect(before.complete).toBe(true);
    const token = sut.issuePreviewGrant(before, { workerId: 'actual-worker' });
    expect((await sut.verifyReadGrant(token, { workerId: 'actual-worker', auth })).valid).toBe(true);
    const operations = new MediaOperationRepository(db);
    const oldOperation = await operations.create({
      ownerId: viewer.id,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Local,
      label: 'old actual source admission',
      snapshot: { kind: 'studio-export', sourceEpochs: before.sourceEpochs },
      settings: {},
    });
    const repo = new AssetLocalEffectRepository(db);
    const transition = (status: AssetStatus.Active | AssetStatus.Trashed) =>
      db.transaction().execute(async (tx) => {
        await tx
          .updateTable('asset')
          .set({ status, deletedAt: status === AssetStatus.Trashed ? new Date() : null })
          .where('id', '=', asset.id)
          .execute();
        return repo.append(tx, owner.id, randomUUID(), {
          origin: { kind: status === AssetStatus.Trashed ? 'trash' : 'restore' },
          assets: [{ assetId: asset.id, status, revoke: status === AssetStatus.Trashed }],
          stacks: [],
        });
      });
    const trashEffect = await transition(AssetStatus.Trashed);
    expect((await sut.verifyReadGrant(token, { workerId: 'actual-worker', auth })).valid).toBe(false);
    await transition(AssetStatus.Active);
    expect((await sut.verifyReadGrant(token, { workerId: 'actual-worker', auth })).valid).toBe(false);
    const fresh = (await sut.resolveProjectResources(auth, context)).manifest;
    expect(fresh.digest).not.toBe(before.digest);
    const request = (sourceEpochs: typeof fresh.sourceEpochs) => ({
      ownerId: viewer.id,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Local,
      label: 'actual source admission',
      snapshot: { kind: 'studio-export', sourceEpochs },
      settings: {},
    });
    await expect(operations.create(request(before.sourceEpochs))).rejects.toThrow('studio_source_admission_changed');
    const freshOperation = await operations.create(request(fresh.sourceEpochs));
    expect(freshOperation.snapshot.sourceEpochs).toEqual(fresh.sourceEpochs);
    const targets = await operations.listRevokedSourceAdmissions(trashEffect.revocations);
    expect(targets.map((row) => row.id)).toContain(oldOperation.id);
    expect(targets.map((row) => row.id)).not.toContain(freshOperation.id);
    const newToken = sut.issuePreviewGrant(fresh, { workerId: 'actual-worker' });
    expect((await sut.verifyReadGrant(newToken, { workerId: 'actual-worker', auth })).valid).toBe(true);
  },
);

it('retains exact generated producer admission across reopen and refuses it after Trash/restore', async () => {
  const { sut, ctx } = newMediumService(StudioResourceService, {
    database: db,
    real: [AccessRepository, AssetRepository, CryptoRepository, IntegrityRepository],
    mock: [LoggingRepository],
  });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
  const auth = factory.auth({ user });
  const projects = new StudioProjectRepository(db);
  const { project } = await projects.createWithRevision({
    ownerId: user.id,
    name: 'actual producer admission',
    revision: {
      authorId: user.id,
      envelope: {},
      digest: 'source-digest',
      graphBytes: 2,
      summary: {},
      requestKey: null,
    },
  });
  const base = { projectId: project.id, ownerId: user.id, revision: 1, destination: StudioDestination.Local };
  const before = (
    await sut.resolveProjectResources(auth, { ...base, graph: { tracks: [{ clips: [{ assetId: asset.id }] }] } })
  ).manifest;
  expect(before.complete).toBe(true);
  const operations = new MediaOperationRepository(db);
  const operation = await operations.create({
    ownerId: user.id,
    projectId: project.id,
    kind: MediaOperationKind.StudioReverseConform,
    destination: MediaOperationDestination.Local,
    label: 'actual producer',
    snapshot: { revision: 1, sourceEpochs: before.sourceEpochs },
    settings: {},
  });
  const claim = await operations.claimNext({
    kinds: [MediaOperationKind.StudioReverseConform],
    workerId: 'actual-worker',
    leaseMs: 60_000,
  });
  expect(claim?.operation.id).toBe(operation.id);
  expect(await operations.beginValidation(operation.id, claim!.claimToken, true)).toBe(true);
  const generatedId = `reverse-${operation.id}`;
  const checksum = 'ab'.repeat(32);
  expect(
    await operations.publishValidated(operation.id, claim!.claimToken, async (tx) => {
      await projects.registerGeneratedResource(
        {
          projectId: project.id,
          ownerId: user.id,
          sourceRevision: 1,
          id: generatedId,
          producer: 'reverse-conform',
          checksum,
          path: '/private/studio/actual-generated.mp4',
          derivedFrom: [`library-asset:${asset.id}`],
        },
        tx,
      );
      await tx
        .updateTable('media_operation')
        .set({ result: { generatedId, checksum } })
        .where('id', '=', operation.id)
        .execute();
      return true;
    }),
  ).toBe('completed');
  const generated = await new StudioProjectRepository(db).listGeneratedResources(project.id);
  expect(generated[0].sourceEpochs).toEqual(before.sourceEpochs);
  const request = { ...base, graph: { tracks: [{ clips: [{ generatedId }] }] }, generated };
  expect((await sut.resolveProjectResources(auth, request)).manifest.complete).toBe(true);
  const effects = new AssetLocalEffectRepository(db);
  for (const status of [AssetStatus.Trashed, AssetStatus.Active] as const)
    await db.transaction().execute(async (tx) => {
      await tx
        .updateTable('asset')
        .set({ status, deletedAt: status === AssetStatus.Trashed ? new Date() : null })
        .where('id', '=', asset.id)
        .execute();
      await effects.append(tx, user.id, randomUUID(), {
        origin: { kind: status === AssetStatus.Trashed ? 'trash' : 'restore' },
        assets: [{ assetId: asset.id, status, revoke: status === AssetStatus.Trashed }],
        stacks: [],
      });
    });
  const reopened = await new StudioProjectRepository(db).listGeneratedResources(project.id);
  expect(reopened[0].sourceEpochs).toEqual(before.sourceEpochs);
  const refused = await sut.resolveProjectResources(auth, { ...request, generated: reopened });
  expect(refused.manifest.complete).toBe(false);
  expect(refused.manifest.entries.some((entry) => entry.id === generatedId)).toBe(false);
});

it('C2 RED: an interactive request keeps its original owner-stream view across a real Lock and Unlock', async () => {
  const { sut, ctx } = newMediumService(StudioResourceService, {
    database: db,
    real: [AccessRepository, AssetRepository, CryptoRepository, IntegrityRepository],
    mock: [LoggingRepository],
  });
  const { user } = await ctx.newUser(),
    { session } = await ctx.newSession({ userId: user.id });
  const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
  const auth = factory.auth({ user, session: { ...session, hasElevatedPermission: false } });
  const manifest = (
    await sut.resolveProjectResources(auth, {
      projectId: randomUUID(),
      ownerId: user.id,
      revision: 1,
      graph: { tracks: [{ clips: [{ assetId: asset.id }] }] },
      destination: StudioDestination.Local,
    })
  ).manifest;
  expect(manifest.complete).toBe(true);
  expect(manifest.interactiveAdmissionView).toEqual({
    actorId: user.id,
    sessionId: session.id,
    owners: [{ ownerId: user.id, streamEpoch: null, sequence: '0' }],
  });
  const snapshot = {
    kind: 'studio-preview',
    sourceEpochs: manifest.sourceEpochs,
    interactiveAdmissionView: manifest.interactiveAdmissionView,
  };
  const assets = new AssetRepository(db),
    effects = new AssetLocalEffectRepository(db);
  await db.transaction().execute(async (tx) => {
    await assets.lock([asset.id], AssetLockReason.Marked, user.id, tx);
    await effects.append(tx, user.id, randomUUID(), {
      origin: { kind: 'stack' },
      assets: [{ assetId: asset.id, status: AssetStatus.Active, revoke: false }],
      stacks: [],
    });
  });
  await assets.unlock([asset.id]);
  expect((await AssetLocalEffectRepository.sourceEpochs(db, [asset.id]))[0].epoch).toBe('0');
  const operations = new MediaOperationRepository(db);
  await expect(
    operations.create({
      ownerId: user.id,
      kind: MediaOperationKind.StudioPreview,
      destination: MediaOperationDestination.Local,
      label: 'old pending interactive admission',
      snapshot,
      settings: {},
    }),
  ).rejects.toThrow('studio_source_admission_changed');
  expect(await db.selectFrom('media_operation').select('id').where('ownerId', '=', user.id).execute()).toEqual([]);
});

it('C2 RED: a real first interactive admission leaves a cursor that can durably dispatch the subsequent local effect', async () => {
  const { sut, ctx } = newMediumService(StudioResourceService, {
    database: db,
    real: [AccessRepository, AssetRepository, CryptoRepository, IntegrityRepository],
    mock: [LoggingRepository],
  });
  const { user } = await ctx.newUser(),
    { session } = await ctx.newSession({ userId: user.id }),
    { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
  const auth = factory.auth({ user, session: { ...session, hasElevatedPermission: false } });
  const before = (
    await sut.resolveProjectResources(auth, {
      projectId: randomUUID(),
      ownerId: user.id,
      revision: 1,
      graph: { tracks: [{ clips: [{ assetId: asset.id }] }] },
      destination: StudioDestination.Local,
    })
  ).manifest;
  await new MediaOperationRepository(db).create({
    ownerId: user.id,
    kind: MediaOperationKind.StudioPreviewStream,
    destination: MediaOperationDestination.Local,
    label: 'first real source admission',
    snapshot: {
      kind: 'studio-preview-stream',
      sourceEpochs: before.sourceEpochs,
      interactiveAdmissionView: before.interactiveAdmissionView,
    },
    settings: {},
  });
  const effects = new AssetLocalEffectRepository(db);
  await db.transaction().execute((tx) =>
    effects.append(tx, user.id, randomUUID(), {
      origin: { kind: 'stack' },
      assets: [{ assetId: asset.id, status: AssetStatus.Active, revoke: false }],
      stacks: [],
    }),
  );
  const store = new SqlQueueStore(db),
    worker = randomUUID();
  await store.initialize([QueueName.BackgroundTask], worker);
  // Earlier cases deliberately retain durable heads for other owners. Check the real
  // producer's complete bounded fanout, then dispatch actual claimed owner targets.
  const { rows: eligible } = await sql<{ ownerId: string }>`SELECT s."ownerId" FROM asset_local_effect_stream s
    JOIN asset_local_effect_cursor c USING("ownerId") WHERE s."nextSequence">coalesce(c."acknowledgedSequence",0)+1
    AND NOT EXISTS(SELECT 1 FROM job j WHERE j.queue=${QueueName.BackgroundTask}
      AND j."dedupKey"=${JobName.ICloudRelations + ':owner-stream:'}||s."ownerId"::text AND j.state IN ('pending','waiting','active'))`.execute(
    db,
  );
  expect(eligible.map((row) => row.ownerId)).toContain(user.id);
  expect(eligible.length).toBeLessThanOrEqual(25);
  expect(await effects.enqueuePending()).toBe(eligible.length);
  const delivered: string[] = [],
    targets: string[] = [];
  for (let remaining = eligible.length; remaining > 0;) {
    const claims = await store.claim(QueueName.BackgroundTask, worker);
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(
        await queueExecution.run(
          {
            claim,
            signal: new AbortController().signal,
            progress: () => {},
            followups: [],
            adoptions: [],
            buffering: true,
            progressUnits: 0,
          },
          async () => {
            const target = await effects.resolveOwnerTarget();
            expect(target).toBeDefined();
            targets.push(target!);
            return effects.dispatch(target!, (bundle) => {
              if (target === user.id) delivered.push(bundle.sequence);
              return Promise.resolve();
            });
          },
        ),
      ).toBe(true);
      expect(await store.complete(claim, [])).toBe(true);
      remaining--;
    }
  }
  expect(new Set(targets)).toEqual(new Set(eligible.map((row) => row.ownerId)));
  expect(delivered).toEqual(['1']);
});

// Actual PostgreSQL lock waits, not a timing approximation: admission must use
// the acting session and current asset owner after its final shared-lock wait.
it.each(['pin-expiry', 'owner-change'] as const)(
  'interactive admission rechecks %s after the asset-lock barrier',
  async (change) => {
    const { sut, ctx } = newMediumService(StudioResourceService, {
      database: db,
      real: [AccessRepository, AssetRepository, CryptoRepository, IntegrityRepository],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser(),
      { session } = await ctx.newSession({ userId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
    if (change === 'pin-expiry') {
      await new AssetRepository(db).lock([asset.id], AssetLockReason.Marked, user.id);
      await sql`UPDATE session SET "pinExpiresAt"=clock_timestamp()+interval '2 minutes' WHERE id=${session.id}::uuid`.execute(
        db,
      );
    }
    const auth = await currentAuth(db, user.id, session.id, false);
    expect(auth).toBeDefined();
    const before = (
      await sut.resolveProjectResources(auth!, {
        projectId: randomUUID(),
        ownerId: user.id,
        revision: 1,
        graph: { tracks: [{ clips: [{ assetId: asset.id }] }] },
        destination: StudioDestination.Local,
      })
    ).manifest;
    expect(before.complete).toBe(true);
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await tx.selectFrom('asset').select('id').where('id', '=', asset.id).forUpdate().execute();
      held.resolve();
      await release.promise;
      if (change === 'owner-change') {
        const { user: other } = await ctx.newUser();
        await tx.updateTable('asset').set({ ownerId: other.id }).where('id', '=', asset.id).execute();
      }
    });
    await held.promise;
    const admission = new MediaOperationRepository(db).create({
      ownerId: user.id,
      kind: MediaOperationKind.StudioPreviewStream,
      destination: MediaOperationDestination.Local,
      label: 'real waiting admission',
      snapshot: {
        kind: 'studio-preview-stream',
        sourceEpochs: before.sourceEpochs,
        interactiveAdmissionView: before.interactiveAdmissionView,
      },
      settings: {},
    });
    // Attach the rejection observer before releasing the database barrier.
    const refusal = expect(admission).rejects.toThrow('studio_source_admission_changed');
    try {
      await expect
        .poll(async () => {
          const { rows } = await sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%asset%'`.execute(
            db,
          );
          return rows[0].count;
        })
        .toBeGreaterThan(0);
      if (change === 'pin-expiry')
        await sql`UPDATE session SET "pinExpiresAt"=clock_timestamp()-interval '1 second' WHERE id=${session.id}::uuid`.execute(
          db,
        );
    } finally {
      release.resolve();
      await blocker;
    }
    await refusal;
    expect(await db.selectFrom('media_operation').select('id').where('ownerId', '=', user.id).execute()).toEqual([]);
  },
);

it('a delayed frame attachment cannot bind a revived pending frame with a different update version', async () => {
  const { sut, ctx } = newMediumService(StudioResourceService, {
    database: db,
    real: [AccessRepository, AssetRepository, CryptoRepository, IntegrityRepository],
    mock: [LoggingRepository],
  });
  const { user } = await ctx.newUser(),
    { session } = await ctx.newSession({ userId: user.id }),
    { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
  const auth = factory.auth({ user, session: { ...session, hasElevatedPermission: false } }),
    projectId = randomUUID();
  const manifest = (
    await sut.resolveProjectResources(auth, {
      projectId,
      ownerId: user.id,
      revision: 1,
      graph: { tracks: [{ clips: [{ assetId: asset.id }] }] },
      destination: StudioDestination.Local,
    })
  ).manifest;
  const snapshot = {
    kind: 'studio-preview',
    sourceEpochs: manifest.sourceEpochs,
    interactiveAdmissionView: manifest.interactiveAdmissionView,
  };
  const frames = new StudioPreviewRepository(db, new DerivativePrivacyRepository(db));
  const input = {
    ownerId: user.id,
    projectId,
    revisionDigest: manifest.digest,
    projectRevision: 1,
    grantToken: null,
    grantSessionId: session.id,
    cacheKey: randomUUID(),
    timeNumerator: 0,
    timeDenominator: 1,
    quality: StudioPreviewQuality.Draft,
    viewportWidth: 320,
    viewportHeight: 180,
    operationId: null,
    seekGeneration: 0,
    framePath: null,
    contentType: null,
    sizeInBytes: null,
    frameChecksum: null,
    framePts: null,
    framePtsTimebase: null,
    toneMapped: false,
    errorCode: null,
    readyAt: null,
    expiresAt: null,
  };
  const { frame: old } = await frames.upsert(input, snapshot);
  const operation = await new MediaOperationRepository(db).create({
    ownerId: user.id,
    kind: MediaOperationKind.StudioPreview,
    destination: MediaOperationDestination.Local,
    label: 'actual old frame admission',
    snapshot,
    settings: {},
  });
  await db
    .updateTable('studio_preview_frame')
    .set({ status: StudioPreviewStatus.Superseded })
    .where('id', '=', old.id)
    .execute();
  const { frame: fresh, created } = await frames.upsert(input, snapshot);
  expect(created).toBe(true);
  expect(fresh.id).toBe(old.id);
  expect(fresh.updateId).not.toBe(old.updateId);
  await expect(
    db.transaction().execute((tx) => frames.attachAdmissionOperation(tx, old, operation.id)),
  ).rejects.toThrow('Preview admission was retired before attachment');
  expect(
    await db
      .selectFrom('studio_preview_frame')
      .select(['status', 'operationId', 'updateId'])
      .where('id', '=', fresh.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ status: StudioPreviewStatus.Pending, operationId: null, updateId: fresh.updateId });
  await db.transaction().execute((tx) => frames.attachAdmissionOperation(tx, fresh, operation.id));
  expect(
    (
      await db
        .selectFrom('studio_preview_frame')
        .select('operationId')
        .where('id', '=', fresh.id)
        .executeTakeFirstOrThrow()
    ).operationId,
  ).toBe(operation.id);
});

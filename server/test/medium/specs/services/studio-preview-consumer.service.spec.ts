import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { StorageCore } from 'src/cores/storage.core.js';
import { StudioPreviewCancelQueryDto } from 'src/dtos/studio-preview.dto.js';
import {
  AssetType,
  MediaOperationKind,
  MediaOperationStatus,
  StudioPreviewQuality,
  StudioPreviewStatus,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioExportRepository } from 'src/repositories/studio-export.repository.js';
import { StudioPreviewRepository } from 'src/repositories/studio-preview.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { StudioPreviewService, studioPreviewFrameFolder } from 'src/services/studio-preview.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import {
  PREVIEW_CANCEL_CLEANED,
  PREVIEW_CANCEL_PENDING,
  PREVIEW_CANCEL_UNAVAILABLE,
} from 'src/utils/studio-preview.js';
import { StudioDestination } from 'src/utils/studio-resources.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { automock, getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
  StorageCore.setMediaLocation('/data');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.deleteFrom('studio_preview_frame').execute();
  await database.deleteFrom('media_operation').execute();
});
afterAll(async () => database?.destroy());

const gate = () => {
  const { promise, resolve: release } = Promise.withResolvers<void>();
  return { promise, release };
};

// The same immutable fields the public operation retry copies into a new submission.
const retryInput = (operation: MediaOperation) => ({
  ownerId: operation.ownerId,
  kind: operation.kind,
  destination: operation.destination,
  destinationDetail: operation.destinationDetail,
  label: operation.label,
  assetId: operation.assetId,
  resultAssetId: null,
  retryOfId: operation.id,
  projectId: operation.projectId,
  revisionId: operation.revisionId,
  snapshot: operation.snapshot,
  settings: operation.settings,
  estimate: operation.estimate,
  maxAttempts: operation.maxAttempts,
});

const setup = async () => {
  const { sut: resources, ctx } = newMediumService(StudioResourceService, {
    database,
    real: [AccessRepository, AssetRepository, CryptoRepository, IntegrityRepository],
    mock: [LoggingRepository],
  });
  const { user } = await ctx.newUser();
  const { session } = await ctx.newSession({ userId: user.id });
  const auth = factory.auth({ user, session });
  const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
  const graph = { id: 'sequence', tracks: [{ id: 'video', kind: 'video', clips: [{ assetId: asset.id }] }] };
  const projects = new StudioProjectRepository(database);
  const { project } = await projects.createWithRevision({
    ownerId: user.id,
    spaceId: null,
    name: 'Isolated consumer preview',
    revision: {
      authorId: user.id,
      envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'test', graph },
      digest: 'revision-1',
      graphBytes: JSON.stringify(graph).length,
      summary: {},
      requestKey: null,
    },
  });
  const { manifest } = await resources.resolveProjectResources(auth, {
    projectId: project.id,
    ownerId: user.id,
    revision: 1,
    graph,
    destination: StudioDestination.Local,
  });
  expect(manifest.complete).toBe(true);
  const frames = new StudioPreviewRepository(database, new DerivativePrivacyRepository(database));
  const operations = new MediaOperationRepository(database);
  const storage = automock(StorageRepository, { args: [ctx.getMock(LoggingRepository)], strict: false });
  storage.unlinkDir.mockResolvedValue();
  storage.stat.mockResolvedValue({ isFile: () => true, size: 2048 } as never);
  const makeService = () =>
    new StudioPreviewService(
      ctx.getMock(LoggingRepository),
      frames,
      operations,
      resources,
      new StudioProjectService(
        ctx.getMock(LoggingRepository),
        projects,
        ctx.get(AccessRepository),
        resources,
        automock(WebsocketRepository, { args: [undefined, ctx.getMock(LoggingRepository)], strict: false }),
      ),
      storage,
      automock(StudioExportRepository, { strict: false }),
      ctx.get(UserRepository),
    );
  const sut = makeService();
  const request = async (consumerRequestId: string = randomUUID(), seekGeneration = 0) =>
    (
      await sut.requestForManifest(auth, manifest, {
        time: { numerator: '0', denominator: '1' },
        quality: StudioPreviewQuality.Draft,
        viewportWidth: 960,
        viewportHeight: 540,
        seekGeneration,
        consumerRequestId,
      })
    ).preview;
  const claim = async () => {
    const claimed = await operations.claimNext({
      kinds: [MediaOperationKind.StudioPreview],
      workerId: 'preview-fixture',
      leaseMs: 60_000,
    });
    return claimed ? { ...claimed.operation, claimToken: claimed.claimToken } : undefined;
  };
  return {
    ctx,
    auth,
    user,
    asset,
    project,
    manifest,
    resources,
    frames,
    operations,
    storage,
    sut,
    request,
    claim,
    makeService,
  };
};

it('validates explicit null as a typed wire string, refusing omission, empty and JSON null', () => {
  const consumerRequestId = randomUUID();
  expect(StudioPreviewCancelQueryDto.schema.parse({ consumerRequestId, expectedOperationId: 'null' })).toEqual({
    consumerRequestId,
    expectedOperationId: 'null',
  });
  for (const value of [
    { consumerRequestId },
    { consumerRequestId, expectedOperationId: '' },
    { consumerRequestId, expectedOperationId: null },
  ]) {
    expect(StudioPreviewCancelQueryDto.schema.safeParse(value).success).toBe(false);
  }
});

it('isolates consumers and sessions, preserves same-request identity, and refuses stale or legacy cancellation', async () => {
  const f = await setup();
  const a = await f.request();
  const original = await f.frames.getForOwner(a.id, f.user.id);
  const b = await f.request();
  const retry = await f.request(a.consumerRequestId!);
  expect(retry.id).toBe(a.id);
  expect(retry.operationId).toBe(a.operationId);
  expect((await f.frames.getForOwner(retry.id, f.user.id))!.grantToken).toBe(original!.grantToken);
  expect((await f.frames.getForOwner(retry.id, f.user.id))!.updateId).toBe(original!.updateId);
  expect(b.id).not.toBe(a.id);
  expect(b.operationId).not.toBe(a.operationId);
  await expect(f.sut.cancel(f.auth, a.id)).rejects.toThrow('Preview frame not found');
  await expect(
    f.sut.cancel(f.auth, a.id, { consumerRequestId: a.consumerRequestId, expectedOperationId: b.operationId! }),
  ).rejects.toThrow('The captured preview operation changed');
  await expect(
    f.sut.cancel(f.auth, a.id, { consumerRequestId: b.consumerRequestId, expectedOperationId: a.operationId! }),
  ).rejects.toThrow('Preview frame not found');
  const { session } = await f.ctx.newSession({ userId: f.user.id });
  const otherSession = factory.auth({ user: f.user, session });
  await expect(f.sut.get(otherSession, a.id, { consumerRequestId: a.consumerRequestId })).rejects.toThrow(
    'Preview frame not found',
  );
  const other = factory.auth();
  await expect(
    f.sut.cancel(other, a.id, { consumerRequestId: a.consumerRequestId, expectedOperationId: a.operationId! }),
  ).rejects.toThrow('Preview frame not found');
  const receipt = await f.sut.cancel(f.auth, a.id, {
    consumerRequestId: a.consumerRequestId,
    expectedOperationId: a.operationId!,
  });
  expect(receipt).toMatchObject({ admissionReleased: true, cancellationState: 'not-needed', rendererReleased: null });
  expect(
    await f.operations.claimNext({ kinds: [MediaOperationKind.StudioPreview], workerId: 'next', leaseMs: 60_000 }),
  ).toMatchObject({ operation: { id: b.operationId } });
  expect((await f.frames.getForOwner(b.id, f.user.id))!.status).toBe(StudioPreviewStatus.Rendering);
  expect(f.storage.unlinkDir).toHaveBeenCalledExactlyOnceWith(studioPreviewFrameFolder(f.user.id, a.id), {
    recursive: true,
    force: true,
  });
  expect((await f.request(a.consumerRequestId!)).status).toBe(StudioPreviewStatus.Evicted);
  expect((await f.request()).id).not.toBe(a.id);
});

it.each([false, true])(
  'retains a claimed directory until genuine release=%s, never treating completion as release',
  async (released) => {
    const f = await setup();
    const frame = await f.request();
    const claim = (await f.claim())!;
    expect(claim.id).toBe(frame.operationId);
    const query = { consumerRequestId: frame.consumerRequestId, expectedOperationId: frame.operationId! };
    const receipt = await f.sut.cancel(f.auth, frame.id, query);
    expect(receipt).toMatchObject({ admissionReleased: true, cancellationState: 'requested', rendererReleased: null });
    expect(f.storage.unlinkDir).not.toHaveBeenCalled();
    expect(await f.operations.acknowledgeCancel(claim.id, randomUUID(), { released: true })).toBe(false);
    expect(await f.operations.acknowledgeCancel(claim.id, claim.claimToken!, { released })).toBe(true);
    await f.makeService().sweep();
    expect((await f.frames.getForOwner(frame.id, f.user.id))!.errorCode).toBe(
      released ? PREVIEW_CANCEL_CLEANED : PREVIEW_CANCEL_PENDING,
    );
    expect(f.storage.unlinkDir.mock.calls.length).toBe(released ? 1 : 0);
    const repeated = await f.sut.cancel(f.auth, frame.id, query);
    expect(repeated.rendererReleased).toBe(released ? true : null);
  },
);

it('retains completed preview resources and lease-recovered cancellation without a genuine release', async () => {
  const f = await setup();
  const completed = await f.request();
  const claim = (await f.claim())!;
  await database
    .updateTable('media_operation')
    .set({ status: MediaOperationStatus.Validating })
    .where('id', '=', claim.id)
    .execute();
  expect(await f.operations.complete(claim.id, claim.claimToken!, { resultAssetId: null })).toBe(true);
  await f.sut.cancel(f.auth, completed.id, {
    consumerRequestId: completed.consumerRequestId,
    expectedOperationId: completed.operationId!,
  });
  expect(f.storage.unlinkDir).not.toHaveBeenCalled();
  const recovered = await f.request();
  const lost = (await f.claim())!;
  await f.sut.cancel(f.auth, recovered.id, {
    consumerRequestId: recovered.consumerRequestId,
    expectedOperationId: recovered.operationId!,
  });
  await database
    .updateTable('media_operation')
    .set({ claimExpiresAt: new Date(0) })
    .where('id', '=', lost.id)
    .execute();
  expect(await f.operations.acknowledgeCancel(lost.id, lost.claimToken!, { released: true })).toBe(false);
  await f.operations.recoverExpiredClaims({ errorCode: 'fixture-lost-claim', error: 'fixture expired claim' });
  expect(await f.operations.getForOwner(lost.id, f.user.id)).toMatchObject({
    status: MediaOperationStatus.Cancelled,
    cancelAcknowledgedAt: null,
    remoteReleasedAt: null,
  });
  await f.makeService().sweep();
  expect(f.storage.unlinkDir).not.toHaveBeenCalled();
  await database
    .updateTable('studio_preview_frame')
    .set({ updatedAt: new Date(0) })
    .where('id', 'in', [completed.id, recovered.id])
    .execute();
  expect(await f.frames.deleteEvictedBefore(new Date(Date.now() + 1000), 100)).toBe(0);
});

it('commits the delivery fence despite a real SQL cancel failure and retries after restart without premature cleanup', async () => {
  const f = await setup();
  const frame = await f.request();
  const claim = (await f.claim())!;
  const changes: string[] = [];
  const removeListener = f.operations.onChange((rows) => {
    changes.push(...rows.map((row) => row.id));
  });
  await sql`CREATE FUNCTION preview_consumer_cancel_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."cancelRequestedAt" IS NOT NULL AND OLD."cancelRequestedAt" IS NULL THEN
      RAISE EXCEPTION 'fixture cancel failure'; END IF; RETURN NEW; END $$`.execute(database);
  await sql`CREATE TRIGGER preview_consumer_cancel_failure BEFORE UPDATE ON media_operation
    FOR EACH ROW EXECUTE FUNCTION preview_consumer_cancel_failure()`.execute(database);
  try {
    const receipt = await f.sut.cancel(f.auth, frame.id, {
      consumerRequestId: frame.consumerRequestId,
      expectedOperationId: frame.operationId!,
    });
    expect(receipt).toMatchObject({
      admissionReleased: true,
      cancellationState: 'unavailable',
      rendererReleased: null,
    });
    expect(await f.frames.getForOwner(frame.id, f.user.id)).toMatchObject({
      status: StudioPreviewStatus.Evicted,
      errorCode: PREVIEW_CANCEL_UNAVAILABLE,
      operationId: claim.id,
      framePath: null,
    });
    expect(await f.operations.getForOwner(claim.id, f.user.id)).toMatchObject({
      cancelRequestedAt: null,
      claimToken: claim.claimToken,
    });
    expect(f.storage.unlinkDir).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  } finally {
    await sql`DROP TRIGGER preview_consumer_cancel_failure ON media_operation`.execute(database);
    await sql`DROP FUNCTION preview_consumer_cancel_failure()`.execute(database);
  }
  await f.makeService().sweep();
  expect(changes).toEqual([claim.id]);
  removeListener();
  expect(await f.operations.getForOwner(claim.id, f.user.id)).toMatchObject({
    status: MediaOperationStatus.Cancelling,
    claimToken: claim.claimToken,
  });
  expect(f.storage.unlinkDir).not.toHaveBeenCalled();
  expect(await f.operations.acknowledgeCancel(claim.id, claim.claimToken!, { released: true })).toBe(true);
  f.storage.unlinkDir.mockRejectedValueOnce(new Error('fixture removal failure'));
  await f.makeService().sweep();
  expect((await f.frames.getForOwner(frame.id, f.user.id))!.errorCode).not.toBe(PREVIEW_CANCEL_CLEANED);
  await f.makeService().sweep();
  expect((await f.frames.getForOwner(frame.id, f.user.id))!.errorCode).toBe(PREVIEW_CANCEL_CLEANED);
});

it('serializes allocation with cancellation: null can retire only before real operation attachment', async () => {
  const f = await setup();
  const entered = gate();
  const continueAllocation = gate();
  const attach = f.frames.attachAdmissionOperation.bind(f.frames);
  vi.spyOn(f.frames, 'attachAdmissionOperation').mockImplementationOnce(async (...args) => {
    entered.release();
    await continueAllocation.promise;
    return attach(...args);
  });
  const requestId = randomUUID();
  const requesting = f.request(requestId);
  await entered.promise;
  let cancelling: Promise<void>;
  try {
    const pending = await database
      .selectFrom('studio_preview_frame')
      .selectAll()
      .where('ownerId', '=', f.user.id)
      .executeTakeFirstOrThrow();
    expect(pending.operationId).toBeNull(); // Allocated job remains invisible until the same commit.
    cancelling = expect(
      f.sut.cancel(f.auth, pending.id, {
        consumerRequestId: requestId,
        expectedOperationId: 'null',
      }),
    ).rejects.toThrow('The captured preview operation changed');
  } finally {
    continueAllocation.release();
  }
  const frame = await requesting;
  await cancelling;
  expect(await f.operations.getForOwner(frame.operationId!, f.user.id)).toMatchObject({
    status: MediaOperationStatus.Queued,
    cancelRequestedAt: null,
  });
  expect(f.storage.unlinkDir).not.toHaveBeenCalled();
});

it('cancels before allocation without creating an orphan operation, and cannot revive the retired admission', async () => {
  const f = await setup();
  const entered = gate();
  const proceed = gate();
  const lock = f.frames.lockPendingAdmission.bind(f.frames);
  vi.spyOn(f.frames, 'lockPendingAdmission').mockImplementationOnce(async (...args) => {
    entered.release();
    await proceed.promise;
    return lock(...args);
  });
  const requestId = randomUUID();
  const requesting = f.request(requestId);
  await entered.promise;
  const pending = await database
    .selectFrom('studio_preview_frame')
    .selectAll()
    .where('ownerId', '=', f.user.id)
    .executeTakeFirstOrThrow();
  try {
    const receipt = await f.sut.cancel(f.auth, pending.id, {
      consumerRequestId: requestId,
      expectedOperationId: 'null',
    });
    expect(receipt).toMatchObject({ admissionReleased: true, cancellationState: 'not-needed', operationId: null });
  } finally {
    proceed.release();
  }
  expect(await requesting).toMatchObject({ id: pending.id, status: StudioPreviewStatus.Evicted, operationId: null });
  expect(await database.selectFrom('media_operation').select('id').where('ownerId', '=', f.user.id).execute()).toEqual(
    [],
  );
});

it('late completion/failure and privacy revocation cannot erase a claimed cleanup obligation', async () => {
  const f = await setup();
  const frame = await f.request();
  const claim = (await f.claim())!;
  await f.sut.revokeForProjects([f.project.id], f.user.id);
  expect(f.storage.unlinkDir).not.toHaveBeenCalled();
  await f.sut.onRenderFailed(claim, 'late-failure');
  expect(await f.frames.getForOwner(frame.id, f.user.id)).toMatchObject({
    status: StudioPreviewStatus.Evicted,
    errorCode: PREVIEW_CANCEL_PENDING,
    operationId: claim.id,
  });
  await expect(
    f.sut.onRenderCompleted(claim, {
      path: `${studioPreviewFrameFolder(f.user.id, frame.id)}/frame.png`,
      checksum: 'c'.repeat(64),
      sizeInBytes: '2048',
      contentType: 'image/png',
    }),
  ).resolves.toEqual({ published: false });
  expect(f.storage.unlinkDir).not.toHaveBeenCalled();
  await expect(f.sut.getFrame(f.auth, frame.id, { consumerRequestId: frame.consumerRequestId })).rejects.toThrow();
  expect(await f.frames.getForOwner(frame.id, f.user.id)).toMatchObject({
    status: StudioPreviewStatus.Evicted,
    operationId: claim.id,
  });
});

it('a current source refusal fences a scoped read without removing a claimed directory', async () => {
  const f = await setup();
  const frame = await f.request();
  const claim = (await f.claim())!;
  await database.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', f.asset.id).execute();
  await expect(f.sut.getFrame(f.auth, frame.id, { consumerRequestId: frame.consumerRequestId })).rejects.toThrow(
    'This preview is no longer authorized',
  );
  expect(await f.frames.getForOwner(frame.id, f.user.id)).toMatchObject({
    status: StudioPreviewStatus.Evicted,
    framePath: null,
    operationId: claim.id,
  });
  expect(await f.operations.getForOwner(claim.id, f.user.id)).toMatchObject({
    status: MediaOperationStatus.Cancelling,
  });
  expect(f.storage.unlinkDir).not.toHaveBeenCalled();
});

it('a recovered queued operation is not treated as never claimed for directory cleanup', async () => {
  const f = await setup();
  const frame = await f.request();
  const claimed = (await f.claim())!;
  // Recovery can queue work whose former executor has not proved it released its directory.
  await database
    .updateTable('media_operation')
    .set({ status: MediaOperationStatus.Queued, claimToken: null, claimExpiresAt: null })
    .where('id', '=', claimed.id)
    .execute();
  const result = await f.sut.cancel(f.auth, frame.id, {
    consumerRequestId: frame.consumerRequestId,
    expectedOperationId: frame.operationId!,
  });
  expect(result).toMatchObject({ admissionReleased: true, cancellationState: 'acknowledged', rendererReleased: null });
  expect(f.storage.unlinkDir).not.toHaveBeenCalled();
  await f.makeService().sweep();
  expect(f.storage.unlinkDir).not.toHaveBeenCalled();
});

it('checks scoped claim expiry after a row-lock wait at the actual ACK write', async () => {
  const f = await setup();
  const frame = await f.request();
  const claim = (await f.claim())!;
  await f.sut.cancel(f.auth, frame.id, {
    consumerRequestId: frame.consumerRequestId,
    expectedOperationId: frame.operationId!,
  });
  const precheck = (await f.operations.getForOwner(claim.id, f.user.id))!;
  expect(new Date(precheck.claimExpiresAt!).getTime()).toBeGreaterThan(Date.now());
  const locked = gate();
  const finishLock = gate();
  const holding = database.transaction().execute(async (tx) => {
    await tx
      .selectFrom('media_operation')
      .select('id')
      .where('id', '=', claim.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    locked.release();
    await finishLock.promise;
    await tx
      .updateTable('media_operation')
      .set({ claimExpiresAt: new Date(0) })
      .where('id', '=', claim.id)
      .execute();
  });
  await locked.promise;
  const acknowledging = f.operations.acknowledgeCancel(claim.id, claim.claimToken!, { released: true });
  finishLock.release();
  await holding;
  expect(await acknowledging).toBe(false);
  expect(await f.operations.getForOwner(claim.id, f.user.id)).toMatchObject({
    status: MediaOperationStatus.Cancelling,
    cancelAcknowledgedAt: null,
    remoteReleasedAt: null,
  });
  await f.makeService().sweep();
  expect(f.storage.unlinkDir).not.toHaveBeenCalled();
});

it.each(['missing', 'wrong'] as const)(
  'a %s scoped discriminator never falls back to legacy ACK authority',
  async (mutation) => {
    const f = await setup();
    const frame = await f.request();
    const claim = (await f.claim())!;
    await f.sut.cancel(f.auth, frame.id, {
      consumerRequestId: frame.consumerRequestId,
      expectedOperationId: frame.operationId!,
    });
    const snapshot = { ...claim.snapshot };
    if (mutation === 'missing') {
      delete snapshot.consumerRequestId;
    } else {
      snapshot.consumerRequestId = randomUUID();
    }
    await database.updateTable('media_operation').set({ snapshot }).where('id', '=', claim.id).execute();
    expect(await f.operations.acknowledgeCancel(claim.id, claim.claimToken!, { released: true })).toBe(false);
    expect(await f.operations.getForOwner(claim.id, f.user.id)).toMatchObject({
      remoteReleasedAt: null,
      cancelAcknowledgedAt: null,
    });
    await f.makeService().sweep();
    expect(f.storage.unlinkDir).not.toHaveBeenCalled();
  },
);

it.each(['original', 'missing', 'wrong', 'pruned'] as const)(
  'generic retry cannot allocate a new operation from a %s scoped admission',
  async (mutation) => {
    const f = await setup();
    const frame = await f.request();
    await f.sut.cancel(f.auth, frame.id, {
      consumerRequestId: frame.consumerRequestId,
      expectedOperationId: frame.operationId!,
    });
    const original = (await f.operations.getForOwner(frame.operationId!, f.user.id))!;
    if (mutation === 'pruned') {
      await database
        .updateTable('studio_preview_frame')
        .set({ updatedAt: new Date(0) })
        .where('id', '=', frame.id)
        .execute();
      expect(await f.frames.deleteEvictedBefore(new Date(Date.now() + 1000), 100)).toBe(1);
    } else if (mutation !== 'original') {
      const snapshot = { ...original.snapshot };
      if (mutation === 'missing') {
        delete snapshot.consumerRequestId;
      } else {
        snapshot.consumerRequestId = null;
      }
      await database.updateTable('media_operation').set({ snapshot }).where('id', '=', original.id).execute();
    }
    const retired = (await f.operations.getForOwner(original.id, f.user.id))!;
    f.storage.unlinkDir.mockClear();
    await expect(f.operations.createRetry(retryInput(retired))).rejects.toThrow(
      'Request a new consumer preview from Studio',
    );
    expect(
      await database.selectFrom('media_operation').select('id').where('ownerId', '=', f.user.id).execute(),
    ).toEqual([{ id: original.id }]);
    expect(f.storage.unlinkDir).not.toHaveBeenCalled();
  },
);

it('retains legacy retry semantics and ignores a consumer flag on a foreign operation kind', async () => {
  const f = await setup();
  const frame = (
    await f.sut.requestForManifest(f.auth, f.manifest, {
      time: { numerator: '0', denominator: '1' },
      quality: StudioPreviewQuality.Draft,
      viewportWidth: 960,
      viewportHeight: 540,
      seekGeneration: 0,
    })
  ).preview;
  await f.sut.cancel(f.auth, frame.id);
  const legacy = (await f.operations.getForOwner(frame.operationId!, f.user.id))!;
  const retry = await f.operations.createRetry(retryInput(legacy));
  expect(retry.created).toBe(true);
  expect(retry.operation).toMatchObject({ retryOfId: legacy.id, snapshot: legacy.snapshot });

  const foreign = await f.operations.create({
    ...retryInput(legacy),
    retryOfId: null,
    kind: MediaOperationKind.StudioExport,
    snapshot: { ...legacy.snapshot, consumerRequestId: randomUUID() },
  });
  await f.operations.requestCancel(foreign.id, f.user.id);
  const foreignRetry = await f.operations.createRetry(retryInput(foreign));
  expect(foreignRetry.created).toBe(true);
  expect(foreignRetry.operation.kind).toBe(MediaOperationKind.StudioExport);
});

it('an outer commit failure publishes neither the admission fence nor cancellation notification', async () => {
  const f = await setup();
  const frame = await f.request();
  const claim = (await f.claim())!;
  const changes: string[] = [];
  const removeListener = f.operations.onChange((rows) => {
    changes.push(...rows.map(({ id }) => id));
  });
  await sql`CREATE FUNCTION preview_consumer_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."status" = 'evicted' THEN RAISE EXCEPTION 'fixture outer commit failure'; END IF;
      RETURN NEW;
    END $$`.execute(database);
  await sql`CREATE CONSTRAINT TRIGGER preview_consumer_commit_failure
    AFTER UPDATE ON studio_preview_frame DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION preview_consumer_commit_failure()`.execute(database);
  try {
    await expect(
      f.sut.cancel(f.auth, frame.id, {
        consumerRequestId: frame.consumerRequestId,
        expectedOperationId: frame.operationId!,
      }),
    ).rejects.toThrow('fixture outer commit failure');
    expect(await f.frames.getForOwner(frame.id, f.user.id)).toMatchObject({
      status: StudioPreviewStatus.Rendering,
      operationId: claim.id,
      errorCode: null,
    });
    expect(await f.operations.getForOwner(claim.id, f.user.id)).toMatchObject({
      cancelRequestedAt: null,
      claimToken: claim.claimToken,
    });
    expect(changes).toEqual([]);
    expect(f.storage.unlinkDir).not.toHaveBeenCalled();
  } finally {
    removeListener();
    await sql`DROP TRIGGER preview_consumer_commit_failure ON studio_preview_frame`.execute(database);
    await sql`DROP FUNCTION preview_consumer_commit_failure()`.execute(database);
  }
});

it('a status read suspended in authorization cannot republish the state from before retirement', async () => {
  const f = await setup();
  const frame = await f.request();
  const entered = gate();
  const proceed = gate();
  const verify = f.resources.verifyReadGrant.bind(f.resources);
  vi.spyOn(f.resources, 'verifyReadGrant').mockImplementationOnce(async (...args) => {
    const result = await verify(...args);
    entered.release();
    await proceed.promise;
    return result;
  });
  const reading = f.sut.get(f.auth, frame.id, { consumerRequestId: frame.consumerRequestId });
  await entered.promise;
  try {
    await f.sut.cancel(f.auth, frame.id, {
      consumerRequestId: frame.consumerRequestId,
      expectedOperationId: frame.operationId!,
    });
  } finally {
    proceed.release();
  }
  expect(await reading).toMatchObject({ id: frame.id, status: StudioPreviewStatus.Evicted });
});

it('an allocation SQL failure leaves a retryable pending admission without an orphan operation', async () => {
  const f = await setup();
  const consumerRequestId = randomUUID();
  await sql`CREATE FUNCTION preview_consumer_allocation_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture allocation failure'; END $$`.execute(database);
  await sql`CREATE TRIGGER preview_consumer_allocation_failure BEFORE INSERT ON media_operation
    FOR EACH ROW EXECUTE FUNCTION preview_consumer_allocation_failure()`.execute(database);
  try {
    await expect(f.request(consumerRequestId)).rejects.toThrow('fixture allocation failure');
    expect(
      await database.selectFrom('media_operation').select('id').where('ownerId', '=', f.user.id).execute(),
    ).toEqual([]);
  } finally {
    await sql`DROP TRIGGER preview_consumer_allocation_failure ON media_operation`.execute(database);
    await sql`DROP FUNCTION preview_consumer_allocation_failure()`.execute(database);
  }
  const pending = await database
    .selectFrom('studio_preview_frame')
    .selectAll()
    .where('ownerId', '=', f.user.id)
    .executeTakeFirstOrThrow();
  expect(pending).toMatchObject({ status: StudioPreviewStatus.Pending, operationId: null });
  const retry = await f.request(consumerRequestId);
  expect(retry).toMatchObject({ id: pending.id, status: StudioPreviewStatus.Rendering });
  expect(await f.operations.getForOwner(retry.operationId!, f.user.id)).toMatchObject({
    status: MediaOperationStatus.Queued,
    snapshot: { previewFrameId: pending.id, consumerRequestId },
  });
  expect(await database.selectFrom('media_operation').select('id').where('ownerId', '=', f.user.id).execute()).toEqual([
    { id: retry.operationId },
  ]);
});

it('revision supersession retains a claimed directory while retiring a never-claimed admission separately', async () => {
  const f = await setup();
  const claimedFrame = await f.request();
  const claim = (await f.claim())!;
  const unclaimedFrame = await f.request();
  await f.sut.revisionCommitted({ projectId: f.project.id, revision: 2 });
  expect(await f.operations.getForOwner(claim.id, f.user.id)).toMatchObject({
    status: MediaOperationStatus.Cancelling,
    claimToken: claim.claimToken,
  });
  expect(await f.frames.getForOwner(claimedFrame.id, f.user.id)).toMatchObject({
    status: StudioPreviewStatus.Evicted,
    errorCode: PREVIEW_CANCEL_PENDING,
  });
  expect(await f.frames.getForOwner(unclaimedFrame.id, f.user.id)).toMatchObject({
    status: StudioPreviewStatus.Evicted,
    errorCode: PREVIEW_CANCEL_CLEANED,
  });
  expect(f.storage.unlinkDir).toHaveBeenCalledExactlyOnceWith(studioPreviewFrameFolder(f.user.id, unclaimedFrame.id), {
    recursive: true,
    force: true,
  });
});

it('retirement during the final recency await denies delivery while retaining the claimed directory', async () => {
  const f = await setup();
  const frame = await f.request();
  const claim = (await f.claim())!;
  const outputPath = `${studioPreviewFrameFolder(f.user.id, frame.id)}/frame.png`;
  expect(
    await f.sut.onRenderCompleted(claim, {
      path: outputPath,
      checksum: 'd'.repeat(64),
      sizeInBytes: '2048',
      contentType: 'image/png',
    }),
  ).toEqual({ published: true });
  const ready = (await f.frames.getForOwner(frame.id, f.user.id))!;
  expect(ready).toMatchObject({ status: StudioPreviewStatus.Ready, framePath: outputPath });

  const entered = gate();
  const proceed = gate();
  const admit = f.frames.markConsumerAccessed.bind(f.frames);
  vi.spyOn(f.frames, 'markConsumerAccessed').mockImplementationOnce(async (...args) => {
    entered.release();
    await proceed.promise;
    return admit(...args);
  });
  const reading = expect(
    f.sut.getFrame(f.auth, frame.id, {
      consumerRequestId: frame.consumerRequestId,
    }),
  ).rejects.toThrow('This preview admission was retired');
  await entered.promise;
  let retired: typeof ready;
  try {
    const receipt = await f.sut.cancel(f.auth, frame.id, {
      consumerRequestId: frame.consumerRequestId,
      expectedOperationId: frame.operationId!,
    });
    expect(receipt).toMatchObject({ admissionReleased: true, cancellationState: 'requested', rendererReleased: null });
    retired = (await f.frames.getForOwner(frame.id, f.user.id))!;
    expect(retired).toMatchObject({ status: StudioPreviewStatus.Evicted, framePath: null, operationId: claim.id });
  } finally {
    proceed.release();
  }
  await reading;
  const afterRead = (await f.frames.getForOwner(frame.id, f.user.id))!;
  expect(afterRead.lastAccessedAt).toEqual(retired.lastAccessedAt);
  expect(afterRead.updateId).toBe(retired.updateId); // Refused CAS must not touch the evicted row.
  expect(await f.operations.getForOwner(claim.id, f.user.id)).toMatchObject({
    status: MediaOperationStatus.Cancelling,
    cancelAcknowledgedAt: null,
    remoteReleasedAt: null,
  });
  expect(f.storage.unlinkDir).not.toHaveBeenCalled();
});

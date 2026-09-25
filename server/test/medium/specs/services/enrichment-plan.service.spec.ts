import { Kysely } from 'kysely';
import {
  AssetType,
  EnrichmentItemState,
  EnrichmentStage,
  JobStatus,
  MediaOperationKind,
  MediaOperationStatus,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { VideoMomentRepository } from 'src/repositories/video-moment.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { EnrichmentPlanService } from 'src/services/enrichment-plan.service.js';
import { parseEnrichmentPlanResult } from 'src/utils/enrichment-plan.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { automock, getKyselyDB } from 'test/utils.js';

/**
 * FL-59: enrichment plans against real `media_operation` rows. The model work (descriptions, the
 * Locked check, the moment stages) is mocked; claiming, progress, cancellation, the one automatic
 * retry and the idempotency key are the repository's real SQL.
 */
let database: Kysely<DB>;

beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => database?.destroy());

/** Claiming takes the oldest queued plan on the instance, so every test starts from an empty table. */
afterEach(async () => {
  await database.deleteFrom('media_operation').execute();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });

  const enrichment = {
    detectLockedContent: vi.fn().mockResolvedValue({ status: JobStatus.Success }),
    describeAsset: vi.fn().mockResolvedValue({ status: JobStatus.Success }),
    previewDescription: vi.fn(),
  };
  const moments = {
    runFramesStage: vi.fn().mockResolvedValue({ state: EnrichmentItemState.Completed }),
    runIndexStage: vi.fn().mockResolvedValue({ state: EnrichmentItemState.Completed }),
    runCaptionStage: vi.fn().mockResolvedValue({ state: EnrichmentItemState.Completed }),
  };

  // Library workloads are routed to a healthy local destination, as in the unit tests (FL-110).
  const mlDestinations = automock(MlDestinationRepository);
  mlDestinations.getRoute.mockImplementation((workload) =>
    Promise.resolve({ workload, destinationId: mlDestinationStub.local.id, modelId: null, updatedAt: new Date() }),
  );
  mlDestinations.getById.mockResolvedValue(mlDestinationStub.local);
  mlDestinations.getAll.mockResolvedValue([mlDestinationStub.local]);
  mlDestinations.getRoutes.mockResolvedValue([]);
  const machineLearning = automock(MachineLearningRepository, { args: [{ setContext: () => {} }] });

  const operations = ctx.get(MediaOperationRepository);
  const sut = new EnrichmentPlanService(
    ctx.getMock(LoggingRepository),
    operations,
    ctx.get(AccessRepository),
    ctx.get(UserRepository),
    enrichment as never,
    moments as never,
    ctx.get(VideoMomentRepository),
    mlDestinations,
    machineLearning,
    ctx.get(ConfigRepository),
    ctx.get(SystemMetadataRepository),
  );

  const newOwner = async () => {
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user: { id: user.id, isAdmin: false } });
    return { user, auth };
  };

  const newImages = async (ownerId: string, count: number) => {
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const { asset } = await ctx.newAsset({ ownerId, type: AssetType.Image });
      ids.push(asset.id);
    }
    return ids;
  };

  const row = (id: string) =>
    database.selectFrom('media_operation').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  /** Let a plan the worker handed back for its automatic retry be claimed now, not in 30 seconds. */
  const releaseRetry = (id: string) =>
    database
      .updateTable('media_operation')
      .set({ retryAt: new Date(Date.now() - 1000) })
      .where('id', '=', id)
      .execute();

  return { ctx, sut, operations, enrichment, moments, newOwner, newImages, row, releaseRetry };
};

describe(EnrichmentPlanService.name, () => {
  describe('createPlan idempotency', () => {
    it('answers two concurrent submits of one request key with one plan', async () => {
      const { sut, operations, newOwner, newImages } = setup();
      const { user, auth } = await newOwner();
      const assetIds = await newImages(user.id, 2);
      const requestKey = newUuid();
      const dto = { assetIds, stages: [EnrichmentStage.Description], requestKey };

      // Both submits pass the early lookup before either has inserted, so both reach the insert and
      // the unique index on (owner, request key) decides the race.
      const lookup = vi.spyOn(operations, 'getByRequestKey');
      lookup.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
      const insert = vi.spyOn(operations, 'create');

      const [first, second] = await Promise.all([sut.createPlan(auth, dto), sut.createPlan(auth, dto)]);

      expect(insert).toHaveBeenCalledTimes(2);
      expect(lookup).toHaveBeenCalledTimes(3);
      expect(first.operation.id).toBe(second.operation.id);
      const rows = await database
        .selectFrom('media_operation')
        .select(['id', 'kind', 'status'])
        .where('ownerId', '=', user.id)
        .execute();
      expect(rows).toEqual([
        { id: first.operation.id, kind: MediaOperationKind.EnrichmentPlan, status: MediaOperationStatus.Queued },
      ]);
    });

    it('returns the first plan when the same request key is submitted again', async () => {
      const { sut, newOwner, newImages } = setup();
      const { user, auth } = await newOwner();
      const assetIds = await newImages(user.id, 2);
      const requestKey = newUuid();

      const first = await sut.createPlan(auth, { assetIds, stages: [EnrichmentStage.Description], requestKey });
      // A repeat with a different body is still the same submit: the first plan is the answer.
      const again = await sut.createPlan(auth, {
        assetIds: [assetIds[0]],
        stages: [EnrichmentStage.LockedCheck],
        requestKey,
      });

      expect(again.operation.id).toBe(first.operation.id);
      expect(again.stages).toEqual([EnrichmentStage.Description]);
      expect(again.items.map(({ assetId }) => assetId)).toEqual(assetIds);
      await expect(
        database.selectFrom('media_operation').select('id').where('ownerId', '=', user.id).execute(),
      ).resolves.toHaveLength(1);
    });

    it('keeps request keys apart per owner', async () => {
      const { sut, newOwner, newImages } = setup();
      const requestKey = newUuid();
      const alice = await newOwner();
      const bob = await newOwner();
      const [aliceAsset] = await newImages(alice.user.id, 1);
      const [bobAsset] = await newImages(bob.user.id, 1);

      const [forAlice, forBob] = await Promise.all([
        sut.createPlan(alice.auth, { assetIds: [aliceAsset], stages: [EnrichmentStage.Description], requestKey }),
        sut.createPlan(bob.auth, { assetIds: [bobAsset], stages: [EnrichmentStage.Description], requestKey }),
      ]);

      expect(forAlice.operation.id).not.toBe(forBob.operation.id);
    });
  });

  describe('the worker', () => {
    it('claims a plan, records progress after every asset and completes it', async () => {
      const { sut, enrichment, newOwner, newImages, row } = setup();
      const { user, auth } = await newOwner();
      const assetIds = await newImages(user.id, 3);
      const plan = await sut.createPlan(auth, { assetIds, stages: [EnrichmentStage.Description] });

      // What the row says while each asset is in hand: the cursor and the asset being worked on.
      const seen: Array<{ assetId: string; processedUnits: number; inFlight: string | null; status: string }> = [];
      enrichment.describeAsset.mockImplementation(async (assetId: string) => {
        const current = await row(plan.operation.id);
        seen.push({
          assetId,
          processedUnits: Number(current.processedUnits),
          inFlight: parseEnrichmentPlanResult(current.result).inFlight,
          status: current.status,
        });
        return { status: JobStatus.Success };
      });

      await sut.drain();

      expect(seen).toEqual(
        assetIds.map((assetId, index) => ({
          assetId,
          processedUnits: index,
          inFlight: assetId,
          status: MediaOperationStatus.Rendering,
        })),
      );
      // Each stage is run with the plan's pinned options, as a plan run.
      expect(enrichment.describeAsset).toHaveBeenCalledWith(
        assetIds[0],
        expect.objectContaining({ jobId: plan.operation.id, planRun: true, configHash: plan.configHash }),
      );

      const finished = await row(plan.operation.id);
      expect(finished).toMatchObject({
        status: MediaOperationStatus.Completed,
        processedUnits: 3,
        totalUnits: 3,
        progress: 100,
        attempt: 1,
        claimToken: null,
      });
      expect(finished.heartbeatAt).not.toBeNull();

      const result = parseEnrichmentPlanResult(finished.result);
      expect(result.inFlight).toBeNull();
      expect(result.items.map(({ id }) => id)).toEqual(assetIds);
      for (const item of result.items) {
        expect(item.stages[EnrichmentStage.Description]).toMatchObject({
          state: EnrichmentItemState.Completed,
          at: expect.any(String),
        });
      }

      const view = await sut.getPlan(auth, plan.operation.id);
      expect(view.counts).toMatchObject({ total: 3, completed: 3, failed: 0, queued: 0 });
    });

    it('stops at the next asset when the owner cancels', async () => {
      const { sut, operations, enrichment, newOwner, newImages, row } = setup();
      const { user, auth } = await newOwner();
      const assetIds = await newImages(user.id, 3);
      const plan = await sut.createPlan(auth, { assetIds, stages: [EnrichmentStage.Description] });

      enrichment.describeAsset.mockImplementation(async () => {
        // The owner presses Cancel while the first asset is being described.
        await expect(operations.requestCancel(plan.operation.id, user.id)).resolves.toMatchObject({
          status: MediaOperationStatus.Cancelling,
        });
        return { status: JobStatus.Success };
      });

      await sut.drain();

      // The asset in hand finishes and is recorded; nothing after it is started.
      expect(enrichment.describeAsset).toHaveBeenCalledTimes(1);
      const cancelled = await row(plan.operation.id);
      expect(cancelled).toMatchObject({ status: MediaOperationStatus.Cancelled, processedUnits: 1 });
      expect(cancelled.cancelAcknowledgedAt).not.toBeNull();

      const view = await sut.getPlan(auth, plan.operation.id);
      expect(view.items.map(({ state }) => state)).toEqual([
        EnrichmentItemState.Completed,
        EnrichmentItemState.Cancelled,
        EnrichmentItemState.Cancelled,
      ]);
    });

    it('retries only the failed stages of the failed assets, once, after the retry delay', async () => {
      const { sut, enrichment, newOwner, newImages, row, releaseRetry } = setup();
      const { user, auth } = await newOwner();
      const [good, flaky] = await newImages(user.id, 2);
      const plan = await sut.createPlan(auth, {
        assetIds: [good, flaky],
        stages: [EnrichmentStage.LockedCheck, EnrichmentStage.Description],
      });

      let flakyAttempts = 0;
      enrichment.describeAsset.mockImplementation((assetId: string) => {
        if (assetId === flaky && flakyAttempts++ === 0) {
          return Promise.resolve({ status: JobStatus.Failed, reasonKey: 'model-error', message: 'timed out' });
        }
        return Promise.resolve({ status: JobStatus.Success });
      });

      await sut.drain();

      // The first pass is over; the plan waits out its retry delay without using up an attempt.
      const waiting = await row(plan.operation.id);
      expect(waiting).toMatchObject({ status: MediaOperationStatus.Queued, attempt: 0, claimToken: null });
      expect(waiting.retryAt).not.toBeNull();
      expect(parseEnrichmentPlanResult(waiting.result).retry).toEqual({ ids: [flaky], processed: 0 });
      await expect(sut.getPlan(auth, plan.operation.id)).resolves.toMatchObject({
        items: [
          { assetId: good, state: EnrichmentItemState.Completed, retryPending: false },
          { assetId: flaky, retryPending: true },
        ],
      });

      // Not claimable before the delay.
      await sut.drain();
      expect(enrichment.describeAsset).toHaveBeenCalledTimes(2);

      await releaseRetry(plan.operation.id);
      await sut.drain();

      // Only the flaky asset's description ran again; its Locked check had already succeeded.
      expect(enrichment.describeAsset.mock.calls.map(([assetId]) => assetId)).toEqual([good, flaky, flaky]);
      expect(enrichment.detectLockedContent.mock.calls.map(([assetId]) => assetId)).toEqual([good, flaky]);

      const finished = await row(plan.operation.id);
      expect(finished.status).toBe(MediaOperationStatus.Completed);
      expect(parseEnrichmentPlanResult(finished.result).retry).toEqual({ ids: [flaky], processed: 1 });
      const view = await sut.getPlan(auth, plan.operation.id);
      expect(view.counts).toMatchObject({ completed: 2, failed: 0 });
    });

    it('reports an asset that fails its retry as failed instead of retrying it again', async () => {
      const { sut, enrichment, newOwner, newImages, row, releaseRetry } = setup();
      const { user, auth } = await newOwner();
      const [broken] = await newImages(user.id, 1);
      const plan = await sut.createPlan(auth, { assetIds: [broken], stages: [EnrichmentStage.Description] });
      enrichment.describeAsset.mockResolvedValue({ status: JobStatus.Failed, reasonKey: 'model-error' });

      await sut.drain();
      await releaseRetry(plan.operation.id);
      await sut.drain();
      await releaseRetry(plan.operation.id);
      await sut.drain();

      expect(enrichment.describeAsset).toHaveBeenCalledTimes(2);
      await expect(row(plan.operation.id)).resolves.toMatchObject({ status: MediaOperationStatus.Completed });
      const view = await sut.getPlan(auth, plan.operation.id);
      expect(view.counts).toMatchObject({ total: 1, failed: 1, completed: 0 });
      expect(view.items[0]).toMatchObject({
        state: EnrichmentItemState.Failed,
        retryPending: false,
        stages: [{ stage: EnrichmentStage.Description, state: EnrichmentItemState.Failed, reasonKey: 'model-error' }],
      });
    });

    it('skips an asset that is no longer the owner’s instead of running it', async () => {
      const { ctx, sut, enrichment, newOwner, newImages, row } = setup();
      const { user, auth } = await newOwner();
      const [kept, deleted] = await newImages(user.id, 2);
      const plan = await sut.createPlan(auth, { assetIds: [kept, deleted], stages: [EnrichmentStage.Description] });

      // Gone between submit and run.
      await ctx.database.deleteFrom('asset').where('id', '=', deleted).execute();
      await sut.drain();

      expect(enrichment.describeAsset.mock.calls.map(([assetId]) => assetId)).toEqual([kept]);
      const finished = await row(plan.operation.id);
      expect(finished.status).toBe(MediaOperationStatus.Completed);
      const item = parseEnrichmentPlanResult(finished.result).items.find(({ id }) => id === deleted);
      expect(item?.stages[EnrichmentStage.Description]).toMatchObject({
        state: EnrichmentItemState.Skipped,
        reasonKey: 'not-found',
      });
    });
  });
});

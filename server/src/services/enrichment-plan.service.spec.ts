import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  AssetType,
  EnrichmentItemState,
  EnrichmentStage,
  JobStatus,
  MediaOperationKind,
  MediaOperationStatus,
  MlAdmissionRefusal,
  MlWorkload,
} from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { EnrichmentPlanService } from 'src/services/enrichment-plan.service.js';
import {
  EnrichmentPlanSnapshot,
  emptyEnrichmentPlanResult,
  parseEnrichmentPlanResult,
} from 'src/utils/enrichment-plan.js';
import { MEDIA_OPERATION_AUTO_RETRY_DELAY_MS } from 'src/utils/media-operation.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const ownerId = authStub.user1.user.id;
const destinationId = mlDestinationStub.local.id;

const pinnedConfig = {
  description: { modelName: 'm', fallbackModelName: 'f', device: 'AUTO', acceleration: 'auto', prompt: {} },
  lockedCheck: { modelName: 'n', threshold: 0.8, device: 'AUTO' },
  search: { modelName: 'clip' },
};

const snapshotOf = (overrides: Partial<EnrichmentPlanSnapshot> = {}): EnrichmentPlanSnapshot => ({
  version: 1,
  assetIds: [newUuid(), newUuid()],
  requestedStages: [EnrichmentStage.Description],
  stages: [EnrichmentStage.Description],
  destinations: { enrichment: destinationId, search: destinationId },
  config: pinnedConfig,
  configHash: 'hash',
  requestKey: null,
  elevated: false,
  ...overrides,
});

const operationOf = (snapshot: EnrichmentPlanSnapshot, overrides: Partial<MediaOperation> = {}): MediaOperation =>
  ({
    id: '0195e2a0-0000-7000-8000-0000000000e1',
    ownerId,
    kind: MediaOperationKind.EnrichmentPlan,
    status: MediaOperationStatus.Preparing,
    snapshot,
    result: null,
    processedUnits: '0',
    totalUnits: String(snapshot.assetIds.length),
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as unknown as MediaOperation;

describe(EnrichmentPlanService.name, () => {
  let sut: EnrichmentPlanService;
  let mocks: ServiceMocks;
  let operations: MediaOperationRepository;
  let enrichment: { detectLockedContent: any; describeAsset: any; previewDescription: any };
  let moments: { runFramesStage: any; runIndexStage: any; runCaptionStage: any };
  let momentRepository: { getAssetKinds: any };
  let users: { get: any };

  const running = { status: MediaOperationStatus.Rendering, cancelRequestedAt: null, pauseRequestedAt: null };

  beforeEach(() => {
    mocks = getMocks();
    operations = {
      create: vi.fn().mockImplementation((values) => Promise.resolve(operationOf(values.snapshot, values))),
      getByRequestKey: vi.fn().mockResolvedValue(undefined),
      getForOwner: vi.fn(),
      claimNext: vi.fn().mockResolvedValue(undefined),
      setBulkResult: vi.fn().mockResolvedValue(running),
      reportProgress: vi.fn().mockResolvedValue(true),
      heartbeat: vi.fn().mockResolvedValue(true),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('failed'),
      requeue: vi.fn().mockResolvedValue(true),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      settlePause: vi.fn().mockResolvedValue(true),
      getLockedAssetIds: vi.fn().mockResolvedValue(new Set()),
    } as unknown as MediaOperationRepository;
    enrichment = {
      detectLockedContent: vi.fn().mockResolvedValue({ status: JobStatus.Success }),
      describeAsset: vi.fn().mockResolvedValue({ status: JobStatus.Success }),
      previewDescription: vi.fn(),
    };
    moments = {
      runFramesStage: vi.fn().mockResolvedValue({ state: EnrichmentItemState.Completed }),
      runIndexStage: vi.fn().mockResolvedValue({ state: EnrichmentItemState.Completed }),
      runCaptionStage: vi.fn().mockResolvedValue({ state: EnrichmentItemState.Completed }),
    };
    momentRepository = { getAssetKinds: vi.fn() };
    users = { get: vi.fn().mockResolvedValue({ ...authStub.user1.user }) };
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local]);
    mocks.mlDestination.getRoutes.mockResolvedValue([]);
    mocks.mlDestination.getCloudModelChoices.mockResolvedValue([]);

    sut = new EnrichmentPlanService(
      mocks.logger as never,
      operations,
      mocks.access as never,
      users as never,
      enrichment as never,
      moments as never,
      momentRepository as never,
      mocks.mlDestination as never,
      mocks.machineLearning as never,
      mocks.config as never,
      mocks.systemMetadata as never,
    );
  });

  const kindsOf = (entries: Array<[string, AssetType]>) =>
    new Map(entries.map(([id, type]) => [id, { type, ownerId }]));

  describe('createPlan', () => {
    it('pins the routed destinations and the saved configuration, and never adds moment captions', async () => {
      const assetIds = [newUuid(), newUuid()];
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));

      const plan = await sut.createPlan(authStub.user1, { assetIds, stages: [EnrichmentStage.MomentIndex] });

      const created = vi.mocked(operations.create).mock.calls[0][0];
      const snapshot = created.snapshot as unknown as EnrichmentPlanSnapshot;
      expect(created.kind).toBe(MediaOperationKind.EnrichmentPlan);
      expect(snapshot.stages).toEqual([EnrichmentStage.Frames, EnrichmentStage.MomentIndex]);
      expect(snapshot.stages).not.toContain(EnrichmentStage.MomentCaptions);
      expect(snapshot.destinations).toEqual({ enrichment: null, search: destinationId });
      expect(snapshot.config.search.modelName).toBeDefined();
      expect(snapshot.configHash).toMatch(/^[\da-f]{16}$/);
      expect(plan.addedStages).toEqual([EnrichmentStage.Frames]);
      expect(plan.items.map(({ state }) => state)).toEqual([EnrichmentItemState.Queued, EnrichmentItemState.Queued]);
    });

    it('refuses assets the caller may not change, including Locked ones in an ordinary session', async () => {
      const assetIds = [newUuid()];
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.createPlan(authStub.user1, { assetIds, stages: [EnrichmentStage.Description] })).rejects.toThrow(
        BadRequestException,
      );
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(ownerId, new Set(assetIds), undefined);
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('only lets an administrator name a destination', async () => {
      await expect(
        sut.createPlan(authStub.user1, {
          assetIds: [newUuid()],
          stages: [EnrichmentStage.Description],
          destinationId,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses a destination that does not allow the workload instead of choosing another', async () => {
      const assetIds = [newUuid()];
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.lan);

      await expect(
        sut.createPlan(authStub.admin, {
          assetIds,
          stages: [EnrichmentStage.Description],
          destinationId: mlDestinationStub.lan.id,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('answers a submit that lost the race for its request key with the plan that won', async () => {
      const assetIds = [newUuid()];
      const winner = operationOf(snapshotOf({ assetIds }));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      vi.mocked(operations.create).mockRejectedValue(new Error('duplicate key value violates unique constraint'));
      vi.mocked(operations.getByRequestKey).mockResolvedValueOnce(undefined).mockResolvedValueOnce(winner);

      const plan = await sut.createPlan(authStub.user1, {
        assetIds,
        stages: [EnrichmentStage.Description],
        requestKey: newUuid(),
      });

      expect(plan.operation.id).toBe(winner.id);
    });

    it('answers a repeated submit with the first plan', async () => {
      const existing = operationOf(snapshotOf());
      vi.mocked(operations.getByRequestKey).mockResolvedValue(existing);

      await sut.createPlan(authStub.user1, {
        assetIds: [newUuid()],
        stages: [EnrichmentStage.Description],
        requestKey: newUuid(),
      });

      expect(operations.create).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    it("never previews media that is not the caller's own, such as a partner's", async () => {
      const assetIds = [newUuid()];
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set(assetIds));

      await expect(sut.preview(authStub.admin, { assetIds })).rejects.toThrow(BadRequestException);
      expect(enrichment.previewDescription).not.toHaveBeenCalled();
    });

    it('runs each sample through the draft on the named destination and writes nothing', async () => {
      const assetIds = [newUuid(), newUuid()];
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.local);
      enrichment.previewDescription.mockResolvedValue({
        status: 'success',
        current: 'A lake.',
        candidate: 'A turquoise alpine lake.',
        tags: [],
        warnings: [],
        modelName: 'draft',
        destinationId,
        frameCount: 0,
        durationMs: 12,
      });

      const response = await sut.preview(authStub.admin, { assetIds, destinationId, modelName: 'draft' });

      expect(enrichment.previewDescription).toHaveBeenCalledTimes(2);
      expect(enrichment.previewDescription).toHaveBeenCalledWith(assetIds[0], {
        imageDescription: expect.objectContaining({ modelName: 'draft' }),
        destinationId,
      });
      expect(response.samples.map(({ candidate }) => candidate)).toEqual([
        'A turquoise alpine lake.',
        'A turquoise alpine lake.',
      ]);
      expect(enrichment.describeAsset).not.toHaveBeenCalled();
      expect(operations.create).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    it('runs every stage of every asset on the pinned destinations and records each outcome', async () => {
      const [photo, video] = [newUuid(), newUuid()];
      const snapshot = snapshotOf({
        assetIds: [photo, video],
        stages: [
          EnrichmentStage.Frames,
          EnrichmentStage.LockedCheck,
          EnrichmentStage.Description,
          EnrichmentStage.MomentIndex,
        ],
      });
      momentRepository.getAssetKinds.mockImplementation(([id]: string[]) =>
        Promise.resolve(kindsOf([[id, id === video ? AssetType.Video : AssetType.Image]])),
      );
      mocks.access.asset.checkOwnerAccess.mockImplementation((_userId, ids) => Promise.resolve(new Set(ids)));

      await sut.run(operationOf(snapshot), 'token');

      expect(enrichment.describeAsset).toHaveBeenCalledWith(
        photo,
        expect.objectContaining({ enrichmentDestinationId: destinationId, configHash: 'hash' }),
      );
      expect(moments.runFramesStage).toHaveBeenCalledTimes(1);
      expect(moments.runFramesStage).toHaveBeenCalledWith(video);
      expect(enrichment.detectLockedContent).toHaveBeenCalledTimes(1);
      expect(moments.runIndexStage).toHaveBeenCalledWith(video, expect.objectContaining({ destinationId }));

      const last = vi.mocked(operations.setBulkResult).mock.calls.at(-1)![2];
      const result = parseEnrichmentPlanResult(last.result);
      const photoItem = result.items.find(({ id }) => id === photo)!;
      expect(photoItem.stages[EnrichmentStage.Frames]).toMatchObject({
        state: EnrichmentItemState.Skipped,
        reasonKey: 'not-a-video',
      });
      const videoItem = result.items.find(({ id }) => id === video)!;
      expect(videoItem.stages[EnrichmentStage.LockedCheck]).toMatchObject({
        state: EnrichmentItemState.Skipped,
        reasonKey: 'not-an-image',
      });
      expect(operations.complete).toHaveBeenCalled();
    });

    it('skips the stages that need a failed stage and retries the failures once, later', async () => {
      const video = newUuid();
      const snapshot = snapshotOf({
        assetIds: [video],
        stages: [EnrichmentStage.Frames, EnrichmentStage.MomentIndex],
      });
      momentRepository.getAssetKinds.mockResolvedValue(kindsOf([[video, AssetType.Video]]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([video]));
      moments.runFramesStage.mockResolvedValue({ state: EnrichmentItemState.Failed, reasonKey: 'no-frames' });

      await sut.run(operationOf(snapshot), 'token');

      expect(moments.runIndexStage).not.toHaveBeenCalled();
      expect(operations.requeue).toHaveBeenCalledWith(expect.any(String), 'token', {
        delayMs: MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
        returnAttempt: true,
      });
      expect(operations.complete).not.toHaveBeenCalled();
      const last = parseEnrichmentPlanResult(vi.mocked(operations.setBulkResult).mock.calls.at(-1)![2].result);
      expect(last.retry).toEqual({ ids: [video], processed: 0 });
      expect(last.items[0].stages[EnrichmentStage.MomentIndex]).toMatchObject({ reasonKey: 'dependency-failed' });
    });

    it('reruns only the failed stages on the retry pass', async () => {
      const video = newUuid();
      const snapshot = snapshotOf({ assetIds: [video], stages: [EnrichmentStage.Frames, EnrichmentStage.MomentIndex] });
      momentRepository.getAssetKinds.mockResolvedValue(kindsOf([[video, AssetType.Video]]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([video]));
      const result = {
        ...emptyEnrichmentPlanResult(),
        items: [
          {
            id: video,
            stages: {
              [EnrichmentStage.Frames]: { state: EnrichmentItemState.Completed },
              [EnrichmentStage.MomentIndex]: { state: EnrichmentItemState.Failed, reasonKey: 'model-error' },
            },
          },
        ],
        retry: { ids: [video], processed: 0 },
      };

      await sut.run(operationOf(snapshot, { result: result as never, processedUnits: 1 }), 'token');

      expect(moments.runFramesStage).not.toHaveBeenCalled();
      expect(moments.runIndexStage).toHaveBeenCalledTimes(1);
      expect(operations.complete).toHaveBeenCalled();
    });

    it('stops at the next asset when the owner cancels', async () => {
      const snapshot = snapshotOf();
      momentRepository.getAssetKinds.mockResolvedValue(kindsOf(snapshot.assetIds.map((id) => [id, AssetType.Image])));
      mocks.access.asset.checkOwnerAccess.mockImplementation((_userId, ids) => Promise.resolve(new Set(ids)));
      vi.mocked(operations.setBulkResult)
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(running)
        .mockResolvedValue({ ...running, status: MediaOperationStatus.Cancelling, cancelRequestedAt: new Date() });

      await sut.run(operationOf(snapshot), 'token');

      expect(enrichment.describeAsset).toHaveBeenCalledTimes(1);
      expect(operations.acknowledgeCancel).toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('marks every stage call as a plan run so nothing is sent to an unpinned destination', async () => {
      const snapshot = snapshotOf({ assetIds: [newUuid()], destinations: { enrichment: destinationId, search: null } });
      momentRepository.getAssetKinds.mockResolvedValue(kindsOf([[snapshot.assetIds[0], AssetType.Image]]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));

      await sut.run(operationOf(snapshot), 'token');

      expect(enrichment.describeAsset).toHaveBeenCalledWith(
        snapshot.assetIds[0],
        expect.objectContaining({ planRun: true, searchDestinationId: null }),
      );
    });

    it('stops working on an asset as soon as the claim is lost', async () => {
      const video = newUuid();
      const snapshot = snapshotOf({ assetIds: [video], stages: [EnrichmentStage.Frames, EnrichmentStage.MomentIndex] });
      momentRepository.getAssetKinds.mockResolvedValue(kindsOf([[video, AssetType.Video]]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([video]));
      vi.mocked(operations.heartbeat).mockResolvedValue(false);
      vi.mocked(operations.setBulkResult)
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(running)
        .mockResolvedValue(undefined);

      await sut.run(operationOf(snapshot), 'token');

      expect(moments.runFramesStage).toHaveBeenCalled();
      expect(moments.runIndexStage).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('skips an asset the owner can no longer change', async () => {
      const snapshot = snapshotOf({ assetIds: [newUuid()] });
      momentRepository.getAssetKinds.mockResolvedValue(kindsOf([[snapshot.assetIds[0], AssetType.Image]]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await sut.run(operationOf(snapshot), 'token');

      expect(enrichment.describeAsset).not.toHaveBeenCalled();
      const last = parseEnrichmentPlanResult(vi.mocked(operations.setBulkResult).mock.calls.at(-1)![2].result);
      expect(last.items[0].stages[EnrichmentStage.Description]).toMatchObject({ reasonKey: 'no-access' });
    });

    it('checks access as the owner through an elevated system session, so Locked assets are processed', async () => {
      const snapshot = snapshotOf({ assetIds: [newUuid()] });
      momentRepository.getAssetKinds.mockResolvedValue(kindsOf([[snapshot.assetIds[0], AssetType.Image]]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));

      await sut.run(operationOf(snapshot), 'token');

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(ownerId, new Set(snapshot.assetIds), true);
      expect(enrichment.describeAsset).toHaveBeenCalled();
    });
  });

  describe('getPlan', () => {
    it('leaves Locked assets out for a session that has not unlocked, and counts them', async () => {
      const snapshot = snapshotOf();
      vi.mocked(operations.getForOwner).mockResolvedValue(
        operationOf(snapshot, { status: MediaOperationStatus.Queued }),
      );
      vi.mocked(operations.getLockedAssetIds).mockResolvedValue(new Set([snapshot.assetIds[0]]));

      const plan = await sut.getPlan(authStub.user1, 'id');

      expect(plan.items.map(({ assetId }) => assetId)).toEqual([snapshot.assetIds[1]]);
      expect(plan.hiddenCount).toBe(1);
      expect(plan.counts.total).toBe(2);
    });
  });

  describe('getOptions', () => {
    it('lists destinations by name with their admission, and never offers captions by default', async () => {
      const options = await sut.getOptions();

      expect(options.destinations[0]).toEqual(
        expect.objectContaining({ id: destinationId, name: mlDestinationStub.local.name, cloud: false }),
      );
      expect(options.destinations[0]).not.toHaveProperty('url');
      expect(options.defaultStages).not.toContain(EnrichmentStage.MomentCaptions);
      expect(MlWorkload.Enrichment).toBe('enrichment');
    });

    it('judges Frameleaf Cloud with the chosen model where the catalogue marks no default (FL-186)', async () => {
      const facts = mlDestinationStub.frameleafCloudConsented.lastProbeCloud!;
      const cloud = { ...mlDestinationStub.frameleafCloudConsented, lastProbeCloud: { ...facts, defaultModels: {} } };
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, cloud]);

      const unchosen = await sut.getOptions();
      expect(unchosen.destinations.find(({ id }) => id === cloud.id)?.enrichment).toEqual({
        admitted: false,
        refusal: MlAdmissionRefusal.ModelMismatch,
      });

      mocks.mlDestination.getCloudModelChoices.mockResolvedValue([
        { modelGroup: 'descriptions', modelId: 'describe-large', updatedAt: new Date() },
      ]);
      const chosen = await sut.getOptions();
      expect(chosen.destinations.find(({ id }) => id === cloud.id)?.enrichment).toEqual({
        admitted: true,
        refusal: null,
      });
    });
  });
});

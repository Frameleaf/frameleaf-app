import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DatabaseLock, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { PhysicalDeduplicationPlanService } from 'src/services/physical-deduplication-plan.service.js';
import {
  PhysicalDeduplicationService,
  PreparedPhysicalDeduplicationPlan,
} from 'src/services/physical-deduplication.service.js';
import { MEDIA_OPERATION_AUTO_RETRY_DELAY_MS } from 'src/utils/media-operation.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getMocks } from 'test/utils.js';

const hex = 'aa'.repeat(20);
const fingerprint = 'ab'.repeat(32);
const reviewToken = 'cd'.repeat(32);

const item = (assetId: string) => ({
  assetId,
  ownerId: 'jamie',
  originalPath: `/upload/jamie/${assetId}.jpg`,
  checksum: hex,
  sizeInBytes: 10,
  retainedAssetId: 'master-1',
  retainedPath: '/upload/taylor/master-1.jpg',
  retainedChecksum: hex,
});

const prepared: PreparedPhysicalDeduplicationPlan = {
  planId: 'PD-ABABABAB',
  fingerprint,
  reviewToken,
  confirmation: 'APPLY PD-ABABABAB',
  masterUserId: 'master-user',
  scopeUserId: null,
  ranAt: '2026-09-23T10:00:00.000Z',
  excludedRetainedAssetIds: [],
  items: [item('copy-1'), item('copy-2')],
  retained: [
    {
      assetId: 'master-1',
      originalPath: '/upload/taylor/master-1.jpg',
      checksum: hex,
      sizeInBytes: 10,
      referencesBefore: 1,
    },
  ],
  estimatedBytes: 20,
  hiddenCopies: 1,
};

const snapshot = {
  version: 1,
  planId: prepared.planId,
  fingerprint,
  reviewToken,
  ranAt: prepared.ranAt,
  masterUserId: 'master-user',
  scopeUserId: null,
  excludedRetainedAssetIds: [],
  items: prepared.items,
  retained: prepared.retained,
  estimatedBytes: 20,
};

const operationOf = (overrides: Partial<MediaOperation> = {}): MediaOperation =>
  ({
    id: 'operation-1',
    ownerId: authStub.admin.user.id,
    kind: MediaOperationKind.PhysicalDeduplication,
    status: MediaOperationStatus.Preparing,
    snapshot,
    result: null,
    processedUnits: '0',
    totalUnits: '2',
    progress: 0,
    autoRetries: 0,
    retryAt: null,
    pauseRequestedAt: null,
    error: null,
    createdAt: new Date('2026-09-23T10:00:00.000Z'),
    finishedAt: null,
    ...overrides,
  }) as unknown as MediaOperation;

const applied = { state: 'applied' as const, reasonKey: null, message: null, reclaimedBytes: 10 };

describe(PhysicalDeduplicationPlanService.name, () => {
  let sut: PhysicalDeduplicationPlanService;
  let operations: Record<string, ReturnType<typeof vi.fn>>;
  let users: Record<string, ReturnType<typeof vi.fn>>;
  let deduplication: Record<string, ReturnType<typeof vi.fn>>;

  const running = { status: MediaOperationStatus.Rendering, cancelRequestedAt: null, pauseRequestedAt: null };
  const dto = { fingerprint, reviewToken, confirmation: 'APPLY PD-ABABABAB' };

  beforeEach(() => {
    const mocks = getMocks();
    operations = {
      createExclusive: vi
        .fn()
        .mockImplementation((values) => Promise.resolve({ created: operationOf({ ...values, id: 'created-1' }) })),
      getActiveOfKind: vi.fn().mockResolvedValue(undefined),
      getForOwner: vi.fn(),
      getOfKind: vi.fn(),
      listRecentOfKind: vi.fn().mockResolvedValue([]),
      claimNext: vi.fn().mockResolvedValue(undefined),
      heartbeat: vi.fn().mockResolvedValue(true),
      reportProgress: vi.fn().mockResolvedValue(true),
      setBulkResult: vi.fn().mockResolvedValue(running),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('retrying'),
      requeue: vi.fn().mockResolvedValue(true),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      settlePause: vi.fn().mockResolvedValue(true),
    };
    users = {
      get: vi.fn().mockResolvedValue({ id: authStub.admin.user.id, isAdmin: true }),
      getList: vi.fn().mockResolvedValue([{ id: authStub.admin.user.id, name: 'Taylor' }]),
    };
    deduplication = {
      getPreview: vi.fn().mockResolvedValue({
        plan: null,
        savedMasterUserId: 'master-user',
        enabled: true,
        running: false,
        applying: false,
        applies: [],
      }),
      preparePlan: vi.fn().mockResolvedValue(prepared),
      requireApplyAllowed: vi.fn().mockResolvedValue(undefined),
      canApplyPlans: vi.fn().mockResolvedValue(true),
      applyPlanItem: vi.fn().mockResolvedValue(applied),
      recordPlanApplied: vi.fn().mockResolvedValue(undefined),
      verifyAppliedCopies: vi.fn().mockResolvedValue({ copies: 1, items: [] }),
      restoreAppliedCopy: vi.fn().mockResolvedValue(undefined),
    };
    sut = new PhysicalDeduplicationPlanService(
      mocks.logger as never,
      operations as unknown as MediaOperationRepository,
      users as unknown as UserRepository,
      deduplication as unknown as PhysicalDeduplicationService,
    );
  });

  describe('review', () => {
    it('binds these decisions to this plan and counts hidden copies without naming them', async () => {
      const review = await sut.review(authStub.admin, { fingerprint });

      expect(deduplication.preparePlan).toHaveBeenCalledWith(authStub.admin, { fingerprint });
      expect(review).toEqual(
        expect.objectContaining({
          planId: 'PD-ABABABAB',
          reviewToken,
          confirmation: 'APPLY PD-ABABABAB',
          copies: 2,
          retainedOriginals: 1,
          estimatedBytes: 20,
          hiddenCopies: 1,
        }),
      );
      expect(review).not.toHaveProperty('items');
    });

    it('passes a 409 from the evidence check through', async () => {
      deduplication.preparePlan.mockRejectedValue(new ConflictException('File or reference evidence changed.'));

      await expect(sut.review(authStub.admin, { fingerprint })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('apply', () => {
    it('queues exactly the reviewed copies as a durable job', async () => {
      const queued = await sut.apply(authStub.admin, dto);

      expect(deduplication.requireApplyAllowed).toHaveBeenCalledWith(prepared);
      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: authStub.admin.user.id,
          kind: MediaOperationKind.PhysicalDeduplication,
          label: 'PD-ABABABAB',
          settings: { planId: 'PD-ABABABAB', copies: 2 },
          assetId: null,
          snapshot: expect.objectContaining({
            version: 1,
            planId: 'PD-ABABABAB',
            fingerprint,
            reviewToken,
            items: prepared.items,
            retained: prepared.retained,
          }),
          totalUnits: '2',
        }),
        DatabaseLock.PhysicalDeduplicationApply,
      );
      expect(queued.id).toBe('created-1');
    });

    it('refuses with 409 when another administrator started a plan in the same moment', async () => {
      operations.createExclusive.mockResolvedValue({
        active: { id: 'other', ownerId: 'someone-else', fingerprint: 'ff'.repeat(32) },
      });

      await expect(sut.apply(authStub.admin, dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses with 409 when the decisions differ from the reviewed ones', async () => {
      await expect(sut.apply(authStub.admin, { ...dto, reviewToken: 'ee'.repeat(32) })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('refuses a confirmation that does not name this plan', async () => {
      await expect(sut.apply(authStub.admin, { ...dto, confirmation: 'APPLY PD-00000000' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('refuses with 409 when anything changed since the review', async () => {
      deduplication.preparePlan.mockRejectedValue(new ConflictException('File or reference evidence changed.'));

      await expect(sut.apply(authStub.admin, dto)).rejects.toBeInstanceOf(ConflictException);
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('refuses when the retained account or feature settings do not allow it', async () => {
      deduplication.requireApplyAllowed.mockRejectedValue(new BadRequestException('Enable file reuse'));

      await expect(sut.apply(authStub.admin, dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('refuses with 409 while another plan is being applied', async () => {
      operations.getActiveOfKind.mockResolvedValue({ id: 'other', fingerprint: 'ff'.repeat(32) });

      await expect(sut.apply(authStub.admin, dto)).rejects.toBeInstanceOf(ConflictException);
      expect(deduplication.preparePlan).not.toHaveBeenCalled();
    });

    it('answers a repeated submit of the plan being applied with the running job', async () => {
      operations.getActiveOfKind.mockResolvedValue({ id: 'operation-1', fingerprint });
      operations.getForOwner.mockResolvedValue(operationOf({ status: MediaOperationStatus.Rendering }));

      const answer = await sut.apply(authStub.admin, dto);

      expect(answer.id).toBe('operation-1');
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it("refuses another administrator's repeat of a plan already being applied", async () => {
      operations.getActiveOfKind.mockResolvedValue({ id: 'operation-1', fingerprint });
      operations.getForOwner.mockResolvedValue(undefined);

      await expect(sut.apply(authStub.admin, dto)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getPreview', () => {
    it('lists applied plans with counts and names only', async () => {
      operations.listRecentOfKind.mockResolvedValue([
        operationOf({
          status: MediaOperationStatus.Completed,
          processedUnits: 2,
          snapshot: { planId: 'PD-ABABABAB', fingerprint, estimatedBytes: 20 },
          result: { summary: { applied: 1, alreadyApplied: 0, skipped: 1, failed: 0, reclaimedBytes: 10 } },
          finishedAt: new Date('2026-09-23T10:05:00.000Z'),
        }),
      ]);
      operations.getActiveOfKind.mockResolvedValue(undefined);

      const preview = await sut.getPreview(authStub.admin);

      expect(operations.listRecentOfKind).toHaveBeenCalledWith(MediaOperationKind.PhysicalDeduplication, 10);
      expect(preview.applying).toBe(false);
      expect(preview.applies).toEqual([
        expect.objectContaining({
          operationId: 'operation-1',
          planId: 'PD-ABABABAB',
          status: MediaOperationStatus.Completed,
          requestedByName: 'Taylor',
          mine: true,
          total: 2,
          processed: 2,
          applied: 1,
          skipped: 1,
          reclaimedBytes: 10,
          estimatedBytes: 20,
          finishedAt: '2026-09-23T10:05:00.000Z',
        }),
      ]);
    });

    it('reports a plan being applied by anyone', async () => {
      operations.getActiveOfKind.mockResolvedValue({ id: 'other', fingerprint });

      await expect(sut.getPreview(authStub.admin)).resolves.toEqual(expect.objectContaining({ applying: true }));
    });
  });

  describe('run', () => {
    it('applies every reviewed copy in order, records each, and completes', async () => {
      await sut.run(operationOf(), 'token');

      expect(deduplication.applyPlanItem).toHaveBeenCalledTimes(2);
      expect(deduplication.applyPlanItem).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ planId: 'PD-ABABABAB' }),
        prepared.items[0],
        expect.any(Map),
      );
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        'operation-1',
        'token',
        expect.objectContaining({
          processedUnits: 2,
          totalUnits: 2,
          progress: 100,
          result: expect.objectContaining({
            summary: { applied: 2, alreadyApplied: 0, skipped: 0, failed: 0, reclaimedBytes: 20 },
          }),
        }),
      );
      expect(operations.complete).toHaveBeenCalledWith('operation-1', 'token', { resultAssetId: null });
      // The stored plan reads as applied from the first copy that changed, and gets the final counts.
      expect(deduplication.recordPlanApplied).toHaveBeenCalledWith(fingerprint, { linkedAssets: 1, deletedBytes: 10 });
      expect(deduplication.recordPlanApplied).toHaveBeenLastCalledWith(fingerprint, {
        linkedAssets: 2,
        deletedBytes: 20,
      });
    });

    it('checks the feature and the saved retained account on every claim', async () => {
      deduplication.requireApplyAllowed.mockRejectedValue(new ConflictException('The retained account changed.'));

      await sut.run(operationOf(), 'token');

      expect(deduplication.requireApplyAllowed).toHaveBeenCalledWith({ masterUserId: 'master-user' });
      expect(deduplication.applyPlanItem).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalled();
    });

    it('does not mark the plan applied when no copy changed', async () => {
      deduplication.applyPlanItem.mockResolvedValue({
        state: 'skipped',
        reasonKey: 'copy-changed',
        message: null,
        reclaimedBytes: 0,
      });

      await sut.run(operationOf(), 'token');

      expect(deduplication.recordPlanApplied).not.toHaveBeenCalled();
    });

    it('resumes from the cursor after a restart, without applying a finished copy again', async () => {
      const resumed = operationOf({
        processedUnits: '1',
        result: {
          items: [{ id: 'copy-1', state: 'applied', reasonKey: null, message: null, reclaimedBytes: 10, at: 'x' }],
        },
      } as never);

      await sut.run(resumed, 'token');

      expect(deduplication.applyPlanItem).toHaveBeenCalledTimes(1);
      expect(deduplication.applyPlanItem).toHaveBeenCalledWith(expect.anything(), prepared.items[1], expect.any(Map));
      expect(operations.complete).toHaveBeenCalled();
    });

    it('records a failed copy and hands the job back for one retry pass of that copy', async () => {
      deduplication.applyPlanItem.mockRejectedValueOnce(new Error('disk hiccup')).mockResolvedValue(applied);

      await sut.run(operationOf(), 'token');

      expect(operations.requeue).toHaveBeenCalledWith('operation-1', 'token', {
        delayMs: MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
        returnAttempt: true,
      });
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        'operation-1',
        'token',
        expect.objectContaining({
          result: expect.objectContaining({
            retry: { ids: ['copy-1'], processed: 0 },
            summary: expect.objectContaining({ applied: 1, failed: 1 }),
          }),
        }),
      );
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('runs the retry pass on the next claim and then completes', async () => {
      const retrying = operationOf({
        processedUnits: '2',
        result: {
          items: [
            { id: 'copy-2', state: 'applied', reasonKey: null, message: null, reclaimedBytes: 10, at: 'x' },
            { id: 'copy-1', state: 'failed', reasonKey: 'error', message: 'disk hiccup', reclaimedBytes: 0, at: 'x' },
          ],
          retry: { ids: ['copy-1'], processed: 0 },
        },
      } as never);

      await sut.run(retrying, 'token');

      expect(deduplication.applyPlanItem).toHaveBeenCalledTimes(1);
      expect(deduplication.applyPlanItem).toHaveBeenCalledWith(expect.anything(), prepared.items[0], expect.any(Map));
      expect(operations.requeue).not.toHaveBeenCalled();
      expect(operations.complete).toHaveBeenCalled();
    });

    it('does not retry a copy whose evidence changed', async () => {
      deduplication.applyPlanItem.mockResolvedValue({
        state: 'skipped',
        reasonKey: 'copy-changed',
        message: null,
        reclaimedBytes: 0,
      });

      await sut.run(operationOf(), 'token');

      expect(operations.requeue).not.toHaveBeenCalled();
      expect(operations.complete).toHaveBeenCalled();
    });

    it('stops at a copy boundary when paused', async () => {
      operations.setBulkResult
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce({ ...running, pauseRequestedAt: new Date() });

      await sut.run(operationOf(), 'token');

      expect(deduplication.applyPlanItem).toHaveBeenCalledTimes(1);
      expect(operations.settlePause).toHaveBeenCalledWith('operation-1', 'token');
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('stops and settles a cancel at a copy boundary', async () => {
      operations.setBulkResult
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce({ ...running, status: MediaOperationStatus.Cancelling, cancelRequestedAt: new Date() });

      await sut.run(operationOf(), 'token');

      expect(deduplication.applyPlanItem).toHaveBeenCalledTimes(1);
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith('operation-1', 'token', { released: false });
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('fails, with its automatic retry, when the administrator lost administrator access', async () => {
      users.get.mockResolvedValue({ id: authStub.admin.user.id, isAdmin: false });

      await sut.run(operationOf(), 'token');

      expect(deduplication.applyPlanItem).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        'operation-1',
        'token',
        expect.objectContaining({ errorCode: 'physical_deduplication_failed' }),
      );
    });

    it('fails without touching a file when the frozen plan cannot be read', async () => {
      await sut.run(operationOf({ snapshot: { version: 1 } } as never), 'token');

      expect(deduplication.applyPlanItem).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        'operation-1',
        'token',
        expect.objectContaining({ errorCode: 'physical_deduplication_snapshot_invalid' }),
      );
    });

    it('fails outside an active storage handoff', async () => {
      deduplication.canApplyPlans.mockResolvedValue(false);

      await sut.run(operationOf(), 'token');

      expect(deduplication.applyPlanItem).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalled();
    });
  });

  describe('verify and restore (FL-73)', () => {
    const outcome = (id: string, state: string) => ({
      id,
      state,
      reasonKey: null,
      message: null,
      reclaimedBytes: 0,
      at: '',
    });

    it('verifies only the copies an interrupted (cancelled) apply actually changed', async () => {
      operations.getOfKind.mockResolvedValue(
        operationOf({
          status: MediaOperationStatus.Cancelled,
          result: { version: 1, items: [outcome('copy-1', 'applied')], inFlight: null, retry: null },
        } as never),
      );

      const report = await sut.verify(authStub.admin, 'operation-1');

      expect(operations.getOfKind).toHaveBeenCalledWith('operation-1', MediaOperationKind.PhysicalDeduplication);
      expect(deduplication.verifyAppliedCopies).toHaveBeenCalledWith(
        authStub.admin,
        expect.objectContaining({ planId: prepared.planId }),
        ['copy-1'],
      );
      expect(report).toEqual(
        expect.objectContaining({ operationId: 'operation-1', planId: prepared.planId, copies: 1 }),
      );
    });

    it('counts already-applied copies from a resumed attempt, never skipped or failed ones', async () => {
      operations.getOfKind.mockResolvedValue(
        operationOf({
          status: MediaOperationStatus.Completed,
          result: {
            version: 1,
            items: [outcome('copy-1', 'already-applied'), outcome('copy-2', 'skipped'), outcome('copy-3', 'failed')],
          },
        } as never),
      );

      await sut.verify(authStub.admin, 'operation-1');

      expect(deduplication.verifyAppliedCopies).toHaveBeenCalledWith(authStub.admin, expect.anything(), ['copy-1']);
    });

    it('refuses to verify a plan still being applied', async () => {
      operations.getOfKind.mockResolvedValue(operationOf({ status: MediaOperationStatus.Rendering }));

      await expect(sut.verify(authStub.admin, 'operation-1')).rejects.toBeInstanceOf(ConflictException);
      expect(deduplication.verifyAppliedCopies).not.toHaveBeenCalled();
    });

    it('answers 404 for an id that is not an applied plan', async () => {
      operations.getOfKind.mockResolvedValue(undefined);

      await expect(sut.verify(authStub.admin, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('restores one copy and answers with the plan verified again', async () => {
      operations.getOfKind.mockResolvedValue(
        operationOf({
          status: MediaOperationStatus.Completed,
          result: { version: 1, items: [outcome('copy-1', 'applied')] },
        } as never),
      );

      const report = await sut.restore(authStub.admin, 'operation-1', { assetId: 'copy-1' });

      expect(deduplication.restoreAppliedCopy).toHaveBeenCalledWith(
        authStub.admin,
        expect.objectContaining({ planId: prepared.planId }),
        ['copy-1'],
        'copy-1',
      );
      expect(deduplication.verifyAppliedCopies).toHaveBeenCalledAfter(deduplication.restoreAppliedCopy);
      expect(report.operationId).toBe('operation-1');
    });
  });
});

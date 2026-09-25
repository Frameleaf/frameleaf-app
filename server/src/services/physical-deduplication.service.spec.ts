import { BadRequestException, ConflictException } from '@nestjs/common';
import { Readable } from 'node:stream';
import {
  AssetStatus,
  DatabaseLock,
  JobName,
  JobStatus,
  PhysicalDeduplicationDecision,
  PhysicalDeduplicationSkipReason,
  SystemMetadataKey,
} from 'src/enum.js';
import { PhysicalDeduplicationService } from 'src/services/physical-deduplication.service.js';
import {
  physicalDeduplicationFingerprint,
  physicalDeduplicationPlanId,
  physicalDeduplicationReviewToken,
} from 'src/utils/physical-deduplication-plan.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

type Handler = 'handleDryRun' | 'handleApply';

const MASTER_ID = '00000000-0000-4000-8000-00000000000a';
const COPY_1 = '00000000-0000-4000-8000-00000000000b';
const COPY_2 = '00000000-0000-4000-8000-00000000000c';

const forkSchemaActive = { active: true, phase: 'active' as const, schemaVersion: '1', upstreamVersion: '3.0.3' };

const lastDryRun = {
  mode: 'dry-run' as const,
  masterUserId: 'master-user',
  ranAt: new Date().toISOString(),
  eligibleAssets: 0,
  linkedAssets: 0,
  skippedExternal: 0,
  skippedMissingMaster: 0,
  reclaimableBytes: 0,
  deletedBytes: 0,
  samples: [],
};

const checksum = Buffer.from('aa'.repeat(20), 'hex');

const candidate = (overrides: Record<string, unknown> = {}) => ({
  id: 'copy-1',
  ownerId: 'jamie',
  originalPath: '/upload/library/jamie/copy-1.jpg',
  originalFileName: 'Moraine Lake.jpg',
  type: 'IMAGE',
  checksum,
  isExternal: false,
  isOffline: false,
  libraryId: null,
  physicalOriginalFileId: null,
  sizeInBytes: 14_850_240,
  ...overrides,
});

const master = (overrides: Record<string, unknown> = {}) => ({
  id: 'master-1',
  originalPath: '/upload/library/taylor/master-1.jpg',
  originalFileName: 'Moraine Lake.jpg',
  type: 'IMAGE',
  physicalOriginalFileId: 'pf-1',
  checksum,
  sizeInBytes: 14_850_240,
  ...overrides,
});

const stream = (...items: unknown[]) => Readable.from(items);

const mockConfig = (
  mocks: ServiceMocks,
  physicalDeduplication: { enabled: boolean; masterUserId: string | null },
  lastRun: unknown = lastDryRun,
) => {
  mocks.systemMetadata.get.mockImplementation((key) =>
    Promise.resolve(
      (key === SystemMetadataKey.PhysicalDeduplicationMigration ? lastRun : { physicalDeduplication }) as never,
    ),
  );
};

const activeUser = (id: string) => ({ id, name: id, deletedAt: null });

describe(PhysicalDeduplicationService.name, () => {
  const blockedCases: Array<[Handler, 'inactive' | 'failed']> = [
    ['handleDryRun', 'inactive'],
    ['handleDryRun', 'failed'],
    ['handleApply', 'inactive'],
    ['handleApply', 'failed'],
  ];

  it.each(blockedCases)('%s refuses to create physical mappings in the %s phase', async (handler, phase) => {
    const { sut, mocks } = newTestService(PhysicalDeduplicationService);
    mocks.forkSchema.getState.mockResolvedValue({
      active: false,
      phase,
      schemaVersion: '1',
      upstreamVersion: '3.0.3',
    });

    await expect(sut[handler]({})).resolves.toBe(JobStatus.Skipped);

    expect(mocks.physicalFile.getMigrationCandidates).not.toHaveBeenCalled();
  });

  const allowedCases: Array<[Handler, 'legacy' | 'dual-write' | 'ready' | 'active']> = [
    ['handleDryRun', 'legacy'],
    ['handleDryRun', 'dual-write'],
    ['handleDryRun', 'ready'],
    ['handleDryRun', 'active'],
  ];

  it.each(allowedCases)('%s runs deduplication in the %s phase when enabled', async (handler, phase) => {
    const { sut, mocks } = newTestService(PhysicalDeduplicationService);
    mocks.forkSchema.getState.mockResolvedValue({
      active: phase === 'active',
      phase,
      schemaVersion: '1',
      upstreamVersion: '3.0.3',
    });
    mockConfig(mocks, { enabled: true, masterUserId: 'master-user' });
    mocks.user.get.mockResolvedValue(activeUser('master-user') as never);
    mocks.database.withLock.mockImplementation((_lock, callback) => callback());
    mocks.physicalFile.getMigrationCandidates.mockReturnValue(stream() as never);

    await expect(sut[handler]({})).resolves.toBe(JobStatus.Success);

    expect(mocks.physicalFile.getMigrationCandidates).toHaveBeenCalledWith('master-user');
  });

  describe('handleDryRun', () => {
    const setup = () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mocks.forkSchema.getState.mockResolvedValue(forkSchemaActive);
      mocks.database.withLock.mockImplementation((_lock, callback) => callback());
      mocks.user.get.mockImplementation((id) => Promise.resolve(activeUser(id) as never));
      mocks.physicalFile.getGeneratedFiles.mockResolvedValue([]);
      return { sut, mocks };
    };

    it('previews against the account chosen on the page even while the feature is disabled', async () => {
      const { sut, mocks } = setup();
      mockConfig(mocks, { enabled: false, masterUserId: null }, null);
      mocks.physicalFile.getMigrationCandidates.mockReturnValue(stream() as never);

      await expect(sut.handleDryRun({ masterUserId: 'chosen-user' })).resolves.toBe(JobStatus.Success);

      expect(mocks.physicalFile.getMigrationCandidates).toHaveBeenCalledWith('chosen-user');
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(
        SystemMetadataKey.PhysicalDeduplicationMigration,
        expect.objectContaining({ mode: 'dry-run', masterUserId: 'chosen-user', scopeUserId: null }),
      );
    });

    it('is skipped when no retained account is chosen or saved', async () => {
      const { sut, mocks } = setup();
      mockConfig(mocks, { enabled: false, masterUserId: null }, null);

      await expect(sut.handleDryRun({})).resolves.toBe(JobStatus.Skipped);

      expect(mocks.physicalFile.getMigrationCandidates).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('is skipped when the retained account does not exist', async () => {
      const { sut, mocks } = setup();
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' });
      mocks.user.get.mockResolvedValue(undefined as never);

      await expect(sut.handleDryRun({})).resolves.toBe(JobStatus.Skipped);

      expect(mocks.physicalFile.getMigrationCandidates).not.toHaveBeenCalled();
    });

    it('records share decisions with checksum evidence and reference counts before and after', async () => {
      const { sut, mocks } = setup();
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' });
      mocks.physicalFile.getMigrationCandidates.mockReturnValue(
        stream(candidate(), candidate({ id: 'copy-2', ownerId: 'emma' })) as never,
      );
      mocks.physicalFile.getMasterOriginalCandidate.mockResolvedValue(master() as never);
      mocks.physicalFile.countOriginalReferences.mockResolvedValue(1);

      await expect(sut.handleDryRun({})).resolves.toBe(JobStatus.Success);

      const [, summary] = mocks.systemMetadata.set.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(summary).toEqual(
        expect.objectContaining({
          eligibleAssets: 2,
          reclaimableBytes: 14_850_240 * 2,
          copiesTruncated: false,
          retained: [
            expect.objectContaining({
              assetId: 'master-1',
              ownerId: 'master-user',
              checksum: 'aa'.repeat(20),
              referencesBefore: 1,
              referencesAfter: 3,
            }),
          ],
        }),
      );
      expect(summary.copies).toEqual([
        expect.objectContaining({
          assetId: 'copy-1',
          ownerId: 'jamie',
          retainedAssetId: 'master-1',
          checksumMatch: true,
          decision: PhysicalDeduplicationDecision.Share,
          reason: null,
        }),
        expect.objectContaining({ assetId: 'copy-2', decision: PhysicalDeduplicationDecision.Share }),
      ]);
      expect(mocks.physicalFile.countOriginalReferences).toHaveBeenCalledWith('pf-1');
      // A preview never touches files.
      expect(mocks.physicalFile.linkAssetToOriginalPhysicalFile).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('groups copies without an exact retained match as skipped', async () => {
      const { sut, mocks } = setup();
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' });
      mocks.physicalFile.getMigrationCandidates.mockReturnValue(stream(candidate()) as never);
      mocks.physicalFile.getMasterOriginalCandidate.mockResolvedValue(undefined as never);

      await sut.handleDryRun({});

      const [, summary] = mocks.systemMetadata.set.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(summary).toEqual(expect.objectContaining({ eligibleAssets: 0, skippedMissingMaster: 1, retained: [] }));
      expect(summary.copies).toEqual([
        expect.objectContaining({
          retainedAssetId: null,
          checksumMatch: false,
          decision: PhysicalDeduplicationDecision.Skip,
          reason: PhysicalDeduplicationSkipReason.NoRetainedMatch,
        }),
      ]);
    });

    it('skips external-library copies and copies that already share the retained original', async () => {
      const { sut, mocks } = setup();
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' });
      mocks.physicalFile.getMigrationCandidates.mockReturnValue(
        stream(
          candidate({ id: 'external', isExternal: true }),
          candidate({ id: 'shared', physicalOriginalFileId: 'pf-1' }),
        ) as never,
      );
      mocks.physicalFile.getMasterOriginalCandidate.mockResolvedValue(master() as never);
      mocks.physicalFile.countOriginalReferences.mockResolvedValue(2);

      await sut.handleDryRun({});

      const [, summary] = mocks.systemMetadata.set.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(summary).toEqual(expect.objectContaining({ eligibleAssets: 0, reclaimableBytes: 0, skippedExternal: 1 }));
      expect(summary.copies).toEqual([
        expect.objectContaining({ assetId: 'external', reason: PhysicalDeduplicationSkipReason.ExternalLibrary }),
        expect.objectContaining({
          assetId: 'shared',
          checksumMatch: true,
          decision: PhysicalDeduplicationDecision.Skip,
          reason: PhysicalDeduplicationSkipReason.AlreadyShared,
        }),
      ]);
      expect(summary.retained).toEqual([expect.objectContaining({ referencesBefore: 2, referencesAfter: 2 })]);
    });

    it('reviews only the scoped account when a scope is requested', async () => {
      const { sut, mocks } = setup();
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' });
      mocks.physicalFile.getMigrationCandidates.mockReturnValue(
        stream(candidate({ ownerId: 'jamie' }), candidate({ id: 'copy-2', ownerId: 'emma' })) as never,
      );
      mocks.physicalFile.getMasterOriginalCandidate.mockResolvedValue(master() as never);
      mocks.physicalFile.countOriginalReferences.mockResolvedValue(1);

      await sut.handleDryRun({ scopeUserId: 'emma' });

      const [, summary] = mocks.systemMetadata.set.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(summary).toEqual(expect.objectContaining({ scopeUserId: 'emma', eligibleAssets: 1 }));
      expect(summary.copies).toEqual([expect.objectContaining({ assetId: 'copy-2', ownerId: 'emma' })]);
    });
  });

  describe('handleApply', () => {
    it('never applies anything: applying needs a reviewed plan (FL-73)', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mocks.forkSchema.getState.mockResolvedValue(forkSchemaActive);
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' });

      await expect(sut.handleApply({})).resolves.toBe(JobStatus.Skipped);

      expect(mocks.physicalFile.getMigrationCandidates).not.toHaveBeenCalled();
      expect(mocks.physicalFile.linkAssetToOriginalPhysicalFile).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });
  });

  describe('preparePlan (FL-73)', () => {
    const retainedState = {
      assetId: MASTER_ID,
      ownerId: 'master-user',
      originalFileName: 'a.jpg',
      originalPath: '/upload/master/a.jpg',
      type: 'IMAGE',
      sizeInBytes: 10,
      checksum: 'aa'.repeat(20),
      referencesBefore: 1,
      referencesAfter: 3,
    };
    const copyState = (assetId: string, ownerId = 'jamie') => ({
      assetId,
      ownerId,
      originalFileName: 'a.jpg',
      originalPath: `/upload/${ownerId}/${assetId}.jpg`,
      type: 'IMAGE',
      sizeInBytes: 10,
      checksum: 'aa'.repeat(20),
      retainedAssetId: MASTER_ID,
      checksumMatch: true,
      decision: PhysicalDeduplicationDecision.Share,
      reason: null,
    });
    const storedPlan = {
      ...lastDryRun,
      eligibleAssets: 2,
      reclaimableBytes: 20,
      retained: [retainedState],
      copies: [copyState(COPY_1), copyState(COPY_2, 'emma')],
      copiesTruncated: false,
    };
    const fingerprint = physicalDeduplicationFingerprint(storedPlan as never);
    const row = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      ownerId: id === MASTER_ID ? 'master-user' : id === COPY_2 ? 'emma' : 'jamie',
      originalPath: id === MASTER_ID ? '/upload/master/a.jpg' : `/upload/${id === COPY_2 ? 'emma' : 'jamie'}/${id}.jpg`,
      checksum: Buffer.from('aa'.repeat(20), 'hex'),
      sizeInBytes: 10,
      deletedAt: null,
      status: AssetStatus.Active,
      isExternal: false,
      isOffline: false,
      libraryId: null,
      physicalOriginalFileId: null,
      ...overrides,
    });

    const setup = (rows = [row(MASTER_ID), row(COPY_1), row(COPY_2)]) => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mocks.forkSchema.getState.mockResolvedValue(forkSchemaActive);
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' }, storedPlan);
      mocks.physicalFile.getPlanEvidence.mockResolvedValue(rows as never);
      mocks.physicalFile.countOriginalReferencesFor.mockResolvedValue(new Map());
      return { sut, mocks };
    };

    it('binds the per-group decisions to the plan and freezes exactly the copies it shares', async () => {
      const { sut, mocks } = setup();

      const plan = await sut.preparePlan(authStub.admin, { fingerprint });

      expect(plan.planId).toBe(physicalDeduplicationPlanId(fingerprint));
      expect(plan.confirmation).toBe(`APPLY ${plan.planId}`);
      // Keyed with the server's own secret: nobody else can make a token for this plan.
      const secret = mocks.crypto.randomBytesAsText.mock.results[0].value as string;
      expect(plan.reviewToken).toBe(physicalDeduplicationReviewToken(secret, fingerprint, []));
      expect(plan.items.map((item) => item.assetId)).toEqual([COPY_1, COPY_2]);
      expect(plan.retained).toEqual([expect.objectContaining({ assetId: MASTER_ID, referencesBefore: 1 })]);
      expect(plan.estimatedBytes).toBe(20);
      expect(plan.hiddenCopies).toBe(0);
    });

    it('leaves out the groups the administrator decided to keep separate', async () => {
      const { sut } = setup();

      await expect(
        sut.preparePlan(authStub.admin, { fingerprint, excludedRetainedAssetIds: [MASTER_ID] }),
      ).rejects.toThrow('This plan has no exact copies to share.');
    });

    it('ignores a left-out id that is not a group of the plan, without saying so', async () => {
      const { sut } = setup();

      const plan = await sut.preparePlan(authStub.admin, { fingerprint, excludedRetainedAssetIds: [COPY_1] });

      expect(plan.excludedRetainedAssetIds).toEqual([]);
      expect(plan.items).toHaveLength(2);
    });

    it('answers 409 when a newer preview replaced the plan on screen', async () => {
      const { sut } = setup();

      await expect(sut.preparePlan(authStub.admin, { fingerprint: 'ff'.repeat(32) })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it.each([
      ['a copy was trashed', [row(MASTER_ID), row(COPY_1, { deletedAt: new Date() }), row(COPY_2)]],
      ['a copy moved to another account', [row(MASTER_ID), row(COPY_1, { ownerId: 'emma' }), row(COPY_2)]],
      [
        'a copy changed checksum',
        [row(MASTER_ID), row(COPY_1, { checksum: Buffer.from('bb'.repeat(20), 'hex') }), row(COPY_2)],
      ],
      ['a copy path changed', [row(MASTER_ID), row(COPY_1, { originalPath: '/elsewhere.jpg' }), row(COPY_2)]],
      ['a copy was deleted', [row(MASTER_ID), row(COPY_2)]],
      ['the retained original was deleted', [row(COPY_1), row(COPY_2)]],
      ['the retained original changed owner', [row(MASTER_ID, { ownerId: 'jamie' }), row(COPY_1), row(COPY_2)]],
      ['the retained original changed size', [row(MASTER_ID, { sizeInBytes: 11 }), row(COPY_1), row(COPY_2)]],
      [
        'a copy already shares the retained original',
        [
          row(MASTER_ID, { physicalOriginalFileId: 'pf-1' }),
          row(COPY_1, { physicalOriginalFileId: 'pf-1' }),
          row(COPY_2),
        ],
      ],
    ])('answers 409 when %s', async (_, rows) => {
      const { sut, mocks } = setup(rows as never);
      mocks.physicalFile.countOriginalReferencesFor.mockResolvedValue(new Map([['pf-1', 2]]));

      await expect(sut.preparePlan(authStub.admin, { fingerprint })).rejects.toThrow(
        'File or reference evidence changed. Prepare a new plan.',
      );
    });

    it('answers 409 when the retained original gained references since the preview', async () => {
      const { sut, mocks } = setup([row(MASTER_ID, { physicalOriginalFileId: 'pf-1' }), row(COPY_1), row(COPY_2)]);
      mocks.physicalFile.countOriginalReferencesFor.mockResolvedValue(new Map([['pf-1', 2]]));

      await expect(sut.preparePlan(authStub.admin, { fingerprint })).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 409 for a plan the old whole-server apply already applied', async () => {
      const { sut, mocks } = setup();
      const applied = { ...storedPlan, mode: 'apply' as const };
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' }, applied);

      await expect(
        sut.preparePlan(authStub.admin, { fingerprint: physicalDeduplicationFingerprint(applied as never) }),
      ).rejects.toThrow('This plan has already been applied.');
    });

    it("counts, but never names, the plan's Locked copies of other accounts", async () => {
      const { sut, mocks } = setup();
      mocks.asset.getLockedAssetIds.mockResolvedValue(new Set([COPY_2]));

      const plan = await sut.preparePlan(authStub.admin, { fingerprint });

      // Background work reaches Locked media: the copy is still in the plan, only unnamed on the page.
      expect(plan.items.map((item) => item.assetId)).toContain(COPY_2);
      expect(plan.hiddenCopies).toBe(1);
    });

    it('is unavailable outside an active storage handoff', async () => {
      const { sut, mocks } = setup();
      mocks.forkSchema.getState.mockResolvedValue({ ...forkSchemaActive, active: false, phase: 'inactive' });

      await expect(sut.preparePlan(authStub.admin, { fingerprint })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('recordPlanApplied (FL-73)', () => {
    it('marks the reviewed plan applied, keeping its fingerprint', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      const stored = { ...lastDryRun, retained: [], copies: [], copiesTruncated: false };
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' }, stored);
      const fingerprint = physicalDeduplicationFingerprint(stored as never);

      await sut.recordPlanApplied(fingerprint, { linkedAssets: 2, deletedBytes: 20 });

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(
        SystemMetadataKey.PhysicalDeduplicationMigration,
        expect.objectContaining({ mode: 'apply', linkedAssets: 2, deletedBytes: 20 }),
      );
      const [, written] = mocks.systemMetadata.set.mock.calls[0] as [unknown, never];
      expect(physicalDeduplicationFingerprint(written)).toBe(fingerprint);
    });

    it('leaves a newer preview alone', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' });

      await sut.recordPlanApplied('ff'.repeat(32), { linkedAssets: 2, deletedBytes: 20 });

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });
  });

  describe('requireApplyAllowed (FL-73)', () => {
    it.each([
      [{ enabled: false, masterUserId: 'master-user' }, BadRequestException],
      [{ enabled: true, masterUserId: null }, BadRequestException],
      [{ enabled: true, masterUserId: 'someone-else' }, ConflictException],
    ])('refuses %o', async (physicalDeduplication, error) => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mockConfig(mocks, physicalDeduplication);
      mocks.user.get.mockImplementation((id) => Promise.resolve(activeUser(id) as never));

      await expect(sut.requireApplyAllowed({ masterUserId: 'master-user' })).rejects.toBeInstanceOf(error);
    });

    it('allows the saved, enabled, existing retained account', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' });
      mocks.user.get.mockImplementation((id) => Promise.resolve(activeUser(id) as never));

      await expect(sut.requireApplyAllowed({ masterUserId: 'master-user' })).resolves.toBeUndefined();
    });
  });

  describe('applyPlanItem (FL-73)', () => {
    const hex = 'aa'.repeat(20);
    const item = {
      assetId: COPY_1,
      ownerId: 'jamie',
      originalPath: '/upload/jamie/copy.jpg',
      checksum: hex,
      sizeInBytes: 10,
      retainedAssetId: MASTER_ID,
      retainedPath: '/upload/master/a.jpg',
      retainedChecksum: hex,
    };
    const snapshot = {
      version: 1 as const,
      planId: 'PD-ABCDEF12',
      fingerprint: 'ab'.repeat(32),
      reviewToken: 'cd'.repeat(32),
      ranAt: new Date().toISOString(),
      masterUserId: 'master-user',
      scopeUserId: null,
      excludedRetainedAssetIds: [],
      items: [item],
      retained: [
        {
          assetId: MASTER_ID,
          originalPath: '/upload/master/a.jpg',
          checksum: hex,
          sizeInBytes: 10,
          referencesBefore: 1,
        },
      ],
      estimatedBytes: 10,
    };
    const evidence = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      ownerId: id === MASTER_ID ? 'master-user' : 'jamie',
      originalPath: id === MASTER_ID ? '/upload/master/a.jpg' : '/upload/jamie/copy.jpg',
      checksum: Buffer.from(hex, 'hex'),
      sizeInBytes: 10,
      deletedAt: null,
      status: AssetStatus.Active,
      isExternal: false,
      isOffline: false,
      libraryId: null,
      physicalOriginalFileId: null,
      ...overrides,
    });

    const setup = (rows = [evidence(MASTER_ID), evidence(COPY_1)]) => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mocks.database.withLock.mockImplementation((_lock, callback) => callback());
      mocks.physicalFile.getPlanEvidence.mockResolvedValue(rows as never);
      mocks.physicalFile.ensureOriginalPhysicalFile.mockResolvedValue({
        id: 'pf-1',
        path: '/upload/master/a.jpg',
      } as never);
      mocks.physicalFile.deleteUnreferencedPath.mockResolvedValue({ deleted: true, references: 0 });
      mocks.physicalFile.getGeneratedFiles.mockResolvedValue([]);
      mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(!path.endsWith('.xmp')));
      mocks.storage.stat.mockResolvedValue({ size: 10 } as never);
      mocks.crypto.hashFileMatching.mockResolvedValue(Buffer.from(hex, 'hex'));
      return { sut, mocks };
    };

    it('verifies both files on disk, links the copy, then removes only the copy', async () => {
      const { sut, mocks } = setup();

      await expect(sut.applyPlanItem(snapshot, item)).resolves.toEqual({
        state: 'applied',
        reasonKey: null,
        message: null,
        reclaimedBytes: 10,
      });

      expect(mocks.crypto.hashFileMatching).toHaveBeenCalledWith('/upload/master/a.jpg', Buffer.from(hex, 'hex'));
      expect(mocks.crypto.hashFileMatching).toHaveBeenCalledWith('/upload/jamie/copy.jpg', Buffer.from(hex, 'hex'));
      expect(mocks.physicalFile.linkAssetToOriginalPhysicalFile).toHaveBeenCalledWith(COPY_1, {
        id: 'pf-1',
        path: '/upload/master/a.jpg',
      });
      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledTimes(1);
      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledWith(
        '/upload/jamie/copy.jpg',
        expect.any(Function),
      );
      // The asset row stays: albums, faces, stacks, shared links and lock records keep pointing at it.
      expect(mocks.asset.remove).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalled();
      // Originals are never written to.
      expect(mocks.storage.copyFile).not.toHaveBeenCalled();
      expect(mocks.storage.rename).not.toHaveBeenCalled();
    });

    it('never removes the copy when the retained original no longer holds the reviewed bytes', async () => {
      const { sut, mocks } = setup();
      mocks.crypto.hashFileMatching.mockResolvedValue(Buffer.from('bb'.repeat(20), 'hex'));

      await expect(sut.applyPlanItem(snapshot, item)).resolves.toEqual(
        expect.objectContaining({ state: 'skipped', reasonKey: 'retained-mismatch', reclaimedBytes: 0 }),
      );
      expect(mocks.physicalFile.linkAssetToOriginalPhysicalFile).not.toHaveBeenCalled();
      expect(mocks.physicalFile.deleteUnreferencedPath).not.toHaveBeenCalled();
    });

    it('never removes the copy when the retained original is missing on disk', async () => {
      const { sut, mocks } = setup();
      mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(path !== '/upload/master/a.jpg'));

      await expect(sut.applyPlanItem(snapshot, item)).resolves.toEqual(
        expect.objectContaining({ state: 'skipped', reasonKey: 'retained-missing' }),
      );
      expect(mocks.physicalFile.deleteUnreferencedPath).not.toHaveBeenCalled();
    });

    it('leaves a copy whose bytes changed on disk', async () => {
      const { sut, mocks } = setup();
      mocks.crypto.hashFileMatching.mockImplementation((path) =>
        Promise.resolve(Buffer.from(path === '/upload/master/a.jpg' ? hex : 'cc'.repeat(20), 'hex')),
      );

      await expect(sut.applyPlanItem(snapshot, item)).resolves.toEqual(
        expect.objectContaining({ state: 'skipped', reasonKey: 'copy-mismatch' }),
      );
      expect(mocks.physicalFile.linkAssetToOriginalPhysicalFile).not.toHaveBeenCalled();
      expect(mocks.physicalFile.deleteUnreferencedPath).not.toHaveBeenCalled();
    });

    it('leaves a copy whose evidence changed since the review', async () => {
      const { sut, mocks } = setup([evidence(MASTER_ID), evidence(COPY_1, { ownerId: 'emma' })]);

      await expect(sut.applyPlanItem(snapshot, item)).resolves.toEqual(
        expect.objectContaining({ state: 'skipped', reasonKey: 'copy-changed' }),
      );
      expect(mocks.physicalFile.ensureOriginalPhysicalFile).not.toHaveBeenCalled();
    });

    it('leaves the copy when the retained original moved to another account', async () => {
      const { sut, mocks } = setup([evidence(MASTER_ID, { ownerId: 'jamie' }), evidence(COPY_1)]);

      await expect(sut.applyPlanItem(snapshot, item)).resolves.toEqual(
        expect.objectContaining({ state: 'skipped', reasonKey: 'retained-changed' }),
      );
      expect(mocks.physicalFile.linkAssetToOriginalPhysicalFile).not.toHaveBeenCalled();
    });

    it('finishes a copy an interrupted attempt already linked without linking it twice', async () => {
      const { sut, mocks } = setup([
        evidence(MASTER_ID, { physicalOriginalFileId: 'pf-1' }),
        evidence(COPY_1, { physicalOriginalFileId: 'pf-1', originalPath: '/upload/master/a.jpg' }),
      ]);

      await expect(sut.applyPlanItem(snapshot, item)).resolves.toEqual(
        expect.objectContaining({ state: 'already-applied', reclaimedBytes: 10 }),
      );
      expect(mocks.physicalFile.linkAssetToOriginalPhysicalFile).not.toHaveBeenCalled();
      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledWith(
        '/upload/jamie/copy.jpg',
        expect.any(Function),
      );
    });

    it('reports nothing reclaimed when the interrupted attempt had already removed the copy', async () => {
      const { sut, mocks } = setup([
        evidence(MASTER_ID, { physicalOriginalFileId: 'pf-1' }),
        evidence(COPY_1, { physicalOriginalFileId: 'pf-1', originalPath: '/upload/master/a.jpg' }),
      ]);
      mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(path === '/upload/master/a.jpg'));

      await expect(sut.applyPlanItem(snapshot, item)).resolves.toEqual(
        expect.objectContaining({ state: 'already-applied', reclaimedBytes: 0 }),
      );
      expect(mocks.physicalFile.deleteUnreferencedPath).not.toHaveBeenCalled();
    });

    it('never removes a path the retained original uses', async () => {
      const { sut, mocks } = setup();
      mocks.physicalFile.ensureOriginalPhysicalFile.mockResolvedValue({
        id: 'pf-1',
        path: '/upload/jamie/copy.jpg',
      } as never);

      await sut.applyPlanItem(snapshot, item);

      expect(mocks.physicalFile.deleteUnreferencedPath).not.toHaveBeenCalledWith(
        '/upload/jamie/copy.jpg',
        expect.anything(),
      );
    });

    it('keeps a file some other asset still names', async () => {
      const { sut, mocks } = setup();
      mocks.physicalFile.deleteUnreferencedPath.mockResolvedValue({ deleted: false, references: 1 });

      await expect(sut.applyPlanItem(snapshot, item)).resolves.toEqual(
        expect.objectContaining({ state: 'applied', reclaimedBytes: 0 }),
      );
    });

    it('hashes a retained original once per run', async () => {
      const { sut, mocks } = setup();
      const verified = new Map();

      await sut.applyPlanItem(snapshot, item, verified);
      mocks.physicalFile.getPlanEvidence.mockResolvedValue([evidence(MASTER_ID), evidence(COPY_2)] as never);
      await sut.applyPlanItem(snapshot, { ...item, assetId: COPY_2 }, verified);

      const retainedHashes = mocks.crypto.hashFileMatching.mock.calls.filter(
        ([path]) => path === '/upload/master/a.jpg',
      );
      expect(retainedHashes).toHaveLength(1);
    });

    it('runs under the storage migration lock', async () => {
      const { sut, mocks } = setup();

      await sut.applyPlanItem(snapshot, item);

      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.StorageTemplateMigration, expect.any(Function));
    });
  });

  describe('requestPreview', () => {
    it('rejects a preview without a chosen or saved retained account', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mockConfig(mocks, { enabled: false, masterUserId: null }, null);

      await expect(sut.requestPreview({})).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('rejects an unknown retained account', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mockConfig(mocks, { enabled: false, masterUserId: null }, null);
      mocks.user.get.mockResolvedValue(undefined as never);

      await expect(sut.requestPreview({ masterUserId: 'missing' })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('rejects scoping the review to the retained account itself', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mockConfig(mocks, { enabled: false, masterUserId: null }, null);
      mocks.user.get.mockImplementation((id) => Promise.resolve(activeUser(id) as never));

      await expect(sut.requestPreview({ masterUserId: 'taylor', scopeUserId: 'taylor' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('queues the dry run with the chosen account and scope', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mockConfig(mocks, { enabled: false, masterUserId: null }, null);
      mocks.user.get.mockImplementation((id) => Promise.resolve(activeUser(id) as never));

      await sut.requestPreview({ masterUserId: 'taylor', scopeUserId: 'emma' });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.PhysicalDeduplicationMigrationDryRun,
        data: { masterUserId: 'taylor', scopeUserId: 'emma' },
      });
    });

    it('falls back to the saved retained account', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' }, null);
      mocks.user.get.mockImplementation((id) => Promise.resolve(activeUser(id) as never));

      await sut.requestPreview({});

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.PhysicalDeduplicationMigrationDryRun,
        data: { masterUserId: 'master-user', scopeUserId: undefined },
      });
    });
  });

  describe('getPreview', () => {
    const counts = { active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0 };

    it('returns the saved configuration and no plan before any run', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mockConfig(mocks, { enabled: false, masterUserId: null }, null);
      mocks.job.getJobCounts.mockResolvedValue(counts);

      await expect(sut.getPreview(authStub.admin)).resolves.toEqual({
        plan: null,
        savedMasterUserId: null,
        enabled: false,
        running: false,
        applying: false,
        applies: [],
      });
    });

    it('reports a running job from the storage template migration queue', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' }, null);
      mocks.job.getJobCounts.mockResolvedValue({ ...counts, waiting: 1 });

      await expect(sut.getPreview(authStub.admin)).resolves.toEqual(expect.objectContaining({ running: true }));
    });

    it('resolves owner names and marks only assets the requester may read as viewable', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      const retained = {
        assetId: 'master-1',
        ownerId: 'master-user',
        originalFileName: 'a.jpg',
        originalPath: '/a.jpg',
        type: 'IMAGE',
        sizeInBytes: 1,
        checksum: 'aa',
        referencesBefore: 1,
        referencesAfter: 2,
      };
      const copy = {
        assetId: 'copy-1',
        ownerId: 'jamie',
        originalFileName: 'a.jpg',
        originalPath: '/b.jpg',
        type: 'IMAGE',
        sizeInBytes: 1,
        checksum: 'aa',
        retainedAssetId: 'master-1',
        checksumMatch: true,
        decision: PhysicalDeduplicationDecision.Share,
        reason: null,
      };
      mockConfig(
        mocks,
        { enabled: true, masterUserId: 'master-user' },
        { ...lastDryRun, scopeUserId: 'jamie', retained: [retained], copies: [copy], copiesTruncated: false },
      );
      mocks.job.getJobCounts.mockResolvedValue(counts);
      mocks.user.getList.mockResolvedValue([
        { id: 'master-user', name: 'Taylor' },
        { id: 'jamie', name: 'Jamie' },
      ] as never);
      // The admin owns the retained asset; Jamie's copy is neither shared nor in a partner library.
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['master-1']));
      mocks.storage.checkFileExists.mockResolvedValue(true);

      const { plan } = await sut.getPreview(authStub.admin);

      expect(mocks.user.getList).toHaveBeenCalledWith({ withDeleted: true });
      expect(plan?.retained[0].fileAvailable).toBe(true);
      expect(plan).toEqual(
        expect.objectContaining({
          masterUserName: 'Taylor',
          scopeUserId: 'jamie',
          scopeUserName: 'Jamie',
          retained: [expect.objectContaining({ assetId: 'master-1', ownerName: 'Taylor', canView: true })],
          copies: [expect.objectContaining({ assetId: 'copy-1', ownerName: 'Jamie', canView: false })],
        }),
      );
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.admin.user.id,
        new Set(['master-1', 'copy-1']),
        undefined,
      );
    });

    it('marks a retained original that is no longer on disk (FL-71 UT-24)', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      const retained = {
        assetId: 'master-1',
        ownerId: 'master-user',
        originalFileName: 'a.jpg',
        originalPath: '/gone.jpg',
        type: 'IMAGE',
        sizeInBytes: 1,
        checksum: 'aa',
        referencesBefore: 1,
        referencesAfter: 1,
      };
      mockConfig(
        mocks,
        { enabled: true, masterUserId: 'master-user' },
        { ...lastDryRun, retained: [retained], copies: [], copiesTruncated: false },
      );
      mocks.job.getJobCounts.mockResolvedValue(counts);
      mocks.user.getList.mockResolvedValue([{ id: 'master-user', name: 'Taylor' }] as never);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['master-1']));
      mocks.storage.checkFileExists.mockResolvedValue(false);

      const { plan } = await sut.getPreview(authStub.admin);

      expect(mocks.storage.checkFileExists).toHaveBeenCalledWith('/gone.jpg');
      expect(plan?.retained).toEqual([expect.objectContaining({ assetId: 'master-1', fileAvailable: false })]);
    });

    it("never names another user's Locked asset in the plan rows (FL-34)", async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      const copy = {
        assetId: 'locked-copy',
        ownerId: 'jamie',
        originalFileName: 'private.jpg',
        originalPath: '/private.jpg',
        type: 'IMAGE',
        sizeInBytes: 1,
        checksum: 'aa',
        retainedAssetId: 'master-1',
        checksumMatch: true,
        decision: PhysicalDeduplicationDecision.Share,
        reason: null,
      };
      mockConfig(
        mocks,
        { enabled: true, masterUserId: 'master-user' },
        { ...lastDryRun, retained: [], copies: [copy], copiesTruncated: false },
      );
      mocks.job.getJobCounts.mockResolvedValue(counts);
      mocks.user.getList.mockResolvedValue([] as never);
      mocks.asset.getLockedAssetIds.mockResolvedValue(new Set(['locked-copy']));

      const { plan } = await sut.getPreview(authStub.adminWithElevatedPermission);

      expect(plan?.copies).toEqual([]);
      expect(plan?.hiddenCopies).toBe(1);
      expect(mocks.asset.getLockedAssetIds).toHaveBeenCalledWith(['locked-copy']);
    });

    it("hides the copies of another account's Locked retained original with it (FL-73)", async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      const retained = {
        assetId: 'locked-master',
        ownerId: 'master-user',
        originalFileName: 'private.jpg',
        originalPath: '/private.jpg',
        type: 'IMAGE',
        sizeInBytes: 1,
        checksum: 'aa',
        referencesBefore: 1,
        referencesAfter: 2,
      };
      const copy = {
        assetId: 'visible-copy',
        ownerId: 'jamie',
        originalFileName: 'private.jpg',
        originalPath: '/copy.jpg',
        type: 'IMAGE',
        sizeInBytes: 1,
        checksum: 'aa',
        retainedAssetId: 'locked-master',
        checksumMatch: true,
        decision: PhysicalDeduplicationDecision.Share,
        reason: null,
      };
      mockConfig(
        mocks,
        { enabled: true, masterUserId: 'master-user' },
        { ...lastDryRun, retained: [retained], copies: [copy], copiesTruncated: false },
      );
      mocks.job.getJobCounts.mockResolvedValue(counts);
      mocks.user.getList.mockResolvedValue([] as never);
      mocks.asset.getLockedAssetIds.mockResolvedValue(new Set(['locked-master']));

      const { plan } = await sut.getPreview(authStub.admin);

      expect(plan?.retained).toEqual([]);
      expect(plan?.copies).toEqual([]);
      expect(plan?.hiddenCopies).toBe(1);
      // Hidden rows still count toward the plan: backend work reaches Locked media.
      expect(plan?.applicableCopies).toBe(1);
    });

    it("counts each group's unlisted Locked copies so leaving the group out is counted exactly (FL-73)", async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      const retained = {
        assetId: 'master-1',
        ownerId: 'master-user',
        originalFileName: 'a.jpg',
        originalPath: '/a.jpg',
        type: 'IMAGE',
        sizeInBytes: 1,
        checksum: 'aa',
        referencesBefore: 1,
        referencesAfter: 3,
      };
      const copy = (assetId: string) => ({
        assetId,
        ownerId: 'jamie',
        originalFileName: 'a.jpg',
        originalPath: `/${assetId}.jpg`,
        type: 'IMAGE',
        sizeInBytes: 1,
        checksum: 'aa',
        retainedAssetId: 'master-1',
        checksumMatch: true,
        decision: PhysicalDeduplicationDecision.Share,
        reason: null,
      });
      mockConfig(
        mocks,
        { enabled: true, masterUserId: 'master-user' },
        { ...lastDryRun, retained: [retained], copies: [copy('shown'), copy('locked')], copiesTruncated: false },
      );
      mocks.job.getJobCounts.mockResolvedValue(counts);
      mocks.user.getList.mockResolvedValue([] as never);
      mocks.asset.getLockedAssetIds.mockResolvedValue(new Set(['locked']));

      const { plan } = await sut.getPreview(authStub.admin);

      expect(plan?.copies.map((item) => item.assetId)).toEqual(['shown']);
      expect(plan?.retained).toEqual([expect.objectContaining({ assetId: 'master-1', hiddenCopies: 1 })]);
    });

    it('names the plan by its fingerprint (FL-73)', async () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      const stored = { ...lastDryRun, retained: [], copies: [], copiesTruncated: false };
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' }, stored);
      mocks.job.getJobCounts.mockResolvedValue(counts);
      mocks.user.getList.mockResolvedValue([] as never);

      const { plan } = await sut.getPreview(authStub.admin);

      const fingerprint = physicalDeduplicationFingerprint(stored as never);
      expect(plan).toEqual(
        expect.objectContaining({ fingerprint, planId: physicalDeduplicationPlanId(fingerprint), applicableCopies: 0 }),
      );
    });
  });
});

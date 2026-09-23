import { BadRequestException } from '@nestjs/common';
import {
  JobName,
  JobStatus,
  PhysicalDeduplicationDecision,
  PhysicalDeduplicationSkipReason,
  SystemMetadataKey,
} from 'src/enum.js';
import { PhysicalDeduplicationService } from 'src/services/physical-deduplication.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newTestService, ServiceMocks } from 'test/utils.js';

type Handler = 'handleDryRun' | 'handleApply';

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

const stream = (...items: unknown[]) =>
  (async function* () {
    for (const item of items) {
      yield item;
    }
  })();

const mockConfig = (
  mocks: ServiceMocks,
  physicalDeduplication: { enabled: boolean; masterUserId: string | null },
  lastRun: unknown = lastDryRun,
) => {
  mocks.systemMetadata.get.mockImplementation((key) =>
    Promise.resolve(key === SystemMetadataKey.PhysicalDeduplicationMigration ? lastRun : { physicalDeduplication }),
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
    ['handleApply', 'legacy'],
    ['handleApply', 'dual-write'],
    ['handleApply', 'ready'],
    ['handleApply', 'active'],
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
    const setup = () => {
      const { sut, mocks } = newTestService(PhysicalDeduplicationService);
      mocks.forkSchema.getState.mockResolvedValue(forkSchemaActive);
      mocks.database.withLock.mockImplementation((_lock, callback) => callback());
      mocks.physicalFile.getMigrationCandidates.mockReturnValue(stream() as never);
      return { sut, mocks };
    };

    it('is skipped while the feature is disabled, even when a preview exists', async () => {
      const { sut, mocks } = setup();
      mockConfig(mocks, { enabled: false, masterUserId: 'master-user' });

      await expect(sut.handleApply({})).resolves.toBe(JobStatus.Skipped);

      expect(mocks.physicalFile.getMigrationCandidates).not.toHaveBeenCalled();
    });

    it('refuses when the last preview retained a different account than the saved master', async () => {
      const { sut, mocks } = setup();
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' }, { ...lastDryRun, masterUserId: 'chosen-user' });

      await expect(sut.handleApply({})).resolves.toBe(JobStatus.Failed);

      expect(mocks.physicalFile.getMigrationCandidates).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('refuses without a preview', async () => {
      const { sut, mocks } = setup();
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' }, null);

      await expect(sut.handleApply({})).resolves.toBe(JobStatus.Failed);
    });

    it('applies exactly the scope the reviewed preview covered', async () => {
      const { sut, mocks } = setup();
      mockConfig(mocks, { enabled: true, masterUserId: 'master-user' }, { ...lastDryRun, scopeUserId: 'emma' });
      mocks.physicalFile.getMigrationCandidates.mockReturnValue(
        stream(candidate({ ownerId: 'jamie' }), candidate({ id: 'copy-2', ownerId: 'emma' })) as never,
      );
      mocks.physicalFile.getMasterOriginalCandidate.mockResolvedValue(master() as never);
      mocks.physicalFile.countOriginalReferences.mockResolvedValue(1);
      mocks.physicalFile.ensureOriginalPhysicalFile.mockResolvedValue({
        id: 'pf-1',
        path: master().originalPath,
      } as never);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.physicalFile.getGeneratedFiles.mockResolvedValue([]);

      await expect(sut.handleApply({})).resolves.toBe(JobStatus.Success);

      expect(mocks.physicalFile.linkAssetToOriginalPhysicalFile).toHaveBeenCalledTimes(1);
      expect(mocks.physicalFile.linkAssetToOriginalPhysicalFile).toHaveBeenCalledWith('copy-2', expect.anything());
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(
        SystemMetadataKey.PhysicalDeduplicationMigration,
        expect.objectContaining({ mode: 'apply', masterUserId: 'master-user', scopeUserId: 'emma', linkedAssets: 1 }),
      );
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

      const { plan } = await sut.getPreview(authStub.admin);

      expect(mocks.user.getList).toHaveBeenCalledWith({ withDeleted: true });
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
  });
});

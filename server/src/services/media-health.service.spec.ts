import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import { CORRUPT_MEDIA_DELETE_CONFIRM_TEXT } from 'src/dtos/media-health.dto.js';
import {
  AssetType,
  AssetVisibility,
  CacheControl,
  ChecksumAlgorithm,
  JobName,
  JobStatus,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
  MediaOperationBulkAction,
  MediaOperationItemStatus,
  MediaOperationKind,
  MediaOperationStatus,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SharpOperations } from 'src/queue/sharp-operations.js';
import { SharpOperationError } from 'src/queue/sharp-pool.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { MANAGED_ROOT_ID, libraryRootId, recoveryRootId } from 'src/utils/media-health-roots.js';
import { classifyImageDecodeFailure } from 'src/utils/media-health.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

/** A non-administrator in an unlocked (PIN-elevated) session. */
const elevatedOwner = { ...authStub.user1, session: { id: 'token-id-elevated', hasElevatedPermission: true } } as never;
/** A regular file's stat as a recovery expects it: written long enough ago to be complete. */
const settledStat = ({ size, mtime = new Date(Date.now() - 60 * 60_000) }: { size: number; mtime?: Date }) => ({
  size,
  mtime,
  mtimeMs: mtime.getTime(),
  isFile: () => true,
});

describe(MediaHealthService.name, () => {
  let sut: MediaHealthService;
  let mocks: ServiceMocks;
  let mediaHealthRepository: MediaHealthRepository;
  let mediaOperationRepository: MediaOperationRepository;
  let mediaOperationService: MediaOperationService;
  let cloudBackupService: { restoreLostOriginal: ReturnType<typeof vi.fn> };
  let iCloudSyncRepository: {
    requestRepair: ReturnType<typeof vi.fn>;
    ownerUploadsPaused: ReturnType<typeof vi.fn>;
    queueOperation: ReturnType<typeof vi.fn>;
  };
  let recoveryRoots: Array<{ label: string; path: string }>;

  beforeEach(() => {
    mocks = getMocks();
    recoveryRoots = [];
    mediaHealthRepository = {
      clearProcessingFailures: vi.fn().mockResolvedValue(undefined),
      createRun: vi.fn(),
      finishRun: vi.fn(),
      getByIds: vi.fn(),
      getAssets: vi.fn(),
      getAssetChecksums: vi.fn(),
      getAssetPage: vi.fn().mockResolvedValue([]),
      countScanAssets: vi.fn().mockResolvedValue(0),
      getCandidatesByHealthIds: vi.fn(),
      getLatestRun: vi.fn(),
      getInternalAssetByOriginalPath: vi.fn(),
      getTrackedPaths: vi.fn(),
      list: vi.fn(),
      count: vi.fn(),
      countByStatus: vi.fn().mockResolvedValue([]),
      countDuplicateGroups: vi.fn().mockResolvedValue(0),
      countPendingMetadata: vi.fn().mockResolvedValue(0),
      countImportReview: vi.fn().mockResolvedValue(0),
      markStatus: vi.fn(),
      markDismissed: vi.fn(),
      markResolved: vi.fn(),
      markResolvedCategories: vi.fn(),
      markResolvedForAssets: vi.fn(),
      setChosenCandidate: vi.fn().mockResolvedValue(true),
      setRetainedPath: vi.fn().mockResolvedValue(undefined),
      isOriginalPathInUse: vi.fn().mockResolvedValue(false),
      getActiveTrashFindingIds: vi.fn().mockResolvedValue([]),
      releaseTrashQueued: vi.fn().mockResolvedValue(0),
      reopenFinding: vi.fn().mockResolvedValue(true),
      withLibraryCareLock: vi.fn().mockImplementation((_ownerId: string, work: () => Promise<unknown>) => work()),
      trashCorruptIfUnchanged: vi.fn().mockResolvedValue(true),
      replaceCandidates: vi.fn(),
      relinkManagedAsset: vi.fn(),
      relinkExternalAsset: vi.fn(),
      streamAssets: vi.fn(),
      upsertFinding: vi.fn(),
      appendSteps: vi.fn().mockResolvedValue(undefined),
      listSteps: vi.fn().mockResolvedValue([]),
      settleFinding: vi.fn().mockResolvedValue(true),
      getFindingsForAsset: vi.fn().mockResolvedValue([]),
      claimSearchPending: vi.fn().mockResolvedValue([]),
      recordSearchResult: vi.fn().mockResolvedValue(true),
      // a photo is one phones are shown unless a spec says otherwise
      isShownToPhones: vi.fn().mockResolvedValue(true),
      listLostOriginals: vi.fn().mockResolvedValue([]),
      findLostOriginals: vi.fn().mockResolvedValue([]),
      recordPhoneReport: vi.fn().mockResolvedValue(undefined),
      listFileProblems: vi.fn().mockResolvedValue([]),
      countFileProblems: vi.fn().mockResolvedValue(0),
      getFileProblem: vi.fn().mockResolvedValue(undefined),
      undoFix: vi.fn().mockResolvedValue('undone'),
      recordRemoved: vi.fn().mockResolvedValue(undefined),
    } as unknown as MediaHealthRepository;
    mediaOperationRepository = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      create: vi
        .fn()
        .mockImplementation((operation) =>
          Promise.resolve({ ...operation, id: '0195e2a0-0000-7000-8000-0000000000c1', status: 'queued' }),
        ),
    } as unknown as MediaOperationRepository;
    mediaOperationService = {
      createBulk: vi.fn().mockResolvedValue({ id: '0195e2a0-0000-7000-8000-0000000000b1' }),
    } as unknown as MediaOperationService;
    // Cloud Backup holds no copy unless a spec says so
    cloudBackupService = { restoreLostOriginal: vi.fn().mockResolvedValue({ outcome: 'not-in-backup' }) };
    iCloudSyncRepository = {
      requestRepair: vi.fn().mockResolvedValue([]),
      ownerUploadsPaused: vi.fn().mockResolvedValue(false),
      queueOperation: vi.fn().mockResolvedValue({ outcome: 'created' }),
    };

    sut = new MediaHealthService(
      mocks.logger as never,
      mocks.asset as never,
      mocks.crypto as never,
      mocks.event as never,
      mocks.forkSchema as never,
      mocks.job as never,
      mocks.library as never,
      mediaHealthRepository,
      mocks.media as never,
      mocks.physicalFile as never,
      mocks.storage as never,
      mocks.user as never,
      { validate: vi.fn().mockResolvedValue({ status: 'healthy' }) } as never,
      { getEnv: () => ({ storage: { ignoreMountCheckErrors: false, recoveryRoots } }) } as never,
      mediaOperationRepository,
      mediaOperationService,
      mocks.cron as never,
      mocks.database as never,
      mocks.systemMetadata as never,
      cloudBackupService as never,
      mocks.session as never,
      iCloudSyncRepository as never,
    );
    clearConfigCache();
    vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([]);
    vi.mocked(mediaHealthRepository.count).mockResolvedValue(0);
    vi.mocked(mocks.user.getList).mockResolvedValue([]);
    // no phone is asked unless a spec says so
    vi.mocked(mocks.session.getByUserId).mockResolvedValue([]);
    vi.mocked(mocks.library.getAll).mockResolvedValue([]);
    // a regular file that settled long ago; a recovery never touches a file still being written
    vi.mocked(mocks.storage.stat).mockResolvedValue(settledStat({ size: 10 }) as never);
    vi.mocked(mocks.storage.walkWithCursor).mockImplementation(async function* (cursor) {
      for await (const batch of mocks.storage.walk({
        pathsToCrawl: cursor.map(({ path }) => path),
        exclusionPatterns: [],
        includeHidden: false,
        take: 500,
      })) {
        for (const file of batch) {
          yield file;
        }
      }
      cursor.length = 0;
    });
  });

  describe('list and dismiss', () => {
    it('lists and dismisses only findings owned by the authenticated user', async () => {
      vi.mocked(mediaHealthRepository.list).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.count).mockResolvedValue(50_000);
      vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue(undefined);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([]);
      const auth = authStub.user1;

      await expect(sut.list(auth, { size: 10 })).resolves.toEqual({ buckets: [], total: 50_000, run: null });
      await sut.dismiss(auth, { ids: ['health-1'] });

      expect(mediaHealthRepository.list).toHaveBeenCalledWith({
        category: undefined,
        ownerId: auth.user.id,
        privacy: {},
        size: 10,
        offset: 0,
        status: undefined,
      });
      expect(mediaHealthRepository.count).toHaveBeenCalledWith({
        category: undefined,
        ownerId: auth.user.id,
        privacy: {},
        status: undefined,
      });
      expect(mediaHealthRepository.getLatestRun).toHaveBeenCalledWith(undefined, auth.user.id);
      expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['health-1'], auth.user.id, {});
      expect(mediaHealthRepository.markDismissed).toHaveBeenCalledWith([], auth.user.id);
    });

    it('lists only findings that still need a decision, a page at a time (FL-69)', async () => {
      vi.mocked(mediaHealthRepository.list).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue(undefined);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([]);

      await sut.list(authStub.user1, { size: 50, page: 3, needsAttention: true });

      const options = vi.mocked(mediaHealthRepository.list).mock.calls[0][0];
      expect(options).toMatchObject({ size: 50, offset: 100 });
      expect(options.statuses).toEqual(expect.arrayContaining([MediaHealthStatus.Missing, MediaHealthStatus.Found]));
      // Unsupported RAW and suspected damage stay open: they are kept, not resolved.
      expect(options.statuses).toEqual(
        expect.arrayContaining([MediaHealthStatus.UnsupportedRaw, MediaHealthStatus.CorruptSuspect]),
      );
      expect(options.statuses).not.toContain(MediaHealthStatus.Relinked);
      expect(options.statuses).not.toContain(MediaHealthStatus.Dismissed);
    });

    it('refuses another account, or every account, to anyone but an administrator (FL-69)', async () => {
      await expect(sut.list(authStub.user1, { ownerId: 'someone-else' })).rejects.toThrow('administrator');
      await expect(sut.list(authStub.user1, { allAccounts: true })).rejects.toThrow('administrator');
      await expect(sut.summary(authStub.user1, { allAccounts: true })).rejects.toThrow('administrator');
      expect(mediaHealthRepository.list).not.toHaveBeenCalled();
    });

    it('lets an administrator review every account, without anybody else’s Locked media (FL-69)', async () => {
      vi.mocked(mediaHealthRepository.list).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue(undefined);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([]);

      await sut.list(authStub.adminWithElevatedPermission, { allAccounts: true });

      // No owner filter; the Locked scope admits only the administrator's own Locked media.
      expect(mediaHealthRepository.list).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: undefined,
          privacy: { lockedOwnerId: authStub.admin.user.id, revealLockedOwnerId: authStub.admin.user.id },
        }),
      );
    });

    it('lets an administrator act on any account’s findings through the same privacy (FL-69)', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([{ id: 'health-1' }] as never);

      await sut.dismiss(authStub.admin, { ids: ['health-1'] });

      expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['health-1'], undefined, {});
      expect(mediaHealthRepository.markDismissed).toHaveBeenCalledWith(['health-1'], undefined);
    });

    it("includes the caller's Locked media only in an elevated session (FL-34)", async () => {
      vi.mocked(mediaHealthRepository.list).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue(undefined);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([]);

      await sut.list(elevatedOwner, { size: 10 });
      await sut.dismiss(elevatedOwner, { ids: ['health-1'] });

      const privacy = { lockedOwnerId: authStub.user1.user.id, revealLockedOwnerId: authStub.user1.user.id };
      expect(mediaHealthRepository.list).toHaveBeenCalledWith(expect.objectContaining({ privacy }));
      expect(mediaHealthRepository.count).toHaveBeenCalledWith(expect.objectContaining({ privacy }));
      expect(mediaHealthRepository.getAssets).toHaveBeenCalledWith([], authStub.user1.user.id, privacy);
      expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['health-1'], authStub.user1.user.id, privacy);
    });

    it("reports the owner's Locked media as locked in an elevated list (FL-34)", async () => {
      // the stored visibility stays `timeline`; the lock record the repository selects makes it Locked
      const asset = {
        ...AssetFactory.create({
          id: 'asset-1',
          ownerId: authStub.adminWithElevatedPermission.user.id,
          originalPath: '/data/upload/admin/locked.jpg',
          originalFileName: 'locked.jpg',
          visibility: AssetVisibility.Timeline,
        }),
        isLocked: true,
      };
      vi.mocked(mediaHealthRepository.list).mockResolvedValue([
        {
          id: 'health-1',
          assetId: asset.id,
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Missing,
          severity: MediaHealthSeverity.Warning,
          originalPath: asset.originalPath,
          originalFileName: asset.originalFileName,
          evidence: {},
          resolution: {},
          checkedAt: new Date('2026-09-04T00:00:00Z'),
          dismissedAt: null,
          resolvedAt: null,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue(undefined);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([]);
      vi.mocked(mocks.user.get).mockResolvedValue({ id: asset.ownerId, storageLabel: null } as never);

      const result = await sut.list(authStub.adminWithElevatedPermission, { size: 10 });

      expect(result.buckets[0].items[0].asset).toEqual(
        expect.objectContaining({ id: asset.id, visibility: AssetVisibility.Locked }),
      );
    });
  });

  describe('candidate paths', () => {
    const map = (
      candidate: Record<string, unknown>,
      ownerRoots: string[] | null,
      roots: unknown[] = [],
      auth = authStub.user1,
    ) =>
      (sut as any).mapCandidateForRoots(
        { checkedAt: new Date('2026-09-04T00:00:00Z'), visualMatchScore: 1, resolution: {}, ...candidate },
        ownerRoots,
        roots,
        false,
        auth,
      );

    it('redacts candidates found in another user directory', () => {
      const mapped = map(
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: '/data/upload/user-2/private.jpg',
          status: MediaHealthStatus.Found,
          evidence: { path: '/data/upload/user-2/private.jpg', reason: 'checksum_match', algorithms: ['sha1'] },
        },
        ['/data/upload/user-1', '/data/library/user-1'],
      );

      expect(mapped).toEqual(
        expect.objectContaining({
          candidatePath: 'Exact checksum match in another user directory',
          evidence: { reason: 'checksum_match', algorithms: ['sha1'] },
          checksumMatch: true,
        }),
      );
      expect(JSON.stringify(mapped)).not.toContain('user-2');
    });

    it('keeps external-library candidate paths visible', () => {
      const mapped = map(
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: '/external/photos/found.jpg',
          status: MediaHealthStatus.Found,
          evidence: { path: '/external/photos/found.jpg' },
        },
        null,
      );

      expect(mapped.candidatePath).toBe('/external/photos/found.jpg');
    });

    it('shows a recovery location path to an administrator only (FL-69)', () => {
      const rootId = recoveryRootId('/mnt/backup/photos');
      const roots = [{ id: rootId, kind: 'recovery', label: 'Verified backup', paths: ['/mnt/backup/photos'] }];
      const candidate = {
        id: 'candidate-1',
        healthId: 'health-1',
        candidatePath: '/mnt/backup/photos/2026/forest.ARW',
        status: MediaHealthStatus.Found,
        evidence: { path: '/mnt/backup/photos/2026/forest.ARW', rootId, rootKind: 'recovery', decodeValid: true },
      };

      const owner = map(candidate, ['/data/upload/user-id'], roots);
      expect(owner).toMatchObject({
        candidatePath: 'Exact checksum match in a recovery location',
        rootId,
        rootKind: 'recovery',
        decodeValid: true,
      });
      expect(JSON.stringify(owner)).not.toContain('/mnt/backup');
      expect(map(candidate, ['/data/upload/admin_id'], roots, authStub.admin).candidatePath).toBe(
        '/mnt/backup/photos/2026/forest.ARW',
      );
    });

    it('keeps recovery provenance and foreign paths out of a non-administrator’s finding evidence', () => {
      const evidence = {
        reason: 'recovered_from_verified_copy',
        candidatePath: '/mnt/backup/photos/forest.jpg',
        previousPath: '/data/upload/user-id/forest.jpg',
        retainedPath: '/data/upload/user-id/ab/cd/.library-care/asset-finding.damaged.jpg',
        provenance: { rootLabel: 'Verified backup', recoveredBy: 'admin_id' },
      };
      const roots = ['/data/upload/user-id', '/data/library/user-id'];

      expect((sut as any).findingEvidenceFor(evidence, roots, authStub.user1)).toEqual({
        reason: 'recovered_from_verified_copy',
        previousPath: '/data/upload/user-id/forest.jpg',
        retainedPath: '/data/upload/user-id/ab/cd/.library-care/asset-finding.damaged.jpg',
      });
      expect((sut as any).findingEvidenceFor(evidence, roots, authStub.admin)).toEqual(evidence);
    });

    it('redacts a relinked foreign path from the finding and mapped asset', async () => {
      const asset = AssetFactory.create({
        id: 'asset-1',
        ownerId: authStub.admin.user.id,
        originalPath: '/data/upload/user-2/private.jpg',
        originalFileName: 'private.jpg',
      });
      vi.mocked(mediaHealthRepository.list).mockResolvedValue([
        {
          id: 'health-1',
          assetId: asset.id,
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Relinked,
          severity: MediaHealthSeverity.Info,
          originalPath: asset.originalPath,
          originalFileName: asset.originalFileName,
          evidence: {},
          resolution: {},
          checkedAt: new Date('2026-09-04T00:00:00Z'),
          dismissedAt: null,
          resolvedAt: new Date('2026-09-04T00:00:00Z'),
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue(undefined);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([]);
      vi.mocked(mocks.user.get).mockResolvedValue({ id: authStub.admin.user.id, storageLabel: null } as never);

      const result = await sut.list(authStub.admin, { size: 10 });

      expect(result.buckets[0].items[0]).toEqual(
        expect.objectContaining({
          originalPath: 'Managed file in another user directory',
          asset: expect.objectContaining({ originalPath: 'Managed file in another user directory' }),
        }),
      );
      expect(JSON.stringify(result)).not.toContain('user-2');
    });
  });

  describe('summary and roots', () => {
    it('counts each queue with the list’s own scope and privacy (FL-69)', async () => {
      vi.mocked(mediaHealthRepository.countByStatus).mockResolvedValue([
        { category: MediaHealthCategory.Missing, status: MediaHealthStatus.Missing, count: 2 },
        { category: MediaHealthCategory.Missing, status: MediaHealthStatus.Found, count: 1 },
        { category: MediaHealthCategory.Missing, status: MediaHealthStatus.Relinked, count: 9 },
        { category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.CorruptConfirmed, count: 3 },
        { category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.CorruptSuspect, count: 4 },
        { category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.UnsupportedRaw, count: 5 },
      ]);
      vi.mocked(mediaHealthRepository.countDuplicateGroups).mockResolvedValue(6);
      vi.mocked(mediaHealthRepository.countImportReview).mockResolvedValue(7);
      vi.mocked(mediaHealthRepository.countPendingMetadata).mockResolvedValue(8);
      vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue(undefined);

      const summary = await sut.summary(elevatedOwner, {});

      expect(summary.queues).toEqual({
        missing: 3,
        missingVerified: 1,
        damagedConfirmed: 3,
        damagedSuspected: 4,
        unsupportedRaw: 5,
        duplicates: 6,
        importReview: 7,
        enrichmentPending: 8,
      });
      const privacy = { lockedOwnerId: authStub.user1.user.id, revealLockedOwnerId: authStub.user1.user.id };
      expect(mediaHealthRepository.countByStatus).toHaveBeenCalledWith({ ownerId: authStub.user1.user.id, privacy });
      expect(mediaHealthRepository.countDuplicateGroups).toHaveBeenCalledWith({
        ownerId: authStub.user1.user.id,
        privacy,
      });
      expect(summary.recoveryAvailable).toBe(false);
    });

    it('reports the latest scan and recent Library Care jobs, and nothing else', async () => {
      vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue(undefined);
      const job = (overrides: Record<string, unknown>) => ({
        id: '0195e2a0-0000-7000-8000-000000000001',
        status: MediaOperationStatus.Rendering,
        progress: 12.5,
        processedUnits: '25',
        totalUnits: '200',
        pauseRequestedAt: null,
        cancelRequestedAt: null,
        autoRetries: 0,
        error: null,
        createdAt: new Date('2026-09-23T10:00:00Z'),
        updatedAt: new Date('2026-09-23T10:01:00Z'),
        finishedAt: null,
        ...overrides,
      });
      vi.mocked(mediaOperationRepository.list).mockImplementation(
        ({ kind }) =>
          Promise.resolve({
            items:
              kind === MediaOperationKind.MediaHealth
                ? [job({ kind, snapshot: { mode: 'scan', userId: 'user-id' } })]
                : [
                    job({
                      id: '0195e2a0-0000-7000-8000-000000000002',
                      kind,
                      snapshot: { action: MediaOperationBulkAction.RelinkMissingMedia },
                      createdAt: new Date('2026-09-23T09:00:00Z'),
                    }),
                    job({ id: '0195e2a0-0000-7000-8000-000000000003', kind, snapshot: { action: 'favorite' } }),
                  ],
            total: 1,
          }) as never,
      );

      const summary = await sut.summary(authStub.user1, {});

      expect(summary.operation).toMatchObject({ mode: 'scan', processedUnits: 25, totalUnits: 200, progress: 12.5 });
      expect(summary.recent.map(({ action }) => action)).toEqual(['scan', 'relink-missing-media']);
      expect(mediaOperationRepository.list).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: authStub.user1.user.id, kind: MediaOperationKind.MediaHealth }),
      );
    });

    it('settles a run whose job ended without its worker, and releases stale trash (FL-69)', async () => {
      vi.mocked(mediaHealthRepository.getLatestRun).mockImplementation((category) =>
        Promise.resolve(
          category === MediaHealthCategory.Missing
            ? ({ id: 'missing-run', status: 'running', startedAt: new Date(), finishedAt: null } as never)
            : ({ id: 'corrupt-run', status: 'completed', startedAt: new Date(), finishedAt: new Date() } as never),
        ),
      );
      vi.mocked(mediaOperationRepository.list).mockImplementation(
        ({ kind }) =>
          Promise.resolve({
            items:
              kind === MediaOperationKind.MediaHealth
                ? [
                    {
                      id: 'job',
                      status: MediaOperationStatus.Cancelled,
                      snapshot: { mode: 'scan' },
                      createdAt: new Date(),
                    },
                  ]
                : [],
            total: 0,
          }) as never,
      );
      vi.mocked(mediaHealthRepository.getActiveTrashFindingIds).mockResolvedValue(['held']);

      await sut.summary(authStub.user1, {});

      expect(mediaHealthRepository.finishRun).toHaveBeenCalledTimes(1);
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith('missing-run', { status: 'cancelled', error: null });
      expect(mediaHealthRepository.releaseTrashQueued).toHaveBeenCalledWith({
        keep: ['held'],
        olderThan: expect.any(Date),
      });
    });

    it('leaves the runs of a job that is still running alone', async () => {
      vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue({ id: 'run', status: 'paused' } as never);
      vi.mocked(mediaOperationRepository.list).mockImplementation(
        ({ kind }) =>
          Promise.resolve({
            items:
              kind === MediaOperationKind.MediaHealth
                ? [
                    {
                      id: 'job',
                      status: MediaOperationStatus.Paused,
                      snapshot: { mode: 'scan' },
                      createdAt: new Date(),
                    },
                  ]
                : [],
            total: 0,
          }) as never,
      );

      await sut.summary(authStub.user1, {});

      expect(mediaHealthRepository.finishRun).not.toHaveBeenCalled();
    });

    it('offers recovery locations to administrators only', async () => {
      recoveryRoots.push({ label: 'Verified backup', path: '/mnt/backup/photos' });
      vi.mocked(mocks.user.get).mockResolvedValue({ id: 'user-id', storageLabel: null } as never);
      vi.mocked(mocks.library.getAll).mockResolvedValue([
        { id: 'library-1', ownerId: 'user-id', name: 'Archive', importPaths: ['/external/archive'] },
        { id: 'library-2', ownerId: 'someone-else', name: 'Theirs', importPaths: ['/external/theirs'] },
      ] as never);

      const owner = await sut.getRoots(authStub.user1);
      expect(owner.roots.map(({ id }) => id)).toEqual([MANAGED_ROOT_ID, 'library:library-1']);

      const admin = await sut.getRoots(authStub.admin);
      expect(admin.roots.map(({ kind }) => kind)).toEqual(['managed', 'library', 'library', 'recovery']);
      expect(admin.roots.at(-1)).toMatchObject({
        id: recoveryRootId('/mnt/backup/photos'),
        label: 'Verified backup',
        paths: ['/mnt/backup/photos'],
      });
    });
  });

  describe('durable scans and searches (FL-69)', () => {
    it('queues one owner-scoped combined scan as a media operation', async () => {
      vi.mocked(mediaHealthRepository.createRun)
        .mockResolvedValueOnce({ id: 'missing-run' } as never)
        .mockResolvedValueOnce({ id: 'corrupt-run' } as never);

      await expect(sut.startMissingScan(authStub.user1)).resolves.toEqual({
        runId: 'missing-run',
        operationId: '0195e2a0-0000-7000-8000-0000000000c1',
      });

      expect(mediaOperationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: authStub.user1.user.id,
          kind: MediaOperationKind.MediaHealth,
          snapshot: {
            mode: 'scan',
            userId: authStub.user1.user.id,
            missingRunId: 'missing-run',
            corruptRunId: 'corrupt-run',
          },
        }),
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('scans only the chosen photos this person may see (FL-737)', async () => {
      vi.mocked(mediaHealthRepository.createRun)
        .mockResolvedValueOnce({ id: 'missing-run' } as never)
        .mockResolvedValueOnce({ id: 'corrupt-run' } as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([{ id: 'asset-1' }] as never);

      await sut.startMissingScan(authStub.user1, { assetIds: ['asset-1', 'asset-1', 'asset-other'] });

      expect(mediaHealthRepository.getAssets).toHaveBeenCalledWith(
        ['asset-1', 'asset-other'],
        authStub.user1.user.id,
        expect.anything(),
      );
      expect(mediaOperationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: {
            mode: 'scan',
            userId: authStub.user1.user.id,
            missingRunId: 'missing-run',
            corruptRunId: 'corrupt-run',
            assetIds: ['asset-1'],
          },
        }),
      );
    });

    it('refuses a scan of photos this person cannot see (FL-737)', async () => {
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([]);

      await expect(sut.startCorruptScan(authStub.user1, { assetIds: ['asset-other'] })).rejects.toThrow(
        'None of these photos can be scanned',
      );
      expect(mediaOperationRepository.create).not.toHaveBeenCalled();
    });

    it.each([
      { active: ['asset-1'], requested: ['asset-2'], label: 'other chosen photos' },
      { active: ['asset-1'], requested: undefined, label: 'the whole library' },
    ])('refuses a scan of $label while a scan of chosen photos runs (FL-737)', async ({ active, requested }) => {
      vi.mocked(mediaOperationRepository.list).mockResolvedValue({
        items: [
          {
            id: '0195e2a0-0000-7000-8000-0000000000d1',
            snapshot: { mode: 'scan', userId: 'user-id', missingRunId: 'm', corruptRunId: 'c', assetIds: active },
          },
        ],
        total: 1,
      } as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([{ id: 'asset-2' }] as never);

      await expect(sut.startMissingScan(authStub.user1, requested && { assetIds: requested })).rejects.toThrow(
        'A scan of other photos is running',
      );
      expect(mediaOperationRepository.create).not.toHaveBeenCalled();
    });

    it('refuses a scan of chosen photos while an incremental scan runs (FL-737)', async () => {
      vi.mocked(mediaOperationRepository.list).mockResolvedValue({
        items: [
          {
            id: '0195e2a0-0000-7000-8000-0000000000d1',
            snapshot: {
              mode: 'scan',
              userId: 'user-id',
              missingRunId: 'm',
              corruptRunId: 'c',
              changedSince: '2026-10-31T02:00:00.000Z',
            },
          },
        ],
        total: 1,
      } as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([{ id: 'asset-2' }] as never);

      await expect(sut.startMissingScan(authStub.user1, { assetIds: ['asset-2'] })).rejects.toThrow(
        'A scan of other photos is running',
      );
      expect(mediaOperationRepository.create).not.toHaveBeenCalled();
    });

    it('refuses a whole-library scan while an incremental scan runs (FL-737)', async () => {
      vi.mocked(mediaOperationRepository.list).mockResolvedValue({
        items: [
          {
            id: '0195e2a0-0000-7000-8000-0000000000d1',
            snapshot: {
              mode: 'scan',
              userId: 'user-id',
              missingRunId: 'm',
              corruptRunId: 'c',
              changedSince: '2026-10-31T02:00:00.000Z',
            },
          },
        ],
        total: 1,
      } as never);

      await expect(sut.startMissingScan(authStub.user1)).rejects.toThrow('A scan of other photos is running');
      expect(mediaOperationRepository.create).not.toHaveBeenCalled();
    });

    it('answers a scan of chosen photos with the full scan already under way (FL-737)', async () => {
      vi.mocked(mediaOperationRepository.list).mockResolvedValue({
        items: [
          {
            id: '0195e2a0-0000-7000-8000-0000000000d1',
            snapshot: { mode: 'scan', userId: 'user-id', missingRunId: 'm', corruptRunId: 'c' },
          },
        ],
        total: 1,
      } as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([{ id: 'asset-2' }] as never);

      await expect(sut.startCorruptScan(authStub.user1, { assetIds: ['asset-2'] })).resolves.toEqual({
        runId: 'c',
        operationId: '0195e2a0-0000-7000-8000-0000000000d1',
      });
      expect(mediaOperationRepository.create).not.toHaveBeenCalled();
    });

    it('answers a second scan request with the scan already under way', async () => {
      vi.mocked(mediaOperationRepository.list).mockResolvedValue({
        items: [
          {
            id: '0195e2a0-0000-7000-8000-0000000000d1',
            snapshot: { mode: 'scan', userId: 'user-id', missingRunId: 'missing-run', corruptRunId: 'corrupt-run' },
          },
        ],
        total: 1,
      } as never);

      await expect(sut.startCorruptScan(authStub.user1)).resolves.toEqual({
        runId: 'corrupt-run',
        operationId: '0195e2a0-0000-7000-8000-0000000000d1',
      });
      expect(mediaHealthRepository.createRun).not.toHaveBeenCalled();
      expect(mediaOperationRepository.create).not.toHaveBeenCalled();
    });

    it('marks both runs failed when the scan cannot be queued', async () => {
      vi.mocked(mediaHealthRepository.createRun)
        .mockResolvedValueOnce({ id: 'missing-run' } as never)
        .mockResolvedValueOnce({ id: 'corrupt-run' } as never);
      vi.mocked(mediaOperationRepository.create).mockRejectedValueOnce(new Error('database down'));

      await expect(sut.startMissingScan(authStub.user1)).rejects.toThrow('database down');

      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'missing-run',
        expect.objectContaining({ status: 'failed' }),
      );
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'corrupt-run',
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('queues a search of the chosen locations for the reader’s own findings', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Missing,
        },
        {
          id: 'health-2',
          assetId: 'asset-2',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.UnsupportedRaw,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([{ id: 'asset-1', ownerId: 'user-id' }] as never);
      vi.mocked(mediaHealthRepository.createRun).mockResolvedValue({ id: 'run-1' } as never);
      vi.mocked(mocks.user.get).mockResolvedValue({ id: 'user-id', storageLabel: null } as never);

      await expect(
        sut.locateMissing(authStub.user1, { ids: ['health-1', 'health-2'], rootIds: [MANAGED_ROOT_ID] }),
      ).resolves.toEqual({ runId: 'run-1', operationId: '0195e2a0-0000-7000-8000-0000000000c1' });

      expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['health-1', 'health-2'], 'user-id', {});
      // Unsupported RAW is never searched for a replacement.
      expect(mediaOperationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.MediaHealth,
          snapshot: {
            mode: 'locate',
            userId: 'user-id',
            runId: 'run-1',
            findingIds: ['health-1'],
            rootIds: [MANAGED_ROOT_ID],
            anyOwner: false,
          },
        }),
      );
    });

    it('refuses a recovery location to anyone but an administrator', async () => {
      recoveryRoots.push({ label: 'Verified backup', path: '/mnt/backup/photos' });
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Missing,
        },
      ] as never);
      vi.mocked(mocks.user.get).mockResolvedValue({ id: 'user-id', storageLabel: null } as never);

      await expect(
        sut.locateMissing(authStub.user1, { ids: ['health-1'], rootIds: [recoveryRootId('/mnt/backup/photos')] }),
      ).rejects.toThrow('not available');
      expect(mediaOperationRepository.create).not.toHaveBeenCalled();
    });

    it('does not search hidden findings from a non-elevated privacy session', async () => {
      const auth = { ...authStub.user1, hideNsfwAssets: true };
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([] as never);

      await expect(sut.locateMissing(auth, { ids: ['visible-health', 'hidden-health'] })).rejects.toThrow(
        'Choose missing originals',
      );

      expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['visible-health', 'hidden-health'], auth.user.id, {
        excludeNsfw: true,
      });
    });

    it('runs one search or scan at a time for each account', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Missing,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([] as never);
      vi.mocked(mediaOperationRepository.list).mockResolvedValue({
        items: [{ id: 'busy', snapshot: { mode: 'scan', userId: 'user-id', missingRunId: 'm', corruptRunId: 'c' } }],
        total: 1,
      } as never);

      await expect(sut.locateMissing(authStub.user1, { ids: ['health-1'] })).rejects.toMatchObject({ status: 409 });
      expect(mediaHealthRepository.createRun).not.toHaveBeenCalled();
    });

    it('checks an administrator search of other accounts again when it runs', async () => {
      vi.mocked(mocks.user.get).mockResolvedValue({ id: 'user-id', isAdmin: false } as never);

      await expect(
        sut.locateStep(
          {
            mode: 'locate',
            userId: 'user-id',
            runId: 'run-1',
            findingIds: ['health-1'],
            rootIds: null,
            anyOwner: true,
          },
          null,
        ),
      ).rejects.toThrow('administrator');
    });

    it('scans a page of assets in id order and reports what it found', async () => {
      const assets = ['a-1', 'a-2', 'a-3'].map((id) => ({ id, originalPath: `/data/${id}.jpg` }));
      vi.mocked(mediaHealthRepository.getAssetPage).mockResolvedValue(assets as never);
      const scanAsset = vi
        .spyOn(sut as any, 'scanAsset')
        .mockResolvedValueOnce('missing')
        .mockResolvedValueOnce('healthy')
        .mockResolvedValueOnce('corrupt');
      const snapshot = { mode: 'scan' as const, userId: 'user-id', missingRunId: 'm', corruptRunId: 'c' };

      await expect(sut.scanPage(snapshot, 'a-0', 25)).resolves.toEqual({
        checked: 3,
        missing: 1,
        corrupt: 1,
        lastId: 'a-3',
      });
      expect(mediaHealthRepository.getAssetPage).toHaveBeenCalledWith({
        ownerId: 'user-id',
        afterId: 'a-0',
        limit: 25,
      });
      expect(scanAsset).toHaveBeenCalledWith(assets[0], 'm', 'c', { checksumScan: true });
    });

    it('keeps a paused run open and closes a finished one', async () => {
      const snapshot = { mode: 'scan' as const, userId: 'user-id', missingRunId: 'm', corruptRunId: 'c' };

      await sut.setRunState(snapshot, 'paused', { checked: 5, missing: 1, corrupt: 2 });
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'm',
        expect.objectContaining({ status: 'paused', finishedAt: null, checkedAssets: 5, foundAssets: 1 }),
      );

      vi.mocked(mediaHealthRepository.finishRun).mockClear();
      await sut.setRunState(snapshot, 'completed', { checked: 9, missing: 1, corrupt: 2 });
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'c',
        expect.not.objectContaining({ finishedAt: null }),
      );
    });
  });

  describe('deleteCorrupt', () => {
    it('queues a durable trash job after revalidating confirmed corrupt media', async () => {
      vi.mocked(mocks.user.getForPinCode).mockResolvedValue({ password: '', pinCode: null });
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.CorruptConfirmed,
          checkedAt: new Date(),
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          originalPath: '/library/file.jpg',
          originalFileName: 'file.jpg',
          type: AssetType.Image,
        },
      ] as never);
      vi.spyOn(sut as any, 'validateAssetIntegrity').mockResolvedValue({
        status: MediaHealthStatus.CorruptConfirmed,
        score: null,
        evidence: {},
        resolution: {},
      });

      await expect(
        sut.deleteCorrupt(authStub.user1, { ids: ['health-1'], confirmText: CORRUPT_MEDIA_DELETE_CONFIRM_TEXT }),
      ).resolves.toEqual({
        results: [{ id: 'health-1', success: true, status: MediaHealthStatus.TrashQueued }],
        operationId: '0195e2a0-0000-7000-8000-0000000000b1',
      });

      expect(mediaHealthRepository.markStatus).toHaveBeenCalledWith(['health-1'], MediaHealthStatus.TrashQueued);
      expect(mediaOperationService.createBulk).toHaveBeenCalledWith(
        authStub.user1,
        expect.objectContaining({
          action: MediaOperationBulkAction.TrashDamagedMedia,
          assetIds: ['asset-1'],
          payload: { mediaHealth: [{ assetId: 'asset-1', findingId: 'health-1' }] },
        }),
        { libraryCare: true },
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('requires the typed confirmation, and the PIN when the account has one', async () => {
      await expect(sut.deleteCorrupt(authStub.user1, { ids: ['health-1'], confirmText: 'yes' })).rejects.toThrow(
        CORRUPT_MEDIA_DELETE_CONFIRM_TEXT,
      );
      vi.mocked(mocks.user.getForPinCode).mockResolvedValue({ password: '', pinCode: 'hash' });
      await expect(
        sut.deleteCorrupt(authStub.user1, { ids: ['health-1'], confirmText: CORRUPT_MEDIA_DELETE_CONFIRM_TEXT }),
      ).rejects.toThrow('PIN');
      expect(mediaOperationService.createBulk).not.toHaveBeenCalled();
    });

    it('never queues evidence older than a day or findings that are not confirmed damage', async () => {
      vi.mocked(mocks.user.getForPinCode).mockResolvedValue({ password: '', pinCode: null });
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'old',
          assetId: 'asset-1',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.CorruptConfirmed,
          checkedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        },
        {
          id: 'raw',
          assetId: 'asset-2',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.UnsupportedRaw,
          checkedAt: new Date(),
        },
      ] as never);

      await expect(
        sut.deleteCorrupt(authStub.user1, { ids: ['old', 'raw'], confirmText: CORRUPT_MEDIA_DELETE_CONFIRM_TEXT }),
      ).rejects.toThrow('No recently confirmed');
      expect(mediaOperationService.createBulk).not.toHaveBeenCalled();
    });
  });

  describe('relinkMissing and recoverDamaged submit', () => {
    const found = (overrides: Record<string, unknown> = {}) => ({
      id: 'candidate-1',
      healthId: 'health-1',
      candidatePath: '/data/upload/user-id/found.jpg',
      status: MediaHealthStatus.Found,
      evidence: { reason: 'checksum_match', algorithms: ['sha1'], decodeValid: true, rootId: MANAGED_ROOT_ID },
      resolution: { autoRelinkable: true },
      ...overrides,
    });

    it('queues a durable relink for findings with exactly one verified copy', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing, status: MediaHealthStatus.Found },
        { id: 'health-2', assetId: 'asset-2', category: MediaHealthCategory.Missing, status: MediaHealthStatus.Found },
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        found(),
        found({ id: 'candidate-2', healthId: 'health-2' }),
        found({ id: 'candidate-3', healthId: 'health-2', candidatePath: '/data/upload/user-id/other.jpg' }),
      ] as never);

      const response = await sut.relinkMissing(authStub.user1, { ids: ['health-1', 'health-2'] });

      expect(response.results).toEqual([
        { id: 'health-1', success: true, status: MediaHealthStatus.Found },
        expect.objectContaining({ id: 'health-2', success: false }),
      ]);
      expect(mediaOperationService.createBulk).toHaveBeenCalledWith(
        authStub.user1,
        expect.objectContaining({
          action: MediaOperationBulkAction.RelinkMissingMedia,
          assetIds: ['asset-1'],
          payload: { mediaHealth: [{ assetId: 'asset-1', findingId: 'health-1', candidateId: 'candidate-1' }] },
        }),
        { libraryCare: true },
      );
    });

    it('relinks to the copy the reviewer chose among several', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Found,
          resolution: { chosenCandidateId: 'candidate-2' },
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        found(),
        found({ id: 'candidate-2', candidatePath: '/data/upload/user-id/copy.jpg' }),
      ] as never);

      await sut.relinkMissing(authStub.user1, { ids: ['health-1'] });

      expect(mediaOperationService.createBulk).toHaveBeenCalledWith(
        authStub.user1,
        expect.objectContaining({
          payload: { mediaHealth: [{ assetId: 'asset-1', findingId: 'health-1', candidateId: 'candidate-2' }] },
        }),
        { libraryCare: true },
      );
    });

    it('queues nothing when no finding has a verified copy', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing, status: MediaHealthStatus.Found },
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        found({ resolution: { autoRelinkable: false } }),
      ] as never);

      await expect(sut.relinkMissing(authStub.user1, { ids: ['health-1'] })).resolves.toMatchObject({
        operationId: null,
      });
      expect(mediaOperationService.createBulk).not.toHaveBeenCalled();
    });

    it('records a chosen candidate only when it is a verified copy of a missing original', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing, status: MediaHealthStatus.Found },
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        found(),
        found({ id: 'different', status: MediaHealthStatus.Candidate }),
      ] as never);

      const response = await sut.chooseCandidates(authStub.user1, {
        choices: [
          { findingId: 'health-1', candidateId: 'different' },
          { findingId: 'health-1', candidateId: 'candidate-1' },
        ],
      });

      expect(response.results.map(({ success }) => success)).toEqual([false, true]);
      expect(mediaHealthRepository.setChosenCandidate).toHaveBeenCalledTimes(1);
      expect(mediaHealthRepository.setChosenCandidate).toHaveBeenCalledWith('health-1', 'candidate-1');
    });

    it('recovers only confirmed damage, from an exact decoded copy, with explicit consent', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.CorruptConfirmed,
        },
        {
          id: 'raw',
          assetId: 'asset-2',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.UnsupportedRaw,
        },
        {
          id: 'undecoded',
          assetId: 'asset-3',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.CorruptConfirmed,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        found(),
        found({ id: 'c-raw', healthId: 'raw' }),
        found({ id: 'c-undecoded', healthId: 'undecoded', evidence: { algorithms: ['sha1'], decodeValid: null } }),
      ] as never);

      await expect(
        sut.recoverDamaged(authStub.user1, {
          choices: [{ findingId: 'health-1', candidateId: 'candidate-1' }],
          confirmed: false,
        }),
      ).rejects.toThrow('Confirm');

      const response = await sut.recoverDamaged(authStub.user1, {
        choices: [
          { findingId: 'health-1', candidateId: 'candidate-1' },
          { findingId: 'raw', candidateId: 'c-raw' },
          { findingId: 'undecoded', candidateId: 'c-undecoded' },
        ],
        confirmed: true,
      });

      expect(response.results.map(({ id, success }) => [id, success])).toEqual([
        ['health-1', true],
        ['raw', false],
        ['undecoded', false],
      ]);
      expect(mediaHealthRepository.setChosenCandidate).toHaveBeenCalledWith('health-1', 'candidate-1');
      expect(mediaOperationService.createBulk).toHaveBeenCalledWith(
        authStub.user1,
        expect.objectContaining({
          action: MediaOperationBulkAction.RecoverDamagedMedia,
          assetIds: ['asset-1'],
        }),
        { libraryCare: true },
      );
    });

    it('never relinks or chooses a recovery-location copy for a non-administrator', async () => {
      const recovery = { algorithms: ['sha1'], decodeValid: true, rootId: recoveryRootId('/mnt/backup') };
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing, status: MediaHealthStatus.Found },
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        found({ evidence: recovery }),
      ] as never);

      await expect(sut.relinkMissing(authStub.user1, { ids: ['health-1'] })).resolves.toMatchObject({
        operationId: null,
      });
      const chosen = await sut.chooseCandidates(authStub.user1, {
        choices: [{ findingId: 'health-1', candidateId: 'candidate-1' }],
      });
      expect(chosen.results[0]).toMatchObject({ success: false, error: 'Location not available' });
      expect(mediaHealthRepository.setChosenCandidate).not.toHaveBeenCalled();
    });

    it('keeps recovery locations an administrator’s', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.CorruptConfirmed,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        found({ evidence: { algorithms: ['sha1'], decodeValid: true, rootId: recoveryRootId('/mnt/backup') } }),
      ] as never);

      const response = await sut.recoverDamaged(authStub.user1, {
        choices: [{ findingId: 'health-1', candidateId: 'candidate-1' }],
        confirmed: true,
      });

      expect(response.results[0]).toMatchObject({ success: false, error: 'Location not available' });
      expect(mediaOperationService.createBulk).not.toHaveBeenCalled();
    });
  });

  describe('applyBulkEntry', () => {
    const sha1 = Buffer.alloc(20, 1);
    const sha256 = Buffer.alloc(32, 2);
    const entry = { assetId: 'asset-1', findingId: 'health-1', candidateId: 'candidate-1' };
    const worker = (overrides: Record<string, unknown> = {}) =>
      ({
        user: { ...authStub.user1.user, ...overrides },
        session: { id: 'worker', hasElevatedPermission: true },
      }) as never;
    const missingAsset = (overrides: Record<string, unknown> = {}) => ({
      id: 'asset-1',
      ownerId: 'user-id',
      updateId: 'update-1',
      checksum: sha1,
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
      originalPath: '/data/upload/user-id/missing.jpg',
      originalFileName: 'missing.jpg',
      type: AssetType.Image,
      isExternal: false,
      libraryId: null,
      deletedAt: null,
      ...overrides,
    });
    const finding = (overrides: Record<string, unknown> = {}) => ({
      id: 'health-1',
      assetId: 'asset-1',
      category: MediaHealthCategory.Missing,
      status: MediaHealthStatus.Found,
      resolution: { autoRelinkable: true },
      ...overrides,
    });

    it('relinks a verified copy in library storage, re-hashing it now', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([finding()] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([missingAsset()] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: '/data/upload/user-2/private-name.jpg',
          status: MediaHealthStatus.Found,
          evidence: { rootId: MANAGED_ROOT_ID },
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([
        { assetId: 'asset-1', sha1, sha256, sizeInBytes: 10 },
      ]);
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({ sha1, sha256, sizeInBytes: 10 });
      vi.mocked(mocks.storage.stat).mockResolvedValue({ mtime: new Date('2026-09-04T00:00:00Z') } as never);
      vi.mocked(mediaHealthRepository.relinkManagedAsset).mockImplementation(async (input) => {
        expect(await input.verifyCandidate()).toEqual({ sha1, sha256, sizeInBytes: 10 });
        return true;
      });

      await expect(sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry)).resolves.toEqual({
        id: 'asset-1',
        status: MediaOperationItemStatus.Ok,
      });

      expect(mediaHealthRepository.relinkManagedAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: 'asset-1',
          candidateId: 'candidate-1',
          ownerId: 'user-id',
          healthId: 'health-1',
          expectedOriginalPath: '/data/upload/user-id/missing.jpg',
          originalPath: '/data/upload/user-2/private-name.jpg',
          originalFileName: 'missing.jpg',
        }),
      );
      // its details are read again as work of the asking job's run, which keeps an import's metadata rules; its
      // previews outside it, as the run may already hold this photo's finished thumbnails (11b)
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SidecarCheck, data: { id: 'asset-1', source: 'upload' } },
      ]);
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith([
        { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
      ]);
      // FL-845: what failed on the old file is cleared first, so a step set aside after it never blocks the new one
      expect(mediaHealthRepository.clearProcessingFailures).toHaveBeenCalledWith('asset-1');
      const cleared = vi.mocked(mediaHealthRepository.clearProcessingFailures).mock.invocationCallOrder[0];
      expect(cleared).toBeLessThan(vi.mocked(mocks.job.queueAll).mock.invocationCallOrder[0]);
      expect(cleared).toBeLessThan(vi.mocked(mocks.job.queueOutsideRun).mock.invocationCallOrder[0]);
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.FileDelete }));
    });

    it.each([
      { matches: true, pathHash: false, relinked: true },
      { matches: true, pathHash: true, relinked: false },
      { matches: false, pathHash: false, relinked: false },
    ])('requires a fresh hash match for an external relink ($matches, path hash $pathHash)', async (row) => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([finding()] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        missingAsset({
          checksumAlgorithm: row.pathHash ? ChecksumAlgorithm.sha1Path : ChecksumAlgorithm.sha1File,
          originalPath: '/external/old/original.mp4',
          isExternal: true,
          libraryId: 'library-1',
        }),
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        { id: 'candidate-1', healthId: 'health-1', candidatePath: '/external/new/original.mp4', status: 'found' },
      ] as never);
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({
        sha1: row.matches ? sha1 : Buffer.alloc(20, 9),
        sha256,
        sizeInBytes: 10,
      });
      vi.mocked(mediaHealthRepository.relinkExternalAsset).mockResolvedValue(true);

      const result = await sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry);

      expect(result.status).toBe(row.relinked ? MediaOperationItemStatus.Ok : MediaOperationItemStatus.Skipped);
      expect(mediaHealthRepository.relinkExternalAsset).toHaveBeenCalledTimes(row.relinked ? 1 : 0);
    });

    it('reports a candidate that disappeared as a failure to retry, not a success', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([finding()] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([missingAsset()] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        { id: 'candidate-1', healthId: 'health-1', candidatePath: '/data/upload/user-id/found.jpg', status: 'found' },
      ] as never);
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({ sha1, sha256, sizeInBytes: 10 });
      vi.mocked(mocks.storage.stat).mockRejectedValue(new Error('ENOENT'));

      await expect(
        sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry),
      ).resolves.toMatchObject({ status: MediaOperationItemStatus.Failed });
      expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
    });

    it('answers a replayed batch with success when this entry already relinked the item', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        finding({
          status: MediaHealthStatus.Relinked,
          resolution: { healthId: 'health-1', candidateId: 'candidate-1' },
        }),
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([missingAsset()] as never);

      await expect(sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry)).resolves.toEqual({
        id: 'asset-1',
        status: MediaOperationItemStatus.Ok,
      });
      expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
    });

    it('never reaches another account’s item unless the job is an administrator’s, and never a Locked one', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([finding()] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        missingAsset({ ownerId: 'someone-else' }),
      ] as never);

      await expect(
        sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry),
      ).resolves.toMatchObject({
        status: MediaOperationItemStatus.Skipped,
        reasonKey: 'frameleaf_bulk_reason_no_permission',
      });

      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        missingAsset({ ownerId: 'someone-else', isLocked: true }),
      ] as never);
      await expect(
        sut.applyBulkEntry(worker({ isAdmin: true }), MediaOperationBulkAction.RelinkMissingMedia, entry),
      ).resolves.toMatchObject({
        status: MediaOperationItemStatus.Skipped,
        reasonKey: 'frameleaf_bulk_reason_no_permission',
      });
      expect(mediaHealthRepository.getCandidatesByHealthIds).not.toHaveBeenCalled();
    });

    describe('a copy in the folders an Immich import read from (Task 11b)', () => {
      let root: string;
      let uploads: string;
      let immich: string;
      let copy: string;
      let own: string;
      const bytes = Buffer.from('the photo, exactly');
      const fromImport = () =>
        vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
          {
            id: 'candidate-1',
            healthId: 'health-1',
            candidatePath: copy,
            status: MediaHealthStatus.Found,
            // in no search location: the search reached it through the import's folders
            evidence: { decodeValid: true },
            resolution: { autoRelinkable: true },
          },
        ] as never);

      beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'library-care-relink-'));
        uploads = join(root, 'upload');
        const baseFolder = StorageCore.getBaseFolder.bind(StorageCore);
        const base = vi
          .spyOn(StorageCore, 'getBaseFolder')
          .mockImplementation((folder) => (folder === StorageFolder.Upload ? uploads : baseFolder(folder)));
        onTestFinished(() => base.mockRestore());
        await mkdir(join(uploads, 'user-id'), { recursive: true });
        await writeFile(join(uploads, '.frameleaf'), '');
        immich = join(root, 'immich', 'library');
        await mkdir(immich, { recursive: true });
        copy = join(immich, 'IMG_3310.jpg');
        await writeFile(copy, bytes);
        own = join(uploads, 'user-id', 'IMG_3310.jpg');
        const crypto = new CryptoRepository();
        vi.mocked(mocks.crypto.hashFileDigests).mockImplementation((file) => crypto.hashFileDigests(file));
        // the drive is there while its mount file is
        vi.mocked(mocks.storage.stat).mockImplementation((file) => stat(file) as never);
        vi.mocked(mocks.systemMetadata.get).mockImplementation(((key: SystemMetadataKey) =>
          Promise.resolve(key === SystemMetadataKey.FileFixSourceRoots ? [join(root, 'immich')] : undefined)) as never);
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([finding()] as never);
        vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
          missingAsset({
            originalPath: own,
            originalFileName: 'IMG_3310.jpg',
            checksum: createHash('sha1').update(bytes).digest(),
          }),
        ] as never);
        fromImport();
      });

      afterEach(async () => {
        await rm(root, { recursive: true, force: true });
      });

      it('copies the reviewed copy into the photo’s own place, never linking to the old app’s folder', async () => {
        await expect(sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry)).resolves.toEqual(
          { id: 'asset-1', status: MediaOperationItemStatus.Ok },
        );

        // the library keeps a verified copy of its own; the old app's file is left exactly as it is
        expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
        await expect(readFile(own)).resolves.toEqual(bytes);
        await expect(readFile(copy)).resolves.toEqual(bytes);
        expect((await stat(own)).ino).not.toBe((await stat(copy)).ino);
        // as the automatic put-back records it, with who did it, and Undo moves the copy aside
        expect(mediaHealthRepository.settleFinding).toHaveBeenCalledExactlyOnceWith({
          healthId: 'health-1',
          evidence: { fixState: 'found-again', searchPending: false },
          status: MediaHealthStatus.Relinked,
          steps: [
            {
              step: 'put-back',
              outcome: 'ok',
              facts: { copied: true, by: authStub.user1.user.name },
              undo: {
                kind: 'restore',
                previousPath: own,
                originalPath: own,
                checksum: createHash('sha1').update(bytes).digest('hex'),
              },
            },
          ],
        });
        expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith(
          expect.arrayContaining([
            { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
          ]),
        );
      });

      it('never puts anything at the photo’s place for a copy that no longer matches, or over a file there', async () => {
        await writeFile(copy, 'another photo');
        await expect(
          sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry),
        ).resolves.toMatchObject({
          status: MediaOperationItemStatus.Skipped,
          reasonKey: 'frameleaf_bulk_reason_media_health_unverified',
        });
        await expect(stat(own)).rejects.toThrow();

        // a file came back at the photo's place meanwhile: it is never replaced
        await writeFile(copy, bytes);
        await writeFile(own, 'something else');
        await expect(
          sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry),
        ).resolves.toMatchObject({ status: MediaOperationItemStatus.Failed });
        await expect(readFile(own, 'utf8')).resolves.toBe('something else');
        expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
        expect(mediaHealthRepository.settleFinding).not.toHaveBeenCalled();
        expect(mocks.job.queueOutsideRun).not.toHaveBeenCalled();
      });

      it('waits for the photo’s drive, copying nothing while it is away', async () => {
        await rm(join(uploads, '.frameleaf'));

        await expect(
          sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry),
        ).resolves.toMatchObject({
          status: MediaOperationItemStatus.Failed,
          reasonKey: 'frameleaf_bulk_reason_failed',
        });
        await expect(stat(own)).rejects.toThrow();
        expect(mediaHealthRepository.settleFinding).not.toHaveBeenCalled();
      });

      it('copies only the copy a reviewer could relink: one verified, or the one chosen', async () => {
        vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
          {
            id: 'candidate-1',
            healthId: 'health-1',
            candidatePath: copy,
            status: MediaHealthStatus.Found,
            evidence: {},
            resolution: { autoRelinkable: true },
          },
          {
            id: 'candidate-2',
            healthId: 'health-1',
            candidatePath: join(immich, 'other.jpg'),
            status: MediaHealthStatus.Found,
            evidence: {},
            resolution: { autoRelinkable: true },
          },
        ] as never);

        await expect(
          sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry),
        ).resolves.toMatchObject({ status: MediaOperationItemStatus.Skipped });
        await expect(stat(own)).rejects.toThrow();

        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
          finding({ resolution: { autoRelinkable: true, chosenCandidateId: 'candidate-1' } }),
        ] as never);
        await expect(sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry)).resolves.toEqual(
          { id: 'asset-1', status: MediaOperationItemStatus.Ok },
        );
        await expect(readFile(own)).resolves.toEqual(bytes);
      });
    });

    it('refuses an entry whose finding belongs to another item', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([finding({ assetId: 'asset-9' })] as never);

      await expect(
        sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry),
      ).resolves.toMatchObject({
        status: MediaOperationItemStatus.Skipped,
        reasonKey: 'frameleaf_bulk_reason_not_found',
      });
    });

    it('never replaces unsupported RAW or suspected damage', async () => {
      for (const status of [MediaHealthStatus.UnsupportedRaw, MediaHealthStatus.CorruptSuspect]) {
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
          finding({ category: MediaHealthCategory.Corrupt, status }),
        ] as never);
        vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([missingAsset()] as never);

        await expect(
          sut.applyBulkEntry(worker(), MediaOperationBulkAction.RecoverDamagedMedia, entry),
        ).resolves.toMatchObject({
          status: MediaOperationItemStatus.Skipped,
          reasonKey: 'frameleaf_bulk_reason_media_health_changed',
        });
      }
      expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
    });

    const trashEntry = { assetId: 'asset-1', findingId: 'health-1' };

    it('moves revalidated damage to the trash and keeps an item that no longer fails', async () => {
      const damaged = finding({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.TrashQueued });
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([damaged] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([missingAsset()] as never);
      const validate = vi.spyOn(sut as any, 'validateAssetIntegrity').mockResolvedValueOnce({
        status: MediaHealthStatus.CorruptConfirmed,
        score: null,
        evidence: {},
        resolution: {},
      });

      await expect(
        sut.applyBulkEntry(worker(), MediaOperationBulkAction.TrashDamagedMedia, trashEntry),
      ).resolves.toEqual({ id: 'asset-1', status: MediaOperationItemStatus.Ok });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetTrashAll', { assetIds: ['asset-1'], userId: 'user-id' });

      validate.mockResolvedValueOnce(null);
      await expect(
        sut.applyBulkEntry(worker(), MediaOperationBulkAction.TrashDamagedMedia, trashEntry),
      ).resolves.toMatchObject({
        status: MediaOperationItemStatus.Skipped,
        reasonKey: 'frameleaf_bulk_reason_media_health_not_damaged',
      });
      expect(mediaHealthRepository.trashCorruptIfUnchanged).toHaveBeenCalledTimes(1);
    });

    it('only moves a finding that passed the typed confirmation to the trash', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        finding({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.CorruptConfirmed }),
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([missingAsset()] as never);

      await expect(
        sut.applyBulkEntry(worker(), MediaOperationBulkAction.TrashDamagedMedia, trashEntry),
      ).resolves.toMatchObject({ status: MediaOperationItemStatus.Skipped });
      expect(mediaHealthRepository.trashCorruptIfUnchanged).not.toHaveBeenCalled();
    });

    describe('encrypted Locked originals (FL-721, spec §8.3)', () => {
      let directory: string;
      let sealed: string;
      const confirmed = { status: MediaHealthStatus.CorruptConfirmed, score: null, evidence: {}, resolution: {} };

      beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'media-health-bulk-locked-'));
        sealed = join(directory, 'sealed.jpg');
        await writeFile(sealed, Buffer.concat([Buffer.from('FLLK'), Buffer.alloc(64, 1)]));
      });

      afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
      });

      it('the trash worker keeps an item whose original is sealed, however it was queued', async () => {
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
          finding({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.TrashQueued }),
        ] as never);
        vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([missingAsset({ originalPath: sealed })] as never);
        vi.spyOn(sut as any, 'validateAssetIntegrity').mockResolvedValue(confirmed);

        await expect(
          sut.applyBulkEntry(worker(), MediaOperationBulkAction.TrashDamagedMedia, {
            assetId: 'asset-1',
            findingId: 'health-1',
          }),
        ).resolves.toMatchObject({
          status: MediaOperationItemStatus.Skipped,
          reasonKey: 'frameleaf_bulk_reason_media_health_not_damaged',
        });
        expect(mediaHealthRepository.trashCorruptIfUnchanged).not.toHaveBeenCalled();
        expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetTrashAll', expect.anything());
        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
          expect.objectContaining({ status: MediaHealthStatus.Resolved, evidence: { reason: 'locked_encrypted' } }),
        );
      });

      it('never replaces a sealed original with a recovery copy', async () => {
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
          finding({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.CorruptConfirmed }),
        ] as never);
        vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([missingAsset({ originalPath: sealed })] as never);

        await expect(
          sut.applyBulkEntry(worker({ isAdmin: true }), MediaOperationBulkAction.RecoverDamagedMedia, entry),
        ).resolves.toMatchObject({
          status: MediaOperationItemStatus.Skipped,
          reasonKey: 'frameleaf_bulk_reason_media_health_changed',
        });
        expect(mediaHealthRepository.getCandidatesByHealthIds).not.toHaveBeenCalled();
        expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
      });

      it('never hashes or relinks a sealed candidate', async () => {
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([finding()] as never);
        vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([missingAsset()] as never);
        vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
          {
            id: 'candidate-1',
            healthId: 'health-1',
            candidatePath: sealed,
            status: MediaHealthStatus.Found,
            evidence: { rootId: MANAGED_ROOT_ID },
          },
        ] as never);
        // a hash that would match, if anything read the ciphertext
        vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({ sha1, sha256, sizeInBytes: 10 });

        await expect(
          sut.applyBulkEntry(worker(), MediaOperationBulkAction.RelinkMissingMedia, entry),
        ).resolves.toMatchObject({ status: MediaOperationItemStatus.Skipped });
        expect(mocks.crypto.hashFileDigests).not.toHaveBeenCalled();
        expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
      });
    });

    describe('recovery from a verified copy (disposable filesystem fixtures)', () => {
      let root: string;
      let backup: string;
      let media: string;
      let nestedPath: { mockRestore: () => void };
      const bytes = Buffer.from('the original bytes of forest.jpg');
      const digest = {
        sha1: createHash('sha1').update(bytes).digest(),
        sha256: createHash('sha256').update(bytes).digest(),
        sizeInBytes: bytes.length,
      };

      beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'library-care-'));
        backup = join(root, 'backup');
        media = join(root, 'media');
        await mkdir(join(backup, '2026'), { recursive: true });
        await mkdir(media, { recursive: true });
        recoveryRoots.push({ label: 'Verified backup', path: backup });
        const crypto = new CryptoRepository();
        vi.mocked(mocks.crypto.hashFileDigests).mockImplementation((path) => crypto.hashFileDigests(path));
        vi.mocked(mocks.storage.stat).mockImplementation((path) => stat(path) as never);
        nestedPath = vi
          .spyOn(StorageCore, 'getNestedPath')
          .mockReturnValue(join(media, 'upload', 'user-id', 'as', 'se', 'asset-1'));
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
          finding({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.CorruptConfirmed }),
        ] as never);
        vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
          missingAsset({
            checksum: digest.sha1,
            originalPath: join(media, 'damaged.jpg'),
            originalFileName: 'forest.jpg',
          }),
        ] as never);
        vi.mocked(mediaHealthRepository.relinkManagedAsset).mockImplementation(async (input) => {
          const verified = await input.verifyCandidate();
          return !!verified && verified.sha1.equals(digest.sha1);
        });
      });

      afterEach(async () => {
        nestedPath.mockRestore();
        await rm(root, { recursive: true, force: true });
      });

      const candidateAt = (candidatePath: string) =>
        vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
          {
            id: 'candidate-1',
            healthId: 'health-1',
            candidatePath,
            status: MediaHealthStatus.Found,
            evidence: { rootId: recoveryRootId(backup) },
          },
        ] as never);

      it('publishes an exact copy into library storage and keeps the damaged original', async () => {
        const source = join(backup, '2026', 'forest.jpg');
        await writeFile(source, bytes);
        await writeFile(join(media, 'damaged.jpg'), 'damaged');
        candidateAt(source);

        await expect(
          sut.applyBulkEntry(worker({ isAdmin: true }), MediaOperationBulkAction.RecoverDamagedMedia, entry),
        ).resolves.toEqual({ id: 'asset-1', status: MediaOperationItemStatus.Ok });

        const input = vi.mocked(mediaHealthRepository.relinkManagedAsset).mock.calls[0][0];
        expect(input).toMatchObject({
          category: MediaHealthCategory.Corrupt,
          candidatePath: source,
          expectedOriginalPath: join(media, 'damaged.jpg'),
          provenance: expect.objectContaining({ rootId: recoveryRootId(backup), rootKind: 'recovery' }),
        });
        expect(input.originalPath).toContain('.library-care');
        await expect(readFile(input.originalPath)).resolves.toEqual(bytes);
        // The damaged original and the recovery location are left exactly as they were.
        await expect(readFile(join(media, 'damaged.jpg'), 'utf8')).resolves.toBe('damaged');
        await expect(readFile(source)).resolves.toEqual(bytes);
      });

      it('moves the replaced damaged file into the hidden Library Care folder, never over anything', async () => {
        const source = join(backup, '2026', 'forest.jpg');
        const damaged = join(media, 'damaged.jpg');
        await writeFile(source, bytes);
        await writeFile(damaged, 'damaged');
        candidateAt(source);
        const committed = { ...finding({ category: MediaHealthCategory.Corrupt }) };
        vi.mocked(mediaHealthRepository.relinkManagedAsset).mockImplementation((input) => {
          Object.assign(committed, {
            status: MediaHealthStatus.Resolved,
            originalPath: input.originalPath,
            evidence: { retainedPath: damaged },
            resolution: { candidateId: 'candidate-1' },
          });
          return Promise.resolve(true);
        });
        vi.mocked(mediaHealthRepository.getByIds)
          .mockResolvedValueOnce([
            finding({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.CorruptConfirmed }),
          ] as never)
          .mockImplementation(() => Promise.resolve([committed] as never));

        await expect(
          sut.applyBulkEntry(worker({ isAdmin: true }), MediaOperationBulkAction.RecoverDamagedMedia, entry),
        ).resolves.toEqual({ id: 'asset-1', status: MediaOperationItemStatus.Ok });

        const retained = vi.mocked(mediaHealthRepository.setRetainedPath).mock.calls[0][1];
        expect(retained).toContain('.library-care');
        expect(retained).toMatch(/\.damaged\.jpg$/);
        await expect(readFile(retained, 'utf8')).resolves.toBe('damaged');
        await expect(readFile(damaged)).rejects.toThrow();
      });

      it('leaves a damaged file some other asset still uses exactly where it is', async () => {
        const source = join(backup, '2026', 'forest.jpg');
        const damaged = join(media, 'damaged.jpg');
        await writeFile(source, bytes);
        await writeFile(damaged, 'damaged');
        candidateAt(source);
        vi.mocked(mediaHealthRepository.isOriginalPathInUse).mockResolvedValue(true);
        vi.mocked(mediaHealthRepository.getByIds)
          .mockResolvedValueOnce([
            finding({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.CorruptConfirmed }),
          ] as never)
          .mockResolvedValue([
            finding({
              category: MediaHealthCategory.Corrupt,
              status: MediaHealthStatus.Resolved,
              originalPath: join(media, 'upload', '.library-care', 'copy.jpg'),
              evidence: { retainedPath: damaged },
            }),
          ] as never);

        await sut.applyBulkEntry(worker({ isAdmin: true }), MediaOperationBulkAction.RecoverDamagedMedia, entry);

        await expect(readFile(damaged, 'utf8')).resolves.toBe('damaged');
        expect(mediaHealthRepository.setRetainedPath).not.toHaveBeenCalled();
      });

      it('refuses a copy whose checksum is not the original’s', async () => {
        const source = join(backup, '2026', 'forest.jpg');
        await writeFile(source, 'similar name, different bytes');
        candidateAt(source);

        await expect(
          sut.applyBulkEntry(worker({ isAdmin: true }), MediaOperationBulkAction.RecoverDamagedMedia, entry),
        ).resolves.toMatchObject({ reasonKey: 'frameleaf_bulk_reason_media_health_unverified' });
        expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
      });

      it('refuses a candidate that is gone', async () => {
        candidateAt(join(backup, '2026', 'missing.jpg'));

        await expect(
          sut.applyBulkEntry(worker({ isAdmin: true }), MediaOperationBulkAction.RecoverDamagedMedia, entry),
        ).resolves.toMatchObject({ reasonKey: 'frameleaf_bulk_reason_media_health_unverified' });
      });

      it('refuses a candidate that resolves outside its recovery location', async () => {
        const outside = join(root, 'outside.jpg');
        await writeFile(outside, bytes);
        const link = join(backup, '2026', 'forest.jpg');
        await symlink(outside, link);
        candidateAt(link);

        await expect(
          sut.applyBulkEntry(worker({ isAdmin: true }), MediaOperationBulkAction.RecoverDamagedMedia, entry),
        ).resolves.toMatchObject({ reasonKey: 'frameleaf_bulk_reason_media_health_unverified' });
        expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
      });

      it('keeps recovery locations an administrator’s when the job runs', async () => {
        const source = join(backup, '2026', 'forest.jpg');
        await writeFile(source, bytes);
        candidateAt(source);

        await expect(
          sut.applyBulkEntry(worker(), MediaOperationBulkAction.RecoverDamagedMedia, entry),
        ).resolves.toMatchObject({ reasonKey: 'frameleaf_bulk_reason_media_health_unverified' });
      });

      it('reuses its own earlier copy when a batch is applied again after a restart', async () => {
        const source = join(backup, '2026', 'forest.jpg');
        await writeFile(source, bytes);
        candidateAt(source);
        vi.mocked(mediaHealthRepository.relinkManagedAsset).mockResolvedValueOnce(false);

        await expect(
          sut.applyBulkEntry(worker({ isAdmin: true }), MediaOperationBulkAction.RecoverDamagedMedia, entry),
        ).resolves.toMatchObject({ reasonKey: 'frameleaf_bulk_reason_media_health_changed' });
        await expect(
          sut.applyBulkEntry(worker({ isAdmin: true }), MediaOperationBulkAction.RecoverDamagedMedia, entry),
        ).resolves.toEqual({ id: 'asset-1', status: MediaOperationItemStatus.Ok });
        const [first, second] = vi.mocked(mediaHealthRepository.relinkManagedAsset).mock.calls;
        expect(second[0].originalPath).toBe(first[0].originalPath);
      });
    });
  });

  it('scans only assets owned by the queued user', async () => {
    vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
      // eslint-disable-next-line require-yield
      (async function* () {
        await Promise.resolve();
      })() as never,
    );

    await expect(
      sut.handleMissingScan({ missingRunId: 'missing-run', corruptRunId: 'corrupt-run', userId: 'user-1' }),
    ).resolves.toBe(JobStatus.Success);

    expect(mediaHealthRepository.streamAssets).toHaveBeenCalledWith({ assetIds: undefined, ownerId: 'user-1' });
  });

  describe('handleMissingScan', () => {
    it('restores supported untracked media from only the queued user roots', async () => {
      const sha1 = Buffer.alloc(20, 1);
      const sha256 = Buffer.alloc(32, 2);
      vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
        // eslint-disable-next-line require-yield
        (async function* () {
          await Promise.resolve();
        })() as never,
      );
      vi.mocked(mocks.user.get).mockResolvedValue({
        id: 'user-1',
        storageLabel: 'owner',
        quotaSizeInBytes: null,
        quotaUsageInBytes: 0,
      } as never);
      vi.mocked(mocks.storage.walk).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield ['/data/library/owner/restored.jpg', '/data/library/owner/restored.xmp'];
        })() as never,
      );
      vi.mocked(mediaHealthRepository.getTrackedPaths).mockResolvedValue(new Set());
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({ sha1, sha256, sizeInBytes: 10 });
      vi.mocked(mocks.asset.getByChecksums).mockResolvedValue([]);
      vi.mocked(mocks.forkSchema.hasAssetChecksum).mockResolvedValue(false);
      vi.mocked(mocks.storage.stat).mockResolvedValue(
        settledStat({ size: 10, mtime: new Date('2026-09-04T00:00:00Z') }) as never,
      );
      vi.mocked(mocks.asset.create).mockResolvedValue({ id: 'restored-asset' } as never);

      await expect(
        sut.handleMissingScan({ missingRunId: 'missing-run', corruptRunId: 'corrupt-run', userId: 'user-1' }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.crypto.hashFileDigests).toHaveBeenCalledTimes(1);
      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'user-1',
          originalPath: '/data/library/owner/restored.jpg',
          checksum: sha256,
          checksumAlgorithm: ChecksumAlgorithm.sha256File,
          fileCreatedAt: new Date('2026-09-04T00:00:00Z'),
        }),
        undefined,
        undefined,
        'recovered',
      );
      expect(mocks.forkSchema.recordAssetChecksums).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: 'restored-asset', sha1, sha256, source: 'recovery' }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: 'restored-asset', source: 'upload' },
      });
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.FileDelete }));
    });

    const untrackedUpload = (file = '/data/upload/user-1/ab/cd/in-flight.mp4') => {
      vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
        // eslint-disable-next-line require-yield
        (async function* () {
          await Promise.resolve();
        })() as never,
      );
      vi.mocked(mocks.user.get).mockResolvedValue({
        id: 'user-1',
        storageLabel: null,
        quotaSizeInBytes: null,
        quotaUsageInBytes: 0,
      } as never);
      vi.mocked(mocks.storage.walk).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield [file];
        })() as never,
      );
      vi.mocked(mediaHealthRepository.getTrackedPaths).mockResolvedValue(new Set());
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({
        sha1: Buffer.alloc(20, 1),
        sha256: Buffer.alloc(32, 2),
        sizeInBytes: 10,
      });
      vi.mocked(mocks.asset.getByChecksums).mockResolvedValue([]);
      vi.mocked(mocks.forkSchema.hasAssetChecksum).mockResolvedValue(false);
      vi.mocked(mocks.asset.create).mockResolvedValue({ id: 'restored-asset' } as never);
    };

    // an upload streams straight into its final path; a scan that passes by meanwhile must not adopt it
    it('leaves an untracked file written moments ago alone, without reading it', async () => {
      untrackedUpload();
      vi.mocked(mocks.storage.stat).mockResolvedValue(settledStat({ size: 10, mtime: new Date() }) as never);

      await sut.handleMissingScan({ missingRunId: 'missing-run', corruptRunId: 'corrupt-run', userId: 'user-1' });

      expect(mocks.crypto.hashFileDigests).not.toHaveBeenCalled();
      expect(mocks.asset.create).not.toHaveBeenCalled();
    });

    it('leaves an untracked file that changed while it was read alone', async () => {
      untrackedUpload();
      const before = settledStat({ size: 10 });
      vi.mocked(mocks.storage.stat)
        .mockResolvedValueOnce(before as never)
        .mockResolvedValueOnce(before as never)
        .mockResolvedValueOnce({ ...before, size: 11, mtimeMs: before.mtimeMs + 1 } as never);

      await sut.handleMissingScan({ missingRunId: 'missing-run', corruptRunId: 'corrupt-run', userId: 'user-1' });

      expect(mocks.crypto.hashFileDigests).toHaveBeenCalledTimes(1);
      expect(mocks.asset.create).not.toHaveBeenCalled();
    });

    it('leaves an untracked entry that is not a regular file alone', async () => {
      untrackedUpload();
      vi.mocked(mocks.storage.stat).mockResolvedValue({ ...settledStat({ size: 10 }), isFile: () => false } as never);

      await sut.handleMissingScan({ missingRunId: 'missing-run', corruptRunId: 'corrupt-run', userId: 'user-1' });

      expect(mocks.crypto.hashFileDigests).not.toHaveBeenCalled();
      expect(mocks.asset.create).not.toHaveBeenCalled();
    });

    it('restores an untracked file that settled, keeping its identity across the read', async () => {
      untrackedUpload();

      await expect(
        sut.handleMissingScan({ missingRunId: 'missing-run', corruptRunId: 'corrupt-run', userId: 'user-1' }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.storage.stat).toHaveBeenCalledTimes(3);
      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({ originalPath: '/data/upload/user-1/ab/cd/in-flight.mp4' }),
        undefined,
        undefined,
        'recovered',
      );
    });

    describe('placeUntrackedFile (FL-1532)', () => {
      const digests = { sha1: Buffer.alloc(20, 1), sha256: Buffer.alloc(32, 2), sizeInBytes: 10 };
      const mtime = new Date('2026-11-01T10:00:00.000Z');
      const orphan = '/data/upload/gone-account/ab/cd/IMG_0001.jpg';
      const lost = {
        id: 'lost-asset',
        checksum: digests.sha256,
        deletedAt: null,
        status: 'active',
        originalPath: '/data/library/taylor/2020/08/IMG_3310.jpg',
        libraryId: null,
        isExternal: false,
      };

      it('never adds a file in a folder no account owns', async () => {
        vi.mocked(mocks.asset.getByChecksumsForAnyOwner).mockResolvedValue([]);

        await expect(sut.placeUntrackedFile(null, orphan, mtime, digests)).resolves.toEqual({ outcome: 'no-owner' });

        expect(mocks.asset.getByChecksums).not.toHaveBeenCalled();
        expect(mocks.asset.create).not.toHaveBeenCalled();
      });

      it('puts a file in a folder no account owns back under any account’s photo that lost it', async () => {
        vi.mocked(mocks.asset.getByChecksumsForAnyOwner).mockResolvedValue([lost] as never);
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
        vi.mocked(mocks.physicalFile.restoreLostOriginal).mockResolvedValue(true);

        await expect(sut.placeUntrackedFile(null, orphan, mtime, digests)).resolves.toEqual({
          outcome: 'back',
          assetId: 'lost-asset',
          previousPath: lost.originalPath,
        });

        expect(mocks.physicalFile.restoreLostOriginal).toHaveBeenCalledWith(
          expect.objectContaining({
            assetId: 'lost-asset',
            expectedOriginalPath: lost.originalPath,
            originalPath: orphan,
            reason: 'restored_from_untracked_file',
          }),
        );
        expect(mocks.asset.create).not.toHaveBeenCalled();
      });

      it('calls a file a spare copy when the photo with the same contents still has its own file', async () => {
        vi.mocked(mocks.asset.getByChecksumsForAnyOwner).mockResolvedValue([lost] as never);
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);

        await expect(sut.placeUntrackedFile(null, orphan, mtime, digests)).resolves.toEqual({
          outcome: 'spare',
          assetId: 'lost-asset',
        });

        expect(mocks.physicalFile.restoreLostOriginal).not.toHaveBeenCalled();
      });

      it('says an account has no room, counting what the same pass already added', async () => {
        vi.mocked(mocks.asset.getByChecksums).mockResolvedValue([]);
        vi.mocked(mocks.forkSchema.hasAssetChecksum).mockResolvedValue(false);
        const owner = { id: 'user-1', quotaSizeInBytes: 100, quotaUsageInBytes: 50 };

        await expect(sut.placeUntrackedFile(owner, '/data/upload/user-1/a.jpg', mtime, digests, 45)).resolves.toEqual({
          outcome: 'over-limit',
        });

        expect(mocks.asset.create).not.toHaveBeenCalled();
      });
    });

    it('does not restore an untracked path when either digest already belongs to the user', async () => {
      vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
        // eslint-disable-next-line require-yield
        (async function* () {
          await Promise.resolve();
        })() as never,
      );
      vi.mocked(mocks.user.get).mockResolvedValue({
        id: 'user-1',
        storageLabel: null,
        quotaSizeInBytes: null,
        quotaUsageInBytes: 0,
      } as never);
      vi.mocked(mocks.storage.walk).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield ['/data/upload/user-1/duplicate.jpg'];
        })() as never,
      );
      vi.mocked(mediaHealthRepository.getTrackedPaths).mockResolvedValue(new Set());
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({
        sha1: Buffer.alloc(20, 1),
        sha256: Buffer.alloc(32, 2),
        sizeInBytes: 10,
      });
      vi.mocked(mocks.asset.getByChecksums).mockResolvedValue([]);
      vi.mocked(mocks.forkSchema.hasAssetChecksum).mockResolvedValue(true);

      await sut.handleMissingScan({ missingRunId: 'missing-run', corruptRunId: 'corrupt-run', userId: 'user-1' });

      expect(mocks.asset.create).not.toHaveBeenCalled();
    });

    it.each([
      [MediaHealthStatus.CorruptConfirmed, MediaHealthSeverity.Critical],
      [MediaHealthStatus.UnsupportedRaw, MediaHealthSeverity.Info],
      [MediaHealthStatus.CorruptSuspect, MediaHealthSeverity.Warning],
    ])('maps integrity status %s to severity %s', async (status, severity) => {
      vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield {
            id: 'asset-x',
            ownerId: 'user-1',
            originalPath: '/library/x.jpg',
            originalFileName: 'x.jpg',
            type: AssetType.Image,
            isExternal: false,
            libraryId: null,
          };
        })() as never,
      );
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
      vi.spyOn(sut as any, 'validateReadableAssetIntegrity').mockResolvedValue({
        status,
        score: null,
        evidence: {},
        resolution: {},
      });

      await expect(sut.handleMissingScan({ missingRunId: 'm', corruptRunId: 'c' })).resolves.toBe(JobStatus.Success);

      expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'c', status, severity }),
      );
    });

    it('marks both categories resolved when an asset is healthy and never records a finding', async () => {
      vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield {
            id: 'healthy-asset',
            originalPath: '/library/healthy.jpg',
            originalFileName: 'healthy.jpg',
            type: AssetType.Image,
            isExternal: false,
            libraryId: null,
          };
        })() as never,
      );
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
      vi.spyOn(sut as any, 'validateReadableAssetIntegrity').mockResolvedValue(null);

      await expect(sut.handleMissingScan({ missingRunId: 'm', corruptRunId: 'c' })).resolves.toBe(JobStatus.Success);

      expect(mediaHealthRepository.markResolvedForAssets).toHaveBeenCalledWith(
        [MediaHealthCategory.Missing, MediaHealthCategory.Corrupt],
        [expect.objectContaining({ id: 'healthy-asset' })],
      );
      expect(mediaHealthRepository.markResolved).not.toHaveBeenCalled();
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
    });

    it('continues finishing the second run when the first finishRun rejects on failure', async () => {
      vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
        // eslint-disable-next-line require-yield
        (async function* () {
          await Promise.resolve();
          throw new Error('stream blew up');
        })() as never,
      );
      vi.mocked(mediaHealthRepository.finishRun)
        .mockRejectedValueOnce(new Error('missing finish failed'))
        .mockResolvedValueOnce(undefined as never);

      await expect(sut.handleMissingScan({ missingRunId: 'm', corruptRunId: 'c' })).rejects.toThrow('stream blew up');

      expect(mediaHealthRepository.finishRun).toHaveBeenCalledTimes(2);
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith('m', expect.objectContaining({ status: 'failed' }));
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith('c', expect.objectContaining({ status: 'failed' }));
    });

    it('runs only the missing-asset check for legacy runId-only jobs', async () => {
      vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield {
            id: 'asset-1',
            originalPath: '/library/file.jpg',
            originalFileName: 'file.jpg',
            type: AssetType.Image,
            isExternal: false,
            libraryId: null,
          };
        })() as never,
      );
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
      const validateSpy = vi.spyOn(sut as any, 'validateReadableAssetIntegrity');

      await expect(sut.handleMissingScan({ runId: 'legacy-run' })).resolves.toBe(JobStatus.Success);

      expect(mediaHealthRepository.createRun).not.toHaveBeenCalled();
      expect(validateSpy).not.toHaveBeenCalled();
      expect(mediaHealthRepository.markResolvedForAssets).toHaveBeenCalledWith(
        [MediaHealthCategory.Missing],
        [expect.objectContaining({ id: 'asset-1' })],
      );
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledTimes(1);
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'legacy-run',
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('checks each asset once and records missing or corrupt findings', async () => {
      const assets = [
        {
          id: 'missing-asset',
          ownerId: 'user-1',
          originalPath: '/library/missing.jpg',
          originalFileName: 'missing.jpg',
          type: AssetType.Image,
          isExternal: true,
          libraryId: 'library-1',
        },
        {
          id: 'corrupt-asset',
          ownerId: 'user-1',
          originalPath: '/library/corrupt.jpg',
          originalFileName: 'corrupt.jpg',
          type: AssetType.Image,
          isExternal: false,
          libraryId: null,
        },
      ];
      vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
        (async function* () {
          for (const asset of assets) {
            await Promise.resolve();
            yield asset;
          }
        })() as never,
      );
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      vi.spyOn(sut as any, 'validateReadableAssetIntegrity').mockResolvedValue({
        status: MediaHealthStatus.CorruptConfirmed,
        score: null,
        evidence: { reason: 'image_decode_failed' },
        resolution: { reuploadRecommended: true },
      });

      await expect(sut.handleMissingScan({ missingRunId: 'missing-run', corruptRunId: 'corrupt-run' })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith({
        runId: 'missing-run',
        assetId: 'missing-asset',
        category: MediaHealthCategory.Missing,
        status: MediaHealthStatus.Missing,
        severity: MediaHealthSeverity.Critical,
        originalPath: '/library/missing.jpg',
        originalFileName: 'missing.jpg',
        evidence: { reason: 'source_file_missing_or_unreadable' },
        resolution: { autoRelinkable: true },
        checkedAt: expect.any(Date),
        steps: [
          { step: 'added', outcome: 'info', at: undefined },
          { step: 'not-on-drive', outcome: 'failed', facts: {} },
        ],
      });
      expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith({
        runId: 'corrupt-run',
        assetId: 'corrupt-asset',
        category: MediaHealthCategory.Corrupt,
        status: MediaHealthStatus.CorruptConfirmed,
        severity: MediaHealthSeverity.Critical,
        originalPath: '/library/corrupt.jpg',
        originalFileName: 'corrupt.jpg',
        evidence: { reason: 'image_decode_failed' },
        resolution: { reuploadRecommended: true },
        checkedAt: expect.any(Date),
        steps: [
          { step: 'added', outcome: 'info', at: undefined },
          { step: 'wont-open', outcome: 'failed', facts: {} },
        ],
      });
      expect(mediaHealthRepository.markResolvedForAssets).not.toHaveBeenCalledWith(
        [MediaHealthCategory.Corrupt],
        [expect.objectContaining({ id: 'missing-asset' })],
      );
      expect(mediaHealthRepository.markResolvedForAssets).toHaveBeenCalledWith(
        [MediaHealthCategory.Missing],
        [expect.objectContaining({ id: 'corrupt-asset' })],
      );
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'missing-run',
        expect.objectContaining({ status: 'completed', checkedAssets: 2, foundAssets: 1 }),
      );
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'corrupt-run',
        expect.objectContaining({ status: 'completed', checkedAssets: 2, foundAssets: 1 }),
      );
    });
  });

  describe('handleLocateMissing', () => {
    it.each(['users', 'walk', 'assets'])('finalizes the run if %s lookup fails', async (source) => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        { id: 'asset-1', checksum: Buffer.alloc(20, 1), isExternal: false },
      ] as never);
      vi.mocked(mocks.user.getList).mockResolvedValue([{ id: 'user-1', storageLabel: null }] as never);
      const error = new Error('lookup failed');
      if (source === 'users') {
        vi.mocked(mocks.user.getList).mockRejectedValue(error);
      } else if (source === 'assets') {
        vi.mocked(mediaHealthRepository.getAssets).mockRejectedValue(error);
      } else {
        vi.mocked(mocks.storage.walk).mockReturnValue(
          (async function* () {
            await Promise.reject(error);
            yield [];
          })() as never,
        );
      }

      await expect(sut.handleLocateMissing({ runId: 'run-1', ids: ['health-1'], userId: 'user-1' })).rejects.toThrow(
        'lookup failed',
      );
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith('run-1', {
        status: 'failed',
        error: 'lookup failed',
      });
    });

    it.each([
      { conflict: false, size: 10 },
      { conflict: true, size: 10 },
      { conflict: false, size: 11 * 1024 ** 3 },
    ])(
      'resumes the same lookup across users and retains earlier checksum evidence ($conflict, $size bytes)',
      async ({ conflict, size }) => {
        const sha1 = Buffer.alloc(20, 1);
        const sha256 = Buffer.alloc(32, 2);
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
          { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing },
        ] as never);
        vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
          {
            id: 'asset-1',
            checksum: sha1,
            checksumAlgorithm: ChecksumAlgorithm.sha1File,
            originalPath: '/data/upload/user-1/missing.jpg',
            originalFileName: 'missing.jpg',
            type: AssetType.Image,
            isExternal: false,
          },
        ] as never);
        vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([
          { assetId: 'asset-1', sha1, sha256, sizeInBytes: size },
        ]);
        vi.mocked(mocks.user.getList).mockResolvedValue([{ id: 'user-2', storageLabel: null }] as never);
        vi.mocked(mocks.storage.walkWithCursor)
          .mockImplementationOnce(async function* (cursor) {
            await Promise.resolve();
            cursor[0].after = 'found.jpg';
            yield '/data/upload/user-2/found.jpg';
          })
          .mockImplementationOnce(async function* (cursor) {
            await Promise.resolve();
            yield '/data/upload/user-3/later.jpg';
            cursor.length = 0;
          });
        vi.mocked(mocks.storage.stat).mockResolvedValue({ size } as never);
        vi.mocked(mocks.crypto.hashFileDigests)
          .mockResolvedValueOnce({ sha1, sha256: conflict ? Buffer.alloc(32, 8) : sha256, sizeInBytes: size })
          .mockResolvedValueOnce({
            sha1: Buffer.alloc(20, 9),
            sha256: conflict ? sha256 : Buffer.alloc(32, 9),
            sizeInBytes: size,
          });

        await sut.handleLocateMissing({ runId: 'run-1', ids: ['health-1'], userId: 'user-1' });

        expect(mocks.crypto.hashFileDigests).toHaveBeenCalledTimes(1);
        expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
          'run-1',
          expect.objectContaining({
            status: 'running',
            finishedAt: null,
            error: expect.stringContaining('incomplete'),
          }),
        );
        expect(mediaHealthRepository.recordSearchResult).toHaveBeenCalledWith(
          expect.objectContaining({
            evidence: expect.objectContaining({ searchTruncated: true }),
            resolution: expect.objectContaining({ autoRelinkable: false }),
          }),
        );
        expect(mediaHealthRepository.replaceCandidates).toHaveBeenCalledWith('health-1', [
          expect.objectContaining({
            status: MediaHealthStatus.Candidate,
            resolution: { autoRelinkable: false },
          }),
        ]);

        const queued = vi.mocked(mocks.job.queue).mock.calls.at(-1)![0];
        expect(queued).toMatchObject({
          name: JobName.MediaHealthLocateMissing,
          data: { runId: 'run-1', userId: 'user-1' },
        });
        await sut.handleLocateMissing(JSON.parse(JSON.stringify(queued.data)));

        // Each step reads the search locations again; only the first starts a new walk from them.
        expect(mocks.user.getList).toHaveBeenCalledTimes(2);
        expect(mocks.crypto.hashFileDigests).toHaveBeenCalledTimes(2);
        // An oversized final file yields before the walker can close its last directory frame.
        if (size > 10 * 1024 ** 3) {
          const finalJob = vi.mocked(mocks.job.queue).mock.calls.at(-1)![0];
          vi.mocked(mocks.storage.walkWithCursor).mockImplementationOnce((cursor) => {
            cursor.length = 0;
            return (async function* () {})();
          });
          await sut.handleLocateMissing(JSON.parse(JSON.stringify(finalJob.data)));
        }
        expect(mediaHealthRepository.finishRun).toHaveBeenLastCalledWith(
          'run-1',
          expect.objectContaining({ status: 'completed', error: null }),
        );
        expect(mediaHealthRepository.recordSearchResult).toHaveBeenLastCalledWith(
          expect.objectContaining({
            evidence: expect.objectContaining({ searchTruncated: false }),
            resolution: { autoRelinkable: true },
          }),
        );
        const finalCandidates = vi.mocked(mediaHealthRepository.replaceCandidates).mock.calls.at(-1)![1];
        expect(finalCandidates).toHaveLength(1);
        expect(finalCandidates[0]).toMatchObject({
          candidatePath: '/data/upload/user-2/found.jpg',
          status: MediaHealthStatus.Found,
        });
        expect(mocks.job.queue).toHaveBeenCalledTimes(size > 10 * 1024 ** 3 ? 2 : 1);
      },
    );

    it('matches the public digest when sidecar digest and size evidence disagree', async () => {
      const publicSha1 = Buffer.alloc(20, 1);
      const sidecarSha1 = Buffer.alloc(20, 2);
      const sidecarSha256 = Buffer.alloc(32, 3);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          ownerId: 'user-1',
          checksum: publicSha1,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalPath: '/data/upload/user-1/missing.jpg',
          originalFileName: 'missing.jpg',
          type: AssetType.Image,
          isExternal: false,
          libraryId: null,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([
        { assetId: 'asset-1', sha1: sidecarSha1, sha256: sidecarSha256, sizeInBytes: 10 },
      ]);
      vi.mocked(mocks.user.getList).mockResolvedValue([{ id: 'user-2', storageLabel: null }] as never);
      vi.mocked(mocks.storage.walk).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield ['/data/upload/user-2/found.jpg'];
        })() as never,
      );
      vi.mocked(mocks.storage.stat).mockResolvedValue({ size: 20 } as never);
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({
        sha1: publicSha1,
        sha256: Buffer.alloc(32, 9),
        sizeInBytes: 20,
      });

      await sut.handleLocateMissing({ runId: 'run-1', ids: ['health-1'], userId: 'user-1' });

      expect(mediaHealthRepository.replaceCandidates).toHaveBeenCalledWith(
        'health-1',
        expect.arrayContaining([
          expect.objectContaining({
            candidatePath: '/data/upload/user-2/found.jpg',
            status: MediaHealthStatus.Found,
          }),
        ]),
      );
    });

    it('finds renamed external-library files by checksum when sidecar size is available', async () => {
      const sha1 = Buffer.alloc(20, 1);
      const sha256 = Buffer.alloc(32, 2);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          ownerId: 'user-1',
          checksum: sha1,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalPath: '/external/photos/missing.jpg',
          originalFileName: 'missing.jpg',
          type: AssetType.Image,
          isExternal: true,
          libraryId: 'library-1',
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([
        { assetId: 'asset-1', sha1, sha256, sizeInBytes: 10 },
      ]);
      vi.mocked(mocks.library.get).mockResolvedValue({
        id: 'library-1',
        importPaths: ['/external/photos'],
        exclusionPatterns: [],
      } as never);
      vi.mocked(mocks.storage.walk).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield ['/external/photos/wrong-size.jpg', '/external/photos/renamed', '/external/photos/renamed.xmp'];
        })() as never,
      );
      vi.mocked(mocks.storage.stat)
        .mockResolvedValueOnce({ size: 9 } as never)
        .mockResolvedValueOnce({ size: 10 } as never)
        .mockResolvedValueOnce({ size: 9 } as never);
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({ sha1, sha256, sizeInBytes: 10 });
      vi.mocked(mocks.asset.getByLibraryIdAndOriginalPath).mockResolvedValue(undefined);

      await sut.handleLocateMissing({ runId: 'run-1', ids: ['health-1'], userId: 'user-1' });

      expect(mocks.crypto.hashFileDigests).toHaveBeenCalledTimes(1);
      expect(mediaHealthRepository.replaceCandidates).toHaveBeenCalledWith(
        'health-1',
        expect.arrayContaining([
          expect.objectContaining({
            candidatePath: '/external/photos/renamed',
            status: MediaHealthStatus.Found,
            evidence: expect.objectContaining({ reason: 'checksum_match' }),
            resolution: { autoRelinkable: true },
          }),
        ]),
      );
    });

    it.each(['absent', 'stale'] as const)(
      'finds renamed external files with %s checksum sidecar metadata',
      async (metadata) => {
        const sha1 = Buffer.alloc(20, 1);
        const sha256 = Buffer.alloc(32, 2);
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
          { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing },
        ] as never);
        vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
          {
            id: 'asset-1',
            ownerId: 'user-1',
            checksum: sha1,
            checksumAlgorithm: ChecksumAlgorithm.sha1File,
            originalPath: '/external/photos/missing.jpg',
            originalFileName: 'missing.jpg',
            type: AssetType.Image,
            isExternal: true,
            libraryId: 'library-1',
          },
        ] as never);
        vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([
          ...(metadata === 'absent'
            ? []
            : [{ assetId: 'asset-1', sha1: Buffer.alloc(20, 3), sha256: Buffer.alloc(32, 4), sizeInBytes: 999 }]),
        ]);
        vi.mocked(mocks.library.get).mockResolvedValue({
          id: 'library-1',
          importPaths: ['/external/photos'],
          exclusionPatterns: [],
        } as never);
        vi.mocked(mocks.storage.walk).mockReturnValue(
          (async function* () {
            await Promise.resolve();
            yield ['/external/photos/renamed.jpg', '/external/photos/renamed.xmp'];
          })() as never,
        );
        vi.mocked(mocks.storage.stat).mockResolvedValue({ size: 10 } as never);
        vi.mocked(mocks.crypto.hashFileDigests)
          .mockResolvedValueOnce({ sha1, sha256, sizeInBytes: 10 })
          .mockResolvedValueOnce({ sha1: Buffer.alloc(20, 9), sha256: Buffer.alloc(32, 9), sizeInBytes: 10 });
        vi.mocked(mocks.asset.getByLibraryIdAndOriginalPath).mockResolvedValue(undefined);

        await sut.handleLocateMissing({ runId: 'run-1', ids: ['health-1'], userId: 'user-1' });

        expect(mocks.crypto.hashFileDigests).toHaveBeenCalledTimes(2);
        expect(mediaHealthRepository.replaceCandidates).toHaveBeenCalledWith(
          'health-1',
          expect.arrayContaining([
            expect.objectContaining({
              candidatePath: '/external/photos/renamed.jpg',
              status: MediaHealthStatus.Found,
              evidence: expect.objectContaining({ reason: 'checksum_match' }),
              resolution: { autoRelinkable: true },
            }),
          ]),
        );
      },
    );

    it('uses each external library own sidecar sizes before hashing candidates', async () => {
      const sha1A = Buffer.alloc(20, 1);
      const sha256A = Buffer.alloc(32, 2);
      const sha1B = Buffer.alloc(20, 3);
      const sha256B = Buffer.alloc(32, 4);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-a', assetId: 'asset-a', category: MediaHealthCategory.Missing },
        { id: 'health-b', assetId: 'asset-b', category: MediaHealthCategory.Missing },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-a',
          ownerId: 'user-1',
          checksum: sha1A,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalPath: '/external/a/missing-a.jpg',
          originalFileName: 'missing-a.jpg',
          type: AssetType.Image,
          isExternal: true,
          libraryId: 'library-a',
        },
        {
          id: 'asset-b',
          ownerId: 'user-1',
          checksum: sha1B,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalPath: '/external/b/missing-b.jpg',
          originalFileName: 'missing-b.jpg',
          type: AssetType.Image,
          isExternal: true,
          libraryId: 'library-b',
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([
        { assetId: 'asset-a', sha1: sha1A, sha256: sha256A, sizeInBytes: 10 },
        { assetId: 'asset-b', sha1: sha1B, sha256: sha256B, sizeInBytes: 20 },
      ]);
      vi.mocked(mocks.library.get)
        .mockResolvedValueOnce({ id: 'library-a', importPaths: ['/external/a'], exclusionPatterns: [] } as never)
        .mockResolvedValueOnce({ id: 'library-b', importPaths: ['/external/b'], exclusionPatterns: [] } as never);
      vi.mocked(mocks.storage.walk)
        .mockReturnValueOnce(
          (async function* () {
            await Promise.resolve();
            yield ['/external/a/wrong-library-size.jpg'];
          })() as never,
        )
        .mockReturnValueOnce(
          (async function* () {
            await Promise.resolve();
            yield ['/external/b/found.jpg'];
          })() as never,
        );
      vi.mocked(mocks.storage.stat).mockResolvedValue({ size: 20 } as never);
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({ sha1: sha1B, sha256: sha256B, sizeInBytes: 20 });
      vi.mocked(mocks.asset.getByLibraryIdAndOriginalPath).mockResolvedValue(undefined);

      await sut.handleLocateMissing({ runId: 'run-1', ids: ['health-a', 'health-b'], userId: 'user-1' });

      expect(mocks.crypto.hashFileDigests).toHaveBeenCalledTimes(1);
      expect(mocks.crypto.hashFileDigests).toHaveBeenCalledWith('/external/b/found.jpg');
      expect(mediaHealthRepository.replaceCandidates).toHaveBeenCalledWith('health-a', []);
      expect(mediaHealthRepository.replaceCandidates).toHaveBeenCalledWith(
        'health-b',
        expect.arrayContaining([
          expect.objectContaining({ candidatePath: '/external/b/found.jpg', status: MediaHealthStatus.Found }),
        ]),
      );
    });

    it('finds managed files by either SHA-1 or SHA-256 regardless of filename and rejects metadata hashes', async () => {
      const sha1 = Buffer.alloc(20, 1);
      const sha256 = Buffer.alloc(32, 2);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-sha1', assetId: 'asset-sha1', category: MediaHealthCategory.Missing },
        { id: 'health-sha256', assetId: 'asset-sha256', category: MediaHealthCategory.Missing },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-sha1',
          ownerId: 'user-1',
          checksum: sha1,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalPath: '/data/upload/user-1/missing.jpg',
          originalFileName: 'missing.jpg',
          type: AssetType.Image,
          isExternal: false,
          libraryId: null,
        },
        {
          id: 'asset-sha256',
          ownerId: 'user-1',
          checksum: sha256,
          checksumAlgorithm: ChecksumAlgorithm.sha256File,
          originalPath: '/data/upload/user-1/missing.mp4',
          originalFileName: 'missing.mp4',
          type: AssetType.Video,
          isExternal: false,
          libraryId: null,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([]);
      vi.mocked(mocks.user.getList).mockResolvedValue([
        { id: 'user-1', storageLabel: null },
        { id: 'user-2', storageLabel: 'other' },
      ] as never);
      vi.mocked(mocks.storage.walk).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield [
            '/data/upload/user-2/gone.jpg',
            '/data/upload/user-2/renamed',
            '/data/library/other/renamed.dat',
            '/data/upload/user-2/found.xmp',
          ];
        })() as never,
      );
      vi.mocked(mocks.crypto.hashFileDigests)
        .mockRejectedValueOnce(new Error('file disappeared'))
        .mockResolvedValueOnce({ sha1, sha256: Buffer.alloc(32, 8), sizeInBytes: 10 })
        .mockResolvedValueOnce({ sha1: Buffer.alloc(20, 9), sha256, sizeInBytes: 20 })
        .mockResolvedValueOnce({ sha1: Buffer.alloc(20, 7), sha256: Buffer.alloc(32, 7), sizeInBytes: 20 });

      await expect(
        sut.handleLocateMissing({ runId: 'run-1', ids: ['health-sha1', 'health-sha256'], userId: 'user-1' }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.crypto.hashFileDigests).toHaveBeenCalledTimes(4);
      expect(mediaHealthRepository.replaceCandidates).toHaveBeenCalledWith(
        'health-sha1',
        expect.arrayContaining([
          expect.objectContaining({
            candidatePath: '/data/upload/user-2/renamed',
            status: MediaHealthStatus.Found,
          }),
        ]),
      );
      expect(mediaHealthRepository.replaceCandidates).toHaveBeenCalledWith(
        'health-sha256',
        expect.arrayContaining([
          expect.objectContaining({
            candidatePath: '/data/library/other/renamed.dat',
            status: MediaHealthStatus.Found,
          }),
        ]),
      );
    });

    it('uses the public SHA-256 match when stale sidecar SHA-1 evidence points elsewhere', async () => {
      const sha1 = Buffer.alloc(20, 1);
      const sha256 = Buffer.alloc(32, 2);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          ownerId: 'user-1',
          checksum: sha256,
          checksumAlgorithm: ChecksumAlgorithm.sha256File,
          originalPath: '/data/upload/user-1/missing.jpg',
          originalFileName: 'missing.jpg',
          type: AssetType.Image,
          isExternal: false,
          libraryId: null,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([
        { assetId: 'asset-1', sha1, sha256, sizeInBytes: 10 },
      ]);
      vi.mocked(mocks.user.getList).mockResolvedValue([{ id: 'user-2', storageLabel: null }] as never);
      vi.mocked(mocks.storage.walk).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield ['/data/upload/user-2/oversized.jpg', '/data/upload/user-2/sha1.jpg', '/data/upload/user-2/sha256.jpg'];
        })() as never,
      );
      vi.mocked(mocks.storage.stat)
        .mockResolvedValueOnce({ size: 20 } as never)
        .mockResolvedValue({ size: 10 } as never);
      vi.mocked(mocks.crypto.hashFileDigests)
        .mockResolvedValueOnce({ sha1, sha256: Buffer.alloc(32, 8), sizeInBytes: 10 })
        .mockResolvedValueOnce({ sha1: Buffer.alloc(20, 9), sha256, sizeInBytes: 10 });

      await sut.handleLocateMissing({ runId: 'run-1', ids: ['health-1'], userId: 'user-1' });

      expect(mocks.crypto.hashFileDigests).toHaveBeenCalledTimes(2);
      expect(mediaHealthRepository.replaceCandidates).toHaveBeenCalledWith('health-1', [
        expect.objectContaining({ candidatePath: '/data/upload/user-2/sha256.jpg', status: MediaHealthStatus.Found }),
      ]);
      expect(mediaHealthRepository.recordSearchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          found: expect.objectContaining({ status: MediaHealthStatus.Found }),
          resolution: expect.objectContaining({ autoRelinkable: true }),
        }),
      );
    });

    it('updates findings to found when locate discovers validated candidates', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Missing,
          originalPath: '/library/missing.jpg',
          originalFileName: 'missing.jpg',
          evidence: { reason: 'source_file_missing_or_unreadable' },
          resolution: { autoRelinkable: true },
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          originalPath: '/library/missing.jpg',
          originalFileName: 'missing.jpg',
          type: AssetType.Image,
          isExternal: true,
          libraryId: 'library-1',
        },
      ] as never);
      vi.spyOn(sut as any, 'locateExternalCandidates').mockResolvedValue(
        new Map([
          [
            'asset-1',
            [
              {
                status: MediaHealthStatus.Found,
                score: 0.91,
                evidence: { path: '/library/found.jpg' },
                resolution: { autoRelinkable: false },
              },
            ],
          ],
        ]),
      );

      await expect(sut.handleLocateMissing({ runId: 'run-1', ids: ['health-1'] })).resolves.toBe(JobStatus.Success);

      expect(mediaHealthRepository.replaceCandidates).toHaveBeenCalledWith('health-1', [
        {
          healthId: 'health-1',
          candidatePath: '/library/found.jpg',
          status: MediaHealthStatus.Found,
          visualMatchScore: 0.91,
          // FL-69: a completed search also decodes each exact match, recorded separately.
          evidence: { path: '/library/found.jpg', decodeValid: true, decodeStatus: 'healthy' },
          resolution: { autoRelinkable: false },
          checkedAt: expect.any(Date),
        },
      ]);
      // F7: only what the search found, written onto the finding as it is now (its other evidence stays)
      expect(mediaHealthRepository.recordSearchResult).toHaveBeenCalledWith({
        healthId: 'health-1',
        assetId: 'asset-1',
        expectedUpdateId: undefined,
        originalPath: '/library/missing.jpg',
        evidence: { candidateCount: 1, validatedCandidateCount: 1, searchTruncated: false },
        resolution: { autoRelinkable: true },
        found: { status: MediaHealthStatus.Found, severity: MediaHealthSeverity.Warning, runId: 'run-1' },
      });
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
    });
  });

  describe('encrypted Locked originals (FL-721, spec §8.3)', () => {
    let directory: string;
    let sealedPath: string;
    const confirmed = {
      status: MediaHealthStatus.CorruptConfirmed,
      score: null,
      evidence: { reason: 'expected_mismatch' },
      resolution: {},
    };
    const sealedAsset = () => ({
      id: 'asset-sealed',
      ownerId: authStub.user1.user.id,
      updateId: 'update-1',
      originalPath: sealedPath,
      originalFileName: 'sealed.jpg',
      type: AssetType.Image,
      checksum: Buffer.alloc(32, 3),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'media-health-locked-'));
      sealedPath = join(directory, 'sealed.jpg');
      // a sealed Locked file: its bytes start with the FLLK magic
      await writeFile(sealedPath, Buffer.concat([Buffer.from('FLLK'), Buffer.alloc(64, 1)]));
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('ScanCorrupt never reports an encrypted file', async () => {
      vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield sealedAsset();
        })() as never,
      );
      // whatever a decoder would say about the ciphertext, it is never a finding
      vi.spyOn(sut as any, 'validateAssetIntegrity').mockResolvedValue(confirmed);
      vi.spyOn(sut as any, 'validateReadableAssetIntegrity').mockResolvedValue(confirmed);

      await expect(sut.handleCorruptScan({ runId: 'corrupt-run', userId: authStub.user1.user.id })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
      expect(mediaHealthRepository.markResolvedForAssets).not.toHaveBeenCalled();
      // counted as "encrypted, not checked"
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith('corrupt-run', {
        status: 'completed',
        totalAssets: 1,
        checkedAssets: 0,
        foundAssets: 0,
      });
    });

    it('the combined scan never reports an encrypted file as damaged', async () => {
      vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield sealedAsset();
        })() as never,
      );
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
      vi.spyOn(sut as any, 'validateReadableAssetIntegrity').mockResolvedValue(confirmed);

      await expect(sut.handleMissingScan({ missingRunId: 'missing-run', corruptRunId: 'corrupt-run' })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'corrupt-run',
        expect.objectContaining({ totalAssets: 1, checkedAssets: 0, foundAssets: 0 }),
      );
    });

    it('DeleteCorrupt refuses to delete a path that starts with FLLK, even if queued', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-sealed',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.TrashQueued,
          checkedAt: new Date(),
          runId: 'corrupt-run',
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([sealedAsset()] as never);
      vi.spyOn(sut as any, 'validateAssetIntegrity').mockResolvedValue(confirmed);

      await expect(sut.handleDeleteCorrupt({ ids: ['health-1'], userId: authStub.user1.user.id })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mediaHealthRepository.trashCorruptIfUnchanged).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetTrashAll', expect.anything());
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      // the finding leaves the trash queue
      expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'health-1',
          status: MediaHealthStatus.Resolved,
          evidence: { reason: 'locked_encrypted' },
          resolution: { trashSkipped: true },
        }),
      );
    });

    it('deleteCorrupt never queues an encrypted original for the trash', async () => {
      vi.mocked(mocks.user.getForPinCode).mockResolvedValue({ password: '', pinCode: null });
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-sealed',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.CorruptConfirmed,
          checkedAt: new Date(),
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([sealedAsset()] as never);
      vi.spyOn(sut as any, 'validateAssetIntegrity').mockResolvedValue(confirmed);

      await expect(
        sut.deleteCorrupt(authStub.user1, { ids: ['health-1'], confirmText: CORRUPT_MEDIA_DELETE_CONFIRM_TEXT }),
      ).rejects.toThrow('no longer failed');

      expect(mediaHealthRepository.markStatus).not.toHaveBeenCalled();
      expect(mediaOperationService.createBulk).not.toHaveBeenCalled();
    });

    it('never brings an untracked encrypted file back as a new photo', async () => {
      vi.mocked(mediaHealthRepository.streamAssets).mockReturnValue(
        // eslint-disable-next-line require-yield
        (async function* () {
          await Promise.resolve();
        })() as never,
      );
      vi.mocked(mocks.user.get).mockResolvedValue({
        id: 'user-1',
        storageLabel: 'owner',
        quotaSizeInBytes: null,
        quotaUsageInBytes: 0,
      } as never);
      vi.mocked(mocks.storage.walk).mockReturnValue(
        (async function* () {
          await Promise.resolve();
          yield [sealedPath];
        })() as never,
      );
      vi.mocked(mediaHealthRepository.getTrackedPaths).mockResolvedValue(new Set());

      await sut.handleMissingScan({ missingRunId: 'missing-run', corruptRunId: 'corrupt-run', userId: 'user-1' });

      expect(mocks.crypto.hashFileDigests).not.toHaveBeenCalled();
      expect(mocks.asset.create).not.toHaveBeenCalled();
    });
  });

  describe('handleDeleteCorrupt', () => {
    it('moves revalidated corrupt media to trash without queueing permanent file deletion', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          status: MediaHealthStatus.TrashQueued,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          originalPath: '/library/file.jpg',
          originalFileName: 'file.jpg',
          type: AssetType.Image,
        },
      ] as never);
      vi.spyOn(sut as any, 'validateAssetIntegrity').mockResolvedValue({
        status: MediaHealthStatus.CorruptConfirmed,
        score: null,
        evidence: {},
        resolution: {},
      });

      await expect(sut.handleDeleteCorrupt({ ids: ['health-1'], userId: authStub.admin.user.id })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mediaHealthRepository.trashCorruptIfUnchanged).toHaveBeenCalledWith({
        healthId: 'health-1',
        asset: expect.objectContaining({ id: 'asset-1' }),
      });
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetTrashAll', {
        assetIds: ['asset-1'],
        userId: authStub.admin.user.id,
      });
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mediaHealthRepository.markStatus).not.toHaveBeenCalled();
    });

    it('a check that could not finish changes nothing: not trashed, and never recorded as suspected damage', async () => {
      // FL-1353: a 50 GB video that timed out here used to be written back as "suspected damage"
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', status: MediaHealthStatus.TrashQueued },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        { id: 'asset-1', originalPath: '/library/film.mov', originalFileName: 'film.mov', type: AssetType.Video },
      ] as never);
      vi.spyOn(sut as any, 'validateAssetIntegrity').mockResolvedValue({
        busy: true,
        candidate: {
          status: MediaHealthStatus.CorruptSuspect,
          score: null,
          evidence: { reason: 'validation_timeout', validationStatus: 'timeout' },
          resolution: {},
        },
      });

      await sut.handleDeleteCorrupt({ ids: ['health-1'], userId: authStub.admin.user.id });

      expect(mediaHealthRepository.trashCorruptIfUnchanged).not.toHaveBeenCalled();
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
    });
  });

  describe('handleLocateMissing', () => {
    it('stores validated candidates without relinking during locate', async () => {
      vi.mocked(mediaHealthRepository.createRun).mockResolvedValue({ id: 'run-1' } as never);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Missing,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          originalPath: '/library/file.jpg',
          originalFileName: 'file.jpg',
          type: AssetType.Image,
          isExternal: true,
          libraryId: 'library-1',
        },
      ] as never);

      vi.spyOn(sut as any, 'locateExternalCandidates').mockResolvedValue(
        new Map([
          [
            'asset-1',
            [
              {
                status: MediaHealthStatus.Found,
                score: 0.98,
                evidence: { path: '/library/relinked/file.jpg' },
                resolution: {},
              },
            ],
          ],
        ]),
      );

      await expect(sut.handleLocateMissing({ ids: ['health-1'] })).resolves.toBe(JobStatus.Success);

      expect(mediaHealthRepository.replaceCandidates).toHaveBeenCalledWith(
        'health-1',
        expect.arrayContaining([
          expect.objectContaining({
            candidatePath: '/library/relinked/file.jpg',
            status: MediaHealthStatus.Found,
          }),
        ]),
      );
      expect(mediaHealthRepository.relinkExternalAsset).not.toHaveBeenCalled();
      expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'completed', checkedAssets: 1, foundAssets: 1 }),
      );
    });
  });

  it.each([ChecksumAlgorithm.sha1File, ChecksumAlgorithm.sha256File])(
    'reports decodable wrong content as corruption using stored %s identity',
    async (algorithm) => {
      const directory = await mkdtemp(join(tmpdir(), 'health-content-audit-'));
      try {
        const imagePath = join(directory, 'original.png');
        await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
          .png()
          .toFile(imagePath);
        const original = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } })
          .png()
          .toBuffer();
        const expected = createHash(algorithm === ChecksumAlgorithm.sha1File ? 'sha1' : 'sha256')
          .update(original)
          .digest();
        const checker = new MediaIntegrityService(
          new StorageRepository(mocks.logger as never),
          new CryptoRepository(),
          new MediaRepository(mocks.logger as never),
        );
        Object.assign(sut, { integrityService: checker });
        const asset = AssetFactory.create({
          originalPath: imagePath,
          originalFileName: 'original.png',
          type: AssetType.Image,
          checksumAlgorithm: algorithm,
          checksum: expected,
        });
        const result = await (sut as any).validateReadableAssetIntegrity(asset);
        expect(result).toMatchObject({
          status: MediaHealthStatus.CorruptConfirmed,
          evidence: { reason: 'expected_mismatch' },
        });
        // A path checksum is not expected file content.
        const pathResult = await (sut as any).validateReadableAssetIntegrity({
          ...asset,
          checksumAlgorithm: ChecksumAlgorithm.sha1Path,
        });
        expect(pathResult).toBeNull();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('uses public content identity ahead of stale sidecars and requires complete sidecar identity for path hashes', async () => {
    const digests = { sha1: Buffer.alloc(20, 1), sha256: Buffer.alloc(32, 2), sizeInBytes: 100 };
    vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue(digests);
    const asset = AssetFactory.create({
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      checksum: Buffer.alloc(32, 3),
    });
    vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([{ assetId: asset.id, ...digests }]);
    expect(await (sut as any).validateManagedCandidate(asset, '/candidate.jpg')).toBeUndefined();
    asset.checksum = digests.sha256;
    vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([
      { assetId: asset.id, ...digests, sha256: Buffer.alloc(32, 3) },
    ]);
    expect(await (sut as any).validateManagedCandidate(asset, '/candidate.jpg')).toEqual(digests);
    asset.checksumAlgorithm = ChecksumAlgorithm.sha1Path;
    expect(await (sut as any).validateManagedCandidate(asset, '/candidate.jpg')).toBeUndefined();
    vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([{ assetId: asset.id, ...digests }]);
    expect(await (sut as any).validateManagedCandidate(asset, '/candidate.jpg')).toEqual(digests);
  });

  describe('classifyImageDecodeFailure', () => {
    it('keeps unsupported raws out of corrupt findings after the libraw fallback fails', () => {
      const error = new Error('Unsupported file format or not RAW file');

      expect(classifyImageDecodeFailure(error, { isRaw: true, enhancedRawAttempted: true })).toBe(
        MediaHealthStatus.UnsupportedRaw,
      );
    });
  });
  describe('Library care settings (FL-69)', () => {
    const care = (libraryCare: Record<string, unknown>) => {
      clearConfigCache();
      vi.mocked(mocks.systemMetadata.get).mockResolvedValue({ libraryCare } as never);
    };

    it('keeps the health scan timer stopped on the server that holds the lock: the overnight schedule starts it (FL-363)', async () => {
      vi.mocked(mocks.database.tryLock).mockResolvedValue(true);
      vi.mocked(mocks.cron.create).mockReturnValue();
      vi.mocked(mocks.cron.update).mockReturnValue();
      await sut.onConfigInit({
        newConfig: { libraryCare: { healthScan: false, healthScanCronExpression: '0 02 * * *' } },
      } as never);
      expect(mocks.cron.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'libraryCareHealthScan', expression: '0 02 * * *', start: false }),
      );

      sut.onConfigUpdate({
        newConfig: { libraryCare: { healthScan: true, healthScanCronExpression: '0 03 * * *' } },
      } as never);
      expect(mocks.cron.update).toHaveBeenCalledWith({
        name: 'libraryCareHealthScan',
        expression: '0 03 * * *',
        start: false,
      });
    });

    it('leaves the schedule to another server when the lock is taken', async () => {
      vi.mocked(mocks.database.tryLock).mockResolvedValue(false);
      await sut.onConfigInit({
        newConfig: { libraryCare: { healthScan: true, healthScanCronExpression: '0 02 * * *' } },
      } as never);
      sut.onConfigUpdate({
        newConfig: { libraryCare: { healthScan: true, healthScanCronExpression: '0 02 * * *' } },
      } as never);
      expect(mocks.cron.create).not.toHaveBeenCalled();
      expect(mocks.cron.update).not.toHaveBeenCalled();
    });

    it('starts no scheduled scan while "Schedule incremental health scans" is off', async () => {
      care({ healthScan: false });
      await expect(sut.startScheduledScans()).resolves.toBe(0);
      expect(mediaOperationRepository.create).not.toHaveBeenCalled();
    });

    it('scans each account for what changed since its last completed scan, or everything', async () => {
      vi.useFakeTimers({ now: new Date('2026-09-25T02:00:00.000Z'), toFake: ['Date'] });
      care({ healthScan: true });
      vi.mocked(mocks.user.getList).mockResolvedValue([{ id: 'user-a' }, { id: 'user-b' }] as never);
      vi.mocked(mediaHealthRepository.createRun).mockImplementation((category) =>
        Promise.resolve({ id: `run-${category}` } as never),
      );
      const completed = new Date('2026-09-20T02:00:00.000Z');
      vi.mocked(mediaOperationRepository.list).mockImplementation(
        (options: any) =>
          Promise.resolve(
            options.ownerId === 'user-a' && options.statuses?.includes(MediaOperationStatus.Completed)
              ? {
                  items: [
                    {
                      id: 'op-1',
                      snapshot: { mode: 'scan', userId: 'user-a', missingRunId: 'm', corruptRunId: 'c' },
                      createdAt: completed,
                    },
                  ],
                  total: 1,
                }
              : { items: [], total: 0 },
          ) as never,
      );

      await expect(sut.startScheduledScans()).resolves.toBe(2);

      const snapshots = vi.mocked(mediaOperationRepository.create).mock.calls.map(([operation]) => operation.snapshot);
      expect(snapshots).toEqual([
        expect.objectContaining({ userId: 'user-a', changedSince: completed.toISOString(), scheduled: true }),
        expect.objectContaining({ userId: 'user-b', scheduled: true }),
      ]);
      expect(snapshots[1]).not.toHaveProperty('changedSince');
      expect(vi.mocked(mediaOperationRepository.create).mock.calls[0][0].label).toBe('Scheduled library health scan');
      vi.useRealTimers();
    });

    it('makes a scheduled scan full at least weekly, so files removed or damaged later are found (FL-69)', async () => {
      vi.useFakeTimers({ now: new Date('2026-09-25T02:00:00.000Z'), toFake: ['Date'] });
      care({ healthScan: true });
      vi.mocked(mocks.user.getList).mockResolvedValue([{ id: 'recent' }, { id: 'stale' }, { id: 'no-full' }] as never);
      vi.mocked(mediaHealthRepository.createRun).mockImplementation((category) =>
        Promise.resolve({ id: `run-${category}` } as never),
      );
      const scan = (userId: string, createdAt: string, changedSince?: string) => ({
        id: `op-${userId}-${createdAt}`,
        snapshot: { mode: 'scan', userId, missingRunId: 'm', corruptRunId: 'c', ...(changedSince && { changedSince }) },
        createdAt: new Date(createdAt),
      });
      const history: Record<string, unknown[]> = {
        // Incremental yesterday, full three days ago: incremental from yesterday.
        recent: [
          scan('recent', '2026-09-24T02:00:00.000Z', '2026-09-23T02:00:00.000Z'),
          scan('recent', '2026-09-22T02:00:00.000Z'),
        ],
        // Last full scan eight days ago: full, whatever the incremental ones since, and a scan of
        // chosen photos (FL-737) is no full scan.
        stale: [
          {
            ...scan('stale', '2026-09-24T09:00:00.000Z'),
            snapshot: { mode: 'scan', userId: 'stale', missingRunId: 'm', corruptRunId: 'c', assetIds: ['a'] },
          },
          scan('stale', '2026-09-24T02:00:00.000Z', '2026-09-23T02:00:00.000Z'),
          scan('stale', '2026-09-17T02:00:00.000Z'),
        ],
        // Only incremental scans in reach: full.
        'no-full': [scan('no-full', '2026-09-24T02:00:00.000Z', '2026-09-23T02:00:00.000Z')],
      };
      vi.mocked(mediaOperationRepository.list).mockImplementation(
        (options: any) =>
          Promise.resolve(
            options.statuses?.includes(MediaOperationStatus.Completed)
              ? { items: history[options.ownerId] ?? [], total: 0 }
              : { items: [], total: 0 },
          ) as never,
      );

      await expect(sut.startScheduledScans()).resolves.toBe(3);

      const snapshots = vi.mocked(mediaOperationRepository.create).mock.calls.map(([operation]) => operation.snapshot);
      expect(snapshots[0]).toMatchObject({ userId: 'recent', changedSince: '2026-09-24T02:00:00.000Z' });
      expect(snapshots[1]).toMatchObject({ userId: 'stale' });
      expect(snapshots[1]).not.toHaveProperty('changedSince');
      expect(snapshots[2]).toMatchObject({ userId: 'no-full' });
      expect(snapshots[2]).not.toHaveProperty('changedSince');
      vi.useRealTimers();
    });

    it.each([
      ['a full scan', {}],
      ['an incremental scan', { changedSince: '2026-10-31T02:00:00.000Z' }],
    ])('keeps %s an account already has instead of starting a second one', async (_, extra) => {
      care({ healthScan: true });
      vi.mocked(mocks.user.getList).mockResolvedValue([{ id: 'user-a' }] as never);
      vi.mocked(mediaOperationRepository.list).mockImplementation(
        (options: any) =>
          Promise.resolve(
            options.statuses?.includes(MediaOperationStatus.Paused)
              ? {
                  items: [
                    {
                      id: 'op-open',
                      snapshot: { mode: 'scan', userId: 'user-a', missingRunId: 'm', corruptRunId: 'c', ...extra },
                    },
                  ],
                  total: 1,
                }
              : { items: [], total: 0 },
          ) as never,
      );

      await expect(sut.startScheduledScans()).resolves.toBe(1);
      expect(mediaOperationRepository.create).not.toHaveBeenCalled();
    });

    it('scans only assets changed since an incremental scan began', async () => {
      care({ checksumScan: true });
      vi.mocked(mediaHealthRepository.getAssetPage).mockResolvedValue([]);
      const snapshot = {
        mode: 'scan' as const,
        userId: 'user-id',
        missingRunId: 'm',
        corruptRunId: 'c',
        changedSince: '2026-09-20T02:00:00.000Z',
      };

      await sut.scanPage(snapshot, null, 25);
      await sut.countScanAssets('user-id', snapshot.changedSince);

      expect(mediaHealthRepository.getAssetPage).toHaveBeenCalledWith({
        ownerId: 'user-id',
        afterId: null,
        limit: 25,
        changedSince: new Date(snapshot.changedSince),
      });
      expect(mediaHealthRepository.countScanAssets).toHaveBeenCalledWith('user-id', new Date(snapshot.changedSince));
    });

    it.each([
      [{ status: 'transient', reason: 'validation_busy' }],
      [{ status: 'transient', reason: 'io_failed' }],
      [{ status: 'timeout', reason: 'decode_timeout' }],
    ])('a busy validation records no damage (%j)', async (outcome) => {
      const asset = AssetFactory.create({ id: 'asset-1', originalPath: '/data/a.jpg' });
      const validate = (sut as any).integrityService.validate as ReturnType<typeof vi.fn>;
      validate.mockResolvedValueOnce(outcome);

      expect(await (sut as any).validateReadableAssetIntegrity(asset)).toMatchObject({ busy: true });
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
    });

    it.each([
      [{ status: 'transient', reason: 'decoder_unavailable' }],
      [{ status: 'transient', reason: 'decoder_resource_limit' }],
      [{ status: 'transient', reason: 'file_changed' }],
    ])('also counts %j as busy', async (outcome) => {
      const asset = AssetFactory.create({ id: 'asset-1', originalPath: '/data/a.jpg' });
      ((sut as any).integrityService.validate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(outcome);
      expect(await (sut as any).validateReadableAssetIntegrity(asset)).toMatchObject({ busy: true });
    });

    it.each([
      [{ status: 'transient', reason: 'decode_unverified' }],
      [{ status: 'transient', reason: 'raw_decode_damaged' }],
    ])('keeps %j as a suspect, not busy', async (outcome) => {
      const asset = AssetFactory.create({ id: 'asset-1', originalPath: '/data/a.jpg' });
      ((sut as any).integrityService.validate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(outcome);
      expect(await (sut as any).validateReadableAssetIntegrity(asset)).toMatchObject({
        status: MediaHealthStatus.CorruptSuspect,
      });
    });

    it('a manual repair on a busy check refuses and records no finding', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', originalPath: '/data/a.jpg' });
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
      vi.spyOn(sut as any, 'requireRepairable').mockReturnValue(undefined);
      vi.spyOn(sut as any, 'isEncryptedOriginal').mockResolvedValue(false);
      ((sut as any).integrityService.validate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: 'transient',
        reason: 'validation_busy',
      });

      await expect((sut as any).damageFindingFor(authStub.admin, asset.id)).rejects.toThrow(
        "Frameleaf couldn't check this photo just now. Try again in a few minutes.",
      );
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
    });

    it('a delete revalidation on a busy check leaves the finding as it is', async () => {
      vi.mocked(mocks.user.getForPinCode).mockResolvedValue({ password: '', pinCode: null });
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.CorruptConfirmed,
          checkedAt: new Date(),
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        { id: 'asset-1', originalPath: '/library/file.jpg', originalFileName: 'file.jpg', type: AssetType.Image },
      ] as never);
      vi.spyOn(sut as any, 'isEncryptedOriginal').mockResolvedValue(false);
      ((sut as any).integrityService.validate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: 'timeout',
        reason: 'decode_timeout',
      });

      await expect(
        sut.deleteCorrupt(authStub.user1, { ids: ['health-1'], confirmText: CORRUPT_MEDIA_DELETE_CONFIRM_TEXT }),
      ).rejects.toThrow('no longer failed deletion revalidation');
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
      expect(mediaHealthRepository.markStatus).not.toHaveBeenCalled();
    });

    it('a busy validation keeps an open corrupt finding open', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', originalPath: '/data/a.jpg' });
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
      const validate = (sut as any).integrityService.validate as ReturnType<typeof vi.fn>;
      validate.mockResolvedValueOnce({ status: 'transient', reason: 'validation_busy' });

      const found = await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run');

      expect(found).toBe('busy');
      expect(mediaHealthRepository.markResolvedForAssets).not.toHaveBeenCalled();
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
    });

    describe('file checks hand what they find to the fix', () => {
      const asset = AssetFactory.create({
        id: 'asset-1',
        originalPath: '/data/trips/a.jpg',
        createdAt: new Date('2026-01-02T03:04:05Z'),
      });
      const queued = { name: JobName.MediaHealthFixAsset, data: { id: 'asset-1', from: 'check' } };

      beforeEach(() => {
        vi.spyOn(sut as any, 'ownerFolders').mockResolvedValue(['/data']);
        vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue([]);
        vi.mocked(mediaHealthRepository.upsertFinding).mockResolvedValue({ id: 'health-1' } as never);
      });

      it('a new missing file is recorded and sent to be fixed', async () => {
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);

        expect(await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run')).toBe('missing');

        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
          expect.objectContaining({
            category: MediaHealthCategory.Missing,
            status: MediaHealthStatus.Missing,
            steps: [
              { step: 'added', outcome: 'info', at: asset.createdAt },
              { step: 'not-on-drive', outcome: 'failed', facts: { folder: 'trips', name: 'a.jpg' } },
            ],
          }),
        );
        expect(mocks.job.queue).toHaveBeenCalledTimes(1);
        expect(mocks.job.queue).toHaveBeenCalledWith(queued);
      });

      it('an already-open finding that was handled is not sent again', async () => {
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
        vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue([
          {
            id: 'health-1',
            assetId: 'asset-1',
            category: MediaHealthCategory.Missing,
            status: MediaHealthStatus.Missing,
            evidence: { fixState: 'missing' },
            resolvedAt: null,
            dismissedAt: null,
          },
        ] as never);

        expect(await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run')).toBe('missing');

        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(expect.objectContaining({ steps: [] }));
        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('an open finding nobody has handled yet is sent once, with no new history', async () => {
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
        const open = {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Missing,
          evidence: { source: 'import' },
          resolvedAt: null,
          dismissedAt: null,
        };
        vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue([open] as never);

        await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run');

        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(expect.objectContaining({ steps: [] }));
        expect(mocks.job.queue).toHaveBeenCalledTimes(1);
        expect(mocks.job.queue).toHaveBeenCalledWith(queued);

        // a search that is waiting on its next try has been handled too
        mocks.job.queue.mockClear();
        vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue([
          { ...open, evidence: { searchPending: true } },
        ] as never);
        await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run');
        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('a resolved finding that comes back is recorded and sent again, without a second back-fill', async () => {
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
        vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue([
          {
            id: 'health-1',
            assetId: 'asset-1',
            category: MediaHealthCategory.Missing,
            status: MediaHealthStatus.Resolved,
            resolvedAt: new Date(),
            dismissedAt: null,
          },
        ] as never);

        await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run');

        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
          expect.objectContaining({
            steps: [{ step: 'not-on-drive', outcome: 'failed', facts: { folder: 'trips', name: 'a.jpg' } }],
          }),
        );
        expect(mocks.job.queue).toHaveBeenCalledWith(queued);
      });

      it('a new damaged file records that it will not open and is sent with the decoder message', async () => {
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
        ((sut as any).integrityService.validate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          status: 'corrupt',
          reason: 'decode_failed',
          message: 'Premature end of JPEG file',
        });

        expect(await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run')).toBe('corrupt');

        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
          expect.objectContaining({
            category: MediaHealthCategory.Corrupt,
            status: MediaHealthStatus.CorruptConfirmed,
            steps: [
              { step: 'added', outcome: 'info', at: asset.createdAt },
              { step: 'wont-open', outcome: 'failed', facts: { folder: 'trips', name: 'a.jpg' } },
            ],
          }),
        );
        expect(mocks.job.queue).toHaveBeenCalledWith({
          ...queued,
          data: { ...queued.data, message: 'Premature end of JPEG file' },
        });
      });

      it('a changed file is sent without a reason passed off as the decoder’s words, and not as one that won’t open (F1)', async () => {
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
        ((sut as any).integrityService.validate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          status: 'corrupt',
          reason: 'expected_mismatch',
        });

        expect(await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run')).toBe('corrupt');

        // it may well open: the fix looks at it and says what it found
        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
          expect.objectContaining({
            status: MediaHealthStatus.CorruptConfirmed,
            steps: [{ step: 'added', outcome: 'info', at: asset.createdAt }],
          }),
        );
        expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith(queued);
      });

      it.each([
        ['a file it can’t decode', { status: 'unsupported', reason: 'raw_decode_unsupported' }, []],
        [
          'suspected damage',
          { status: 'transient', reason: 'decode_unverified', message: 'VipsForeignLoad: bad things' },
          [{ step: 'wont-open', outcome: 'failed', facts: { folder: 'trips', name: 'a.jpg' } }],
        ],
      ])('%s is sent to the fix too, so it never sits in Needs you unlooked at (F5)', async (_, result, says) => {
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
        ((sut as any).integrityService.validate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(result);

        expect(await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run')).toBe('corrupt');

        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
          expect.objectContaining({ steps: [{ step: 'added', outcome: 'info', at: asset.createdAt }, ...says] }),
        );
        expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({
          ...queued,
          data: { ...queued.data, ...('message' in result && { message: result.message }) },
        });
      });

      it.each([
        [MediaHealthStatus.Found, { fixState: 'left-as-is' }],
        [MediaHealthStatus.Candidate, { fixState: 'missing', searchPending: false }],
      ])(
        'a missing file whose copies were found (%s) is the same problem: nothing new, its Keep kept (F6)',
        async (status, evidence) => {
          vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
          vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue([
            {
              id: 'health-1',
              assetId: 'asset-1',
              category: MediaHealthCategory.Missing,
              status,
              evidence,
              resolvedAt: null,
              dismissedAt: null,
            },
          ] as never);

          expect(await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run')).toBe('missing');

          // refreshed as missing (the repository keeps how the fix left it), with no new line and no new search
          expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
            expect.objectContaining({ status: MediaHealthStatus.Missing, steps: [] }),
          );
          expect(mocks.job.queue).not.toHaveBeenCalled();
        },
      );

      it('suspected damage confirmed later is the same problem: handed over once if nobody has, never twice', async () => {
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
        const validate = (sut as any).integrityService.validate as ReturnType<typeof vi.fn>;
        const suspect = {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.CorruptSuspect,
          evidence: { reason: 'decode_unverified' },
          resolvedAt: null,
          dismissedAt: null,
        };
        vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue([suspect] as never);
        validate.mockResolvedValueOnce({ status: 'corrupt', reason: 'decode_failed', message: 'Premature end' });

        await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run');

        // nobody had looked at the suspect: it goes to the fix once, with no second "won't open"
        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
          expect.objectContaining({ status: MediaHealthStatus.CorruptConfirmed, steps: [] }),
        );
        expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({
          ...queued,
          data: { ...queued.data, message: 'Premature end' },
        });

        // the fix had settled it: confirmed now, it is still the problem the fix settled
        mocks.job.queue.mockClear();
        vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue([
          { ...suspect, evidence: { reason: 'decode_unverified', fixState: 'cant-repair' } },
        ] as never);
        validate.mockResolvedValueOnce({ status: 'corrupt', reason: 'decode_failed', message: 'Premature end' });
        await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run');
        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('a dismissed problem the check finds again is a new one: recorded and sent again', async () => {
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
        vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue([
          {
            id: 'health-1',
            assetId: 'asset-1',
            category: MediaHealthCategory.Missing,
            status: MediaHealthStatus.Missing,
            evidence: { fixState: 'missing' },
            resolvedAt: null,
            dismissedAt: new Date(),
          },
        ] as never);

        await (sut as any).scanAsset(asset, 'missing-run', 'corrupt-run');

        // the repository starts its evidence afresh (medium spec), so the fix runs instead of seeing it settled
        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
          expect.objectContaining({
            steps: [{ step: 'not-on-drive', outcome: 'failed', facts: { folder: 'trips', name: 'a.jpg' } }],
          }),
        );
        expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith(queued);
      });

      it('a file under an unplugged drive is not judged', async () => {
        const upload = StorageCore.getBaseFolder(StorageFolder.Upload);
        const lost = { ...asset, originalPath: join(upload, 'user-id', 'a.jpg') };
        vi.mocked(mocks.storage.stat).mockImplementation((file) =>
          file === join(upload, '.frameleaf')
            ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
            : Promise.resolve(settledStat({ size: 10 }) as never),
        );
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);

        expect(await (sut as any).scanAsset(lost, 'missing-run', 'corrupt-run')).toBe('busy');

        expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
        expect(mediaHealthRepository.markResolvedForAssets).not.toHaveBeenCalled();
        expect(mocks.job.queue).not.toHaveBeenCalled();
      });
    });

    it('verifies original checksums in a scan only while "Verify original checksums" is on', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', originalPath: '/data/a.jpg' });
      const withSha1 = { ...asset, checksum: Buffer.from('abc'), checksumAlgorithm: ChecksumAlgorithm.sha1File };
      vi.mocked(mediaHealthRepository.getAssetPage).mockResolvedValue([withSha1] as never);
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
      const validate = (sut as any).integrityService.validate as ReturnType<typeof vi.fn>;
      const snapshot = { mode: 'scan' as const, userId: 'user-id', missingRunId: 'm', corruptRunId: 'c' };

      care({ checksumScan: true });
      await sut.scanPage(snapshot, null, 25);
      expect(validate).toHaveBeenLastCalledWith(expect.objectContaining({ expected: { sha1: withSha1.checksum } }));

      care({ checksumScan: false });
      await sut.scanPage(snapshot, null, 25);
      expect(validate).toHaveBeenLastCalledWith(expect.objectContaining({ expected: undefined, deep: true }));
    });

    it('leaves RAW originals out of a search while "Suggest recoverable RAW sources" is off', async () => {
      care({ rawRecovery: false });
      const raw = {
        id: 'health-raw',
        assetId: 'asset-raw',
        category: MediaHealthCategory.Missing,
        originalFileName: 'Forest.ARW',
      };
      const jpeg = {
        id: 'health-jpg',
        assetId: 'asset-jpg',
        category: MediaHealthCategory.Missing,
        originalFileName: 'Lake.jpg',
      };
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([raw] as never);
      await expect(sut.locateMissing(authStub.admin, { ids: [raw.id] })).rejects.toThrow('RAW sources is turned off');

      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([raw, jpeg] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.createRun).mockResolvedValue({ id: 'run-1' } as never);
      await sut.locateMissing(authStub.admin, { ids: [raw.id, jpeg.id] });
      expect(vi.mocked(mediaOperationRepository.create).mock.calls[0][0].snapshot).toEqual(
        expect.objectContaining({ findingIds: [jpeg.id] }),
      );
    });

    it('reports the settings that decide what Library Care offers in the summary', async () => {
      care({ rawRecovery: false, duplicateReview: false });
      const summary = await sut.summary(authStub.admin, {});
      expect(summary.care).toEqual({
        healthScan: true,
        checksumScan: true,
        integrityAudit: true,
        rawRecovery: false,
        duplicateReview: false,
      });
    });
  });

  describe('reopen (FL-69, UT-2)', () => {
    const finding = (overrides: Record<string, unknown>) => ({
      id: 'health-1',
      assetId: 'asset-1',
      category: MediaHealthCategory.Corrupt,
      status: MediaHealthStatus.Dismissed,
      resolution: {},
      ...overrides,
    });

    it('puts a dismissed finding back to the status its dismissal recorded', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        finding({ resolution: { dismissedFrom: MediaHealthStatus.CorruptSuspect } }),
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([]);

      await expect(sut.reopen(authStub.user1, { ids: ['health-1'] })).resolves.toEqual({
        results: [{ id: 'health-1', success: true, status: MediaHealthStatus.CorruptSuspect }],
      });
      expect(mediaHealthRepository.reopenFinding).toHaveBeenCalledWith(
        'health-1',
        MediaHealthStatus.Dismissed,
        MediaHealthStatus.CorruptSuspect,
      );
      // An owner reaches only their own findings, with their own privacy.
      expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['health-1'], authStub.user1.user.id, {});
    });

    it('does not guess the status of a finding dismissed before undo existed', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([finding({})] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([]);

      const { results } = await sut.reopen(authStub.user1, { ids: ['health-1'] });
      expect(results[0]).toMatchObject({ success: false, error: expect.stringContaining('scan again') });
      expect(mediaHealthRepository.reopenFinding).not.toHaveBeenCalled();
    });

    it('reopens trashed damage as confirmed only once its item is out of the trash', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        finding({ status: MediaHealthStatus.Trashed }),
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([{ id: 'asset-1', deletedAt: new Date() }] as never);
      const refused = await sut.reopen(authStub.user1, { ids: ['health-1'] });
      expect(refused.results[0]).toMatchObject({ success: false, error: 'Restore the item from the trash first' });

      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([{ id: 'asset-1', deletedAt: null }] as never);
      const reopened = await sut.reopen(authStub.user1, { ids: ['health-1'] });
      expect(reopened.results[0]).toEqual({
        id: 'health-1',
        success: true,
        status: MediaHealthStatus.CorruptConfirmed,
      });
      expect(mediaHealthRepository.reopenFinding).toHaveBeenCalledWith(
        'health-1',
        MediaHealthStatus.Trashed,
        MediaHealthStatus.CorruptConfirmed,
      );
    });

    it('leaves damage a trash job still holds', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        finding({ status: MediaHealthStatus.TrashQueued }),
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([{ id: 'asset-1', deletedAt: null }] as never);
      vi.mocked(mediaHealthRepository.getActiveTrashFindingIds).mockResolvedValue(['health-1']);

      const { results } = await sut.reopen(authStub.user1, { ids: ['health-1'] });
      expect(results[0].success).toBe(false);
      expect(mediaHealthRepository.reopenFinding).not.toHaveBeenCalled();
    });

    it('never reopens a relink or a finding the reader cannot reach', async () => {
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        finding({ category: MediaHealthCategory.Missing, status: MediaHealthStatus.Relinked }),
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([]);

      const { results } = await sut.reopen(authStub.user1, { ids: ['health-1', 'someone-elses'] });
      expect(results).toEqual([
        expect.objectContaining({ id: 'health-1', success: false }),
        { id: 'someone-elses', success: false, error: 'Finding is not available' },
      ]);
      expect(mediaHealthRepository.reopenFinding).not.toHaveBeenCalled();
    });
  });

  describe('inspect evidence (FL-69)', () => {
    it('lists the recorded checksums, the candidate checksums and, for an administrator, the provenance', async () => {
      const asset = {
        ...AssetFactory.create({
          id: 'asset-1',
          ownerId: authStub.admin.user.id,
          originalPath: '/data/upload/admin/a.jpg',
          originalFileName: 'a.jpg',
        }),
        checksum: Buffer.from('0a0b', 'hex'),
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
      };
      const resolvedAt = new Date('2026-09-21T10:00:00.000Z');
      const row = {
        id: 'health-1',
        assetId: asset.id,
        category: MediaHealthCategory.Missing,
        status: MediaHealthStatus.Relinked,
        severity: MediaHealthSeverity.Info,
        originalPath: asset.originalPath,
        originalFileName: asset.originalFileName,
        evidence: {
          reason: 'candidate_relinked',
          previousPath: '/data/upload/admin/old.jpg',
          provenance: { relinkedBy: authStub.admin.user.id, rootId: MANAGED_ROOT_ID },
        },
        resolution: {},
        checkedAt: resolvedAt,
        dismissedAt: null,
        resolvedAt,
      };
      vi.mocked(mediaHealthRepository.list).mockResolvedValue([row] as never);
      vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue(undefined);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
      vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([
        { assetId: asset.id, sha1: Buffer.from('0a0b', 'hex'), sha256: Buffer.from('ff', 'hex') },
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: '/data/upload/admin/a.jpg',
          status: MediaHealthStatus.Found,
          evidence: { algorithms: ['sha1'], sha1: '0a0b' },
          resolution: {},
          visualMatchScore: 1,
          checkedAt: resolvedAt,
        },
      ] as never);
      vi.mocked(mocks.user.get).mockResolvedValue({ id: asset.ownerId, storageLabel: null } as never);

      const item = (await sut.list(authStub.admin, { size: 10 })).buckets[0].items[0];

      expect(item.expectedChecksums).toEqual([
        { algorithm: 'sha1', value: '0a0b' },
        { algorithm: 'sha256', value: 'ff' },
      ]);
      expect(item.candidates[0].checksums).toEqual([{ algorithm: 'sha1', value: '0a0b' }]);
      expect(item.provenance).toEqual({
        action: 'relinked',
        userId: authStub.admin.user.id,
        rootId: MANAGED_ROOT_ID,
        rootKind: 'managed',
        rootLabel: 'Library storage',
        at: resolvedAt.toISOString(),
        previousPath: '/data/upload/admin/old.jpg',
        sourcePath: null,
      });

      // An owner never sees who repaired it from which location.
      const ownerItem = (
        await sut.list({ ...authStub.admin, user: { ...authStub.admin.user, isAdmin: false } } as never, { size: 10 })
      ).buckets[0].items[0];
      expect(ownerItem.provenance).toBeNull();
    });
  });

  describe('external original digests (FL-69)', () => {
    const digests = { sha1: Buffer.alloc(20, 1), sha256: Buffer.alloc(32, 2), sizeInBytes: 123 };
    const healthy = { status: 'healthy', reason: 'verified', ...digests, identity: {} };
    const readsHealthy = () => {
      Object.assign(sut, { integrityService: { validate: vi.fn().mockResolvedValue(healthy) } });
    };

    it('records the digests of a path-checksum original that reads back intact', async () => {
      readsHealthy();
      const asset = AssetFactory.create({
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
        originalPath: '/external/photos/lake.png',
      });

      await expect((sut as any).validateReadableAssetIntegrity(asset)).resolves.toBeNull();

      expect(mocks.forkSchema.recordExternalScanChecksums).toHaveBeenCalledWith({
        assetId: asset.id,
        ...digests,
        path: '/external/photos/lake.png',
      });
      expect(mocks.forkSchema.recordAssetChecksums).not.toHaveBeenCalled();
    });

    it.each([ChecksumAlgorithm.sha1File, ChecksumAlgorithm.sha256File])(
      'leaves a %s original alone, whether or not the scan verifies checksums',
      async (checksumAlgorithm) => {
        readsHealthy();
        const asset = AssetFactory.create({ checksumAlgorithm });

        await expect((sut as any).validateReadableAssetIntegrity(asset)).resolves.toBeNull();
        await expect((sut as any).validateReadableAssetIntegrity(asset, { verifyChecksum: false })).resolves.toBeNull();

        expect(mocks.forkSchema.recordExternalScanChecksums).not.toHaveBeenCalled();
      },
    );

    it('only logs a failed write, and the scan result stays healthy', async () => {
      readsHealthy();
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
      vi.mocked(mocks.forkSchema.recordExternalScanChecksums).mockRejectedValue(new Error('database busy'));
      const asset = AssetFactory.create({ checksumAlgorithm: ChecksumAlgorithm.sha1Path });

      await expect((sut as any).scanAsset(asset, 'missing-run', 'corrupt-run')).resolves.toBe('healthy');

      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('database busy'));
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
      expect(mediaHealthRepository.markResolvedForAssets).toHaveBeenCalledWith(
        [MediaHealthCategory.Missing, MediaHealthCategory.Corrupt],
        [asset],
      );
    });
  });

  describe('JPEG repair', () => {
    let root: string;
    let damaged: string;
    let nestedPath: { mockRestore: () => void };
    const operations = new SharpOperations();
    const owner = { ...authStub.user1, user: { ...authStub.user1.user, id: 'user-id' } } as never;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'library-care-repair-'));
      damaged = join(root, 'damaged.jpg');
      const good = await sharp({ create: { width: 64, height: 48, channels: 3, background: 'teal' } })
        .jpeg()
        .toBuffer();
      // a 128-byte header before the picture: "improper image header … ReadTGAImage"
      await writeFile(damaged, Buffer.concat([Buffer.alloc(128), good]));
      const crypto = new CryptoRepository();
      vi.mocked(mocks.crypto.hashFileDigests).mockImplementation((path) => crypto.hashFileDigests(path));
      vi.mocked(mocks.storage.stat).mockImplementation((path) => stat(path) as never);
      vi.mocked(mocks.storage.mkdtemp).mockImplementation((prefix) => mkdtemp(join(root, prefix)));
      vi.mocked(mocks.storage.readFile).mockImplementation((path) => readFile(path));
      vi.mocked(mocks.storage.unlinkDir).mockImplementation((folder, options) => rm(folder, options));
      // as through the image worker pool: a repair the worker refused comes back as its operation error
      vi.mocked(mocks.media.repairJpeg).mockImplementation((input, output, preview, metadataSource) =>
        operations.repairJpeg(input, output, preview, metadataSource).catch((error: Error) => {
          throw new SharpOperationError(error.message);
        }),
      );
      nestedPath = vi
        .spyOn(StorageCore, 'getNestedPath')
        .mockReturnValue(join(root, 'upload', 'user-id', 'as', 'se', 'asset-1'));
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        {
          id: 'health-1',
          assetId: 'asset-1',
          category: MediaHealthCategory.Corrupt,
          status: MediaHealthStatus.CorruptSuspect,
          originalPath: damaged,
          evidence: {},
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          ownerId: 'user-id',
          updateId: 'update-1',
          checksum: Buffer.alloc(20),
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalPath: damaged,
          originalFileName: 'IMG_0001.JPG',
          type: AssetType.Image,
          isExternal: false,
          libraryId: null,
          deletedAt: null,
        },
      ] as never);
      (mediaHealthRepository as unknown as Record<string, unknown>).replaceRepairedOriginal = vi
        .fn()
        .mockResolvedValue(true);
    });

    afterEach(async () => {
      nestedPath.mockRestore();
      await rm(root, { recursive: true, force: true });
    });

    it('previews the repaired picture and changes nothing', async () => {
      const preview = await sut.previewRepair(owner, { findingId: 'health-1' });
      expect(preview).toMatchObject({ findingId: 'health-1', method: 'lossless', width: 64, height: 48 });
      expect(preview.preview).toMatch(/^data:image\/jpeg;base64,/);
      expect(mediaHealthRepository.replaceRepairedOriginal).not.toHaveBeenCalled();
    });

    it('replaces the original with exactly the reviewed repair and keeps the damaged file', async () => {
      const { checksum } = await sut.previewRepair(owner, { findingId: 'health-1' });
      await expect(sut.repair(owner, { findingId: 'health-1', checksum })).resolves.toEqual({
        findingId: 'health-1',
        assetId: 'asset-1',
        method: 'lossless',
      });
      const input = vi.mocked(mediaHealthRepository.replaceRepairedOriginal).mock.calls[0][0];
      expect(input.originalPath).toContain('.library-care');
      expect(input.sha1.toString('hex')).toBe(checksum);
      expect(input.expectedOriginalPath).toBe(damaged);
      expect(mocks.job.queueOutsideRun).toHaveBeenCalled();
    });

    it('records the reviewed repair as the automatic one does, so it is fixed and can be undone (FL-1337)', async () => {
      const { checksum } = await sut.previewRepair(owner, { findingId: 'health-1' });
      // after the commit the finding points at the repaired file and records the damaged one as `retainedPath`
      vi.mocked(mediaHealthRepository.getByIds).mockImplementation(() => {
        const input = vi.mocked(mediaHealthRepository.replaceRepairedOriginal).mock.calls[0]?.[0];
        return Promise.resolve([
          {
            id: 'health-1',
            assetId: 'asset-1',
            category: MediaHealthCategory.Corrupt,
            status: input ? MediaHealthStatus.Resolved : MediaHealthStatus.CorruptSuspect,
            originalPath: input?.originalPath ?? damaged,
            evidence: input ? { retainedPath: damaged, autoRepairDeclined: true } : {},
          },
        ] as never);
      });

      await expect(sut.repair(owner, { findingId: 'health-1', checksum })).resolves.toEqual({
        findingId: 'health-1',
        assetId: 'asset-1',
        method: 'lossless',
      });

      const input = vi.mocked(mediaHealthRepository.replaceRepairedOriginal).mock.calls[0][0];
      // a lossless repair saves the whole picture; who reviewed it is in the history
      expect(input.evidence).toEqual({ fixState: 'repaired', partSaved: false });
      expect(input.steps).toEqual([
        {
          step: 'repaired',
          outcome: 'ok',
          facts: { method: 'lossless', percentSaved: 100, metadataLost: false, by: 'User 1' },
        },
      ]);
      expect(input.provenance).toMatchObject({ recoveredBy: 'user-id', repairMethod: 'lossless' });
      // the damaged file is kept beside it, with what Undo needs, in the write that records its place
      const [healthId, keptPath, steps] = vi.mocked(mediaHealthRepository.setRetainedPath).mock.calls[0];
      expect(healthId).toBe('health-1');
      expect(keptPath).toContain('.library-care');
      expect(steps).toEqual([
        {
          step: 'kept-damaged',
          outcome: 'info',
          undo: {
            kind: 'repair',
            previousPath: keptPath,
            originalPath: input.originalPath,
            checksum: input.sha256.toString('hex'),
          },
        },
      ]);
      await expect(stat(keptPath)).resolves.toBeDefined();
    });

    it('copies the photo’s details back when the repair lost them', async () => {
      vi.mocked(mocks.media.repairJpeg).mockImplementation(async (input, output, preview) => {
        await operations.repairJpeg(input, output, preview, join(root, 'unused.jpg'));
        return { method: 'lossless', width: 64, height: 48, metadataLost: ['EXIF', 'XMP', 'IPTC'] };
      });
      vi.mocked(mocks.media.copyTagGroup).mockResolvedValue(true);

      await expect(sut.previewRepair(owner, { findingId: 'health-1' })).resolves.toMatchObject({ metadataKept: true });
      expect(vi.mocked(mocks.media.copyTagGroup).mock.calls.map(([group, source]) => [group, source])).toEqual([
        ['EXIF', damaged],
        ['XMP', damaged],
        ['IPTC', damaged],
      ]);
    });

    it('says when the details could not be copied back', async () => {
      vi.mocked(mocks.media.repairJpeg).mockImplementation(async (input, output, preview) => {
        await operations.repairJpeg(input, output, preview, join(root, 'unused.jpg'));
        return { method: 'rebuilt', width: 64, height: 48, metadataLost: ['EXIF', 'XMP'] };
      });
      // the EXIF comes back but the XMP does not: the result still says details were lost
      vi.mocked(mocks.media.copyTagGroup).mockImplementation((group) => Promise.resolve(group === 'EXIF'));

      await expect(sut.previewRepair(owner, { findingId: 'health-1' })).resolves.toMatchObject({
        method: 'rebuilt',
        metadataKept: false,
      });
    });

    describe('from the photo viewer', () => {
      it('checks the photo now, records the damage and previews the repair', async () => {
        vi.spyOn(
          sut as unknown as { validateAssetIntegrity: () => Promise<unknown> },
          'validateAssetIntegrity',
        ).mockResolvedValue({
          status: MediaHealthStatus.CorruptSuspect,
          score: null,
          evidence: { reason: 'decode_failed' },
          resolution: {},
        });
        vi.mocked(mediaHealthRepository.upsertFinding).mockResolvedValue({ id: 'health-1' } as never);

        await expect(sut.previewRepair(owner, { assetId: 'asset-1' })).resolves.toMatchObject({
          findingId: 'health-1',
          method: 'lossless',
        });
        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
          expect.objectContaining({
            assetId: 'asset-1',
            category: MediaHealthCategory.Corrupt,
            status: MediaHealthStatus.CorruptSuspect,
            dismissedAt: null,
            resolvedAt: null,
          }),
        );
      });

      it('says there is nothing to repair when the photo is not damaged', async () => {
        vi.spyOn(
          sut as unknown as { validateAssetIntegrity: () => Promise<unknown> },
          'validateAssetIntegrity',
        ).mockResolvedValue(null);
        await expect(sut.previewRepair(owner, { assetId: 'asset-1' })).rejects.toThrow('nothing to repair');
        expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
      });

      it('never checks another account’s photo', async () => {
        const validate = vi.spyOn(
          sut as unknown as { validateAssetIntegrity: () => Promise<unknown> },
          'validateAssetIntegrity',
        );
        await expect(sut.previewRepair(authStub.admin, { assetId: 'asset-1' })).rejects.toThrow(
          'Only the photo’s owner can repair it',
        );
        expect(validate).not.toHaveBeenCalled();
      });
    });

    it('refuses to replace a photo whose file already decodes as it is', async () => {
      await writeFile(
        damaged,
        await sharp({ create: { width: 64, height: 48, channels: 3, background: 'teal' } })
          .jpeg()
          .toBuffer(),
      );
      await expect(sut.previewRepair(owner, { findingId: 'health-1' })).rejects.toThrow('nothing to repair');
    });

    it('lets only the photo’s owner repair it, administrators included', async () => {
      await expect(sut.previewRepair(authStub.admin, { findingId: 'health-1' })).rejects.toThrow(
        'Only the photo’s owner can repair it',
      );
      await expect(sut.repair(authStub.admin, { findingId: 'health-1', checksum: 'a'.repeat(40) })).rejects.toThrow(
        'Only the photo’s owner can repair it',
      );
      expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
      expect(mediaHealthRepository.replaceRepairedOriginal).not.toHaveBeenCalled();
    });

    it('refuses a repair that is not the one reviewed', async () => {
      await expect(sut.repair(owner, { findingId: 'health-1', checksum: '0'.repeat(40) })).rejects.toThrow(
        'The repair changed since it was reviewed',
      );
      expect(mediaHealthRepository.replaceRepairedOriginal).not.toHaveBeenCalled();
    });

    it('only repairs JPEG photos', async () => {
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          ownerId: 'user-id',
          originalPath: damaged,
          originalFileName: 'IMG_0001.HEIC',
          deletedAt: null,
        },
      ] as never);
      await expect(sut.previewRepair(owner, { findingId: 'health-1' })).rejects.toThrow('Only JPEG photos');
    });

    it('says when a file has no picture to recover', async () => {
      await writeFile(damaged, 'not a picture at all');
      await expect(sut.previewRepair(owner, { findingId: 'health-1' })).rejects.toThrow('could not be repaired');
    });
  });

  describe('the fix job (FL-1337)', () => {
    type Written = { step: string; outcome: string; facts?: Record<string, any>; undo?: Record<string, any> | null };
    const operations = new SharpOperations();
    const crypto = new CryptoRepository();
    const minutes = (count: number) => count * 60_000;
    const care = (libraryCare: Record<string, unknown>) => {
      clearConfigCache();
      vi.mocked(mocks.systemMetadata.get).mockResolvedValue({ libraryCare } as never);
    };
    let root: string;
    let nestedPath: { mockRestore: () => void };
    let asset: Record<string, unknown> & { id: string; originalPath: string; checksum: Buffer };

    const finding = (category: MediaHealthCategory, status: MediaHealthStatus, evidence = {}) => ({
      id: 'health-1',
      assetId: 'asset-1',
      runId: null,
      category,
      status,
      severity: MediaHealthSeverity.Critical,
      originalPath: asset.originalPath,
      originalFileName: asset.originalFileName,
      evidence,
      resolution: {},
      checkedAt: new Date(),
      resolvedAt: null,
      dismissedAt: null,
    });
    const recorded = (...findings: unknown[]) => {
      vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue(findings as never);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue(findings as never);
    };
    /** The photo's original is this file, stored with its own checksum (it arrived as it is now). */
    const original = async (file: string, bytes: Buffer, originalFileName = file.split('/').pop()!) => {
      await writeFile(file, bytes);
      asset = { ...asset, originalPath: file, originalFileName, checksum: createHash('sha1').update(bytes).digest() };
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
    };
    /** A JPEG whose end was cut off: the decoder says "premature end". Textured, so a cut keeps rows. */
    const cutShort = async () => {
      const values = Buffer.alloc(320 * 240 * 3);
      let seed = 7;
      for (let index = 0; index < values.length; index++) {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        values[index] = seed >>> 24;
      }
      const good = await sharp(values, { raw: { width: 320, height: 240, channels: 3 } })
        .jpeg()
        .toBuffer();
      await original(join(root, 'IMG_2041.jpg'), good.subarray(0, Math.floor(good.length * 0.7)));
    };
    const decoderSays = (result: Record<string, unknown>) =>
      ((sut as any).integrityService.validate as ReturnType<typeof vi.fn>).mockResolvedValue(result);

    /** Every step the job wrote, in the order it wrote them, whichever write carried it. */
    const written = (): Written[] => {
      const repository = mediaHealthRepository as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const carried: Array<{ order: number; steps: Written[] }> = [];
      const collect = (name: string, steps: (args: any[]) => Written[] | undefined) => {
        const mock = repository[name];
        for (const [index, args] of (mock?.mock.calls ?? []).entries()) {
          carried.push({ order: mock.mock.invocationCallOrder[index], steps: steps(args) ?? [] });
        }
      };
      collect('upsertFinding', ([input]) => input.steps);
      collect('replaceRepairedOriginal', ([input]) => input.steps);
      collect('relinkManagedAsset', ([input]) => input.steps);
      collect('relinkExternalAsset', ([input]) => input.steps);
      collect('setRetainedPath', (args) => args[2]);
      collect('settleFinding', ([input]) => input.steps);
      collect('appendSteps', ([steps]) => steps);
      return carried.sort((a, b) => a.order - b.order).flatMap(({ steps }) => steps);
    };
    const stepsWritten = () => written().map(({ step, outcome }) => `${step}/${outcome}`);
    const stepNamed = (name: string) => written().find(({ step }) => step === name);
    /** The finding's last recorded state, from whichever write set it. */
    const fixState = () => {
      const repository = mediaHealthRepository as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const states: Array<{ order: number; evidence: Record<string, unknown> }> = [];
      for (const name of ['replaceRepairedOriginal', 'relinkManagedAsset', 'relinkExternalAsset', 'settleFinding']) {
        const mock = repository[name];
        for (const [index, [input]] of (mock?.mock.calls ?? []).entries()) {
          if (input?.evidence?.fixState) {
            states.push({ order: mock.mock.invocationCallOrder[index], evidence: input.evidence });
          }
        }
      }
      return states.sort((a, b) => a.order - b.order).at(-1)?.evidence;
    };

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'library-care-fix-'));
      asset = {
        id: 'asset-1',
        ownerId: 'user-id',
        updateId: 'update-1',
        checksum: Buffer.alloc(20, 1),
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        originalPath: join(root, 'IMG_2041.jpg'),
        originalFileName: 'IMG_2041.jpg',
        type: AssetType.Image,
        isExternal: false,
        libraryId: null,
        deletedAt: null,
      };
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.createRun).mockResolvedValue({ id: 'run-1' } as never);
      vi.mocked(mediaHealthRepository.upsertFinding).mockImplementation((input) =>
        Promise.resolve({ ...input, id: 'health-1' } as never),
      );
      (mediaHealthRepository as unknown as Record<string, unknown>).replaceRepairedOriginal = vi
        .fn()
        .mockResolvedValue(true);
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
      vi.mocked(mocks.storage.stat).mockImplementation((file) => stat(file) as never);
      vi.mocked(mocks.storage.mkdtemp).mockImplementation((prefix) => mkdtemp(join(root, prefix)));
      vi.mocked(mocks.storage.unlinkDir).mockImplementation((folder, options) => rm(folder, options));
      vi.mocked(mocks.crypto.hashFileDigests).mockImplementation((file) => crypto.hashFileDigests(file));
      vi.mocked(mocks.crypto.hashFileMatching).mockImplementation((file, reference) =>
        crypto.hashFileMatching(file, reference),
      );
      // as through the image worker pool: a repair the worker refused comes back as its operation error
      vi.mocked(mocks.media.repairJpeg).mockImplementation((input, output, preview, metadataSource) =>
        operations.repairJpeg(input, output, preview, metadataSource).catch((error: Error) => {
          throw new SharpOperationError(error.message);
        }),
      );
      nestedPath = vi
        .spyOn(StorageCore, 'getNestedPath')
        .mockReturnValue(join(root, 'upload', 'user-id', 'as', 'se', 'asset-1'));
    });

    afterEach(async () => {
      nestedPath.mockRestore();
      await rm(root, { recursive: true, force: true });
    });

    it('repairs a cut-short JPEG and keeps the damaged file', async () => {
      await cutShort();
      // the fix looks at the file itself: it still won't open
      decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
      const damaged = asset.originalPath;
      // after the commit the finding points at the repaired file and records the damaged one as `retainedPath`
      vi.mocked(mediaHealthRepository.getByIds).mockImplementation(() => {
        const input = vi.mocked(mediaHealthRepository.replaceRepairedOriginal).mock.calls[0]?.[0];
        return Promise.resolve([
          {
            ...finding(MediaHealthCategory.Corrupt, MediaHealthStatus.Resolved, { retainedPath: damaged }),
            originalPath: input?.originalPath,
          },
        ] as never);
      });

      await expect(
        sut.handleFixAsset({ id: 'asset-1', from: 'preview', message: 'VipsJpeg: Premature end of JPEG file' }),
      ).resolves.toBe(JobStatus.Success);

      expect(stepsWritten()).toEqual(['wont-open/failed', 'repaired/ok', 'kept-damaged/info']);
      expect(stepNamed('wont-open')?.facts).toEqual({ cause: 'cut-short' });
      const repaired = stepNamed('repaired')!;
      expect(repaired.facts).toMatchObject({ method: 'rebuilt', metadataLost: false });
      expect(repaired.facts!.percentSaved).toBeGreaterThan(0);
      expect(repaired.facts!.percentSaved).toBeLessThan(100);
      // the damaged file was moved beside the repaired one, never deleted, and Undo knows where it is
      const kept = stepNamed('kept-damaged')!;
      expect(kept.undo).toMatchObject({ kind: 'repair', previousPath: expect.stringContaining('.library-care') });
      await expect(stat(kept.undo!.previousPath)).resolves.toBeDefined();
      await expect(stat(damaged)).rejects.toThrow();
      const input = vi.mocked(mediaHealthRepository.replaceRepairedOriginal).mock.calls[0][0];
      expect(kept.undo).toMatchObject({ originalPath: input.originalPath, checksum: input.sha256.toString('hex') });
      expect(input).toMatchObject({
        expectedOriginalPath: damaged,
        provenance: expect.objectContaining({ recoveredBy: 'user-id', automatic: true, repairMethod: 'rebuilt' }),
      });
      expect(fixState()).toEqual({ fixState: 'part-saved', partSaved: true });
      // previews are made again, as after an upload, so the follow-up work runs too
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith(
        expect.arrayContaining([{ name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } }]),
      );
    });

    it('repairs, but leaves the damaged file where it is while the drive for the kept copy is unplugged', async () => {
      await cutShort();
      decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
      const damaged = asset.originalPath;
      // the repaired copy lands in the Library care folder on the uploads drive, which then goes away
      const uploads = join(root, 'upload');
      const baseFolder = StorageCore.getBaseFolder.bind(StorageCore);
      const base = vi
        .spyOn(StorageCore, 'getBaseFolder')
        .mockImplementation((folder) => (folder === StorageFolder.Upload ? uploads : baseFolder(folder)));
      onTestFinished(() => base.mockRestore());
      await mkdir(uploads, { recursive: true });
      await writeFile(join(uploads, '.frameleaf'), '');
      vi.mocked(mediaHealthRepository.replaceRepairedOriginal).mockImplementation(async () => {
        await rm(join(uploads, '.frameleaf'));
        return true;
      });
      vi.mocked(mediaHealthRepository.getByIds).mockImplementation(() => {
        const input = vi.mocked(mediaHealthRepository.replaceRepairedOriginal).mock.calls[0]?.[0];
        return Promise.resolve([
          {
            ...finding(MediaHealthCategory.Corrupt, MediaHealthStatus.Resolved, { retainedPath: damaged }),
            originalPath: input?.originalPath,
          },
        ] as never);
      });

      await sut.handleFixAsset({ id: 'asset-1', from: 'preview', message: 'VipsJpeg: Premature end of JPEG file' });

      expect(stepsWritten()).toEqual(['wont-open/failed', 'repaired/ok', 'kept-damaged/info']);
      // still where it was, still recorded there: never moved into the empty mount point
      await expect(stat(damaged)).resolves.toBeDefined();
      expect(stepNamed('kept-damaged')?.undo).toMatchObject({ kind: 'repair', previousPath: damaged });
      expect(mediaHealthRepository.setRetainedPath).not.toHaveBeenCalled();
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining('until its drive is back'));
    });

    it('waits for the Upload drive before repairing into its Library care folder (F2)', async () => {
      await cutShort();
      decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
      const before = await readFile(asset.originalPath);
      // the photo is on another drive; the Upload drive, where Library care keeps repairs, is unplugged
      const uploads = join(root, 'upload');
      const baseFolder = StorageCore.getBaseFolder.bind(StorageCore);
      const base = vi
        .spyOn(StorageCore, 'getBaseFolder')
        .mockImplementation((folder) => (folder === StorageFolder.Upload ? uploads : baseFolder(folder)));
      onTestFinished(() => base.mockRestore());

      await expect(
        sut.handleFixAsset({ id: 'asset-1', from: 'preview', message: 'VipsJpeg: Premature end of JPEG file' }),
      ).resolves.toBe(JobStatus.Success);

      // nothing written into the empty mount point, nothing relinked; what was found is recorded once
      expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
      expect(mediaHealthRepository.replaceRepairedOriginal).not.toHaveBeenCalled();
      await expect(stat(join(uploads, 'user-id'))).rejects.toThrow();
      await expect(readFile(asset.originalPath)).resolves.toEqual(before);
      expect(stepsWritten()).toEqual(['wont-open/failed']);
      expect(fixState()).toBeUndefined();
      // it waits like an unplugged drive, straight back to the treatment, with the preview's words dropped
      const queued = vi.mocked(mocks.job.queue).mock.calls.at(-1)![0];
      expect(queued).toEqual({
        name: JobName.MediaHealthFixAsset,
        data: expect.objectContaining({ id: 'asset-1', waits: 1, stage: 'treat', delay: minutes(30) }),
      });
      expect((queued.data as Record<string, unknown>).message).toBeUndefined();
      expect((queued.data as Record<string, unknown>).attempt).toBeUndefined();

      // a day without the drive: the person can try again once it is back
      vi.mocked(mediaHealthRepository.appendSteps).mockClear();
      recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed));
      await sut.handleFixAsset({ ...(queued.data as Record<string, unknown>), waits: 48 } as never);
      expect(stepNamed('checked')?.facts).toEqual({ cause: 'busy' });
      expect(fixState()).toMatchObject({ fixState: 'couldnt-check' });
      expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
    });

    describe('a fix that carries on re-checks the choices made since it began (FL-1337)', () => {
      const began = '2026-11-10T10:00:00.000Z';
      const before = '2026-11-10T09:00:00.000Z';
      const after = '2026-11-10T11:00:00.000Z';
      const carryingOn = [
        { name: 'a busy retry', data: { attempt: 1 } },
        { name: 'the treatment stage', data: { stage: 'treat' } },
        { name: 'the backups stage', data: { stage: 'backups', searched: true } },
        { name: 'a fix that waited for a drive after it began', data: {} },
      ];

      it.each(carryingOn)('leaves the owner’s later Keep as it is in $name', async ({ data }) => {
        await cutShort();
        decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
        recorded(
          finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed, {
            fixState: 'left-as-is',
            keptAt: after,
          }),
        );

        await expect(
          sut.handleFixAsset({ id: 'asset-1', from: 'preview', startedAt: began, ...data } as never),
        ).resolves.toBe(JobStatus.Skipped);

        expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
        expect(stepsWritten()).toEqual([]);
        expect(fixState()).toBeUndefined();
        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('leaves a fix a later Try again superseded as it is, even one from before these times were kept', async () => {
        await cutShort();
        decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
        recorded(
          finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed, {
            fixState: 'cant-repair',
            retriedAt: after,
          }),
        );

        await expect(
          sut.handleFixAsset({ id: 'asset-1', from: 'check', stage: 'treat', startedAt: began }),
        ).resolves.toBe(JobStatus.Skipped);
        await expect(sut.handleFixAsset({ id: 'asset-1', from: 'check', attempt: 2 })).resolves.toBe(JobStatus.Skipped);
        expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
      });

      it('carries on a Try again of a photo kept as it is before it began', async () => {
        await cutShort();
        decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
        recorded(
          finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed, {
            fixState: 'left-as-is',
            keptAt: before,
            retriedAt: before,
          }),
        );

        await expect(
          sut.handleFixAsset({ id: 'asset-1', from: 'person', stage: 'treat', startedAt: began }),
        ).resolves.toBe(JobStatus.Success);
        expect(mocks.media.repairJpeg).toHaveBeenCalled();
      });

      it('records when it began, and every put-back carries that time', async () => {
        await cutShort();
        decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
        // the image worker crashes on each repair: the fix puts itself back to try again
        vi.mocked(mocks.media.repairJpeg).mockRejectedValue(new Error('Sharp child closed (SIGSEGV)'));

        await sut.handleFixAsset({ id: 'asset-1', from: 'preview', message: 'VipsJpeg: Premature end of JPEG file' });

        const queued = vi.mocked(mocks.job.queue).mock.calls.at(-1)![0].data as Record<string, unknown>;
        expect(queued).toMatchObject({ attempt: 1, stage: 'treat', startedAt: expect.any(String) });
        const startedAt = queued.startedAt as string;
        recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed));
        await sut.handleFixAsset(queued as never);
        expect(vi.mocked(mocks.job.queue).mock.calls.at(-1)![0].data).toMatchObject({ attempt: 2, startedAt });
      });

      it('waits while another fix of the photo runs, looking at nothing (one per photo)', async () => {
        await cutShort();
        vi.mocked(mocks.job.isOtherFixRunning).mockResolvedValueOnce(true);

        await expect(sut.handleFixAsset({ id: 'asset-1', from: 'person', attempt: 0 })).resolves.toBe(
          JobStatus.Success,
        );

        expect(mocks.job.isOtherFixRunning).toHaveBeenCalledWith('asset-1');
        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.MediaHealthFixAsset,
          data: { id: 'asset-1', from: 'person', attempt: 0, delay: 60_000, requeue: 1 },
        });
        expect(mediaHealthRepository.getFindingsForAsset).not.toHaveBeenCalled();
        expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
      });
    });

    it('leaves a Photoshop file as it is', async () => {
      await original(join(root, 'Album-cover.psd'), Buffer.concat([Buffer.from('8BPS'), Buffer.alloc(2048, 3)]));
      decoderSays({
        status: 'unsupported',
        reason: 'decode_unsupported',
        message: 'Input buffer contains unsupported image format',
      });

      await sut.handleFixAsset({
        id: 'asset-1',
        from: 'preview',
        message: 'Input buffer contains unsupported image format',
      });

      expect(stepsWritten()).toEqual(['unsupported/info']);
      expect(fixState()).toMatchObject({ fixState: 'left-as-is' });
      expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it.each([
      ['a RAW its decoder can’t read', 'Forest.ARW', { status: 'unsupported', reason: 'raw_decode_unsupported' }],
      ['a file of no kind it decodes', 'Voice memo.m4a', { status: 'unsupported', reason: 'media_type_unsupported' }],
    ])('leaves %s as it is when the file check hands it over (F5)', async (_, name, verdict) => {
      await original(join(root, name), Buffer.concat([Buffer.from('not a picture'), Buffer.alloc(2048, 3)]));
      recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.UnsupportedRaw));
      decoderSays(verdict);

      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'check' })).resolves.toBe(JobStatus.Success);

      // not an error: "Left as it is", out of Needs you, and nothing repaired or looked for
      expect(stepsWritten()).toEqual(['unsupported/info']);
      expect(fixState()).toMatchObject({ fixState: 'left-as-is' });
      expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
      expect(mocks.job.queueOutsideRun).not.toHaveBeenCalled();
    });

    it('does not repair when automatic repair is off', async () => {
      care({ autoRepair: false });
      await cutShort();
      decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });

      await sut.handleFixAsset({ id: 'asset-1', from: 'preview', message: 'VipsJpeg: Premature end of JPEG file' });

      expect(stepsWritten()).toEqual(['wont-open/failed', 'checked/failed']);
      expect(stepNamed('checked')?.facts).toEqual({ cause: 'cut-short' });
      expect(fixState()).toMatchObject({ fixState: 'cant-repair' });
      expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
      expect(mediaHealthRepository.replaceRepairedOriginal).not.toHaveBeenCalled();
    });

    it('does not repair again after Undo', async () => {
      await cutShort();
      recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed, { autoRepairDeclined: true }));
      decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });

      await sut.handleFixAsset({ id: 'asset-1', from: 'check' });

      // the file check already said it won't open: nothing says it twice
      expect(stepsWritten()).toEqual(['checked/failed']);
      expect(fixState()).toMatchObject({ fixState: 'cant-repair' });
      expect(fixState()).not.toHaveProperty('autoRepairDeclined', false);
      expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
    });

    it('restores a changed file from Cloud Backup', async () => {
      await cutShort();
      // the file is no longer the one Frameleaf stored
      asset = { ...asset, checksum: Buffer.alloc(20, 9) };
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
      recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed, { searchPending: true }));
      decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
      // Cloud Backup put the photo back, moving the changed file aside
      const retainedPath = join(root, 'upload', 'user-id', 'as', 'se', '.library-care', 'asset-1-0badc0de.damaged.jpg');
      cloudBackupService.restoreLostOriginal.mockResolvedValue({
        outcome: 'restored',
        since: '2026-10-01T03:00:00.000Z',
        retainedPath,
      });

      // the owner's shared search is complete and found no copy
      await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

      expect(cloudBackupService.restoreLostOriginal).toHaveBeenCalledWith('asset-1');
      expect(stepsWritten()).toEqual(['searched-copy/not-found', 'checked-backups/ok', 'restored/ok']);
      expect(stepNamed('checked-backups')?.facts).toEqual({ backup: 'cloud', since: '2026-10-01T03:00:00.000Z' });
      expect(stepNamed('restored')?.facts).toEqual({ backup: 'cloud' });
      // Undo knows where the changed file went, to put it back
      expect(stepNamed('restored')?.undo).toEqual({
        kind: 'restore',
        previousPath: asset.originalPath,
        originalPath: asset.originalPath,
        checksum: asset.checksum.toString('hex'),
        retainedPath,
      });
      expect(fixState()).toMatchObject({ fixState: 'restored' });
      expect(mediaHealthRepository.settleFinding).toHaveBeenLastCalledWith(
        expect.objectContaining({ healthId: 'health-1', status: MediaHealthStatus.Resolved }),
      );
      // a real original always beats a repair
      expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
    });

    it('puts back the one exact copy of a missing file', async () => {
      const copy = join(root, 'IMG_3310+1.jpg');
      await original(copy, Buffer.from('the photo, exactly'));
      asset = { ...asset, originalPath: join(root, 'IMG_3310.jpg'), originalFileName: 'IMG_3310.jpg' };
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Found, { searchPending: true }));
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: copy,
          status: MediaHealthStatus.Found,
          evidence: { rootId: MANAGED_ROOT_ID, decodeValid: true },
          resolution: { autoRelinkable: true },
        },
      ] as never);
      vi.mocked(mediaHealthRepository.relinkManagedAsset).mockResolvedValue(true);

      await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

      expect(stepsWritten()).toEqual(['searched-copy/ok', 'put-back/ok']);
      expect(stepNamed('put-back')?.undo).toMatchObject({ kind: 'relink', previousPath: join(root, 'IMG_3310.jpg') });
      expect(vi.mocked(mediaHealthRepository.relinkManagedAsset).mock.calls[0][0]).toMatchObject({
        originalPath: copy,
        provenance: expect.objectContaining({ relinkedBy: 'user-id', automatic: true }),
      });
      expect(fixState()).toMatchObject({ fixState: 'found-again' });
    });

    it('copies a missing file found in an old Immich folder into its own place, never linking to it (F3)', async () => {
      const uploads = join(root, 'upload');
      const baseFolder = StorageCore.getBaseFolder.bind(StorageCore);
      const base = vi
        .spyOn(StorageCore, 'getBaseFolder')
        .mockImplementation((folder) => (folder === StorageFolder.Upload ? uploads : baseFolder(folder)));
      onTestFinished(() => base.mockRestore());
      await mkdir(join(uploads, 'user-id'), { recursive: true });
      await writeFile(join(uploads, '.frameleaf'), '');
      // the folder the Immich import read from, still mounted, holds the lost photo
      const immich = join(root, 'immich', 'library');
      const copy = join(immich, 'IMG_3310.jpg');
      await mkdir(immich, { recursive: true });
      await original(copy, Buffer.from('the photo, exactly'));
      const own = join(uploads, 'user-id', 'IMG_3310.jpg');
      asset = { ...asset, originalPath: own, originalFileName: 'IMG_3310.jpg' };
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
      vi.mocked(mocks.systemMetadata.get).mockImplementation(((key: SystemMetadataKey) =>
        Promise.resolve(key === SystemMetadataKey.FileFixSourceRoots ? [join(root, 'immich')] : undefined)) as never);
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Found, { searchPending: true }));
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: copy,
          status: MediaHealthStatus.Found,
          // in no search location: the walk reached it through the import's folders
          evidence: { decodeValid: true },
          resolution: { autoRelinkable: true },
        },
      ] as never);

      await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

      // never relinked to the old app's folder: the library keeps a verified copy of its own
      expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
      await expect(readFile(own, 'utf8')).resolves.toBe('the photo, exactly');
      // the old file is left exactly as it is: deleting the old app's data later loses nothing
      await expect(readFile(copy, 'utf8')).resolves.toBe('the photo, exactly');
      expect((await stat(own)).ino).not.toBe((await stat(copy)).ino);
      expect(stepsWritten()).toEqual(['searched-copy/ok', 'put-back/ok']);
      expect(stepNamed('put-back')).toMatchObject({
        facts: { copied: true },
        // Undo moves the copy aside into Library care, as a restore's does
        undo: { kind: 'restore', previousPath: own, originalPath: own, checksum: asset.checksum.toString('hex') },
      });
      expect(mediaHealthRepository.settleFinding).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: MediaHealthStatus.Relinked }),
      );
      expect(fixState()).toMatchObject({ fixState: 'found-again', searchPending: false });
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith(
        expect.arrayContaining([{ name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } }]),
      );
    });

    it('waits for the Upload drive before putting back a copy of a changed file (F2)', async () => {
      await cutShort();
      // the file is no longer the one Frameleaf stored, and the search found its one exact copy
      asset = { ...asset, checksum: Buffer.alloc(20, 9) };
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
      recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed, { searchPending: true }));
      decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: join(root, 'IMG_2041+1.jpg'),
          status: MediaHealthStatus.Found,
          evidence: { rootId: MANAGED_ROOT_ID, decodeValid: true },
          resolution: { autoRelinkable: true },
        },
      ] as never);
      // the Upload drive, where the copy and the changed file would go, is unplugged
      const uploads = join(root, 'upload');
      const baseFolder = StorageCore.getBaseFolder.bind(StorageCore);
      const base = vi
        .spyOn(StorageCore, 'getBaseFolder')
        .mockImplementation((folder) => (folder === StorageFolder.Upload ? uploads : baseFolder(folder)));
      onTestFinished(() => base.mockRestore());

      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
      expect(written()).toEqual([]);
      expect(fixState()).toBeUndefined();
      // it waits like an unplugged drive; the search is done, so the next try only puts it back
      expect(mocks.job.queue).toHaveBeenLastCalledWith({
        name: JobName.MediaHealthFixAsset,
        data: expect.objectContaining({ id: 'asset-1', searched: true, waits: 1, delay: minutes(30) }),
      });
    });

    it('puts back a missing file from Cloud Backup, with nothing moved aside', async () => {
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { searchPending: true }));
      cloudBackupService.restoreLostOriginal.mockResolvedValue({
        outcome: 'restored',
        since: '2026-10-01T03:00:00.000Z',
      });

      await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

      expect(stepsWritten()).toEqual(['searched-copy/not-found', 'checked-backups/ok', 'restored/ok']);
      expect(stepNamed('restored')?.undo).not.toHaveProperty('retainedPath');
      expect(mediaHealthRepository.settleFinding).toHaveBeenLastCalledWith(
        expect.objectContaining({ healthId: 'health-1', status: MediaHealthStatus.Relinked }),
      );
      // the asset is unchanged: its previews are made again from the file that is back
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith(
        expect.arrayContaining([{ name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } }]),
      );
    });

    it('asks Cloud Backup again later while a backup runs, without searching again', async () => {
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { searchPending: true }));
      cloudBackupService.restoreLostOriginal.mockResolvedValue({ outcome: 'busy' });

      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true })).resolves.toBe(
        JobStatus.Success,
      );

      expect(stepsWritten()).toEqual(['searched-copy/not-found']);
      expect(mocks.job.queue).toHaveBeenLastCalledWith({
        name: JobName.MediaHealthFixAsset,
        data: expect.objectContaining({ id: 'asset-1', stage: 'backups', backupWaits: 1, delay: minutes(30) }),
      });

      // half an hour later it asks Cloud Backup only
      cloudBackupService.restoreLostOriginal.mockResolvedValue({ outcome: 'not-in-backup' });
      await sut.handleFixAsset(vi.mocked(mocks.job.queue).mock.calls.at(-1)![0].data as never);
      expect(stepsWritten()).toEqual([
        'searched-copy/not-found',
        'checked-backups/not-found',
        'asked-phones/not-found',
      ]);
    });

    it('stops waiting for Cloud Backup after a day, and carries on without it', async () => {
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { searchPending: true }));
      cloudBackupService.restoreLostOriginal.mockResolvedValue({ outcome: 'busy' });

      await expect(
        sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true, stage: 'backups', backupWaits: 48 }),
      ).resolves.toBe(JobStatus.Success);

      // not put back again: no backup is named, and the phones are asked
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.MediaHealthFixAsset }));
      expect(stepsWritten()).toEqual(['asked-phones/not-found']);
      expect(fixState()).toMatchObject({ fixState: 'missing' });
    });

    it.each(['not-set-up', 'skipped'])('names no backup when Cloud Backup answers %s', async (outcome) => {
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { searchPending: true }));
      cloudBackupService.restoreLostOriginal.mockResolvedValue({ outcome });

      await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

      expect(stepsWritten()).toEqual(['searched-copy/not-found', 'asked-phones/not-found']);
      expect(fixState()).toMatchObject({ fixState: 'missing' });
    });

    it('waits for a phone when a missing file is nowhere else', async () => {
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { searchPending: true }));
      vi.spyOn(sut as any, 'phonesToAsk').mockResolvedValue([{ deviceId: 'session-1', name: 'iPhone' }]);
      cloudBackupService.restoreLostOriginal.mockResolvedValue({
        outcome: 'not-in-backup',
        since: '2026-10-01T03:00:00.000Z',
      });

      await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

      expect(stepsWritten()).toEqual(['searched-copy/not-found', 'checked-backups/not-found', 'asked-phones/waiting']);
      // "Cloud Backup began on {date}, after this file was already lost"
      expect(stepNamed('checked-backups')?.facts).toEqual({ backup: 'cloud', since: '2026-10-01T03:00:00.000Z' });
      // it no longer waits for the search
      expect(fixState()).toEqual({ fixState: 'waiting-phone', searchPending: false });
      expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
    });

    describe('iCloud Photos (FL-1472)', () => {
      beforeEach(() => {
        vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
        recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { searchPending: true }));
        vi.spyOn(sut as any, 'phonesToAsk').mockResolvedValue([{ deviceId: 'session-1', name: 'iPhone' }]);
      });

      it('asks iCloud Photos for a missing file that came from it, and syncs now', async () => {
        iCloudSyncRepository.requestRepair.mockResolvedValue([
          { connectionId: 'icloud-1', automatic: true, due: true },
        ]);

        await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

        expect(iCloudSyncRepository.requestRepair).toHaveBeenCalledWith('user-id', 'asset-1');
        expect(stepsWritten()).toEqual([
          'searched-copy/not-found',
          'checked-backups/not-found',
          'asked-icloud/waiting',
          'asked-phones/waiting',
        ]);
        expect(stepNamed('asked-icloud')?.facts).toEqual({ later: false });
        expect(iCloudSyncRepository.queueOperation).toHaveBeenCalledWith('icloud-1', 'user-id', { trigger: 'manual' });
        expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.ICloudSync, data: { id: 'icloud-1' } });
      });

      it('waits for the next sync of a connection that only checks when asked, or must back off', async () => {
        iCloudSyncRepository.requestRepair.mockResolvedValue([
          { connectionId: 'icloud-1', automatic: false, due: true },
          { connectionId: 'icloud-2', automatic: true, due: false },
        ]);

        await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

        expect(stepNamed('asked-icloud')?.facts).toEqual({ later: true });
        expect(iCloudSyncRepository.queueOperation).not.toHaveBeenCalled();
      });

      it('says nothing about iCloud for a photo that did not come from it', async () => {
        await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

        expect(stepsWritten()).not.toContain('asked-icloud/waiting');
      });
    });

    describe('an upload of a damaged photo (FL-1472)', () => {
      const good = Buffer.from('the photo as it was stored');
      const sha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest();
      let upload: string;

      const damagedOnDisk = async (bytes: Buffer) => {
        await original(join(root, 'IMG_2041.jpg'), bytes);
        asset = { ...asset, checksum: sha1(good) };
        vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
        recorded({
          ...finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed),
          resolution: { reuploadRecommended: true },
        });
      };

      beforeEach(async () => {
        upload = join(root, 'uploaded.jpg');
        await writeFile(upload, good);
        vi.mocked(mocks.physicalFile.deleteUnreferencedPath).mockImplementation(async (_path, unlink) => {
          await unlink();
          return {} as never;
        });
      });

      it('puts the upload in the damaged file’s place and keeps the damaged file', async () => {
        await damagedOnDisk(Buffer.from('changed on the drive'));
        const damaged = asset.originalPath;
        vi.mocked(mediaHealthRepository.getByIds).mockImplementation(() => {
          const input = vi.mocked(mediaHealthRepository.replaceRepairedOriginal).mock.calls[0]?.[0];
          return Promise.resolve([
            {
              ...finding(MediaHealthCategory.Corrupt, MediaHealthStatus.Resolved, { retainedPath: damaged }),
              originalPath: input?.originalPath,
            },
          ] as never);
        });

        await expect(sut.handlePutBackUpload({ id: 'asset-1', path: upload, device: 'iPhone' })).resolves.toBe(
          JobStatus.Success,
        );

        const input = vi.mocked(mediaHealthRepository.replaceRepairedOriginal).mock.calls[0][0];
        expect(input).toMatchObject({
          expectedOriginalPath: damaged,
          evidence: { fixState: 'found-again' },
          steps: [{ step: 'asked-phones', outcome: 'ok', facts: { device: 'iPhone' } }],
        });
        expect(input.originalPath).toContain('.library-care');
        await expect(readFile(input.originalPath)).resolves.toEqual(good);
        expect(stepNamed('put-back')).toMatchObject({ facts: { uploaded: true }, undo: { kind: 'relink' } });
        expect(mocks.storage.unlink).toHaveBeenCalledWith(upload);
      });

      it('changes nothing for the damaged file’s own bytes, and stops asking for them', async () => {
        await damagedOnDisk(good);

        await expect(sut.handlePutBackUpload({ id: 'asset-1', path: upload })).resolves.toBe(JobStatus.Success);

        expect(mediaHealthRepository.replaceRepairedOriginal).not.toHaveBeenCalled();
        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
          expect.objectContaining({ resolution: { reuploadRecommended: false }, expectedUpdateId: 'update-1' }),
        );
        expect(mocks.storage.unlink).toHaveBeenCalledWith(upload);
      });

      it('leaves a photo alone when its finding no longer asks for an upload', async () => {
        await damagedOnDisk(Buffer.from('changed on the drive'));
        recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed));

        await expect(sut.handlePutBackUpload({ id: 'asset-1', path: upload })).resolves.toBe(JobStatus.Skipped);

        expect(mediaHealthRepository.replaceRepairedOriginal).not.toHaveBeenCalled();
        expect(mocks.storage.unlink).toHaveBeenCalledWith(upload);
      });

      it('puts the true original in a repair’s place (FL-1472)', async () => {
        await original(join(root, 'IMG_2041.jpg'), Buffer.from('the repaired picture'));
        recorded({
          ...finding(MediaHealthCategory.Corrupt, MediaHealthStatus.Resolved, {
            fixState: 'part-saved',
            originalChecksum: sha1(good).toString('hex'),
            repairedChecksum: asset.checksum.toString('hex'),
          }),
          resolvedAt: new Date(),
        });
        (mediaHealthRepository as unknown as Record<string, unknown>).restoreOriginalOverRepair = vi
          .fn()
          .mockResolvedValue(true);

        await expect(sut.handlePutBackUpload({ id: 'asset-1', path: upload })).resolves.toBe(JobStatus.Success);

        const input = vi.mocked(mediaHealthRepository.restoreOriginalOverRepair).mock.calls[0][0];
        expect(input).toMatchObject({
          expectedOriginalPath: asset.originalPath,
          evidence: { fixState: 'found-again' },
          steps: [
            {
              step: 'put-back',
              outcome: 'ok',
              facts: { uploaded: true, overRepair: true },
              undo: { kind: 'relink', previousPath: asset.originalPath },
            },
          ],
        });
        await expect(readFile(input.originalPath)).resolves.toEqual(good);
        expect(mediaHealthRepository.replaceRepairedOriginal).not.toHaveBeenCalled();
      });

      it('never puts other bytes in a repair’s place', async () => {
        await original(join(root, 'IMG_2041.jpg'), Buffer.from('the repaired picture'));
        recorded({
          ...finding(MediaHealthCategory.Corrupt, MediaHealthStatus.Resolved, {
            fixState: 'repaired',
            originalChecksum: 'ab'.repeat(20),
            repairedChecksum: asset.checksum.toString('hex'),
          }),
          resolvedAt: new Date(),
        });
        (mediaHealthRepository as unknown as Record<string, unknown>).restoreOriginalOverRepair = vi.fn();

        await expect(sut.handlePutBackUpload({ id: 'asset-1', path: upload })).resolves.toBe(JobStatus.Skipped);

        expect(mediaHealthRepository.restoreOriginalOverRepair).not.toHaveBeenCalled();
      });

      it('removes the upload only under its path’s lock, when nothing uses it', async () => {
        await damagedOnDisk(Buffer.from('changed on the drive'));
        // a relink meanwhile made it a photo's original: the lock's own check keeps it
        vi.mocked(mocks.physicalFile.deleteUnreferencedPath).mockResolvedValue(false as never);

        await sut.handlePutBackUpload({ id: 'asset-1', path: upload });

        expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledWith(upload, expect.any(Function));
        expect(mocks.storage.unlink).not.toHaveBeenCalledWith(upload);
      });

      it.each(['timeout', 'transient'] as const)(
        'keeps the upload for the retry when its check does not finish (%s, FL-1506)',
        async (status) => {
          await damagedOnDisk(Buffer.from('changed on the drive'));
          ((sut as any).integrityService.validate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            status,
            reason: 'validation_busy',
          });

          await expect(sut.handlePutBackUpload({ id: 'asset-1', path: upload })).rejects.toThrow('could not check');

          expect(mocks.physicalFile.deleteUnreferencedPath).not.toHaveBeenCalled();
          expect(mediaHealthRepository.replaceRepairedOriginal).not.toHaveBeenCalled();
        },
      );

      it('uses checksum-exact bytes in a format the server cannot decode (FL-1506)', async () => {
        await damagedOnDisk(Buffer.from('changed on the drive'));
        ((sut as any).integrityService.validate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          status: 'unsupported',
          reason: 'unsupported_format',
        });

        await expect(sut.handlePutBackUpload({ id: 'asset-1', path: upload })).resolves.toBe(JobStatus.Success);

        expect(mediaHealthRepository.replaceRepairedOriginal).toHaveBeenCalled();
      });

      it('keeps the upload for the retry when an attempt fails', async () => {
        await damagedOnDisk(Buffer.from('changed on the drive'));
        vi.mocked(mocks.storage.stat).mockRejectedValueOnce(new Error('drive went away'));

        await expect(sut.handlePutBackUpload({ id: 'asset-1', path: upload })).rejects.toThrow('drive went away');

        expect(mocks.physicalFile.deleteUnreferencedPath).not.toHaveBeenCalled();
      });
    });

    it('does not wait for phones that are never shown the photo (F4)', async () => {
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { searchPending: true }));
      vi.spyOn(sut as any, 'phonesToAsk').mockResolvedValue([{ deviceId: 'session-1', name: 'iPhone' }]);
      // an upload's SHA-256, an external library's or a Locked photo: the lost-originals list leaves it out
      vi.mocked(mediaHealthRepository.isShownToPhones).mockResolvedValue(false);

      await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

      expect(mediaHealthRepository.isShownToPhones).toHaveBeenCalledWith('user-id', 'asset-1');
      expect(stepsWritten()).toEqual(['searched-copy/not-found', 'checked-backups/not-found']);
      expect(fixState()).toEqual({ fixState: 'missing', searchPending: false });
    });

    it('tries a busy file three times, then stops', async () => {
      await cutShort();
      recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed));
      decoderSays({ status: 'timeout', reason: 'decode_timeout' });

      let data: Record<string, unknown> = { id: 'asset-1', from: 'check' };
      for (const delay of [5, 30, 120]) {
        await expect(sut.handleFixAsset(data as never)).resolves.toBe(JobStatus.Success);
        const queued = vi.mocked(mocks.job.queue).mock.calls.at(-1)![0] as { name: JobName; data: typeof data };
        expect(queued.name).toBe(JobName.MediaHealthFixAsset);
        expect(queued.data).toMatchObject({ id: 'asset-1', from: 'check', delay: minutes(delay) });
        expect(written()).toEqual([]);
        data = queued.data;
      }
      expect(data).toMatchObject({ attempt: 3, requeue: 3 });

      await sut.handleFixAsset(data as never);

      expect(mocks.job.queue).toHaveBeenCalledTimes(3);
      expect(stepsWritten()).toEqual(['checked/failed']);
      expect(stepNamed('checked')?.facts).toEqual({ cause: 'busy' });
      expect(fixState()).toMatchObject({ fixState: 'couldnt-check' });
      expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
    });

    it('tries again when the image worker crashes partway through a repair, leaving the original untouched', async () => {
      await cutShort();
      decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
      const before = await readFile(asset.originalPath);
      vi.mocked(mocks.media.repairJpeg).mockRejectedValue(new Error('Sharp child closed (SIGSEGV)'));

      await expect(
        sut.handleFixAsset({ id: 'asset-1', from: 'preview', message: 'VipsJpeg: Premature end of JPEG file' }),
      ).resolves.toBe(JobStatus.Success);

      expect(vi.mocked(mocks.job.queue).mock.calls[0][0]).toEqual({
        name: JobName.MediaHealthFixAsset,
        data: expect.objectContaining({ attempt: 1, requeue: 1, delay: minutes(5) }),
      });
      expect(mediaHealthRepository.replaceRepairedOriginal).not.toHaveBeenCalled();
      expect(fixState()).toBeUndefined();
      await expect(readFile(asset.originalPath)).resolves.toEqual(before);
    });

    it('settles as "couldn’t check" when the image worker crashes on the fourth repair too (Review Focus 2)', async () => {
      await cutShort();
      const before = await readFile(asset.originalPath);
      decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
      vi.mocked(mocks.media.repairJpeg).mockRejectedValue(new Error('Sharp child closed (SIGSEGV)'));

      let data: Record<string, unknown> = {
        id: 'asset-1',
        from: 'preview',
        message: 'VipsJpeg: Premature end of JPEG file',
      };
      for (const delay of [5, 30, 120]) {
        await expect(sut.handleFixAsset(data as never)).resolves.toBe(JobStatus.Success);
        data = vi.mocked(mocks.job.queue).mock.calls.at(-1)![0].data as typeof data;
        expect(data).toMatchObject({ stage: 'treat', delay: minutes(delay) });
        // the finding the first try recorded is the one the next tries carry on with
        recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed));
      }
      expect(data).toMatchObject({ attempt: 3, requeue: 3 });

      await expect(sut.handleFixAsset(data as never)).resolves.toBe(JobStatus.Success);

      // four repairs, three tries again, then it stops: never an endless retry
      expect(mocks.media.repairJpeg).toHaveBeenCalledTimes(4);
      expect(mocks.job.queue).toHaveBeenCalledTimes(3);
      expect(stepsWritten()).toEqual(['wont-open/failed', 'checked/failed']);
      expect(stepNamed('checked')?.facts).toEqual({ cause: 'busy' });
      expect(fixState()).toMatchObject({ fixState: 'couldnt-check' });
      expect(mediaHealthRepository.replaceRepairedOriginal).not.toHaveBeenCalled();
      await expect(readFile(asset.originalPath)).resolves.toEqual(before);
    });

    it('waits while the drive is unplugged', async () => {
      const upload = StorageCore.getBaseFolder(StorageFolder.Upload);
      asset = { ...asset, originalPath: join(upload, 'user-id', 'as', 'se', 'asset-1.jpg') };
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
      // the drive's mount file is gone, so every file on it looks lost
      vi.mocked(mocks.storage.stat).mockImplementation((file) =>
        file === join(upload, '.frameleaf')
          ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
          : Promise.resolve(settledStat({ size: 10 }) as never),
      );
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);

      // a preview failed with "Input file is missing": the drive was away, not the photo damaged
      await expect(
        sut.handleFixAsset({ id: 'asset-1', from: 'preview', message: 'Input file is missing' }),
      ).resolves.toBe(JobStatus.Success);

      // F1: the preview's words are dropped, so the fix looks at the file itself once the drive is back
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.MediaHealthFixAsset,
        data: { id: 'asset-1', from: 'preview', waits: 1, requeue: 1, delay: minutes(30) },
      });
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
      expect(written()).toEqual([]);

      // after a day of waiting it stops; the next file check or Try again starts it again
      vi.mocked(mocks.job.queue).mockClear();
      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'check', waits: 48 })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(written()).toEqual([]);
    });

    it('records no damage for a preview that failed while the drive was away, once the drive is back (F1)', async () => {
      await cutShort();
      // back: the file opens and is the one Frameleaf stored (the validator says healthy)
      const queued = { id: 'asset-1', from: 'preview' as const, waits: 3, requeue: 3 };

      await expect(sut.handleFixAsset(queued)).resolves.toBe(JobStatus.Skipped);

      expect((sut as any).integrityService.validate).toHaveBeenCalledOnce();
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
      expect(written()).toEqual([]);
      // its thumbnail job ended when it was handed over: its previews are made again, failing as a job if they can't
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledExactlyOnceWith([
        { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload', afterCare: true } },
      ]);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('never trusts a preview’s words: a photo that opens is not damaged, whatever the preview said (F1)', async () => {
      await cutShort();
      // the preview said "premature end", but the image worker could not write it; the file itself opens

      await expect(
        sut.handleFixAsset({ id: 'asset-1', from: 'preview', message: 'VipsJpeg: Premature end of JPEG file' }),
      ).resolves.toBe(JobStatus.Skipped);

      expect((sut as any).integrityService.validate).toHaveBeenCalledOnce();
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
      expect(written()).toEqual([]);
      expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledExactlyOnceWith([
        { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload', afterCare: true } },
      ]);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('settles a problem whose file is fine now with no fix state left on it', async () => {
      await cutShort();
      // a person tries again on a problem kept as it is; the file opens and is the one Frameleaf stored
      recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed, { fixState: 'left-as-is' }));

      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'person' })).resolves.toBe(JobStatus.Success);

      // a stale "left as it is" would keep a resolved problem in Left as they are for ever
      expect(mediaHealthRepository.settleFinding).toHaveBeenCalledExactlyOnceWith({
        healthId: 'health-1',
        evidence: { fixState: null },
        status: MediaHealthStatus.Resolved,
        steps: [{ step: 'checked', outcome: 'ok' }],
      });
    });

    it('leaves a problem settled meanwhile as it is when a fix that waited for a drive runs (F1)', async () => {
      await cutShort();
      recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed, { fixState: 'left-as-is' }));
      decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });

      // the preview's fix waited for the drive; meanwhile the person kept the photo as it is
      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'preview', waits: 2, requeue: 2 })).resolves.toBe(
        JobStatus.Skipped,
      );

      expect(written()).toEqual([]);
      expect(mediaHealthRepository.settleFinding).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('looks at a busy preview again on each try, and records nothing when it stays busy', async () => {
      await cutShort();
      decoderSays({ status: 'timeout', reason: 'decode_timeout' });
      const validate = (sut as any).integrityService.validate as ReturnType<typeof vi.fn>;

      let data: Record<string, unknown> = { id: 'asset-1', from: 'preview', message: 'Timeout' };
      for (const delay of [5, 30, 120]) {
        await expect(sut.handleFixAsset(data as never)).resolves.toBe(JobStatus.Success);
        data = vi.mocked(mocks.job.queue).mock.calls.at(-1)![0].data as typeof data;
        // the preview's words are not carried into the next try, so it checks the file itself
        expect(data.message).toBeUndefined();
        expect(data).toMatchObject({ from: 'preview', delay: minutes(delay) });
      }
      // every try looks at the file itself, the first one too (F1)
      expect(validate).toHaveBeenCalledTimes(3);

      // busy never becomes damage: with nothing recorded before, nothing is recorded now
      await expect(sut.handleFixAsset(data as never)).resolves.toBe(JobStatus.Skipped);
      expect(validate).toHaveBeenCalledTimes(4);
      expect(mocks.job.queue).toHaveBeenCalledTimes(3);
      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
      expect(written()).toEqual([]);
    });

    it('records nothing for a busy preview that opens on the next try', async () => {
      await cutShort();
      // the image worker is busy when the fix looks at the file itself
      decoderSays({ status: 'transient', reason: 'validation_busy' });

      await sut.handleFixAsset({ id: 'asset-1', from: 'preview', message: 'Sharp child closed (SIGSEGV)' });
      const [retry] = vi.mocked(mocks.job.queue).mock.calls.map(([item]) => item);
      expect(retry).toMatchObject({ name: JobName.MediaHealthFixAsset, data: { attempt: 1, message: undefined } });
      // the file opens and is the one Frameleaf stored
      decoderSays({ status: 'healthy' });
      await expect(sut.handleFixAsset(retry.data as never)).resolves.toBe(JobStatus.Skipped);

      expect(mediaHealthRepository.upsertFinding).not.toHaveBeenCalled();
      expect(written()).toEqual([]);
    });

    it('records a changed file that still opens as changed, never as one that will not open', async () => {
      await cutShort();
      // the file opens, but it is no longer the one Frameleaf stored
      asset = { ...asset, checksum: Buffer.alloc(20, 9) };
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);

      await sut.handleFixAsset({ id: 'asset-1', from: 'check' });

      expect(vi.mocked(mediaHealthRepository.upsertFinding).mock.calls[0][0]).toMatchObject({
        status: MediaHealthStatus.CorruptConfirmed,
        evidence: { reason: 'expected_mismatch', cause: 'changed' },
        steps: [],
      });
      expect(written()).toEqual([]);

      // it opens, so a photo without previews gets them made again while the search runs (F1)
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith([
        { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload', afterCare: true } },
      ]);

      // the shared search found no copy, and Cloud Backup has none: the person decides
      recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed, { searchPending: true }));
      await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

      expect(stepsWritten()).toEqual(['searched-copy/not-found', 'checked-backups/not-found', 'checked/failed']);
      expect(stepNamed('checked')?.facts).toEqual({ cause: 'changed' });
      expect(fixState()).toMatchObject({ fixState: 'cant-repair' });
      expect(mocks.media.repairJpeg).not.toHaveBeenCalled();
    });

    it('leaves the one copy of a missing Locked photo for its owner to choose', async () => {
      const copy = join(root, 'IMG_3310+1.jpg');
      await original(copy, Buffer.from('the photo, exactly'));
      asset = { ...asset, originalPath: join(root, 'IMG_3310.jpg'), originalFileName: 'IMG_3310.jpg', isLocked: true };
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([asset] as never);
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Found, { searchPending: true }));
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: copy,
          status: MediaHealthStatus.Found,
          evidence: { rootId: MANAGED_ROOT_ID, decodeValid: true },
          resolution: { autoRelinkable: true },
        },
      ] as never);

      await sut.handleFixAsset({ id: 'asset-1', from: 'check', searched: true });

      expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
      expect(stepsWritten()).toEqual(['searched-copy/ok']);
      expect(stepNamed('searched-copy')?.facts).toMatchObject({ copies: 1 });
      expect(fixState()).toMatchObject({ fixState: 'missing' });
    });

    it('leaves a problem a fix already settled as it is, unless a person asks', async () => {
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { fixState: 'waiting-phone' }));

      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'check' })).resolves.toBe(JobStatus.Skipped);
      expect(written()).toEqual([]);
      expect(mediaHealthRepository.settleFinding).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();

      // Try again: the person asks, so it runs
      await cutShort();
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(true);
      care({ autoRepair: false });
      recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptConfirmed, { fixState: 'cant-repair' }));
      decoderSays({ status: 'corrupt', reason: 'decode_failed', message: 'VipsJpeg: Premature end of JPEG file' });
      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'person' })).resolves.toBe(JobStatus.Success);
      expect(stepsWritten()).toEqual(['checked/failed']);

      // "couldn't check" may be tried again by a check
      vi.mocked(mediaHealthRepository.settleFinding).mockClear();
      recorded(finding(MediaHealthCategory.Corrupt, MediaHealthStatus.CorruptSuspect, { fixState: 'couldnt-check' }));
      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'check' })).resolves.toBe(JobStatus.Success);
      expect(fixState()).toMatchObject({ fixState: 'cant-repair' });
    });

    it('asks its owner’s shared search by contents, writing nothing yet', async () => {
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing));

      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'check' })).resolves.toBe(JobStatus.Success);

      expect(mediaHealthRepository.settleFinding).toHaveBeenCalledWith({
        healthId: 'health-1',
        evidence: { searchPending: true },
        steps: [],
      });
      // F8: outside the run this fix may be in, so the run never drops it as done
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith([
        { name: JobName.MediaHealthLocateMissing, data: { userId: 'user-id', pending: true } },
      ]);
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(written()).toEqual([]);
      // no walk and no run of its own
      expect(mocks.storage.walkWithCursor).not.toHaveBeenCalled();
      expect(mediaHealthRepository.createRun).not.toHaveBeenCalled();
      expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
    });

    it('asks for one shared search for two photos of one owner', async () => {
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      for (const id of ['asset-1', 'asset-2']) {
        vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([{ ...asset, id }] as never);
        recorded({
          ...finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing),
          id: `health-${id}`,
          assetId: id,
        });
        await sut.handleFixAsset({ id, from: 'check' });
      }
      // the same request twice: one owner key, so the store keeps one waiting search (job.repository.spec)
      expect(vi.mocked(mocks.job.queueOutsideRun).mock.calls.map(([items]) => items)).toEqual([
        [{ name: JobName.MediaHealthLocateMissing, data: { userId: 'user-id', pending: true } }],
        [{ name: JobName.MediaHealthLocateMissing, data: { userId: 'user-id', pending: true } }],
      ]);
    });

    it('leaves a finding a search claimed to it, and still asks for a search in case that one stopped', async () => {
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { searchPending: { search: 'job-0' } }));

      await sut.handleFixAsset({ id: 'asset-1', from: 'import' });

      expect(mediaHealthRepository.settleFinding).not.toHaveBeenCalled();
      // the search asked for here claims it again if job-0 is no longer live (medium spec)
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith([
        { name: JobName.MediaHealthLocateMissing, data: { userId: 'user-id', pending: true } },
      ]);
    });

    it('gets the finding searched when a person tries again during a claim that never finished', async () => {
      vi.mocked(mocks.storage.checkFileExists).mockResolvedValue(false);
      recorded(finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { searchPending: { search: 'job-0' } }));

      await sut.handleFixAsset({ id: 'asset-1', from: 'person' });

      // waiting again, so the next search claims it whatever became of job-0
      expect(mediaHealthRepository.settleFinding).toHaveBeenCalledWith({
        healthId: 'health-1',
        evidence: { searchPending: true },
        steps: [],
      });
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith([
        { name: JobName.MediaHealthLocateMissing, data: { userId: 'user-id', pending: true } },
      ]);
    });

    it('lets a retried search step claim the findings it claimed before it failed', async () => {
      vi.mocked(mediaHealthRepository.claimSearchPending).mockResolvedValue(['health-1']);
      vi.spyOn(sut as any, 'locateFindings').mockRejectedValueOnce(new Error('EIO: the drive went away'));
      // the queue runs a step as its job row, and a retry runs the same row again
      const asStep = <T>(work: () => Promise<T>) => queueExecution.run({ claim: { id: 'job-1' } } as never, work);

      await expect(asStep(() => sut.handleLocateMissing({ userId: 'user-id', pending: true }))).rejects.toThrow('EIO');
      expect(mediaHealthRepository.claimSearchPending).toHaveBeenLastCalledWith('user-id', 'job-1');
      expect(mocks.job.queueOutsideRun).not.toHaveBeenCalled();

      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { searchPending: { search: 'job-1' } }),
      ] as never);
      await expect(asStep(() => sut.handleLocateMissing({ userId: 'user-id', pending: true }))).resolves.toBe(
        JobStatus.Success,
      );
      // the same search, so the repository hands its claims back (medium spec), and the fix is fed
      expect(mediaHealthRepository.claimSearchPending).toHaveBeenLastCalledWith('user-id', 'job-1');
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith([
        { name: JobName.MediaHealthFixAsset, data: { id: 'asset-1', from: 'check', searched: true } },
      ]);
    });

    it('feeds each fix still waiting when its owner’s shared search is complete', async () => {
      const waiting = { ...finding(MediaHealthCategory.Missing, MediaHealthStatus.Missing, { searchPending: 'x' }) };
      const decided = { ...waiting, id: 'health-2', assetId: 'asset-2', evidence: { searchPending: false } };
      vi.mocked(mediaHealthRepository.claimSearchPending).mockResolvedValue(['health-1', 'health-2']);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([waiting, decided] as never);

      await expect(sut.handleLocateMissing({ userId: 'user-id', pending: true })).resolves.toBe(JobStatus.Success);

      expect(mediaHealthRepository.claimSearchPending).toHaveBeenCalledWith('user-id', expect.any(String));
      // one walk for every waiting finding of the owner, with no run that would stand in for their last check
      expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['health-1', 'health-2'], 'user-id');
      expect(mediaHealthRepository.createRun).not.toHaveBeenCalled();
      expect(mediaHealthRepository.finishRun).not.toHaveBeenCalled();
      // F8: outside any run, so a later search's feed for the same photo is never dropped as done
      expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith([
        { name: JobName.MediaHealthFixAsset, data: { id: 'asset-1', from: 'check', searched: true } },
      ]);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('carries an incomplete shared search on with the findings it claimed, feeding no fix yet', async () => {
      vi.mocked(mediaHealthRepository.claimSearchPending).mockResolvedValue(['health-1']);
      const continuation = { cursor: [{ path: '/data/library' }], matches: {} };
      vi.spyOn(sut as any, 'locateFindings').mockResolvedValue({ checkedAssets: 1, foundAssets: 0, continuation });

      await queueExecution.run({ claim: { id: 'job-1' } } as never, () =>
        sut.handleLocateMissing({ userId: 'user-id', pending: true }),
      );

      // the walk carries on as the same search, with the findings it claimed
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.MediaHealthLocateMissing,
        data: { userId: 'user-id', pending: true, ids: ['health-1'], searchId: 'job-1', managedSearch: continuation },
      });
      expect(mocks.job.queueOutsideRun).not.toHaveBeenCalled();

      // the next step walks on with the same findings, claiming nothing new
      vi.mocked(mediaHealthRepository.claimSearchPending).mockClear();
      await sut.handleLocateMissing({
        userId: 'user-id',
        pending: true,
        ids: ['health-1'],
        managedSearch: continuation,
      });
      expect(mediaHealthRepository.claimSearchPending).not.toHaveBeenCalled();
    });

    it('does nothing when no fix waits for the shared search', async () => {
      await expect(sut.handleLocateMissing({ userId: 'user-id', pending: true })).resolves.toBe(JobStatus.Skipped);
      expect(mediaHealthRepository.getByIds).not.toHaveBeenCalled();
    });

    it('skips a photo that is gone or in the trash, recording nothing', async () => {
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValueOnce([]);
      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'check' })).resolves.toBe(JobStatus.Skipped);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValueOnce([{ ...asset, deletedAt: new Date() }] as never);
      await expect(sut.handleFixAsset({ id: 'asset-1', from: 'check' })).resolves.toBe(JobStatus.Skipped);
      expect(written()).toEqual([]);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });
  describe('phones and lost originals (FL-1337)', () => {
    const owner = { ...authStub.user1, session: { id: 'session-iphone', hasElevatedPermission: false } };
    const care = (libraryCare: Record<string, unknown>) => {
      clearConfigCache();
      vi.mocked(mocks.systemMetadata.get).mockResolvedValue({ libraryCare } as never);
    };
    const sha1 = createHash('sha1').update('lost').digest();
    const session = (id: string, deviceOS: string, deviceType: string, daysAgo = 1) => ({
      id,
      deviceOS,
      deviceType,
      updatedAt: new Date(Date.now() - daysAgo * 86_400_000),
    });
    const sessions = (...rows: ReturnType<typeof session>[]) =>
      vi.mocked(mocks.session.getByUserId).mockResolvedValue(rows as never);
    const open = () => ({ healthId: 'health-1', assetId: 'asset-1', evidence: { fixState: 'waiting-phone' } });
    const reported = () => vi.mocked(mediaHealthRepository.recordPhoneReport).mock.calls.at(-1)?.[0];

    beforeEach(() => {
      care({});
      sessions(session('session-iphone', 'iOS', 'iPhone15,2'), session('session-pixel', 'Android', 'Pixel 8'));
    });

    describe('phonesToAsk', () => {
      it('is the owner’s phones and tablets used in the last 90 days, by session', async () => {
        sessions(
          session('a', 'iOS', 'iPhone15,2'),
          session('b', 'iPadOS', 'iPad13,4'),
          session('c', 'android', 'Pixel 8'),
          session('d', 'macOS', 'Chrome'),
          session('e', 'Windows', 'Firefox'),
          session('f', 'iOS', 'iPhone12,1', 91),
          session('g', 'Android', '', 3),
        );

        await expect((sut as any).phonesToAsk('owner-1')).resolves.toEqual([
          { deviceId: 'a', name: 'iPhone15,2' },
          { deviceId: 'b', name: 'iPad13,4' },
          { deviceId: 'c', name: 'Pixel 8' },
          { deviceId: 'g', name: 'Android' },
        ]);
        expect(mocks.session.getByUserId).toHaveBeenCalledWith('owner-1');
      });
    });

    describe('listLostOriginals', () => {
      const row = (n: number, fileSize: number | null = 1_048_576 * n) => ({
        assetId: `asset-${n}`,
        checksum: sha1,
        originalFileName: `IMG_${n}.jpg`,
        fileCreatedAt: new Date('2025-01-02T03:04:05.000Z'),
        fileSize,
      });

      it('lists only the caller’s own, with base64 checksums and file sizes', async () => {
        vi.mocked(mediaHealthRepository.listLostOriginals).mockResolvedValue([row(1)] as never);

        await expect(sut.listLostOriginals(owner, { take: 500, skip: 0 })).resolves.toEqual({
          items: [
            {
              assetId: 'asset-1',
              checksum: sha1.toString('base64'),
              originalFileName: 'IMG_1.jpg',
              fileCreatedAt: '2025-01-02T03:04:05.000Z',
              fileSize: 1_048_576,
            },
          ],
          hasNextPage: false,
        });
        expect(mediaHealthRepository.listLostOriginals).toHaveBeenCalledWith(owner.user.id, 500, 0);
      });

      it('gives no file size for a photo whose size was never read (FL-1347)', async () => {
        vi.mocked(mediaHealthRepository.listLostOriginals).mockResolvedValue([row(1, null)] as never);

        const { items } = await sut.listLostOriginals(owner, { take: 500, skip: 0 });

        expect(items).toEqual([expect.objectContaining({ assetId: 'asset-1', fileSize: null })]);
      });

      it('pages: one row beyond the page says there is more', async () => {
        vi.mocked(mediaHealthRepository.listLostOriginals).mockResolvedValue([row(1), row(2), row(3)] as never);

        const page = await sut.listLostOriginals(owner, { take: 2, skip: 4 });

        expect(page.items.map(({ assetId }) => assetId)).toEqual(['asset-1', 'asset-2']);
        expect(page.hasNextPage).toBe(true);
        expect(mediaHealthRepository.listLostOriginals).toHaveBeenCalledWith(owner.user.id, 2, 4);
      });

      it('is empty while phones are not asked', async () => {
        care({ askPhones: false });

        await expect(sut.listLostOriginals(owner, { take: 500, skip: 0 })).resolves.toEqual({
          items: [],
          hasNextPage: false,
        });
        expect(mediaHealthRepository.listLostOriginals).not.toHaveBeenCalled();
      });
    });

    describe('recordPhoneChecked', () => {
      const report = (
        notHere = [sha1.toString('base64')],
        auth: Parameters<typeof sut.recordPhoneChecked>[0] = owner,
      ) => sut.recordPhoneChecked(auth, { deviceId: 'device-1', notHere });

      it('hands the repository the phone, its model and every phone that is asked, to decide under the lock', async () => {
        vi.mocked(mediaHealthRepository.findLostOriginals).mockResolvedValue([open()] as never);

        await report();

        expect(mediaHealthRepository.findLostOriginals).toHaveBeenCalledWith(owner.user.id, [sha1]);
        expect(reported()).toEqual({
          findings: [open()],
          sessionId: 'session-iphone',
          device: 'iPhone15,2',
          deviceId: 'device-1',
          phones: ['session-iphone', 'session-pixel'],
        });
      });

      it('repeats the hand-over for a phone that reported before, so a lost race can still settle', async () => {
        vi.mocked(mediaHealthRepository.findLostOriginals).mockResolvedValue([open()] as never);

        await report();
        await report();

        expect(mediaHealthRepository.recordPhoneReport).toHaveBeenCalledTimes(2);
      });

      it('ignores checksums that are not the caller’s open lost originals, and anything not SHA-1 or SHA-256', async () => {
        // the repository finds only the caller's own open ones
        vi.mocked(mediaHealthRepository.findLostOriginals).mockResolvedValue([]);
        const sha256 = createHash('sha256').update('lost').digest();

        await expect(
          report([
            sha1.toString('base64'),
            'not base64 !',
            Buffer.alloc(16).toString('base64'),
            sha256.toString('base64'),
            Buffer.alloc(48).toString('base64'),
          ]),
        ).resolves.toBeUndefined();

        expect(mediaHealthRepository.findLostOriginals).toHaveBeenCalledWith(owner.user.id, [sha1, sha256]);
        expect(mediaHealthRepository.recordPhoneReport).not.toHaveBeenCalled();
      });

      it('hands over a report by SHA-256, as current uploads are stored (FL-1347)', async () => {
        const sha256 = createHash('sha256').update('uploaded').digest();
        vi.mocked(mediaHealthRepository.findLostOriginals).mockResolvedValue([open()] as never);

        await report([sha256.toString('base64')]);

        expect(mediaHealthRepository.findLostOriginals).toHaveBeenCalledWith(owner.user.id, [sha256]);
        expect(reported()).toMatchObject({ findings: [open()], sessionId: 'session-iphone' });
      });

      it('records nothing for a session that is not a phone or tablet', async () => {
        vi.mocked(mediaHealthRepository.findLostOriginals).mockResolvedValue([open()] as never);
        sessions(
          session('session-iphone', 'iOS', 'iPhone15,2'),
          session('session-browser', 'macOS', 'Chrome'),
          session('session-stale', 'iOS', 'iPhone8,1', 120),
        );

        await report(undefined, { ...owner, session: { id: 'session-browser', hasElevatedPermission: false } });
        await report(undefined, { ...owner, session: { id: 'session-stale', hasElevatedPermission: false } });

        expect(mediaHealthRepository.recordPhoneReport).not.toHaveBeenCalled();
      });

      it('accepts a caller without a session and records nothing', async () => {
        await expect(report(undefined, { ...owner, session: undefined })).resolves.toBeUndefined();

        expect(mediaHealthRepository.findLostOriginals).not.toHaveBeenCalled();
        expect(mediaHealthRepository.recordPhoneReport).not.toHaveBeenCalled();
      });

      it('records nothing while phones are not asked', async () => {
        care({ askPhones: false });

        await report();

        expect(mediaHealthRepository.recordPhoneReport).not.toHaveBeenCalled();
      });
    });
  });

  describe('the list, the history and the actions (FL-1337)', () => {
    const owner = authStub.user1;
    const admin = authStub.admin;
    const CHANGED = "This photo changed since Frameleaf fixed it, so it can't be undone.";
    const sha1 = (bytes: Buffer | string) => createHash('sha1').update(bytes).digest();
    const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest();
    const at = (iso: string) => new Date(iso);
    let root: string;
    let care: string;
    let nestedPath: { mockRestore: () => void };

    /** One problem as the repository reads it: the finding, whose it is, and its newest story step. */
    const problem = (overrides: Record<string, unknown> = {}) => ({
      id: 'health-1',
      assetId: 'asset-1',
      runId: null,
      category: MediaHealthCategory.Corrupt,
      status: MediaHealthStatus.Resolved,
      severity: MediaHealthSeverity.Info,
      originalPath: '/data/upload/user-id/.library-care/asset-1-health-1-0123abcd.jpg',
      originalFileName: 'IMG_2041.jpg',
      evidence: { fixState: 'part-saved', partSaved: true },
      resolution: {},
      checkedAt: at('2026-11-09T02:15:00Z'),
      createdAt: at('2026-11-09T02:14:00Z'),
      updatedAt: at('2026-11-09T02:15:00Z'),
      resolvedAt: at('2026-11-09T02:15:00Z'),
      dismissedAt: null,
      ownerId: owner.user.id,
      ownerName: owner.user.name,
      assetDeletedAt: null,
      line: { step: 'repaired', outcome: 'ok', facts: { method: 'rebuilt', percentSaved: 92 } },
      ...overrides,
    });
    const step = (id: string, name: string, outcome: string, extra: Record<string, unknown> = {}) => ({
      id,
      healthId: 'health-1',
      assetId: 'asset-1',
      at: at(`2026-11-09T02:1${id.slice(-1)}:00Z`),
      step: name,
      outcome,
      facts: {},
      undo: null,
      ...extra,
    });
    const shows = (...problems: Array<ReturnType<typeof problem>>) => {
      let index = 0;
      vi.mocked(mediaHealthRepository.getFileProblem).mockImplementation(() =>
        Promise.resolve(problems[Math.min(index++, problems.length - 1)] as never),
      );
    };
    const history = (...steps: Array<ReturnType<typeof step>>) =>
      vi.mocked(mediaHealthRepository.listSteps).mockResolvedValue(steps as never);
    const photo = (overrides: Record<string, unknown>) =>
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          ownerId: owner.user.id,
          updateId: 'update-1',
          checksumAlgorithm: ChecksumAlgorithm.sha256File,
          originalFileName: 'IMG_2041.jpg',
          type: AssetType.Image,
          isExternal: false,
          libraryId: null,
          deletedAt: null,
          isLocked: false,
          ...overrides,
        },
      ] as never);

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'library-care-undo-'));
      care = join(root, 'upload', 'user-id', 'as', 'se', '.library-care');
      await mkdir(care, { recursive: true });
      nestedPath = vi
        .spyOn(StorageCore, 'getNestedPath')
        .mockReturnValue(join(root, 'upload', 'user-id', 'as', 'se', 'asset-1'));
      const crypto = new CryptoRepository();
      vi.mocked(mocks.crypto.hashFileDigests).mockImplementation((file) => crypto.hashFileDigests(file));
      vi.mocked(mocks.crypto.hashFileMatching).mockImplementation((file, reference) =>
        crypto.hashFileMatching(file, reference),
      );
      vi.mocked(mocks.storage.stat).mockImplementation((file) => stat(file) as never);
      vi.mocked(mocks.user.get).mockImplementation((id) =>
        Promise.resolve({ id, name: id === owner.user.id ? owner.user.name : 'Emma', storageLabel: null } as never),
      );
    });

    afterEach(async () => {
      nestedPath.mockRestore();
      await rm(root, { recursive: true, force: true });
    });

    describe('the list', () => {
      it('lists a member’s own problems by tab', async () => {
        vi.mocked(mediaHealthRepository.listFileProblems).mockResolvedValue([
          problem({
            category: MediaHealthCategory.Missing,
            status: MediaHealthStatus.Missing,
            evidence: {},
            resolvedAt: null,
            line: {
              step: 'checked-on-phone',
              outcome: 'not-found',
              facts: { device: 'iPhone15,2', deviceId: 'device-1', session: 'session-1' },
            },
          }),
        ] as never);
        vi.mocked(mediaHealthRepository.countFileProblems).mockResolvedValue(12);

        for (const tab of ['needs', 'fixed', 'kept'] as const) {
          await sut.listFileProblems(owner, { tab, take: 50, skip: 100 });
          expect(mediaHealthRepository.listFileProblems).toHaveBeenLastCalledWith({
            tab,
            ownerId: owner.user.id,
            privacy: {},
            take: 50,
            skip: 100,
          });
          expect(mediaHealthRepository.countFileProblems).toHaveBeenLastCalledWith({
            tab,
            ownerId: owner.user.id,
            privacy: {},
          });
        }

        await expect(sut.listFileProblems(owner, { tab: 'needs', take: 50, skip: 0 })).resolves.toEqual({
          total: 12,
          items: [
            {
              id: 'health-1',
              assetId: 'asset-1',
              ownerId: owner.user.id,
              ownerName: owner.user.name,
              originalFileName: 'IMG_2041.jpg',
              category: MediaHealthCategory.Missing,
              // no fix has looked at it yet: it needs the person
              fixState: null,
              partSaved: false,
              // what a sentence needs, and nothing about the session that reported it
              line: { step: 'checked-on-phone', outcome: 'not-found', facts: { device: 'iPhone15,2' } },
              updatedAt: '2026-11-09T02:15:00.000Z',
              pictureAllowed: true,
              canAct: true,
            },
          ],
        });
      });

      it('says when a repair saved only part of the picture', async () => {
        vi.mocked(mediaHealthRepository.listFileProblems).mockResolvedValue([problem()] as never);

        const { items } = await sut.listFileProblems(owner, { tab: 'fixed', take: 50, skip: 0 });

        expect(items[0]).toMatchObject({
          fixState: 'part-saved',
          partSaved: true,
          line: { step: 'repaired', outcome: 'ok', facts: { method: 'rebuilt', percentSaved: 92 } },
        });
      });

      it('shows its Locked problems to a member only in their unlocked session', async () => {
        await sut.listFileProblems(elevatedOwner, { tab: 'needs', take: 50, skip: 0 });

        expect(mediaHealthRepository.listFileProblems).toHaveBeenCalledWith(
          expect.objectContaining({
            ownerId: owner.user.id,
            privacy: { lockedOwnerId: owner.user.id, revealLockedOwnerId: owner.user.id },
          }),
        );
      });

      it('an admin sees another account’s row without its picture', async () => {
        vi.mocked(mediaHealthRepository.listFileProblems).mockResolvedValue([
          problem({ ownerId: 'user-2', ownerName: 'Emma' }),
          problem({ id: 'health-2', ownerId: admin.user.id, ownerName: admin.user.name }),
        ] as never);

        const { items } = await sut.listFileProblems(authStub.adminWithElevatedPermission, {
          tab: 'fixed',
          take: 50,
          skip: 0,
        });

        // every account's rows, but Locked ones only the administrator's own
        expect(mediaHealthRepository.listFileProblems).toHaveBeenCalledWith(
          expect.objectContaining({
            ownerId: undefined,
            privacy: { lockedOwnerId: admin.user.id, revealLockedOwnerId: admin.user.id },
          }),
        );
        expect(items[0]).toMatchObject({ ownerName: 'Emma', pictureAllowed: false, canAct: false });
        expect(items[1]).toMatchObject({ ownerName: admin.user.name, pictureAllowed: true, canAct: true });
      });

      it('a member never sees another account’s rows', async () => {
        await sut.listFileProblems(owner, { tab: 'needs', take: 50, skip: 0 });
        expect(mediaHealthRepository.listFileProblems).toHaveBeenCalledWith(
          expect.objectContaining({ ownerId: owner.user.id }),
        );

        // another account's problem is not there for them, and nothing about it is done
        vi.mocked(mediaHealthRepository.getFileProblem).mockResolvedValue(undefined);
        await expect(sut.getFileProblem(owner, 'health-2')).rejects.toThrow('Frameleaf has no record of this problem');
        expect(mediaHealthRepository.getFileProblem).toHaveBeenCalledWith('health-2', owner.user.id, {});
        await expect(sut.tryFileProblemAgain(owner, 'health-2')).rejects.toThrow('no record');
        await expect(sut.undoFileProblemFix(owner, 'health-2')).rejects.toThrow('no record');
        expect(mocks.job.queue).not.toHaveBeenCalled();
        expect(mediaHealthRepository.undoFix).not.toHaveBeenCalled();
      });

      it('gives the history oldest first, without what Undo needs', async () => {
        shows(problem());
        history(
          step('step-1', 'wont-open', 'failed', { facts: { cause: 'cut-short' } }),
          step('step-2', 'repaired', 'ok', { facts: { method: 'rebuilt', percentSaved: 92 } }),
          step('step-3', 'kept-damaged', 'info', { undo: { kind: 'repair', previousPath: '/data/upload/x.jpg' } }),
        );

        const result = await sut.getFileProblem(owner, 'health-1');

        expect(result.steps).toEqual([
          { at: '2026-11-09T02:11:00.000Z', step: 'wont-open', outcome: 'failed', facts: { cause: 'cut-short' } },
          {
            at: '2026-11-09T02:12:00.000Z',
            step: 'repaired',
            outcome: 'ok',
            facts: { method: 'rebuilt', percentSaved: 92 },
          },
          { at: '2026-11-09T02:13:00.000Z', step: 'kept-damaged', outcome: 'info', facts: {} },
        ]);
        expect(mediaHealthRepository.listSteps).toHaveBeenCalledWith('health-1');
      });

      it('gives an administrator the history of another account’s file, without its picture', async () => {
        shows(problem({ ownerId: 'user-2', ownerName: 'Emma' }));

        await expect(sut.getFileProblem(admin, 'health-1')).resolves.toMatchObject({
          ownerName: 'Emma',
          pictureAllowed: false,
          canAct: false,
          steps: [],
        });
        expect(mediaHealthRepository.getFileProblem).toHaveBeenCalledWith('health-1', undefined, {});
      });

      it('lists the folders each person may search', async () => {
        vi.mocked(mocks.library.getAll).mockResolvedValue([
          { id: 'library-1', ownerId: owner.user.id, name: 'Holiday drive', importPaths: ['/mnt/holiday'] },
          { id: 'library-2', ownerId: 'user-2', name: 'Emma’s drive', importPaths: ['/mnt/emma'] },
        ] as never);
        recoveryRoots.push({ label: 'Old NAS', path: '/mnt/old-nas' });

        await expect(sut.getFileProblemFolders(owner)).resolves.toEqual([
          { id: MANAGED_ROOT_ID, name: 'Library storage' },
          { id: libraryRootId('library-1'), name: 'Holiday drive' },
        ]);
        await expect(sut.getFileProblemFolders(admin)).resolves.toEqual([
          { id: MANAGED_ROOT_ID, name: 'Library storage' },
          { id: libraryRootId('library-1'), name: 'Holiday drive' },
          { id: libraryRootId('library-2'), name: 'Emma’s drive' },
          { id: recoveryRootId('/mnt/old-nas'), name: 'Old NAS' },
        ]);
      });
    });

    describe('undo', () => {
      const refused = async (promise: Promise<unknown>, message = CHANGED) => {
        await expect(promise).rejects.toThrow(message);
        await expect(promise).rejects.toMatchObject({ message, status: 409 });
      };

      it('undo puts the damaged file back and stops further repairs', async () => {
        const damaged = join(care, 'asset-1-health-1.damaged.jpg');
        const repaired = join(care, 'asset-1-health-1-0123abcd.jpg');
        await writeFile(damaged, 'the damaged file');
        await writeFile(repaired, 'the repaired file');
        photo({ originalPath: repaired, checksum: sha256('the repaired file') });
        shows(
          problem({
            originalPath: repaired,
            evidence: { fixState: 'part-saved', partSaved: true, retainedPath: damaged },
          }),
          problem({
            status: MediaHealthStatus.CorruptConfirmed,
            resolvedAt: null,
            evidence: { fixState: 'cant-repair' },
          }),
        );
        history(
          step('step-1', 'wont-open', 'failed'),
          step('step-2', 'repaired', 'ok'),
          step('step-3', 'kept-damaged', 'info', {
            undo: {
              kind: 'repair',
              previousPath: damaged,
              originalPath: repaired,
              checksum: sha256('the repaired file').toString('hex'),
            },
          }),
        );

        const result = await sut.undoFileProblemFix(owner, 'health-1');

        expect(mediaHealthRepository.undoFix).toHaveBeenCalledWith({
          healthId: 'health-1',
          assetId: 'asset-1',
          ownerId: owner.user.id,
          stepId: 'step-3',
          expectedOriginalPath: repaired,
          expectedChecksum: sha256('the repaired file'),
          // FL-1364: held and read again under their path locks
          keptPaths: [damaged],
          // the photo is the kept damaged file again, with that file's own checksum
          relinkTo: {
            path: damaged,
            digests: { sha1: sha1('the damaged file'), sha256: sha256('the damaged file'), sizeInBytes: 16 },
            takeChecksum: true,
          },
          // back in Needs you, and never repaired again by itself
          status: MediaHealthStatus.CorruptConfirmed,
          evidence: { fixState: 'cant-repair', partSaved: false, autoRepairDeclined: true },
          steps: [{ step: 'undone', outcome: 'info', facts: { by: owner.user.name } }],
        });
        // the repaired file is kept where it is: nothing is deleted
        await expect(readFile(repaired, 'utf8')).resolves.toBe('the repaired file');
        await expect(readFile(damaged, 'utf8')).resolves.toBe('the damaged file');
        expect(result).toMatchObject({ fixState: 'cant-repair', canAct: true });
        expect(mocks.job.queue).not.toHaveBeenCalled();
        // its details and previews are read again from the file it uses now, as after a relink; the previews
        // outside any run
        expect(mocks.job.queueAll).toHaveBeenCalledWith([
          { name: JobName.SidecarCheck, data: { id: 'asset-1', source: 'upload' } },
        ]);
        expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith([
          { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        ]);
      });

      it('undoes a repair whose kept-damaged step was never written, from the kept file', async () => {
        const damaged = join(care, 'asset-1-health-1.damaged.jpg');
        const repaired = join(care, 'asset-1-health-1-0123abcd.jpg');
        await writeFile(damaged, 'the damaged file');
        await writeFile(repaired, 'the repaired file');
        photo({ originalPath: repaired, checksum: sha256('the repaired file') });
        shows(
          problem({
            originalPath: repaired,
            evidence: { fixState: 'repaired', partSaved: false, retainedPath: damaged },
          }),
        );
        history(step('step-1', 'wont-open', 'failed'), step('step-2', 'repaired', 'ok'));

        await sut.undoFileProblemFix(owner, 'health-1');

        expect(mediaHealthRepository.undoFix).toHaveBeenCalledWith(
          expect.objectContaining({
            stepId: 'step-2',
            expectedOriginalPath: repaired,
            expectedChecksum: sha256('the repaired file'),
            relinkTo: expect.objectContaining({ path: damaged, takeChecksum: true }),
          }),
        );
      });

      it('undoes a relink: the photo is missing again where it was, and the copy stays', async () => {
        const lost = join(root, 'library', 'IMG_3310.jpg');
        const copy = join(root, 'library', 'IMG_3310+1.jpg');
        await mkdir(join(root, 'library'), { recursive: true });
        await writeFile(copy, 'the photo, exactly');
        photo({ originalPath: copy, checksum: sha256('the photo, exactly') });
        shows(
          problem({
            category: MediaHealthCategory.Missing,
            status: MediaHealthStatus.Relinked,
            originalPath: copy,
            evidence: { fixState: 'found-again' },
          }),
        );
        history(
          step('step-1', 'not-on-drive', 'failed'),
          step('step-2', 'searched-copy', 'ok'),
          step('step-3', 'put-back', 'ok', {
            undo: {
              kind: 'relink',
              previousPath: lost,
              originalPath: copy,
              checksum: sha256('the photo, exactly').toString('hex'),
            },
          }),
        );

        await sut.undoFileProblemFix(owner, 'health-1');

        expect(mediaHealthRepository.undoFix).toHaveBeenCalledWith(
          expect.objectContaining({
            stepId: 'step-3',
            expectedOriginalPath: copy,
            // the photo keeps its own checksum: the copy had its very contents
            relinkTo: { path: lost, takeChecksum: false },
            status: MediaHealthStatus.Missing,
            evidence: { fixState: 'missing', partSaved: false },
            steps: [{ step: 'undone', outcome: 'info', facts: { by: owner.user.name } }],
          }),
        );
        await expect(readFile(copy, 'utf8')).resolves.toBe('the photo, exactly');
      });

      it('undoes an in-place restore: the restored file is moved aside and the changed file put back', async () => {
        const original = join(root, 'library', 'IMG_5520.jpg');
        const changed = join(care, 'asset-1-0badc0de.damaged.jpg');
        await mkdir(join(root, 'library'), { recursive: true });
        await writeFile(original, 'the original, from Cloud Backup');
        await writeFile(changed, 'the changed file');
        photo({
          originalPath: original,
          checksum: sha1('the original, from Cloud Backup'),
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalFileName: 'IMG_5520.jpg',
        });
        shows(problem({ originalPath: original, evidence: { fixState: 'restored' } }));
        history(
          step('step-1', 'checked-backups', 'ok'),
          step('step-2', 'restored', 'ok', {
            undo: {
              kind: 'restore',
              previousPath: original,
              originalPath: original,
              checksum: sha1('the original, from Cloud Backup').toString('hex'),
              retainedPath: changed,
            },
          }),
        );
        // the files move under the repository's lock, once the photo is proven unchanged
        vi.mocked(mediaHealthRepository.undoFix).mockImplementation(async (input) => {
          await input.moveFiles?.();
          return 'undone';
        });

        await sut.undoFileProblemFix(owner, 'health-1');

        await expect(readFile(original, 'utf8')).resolves.toBe('the changed file');
        await expect(readFile(join(care, 'asset-1-health-1.restored.jpg'), 'utf8')).resolves.toBe(
          'the original, from Cloud Backup',
        );
        await expect(stat(changed)).rejects.toThrow();
        expect(mediaHealthRepository.undoFix).toHaveBeenCalledWith(
          expect.objectContaining({
            stepId: 'step-2',
            status: MediaHealthStatus.CorruptConfirmed,
            evidence: { fixState: 'cant-repair', partSaved: false },
            steps: [{ step: 'undone', outcome: 'info', facts: { by: owner.user.name } }],
          }),
        );
        // the photo keeps its file and its checksum: only the files at its path move
        expect(vi.mocked(mediaHealthRepository.undoFix).mock.calls[0][0]).not.toHaveProperty('relinkTo');
      });

      it('undoes a restore of a lost file: it is missing again, and the restored file is kept aside', async () => {
        const original = join(root, 'library', 'IMG_0877.jpg');
        await mkdir(join(root, 'library'), { recursive: true });
        await writeFile(original, 'the original, from Cloud Backup');
        photo({ originalPath: original, checksum: sha256('the original, from Cloud Backup') });
        shows(
          problem({
            category: MediaHealthCategory.Missing,
            status: MediaHealthStatus.Relinked,
            originalPath: original,
            evidence: { fixState: 'restored' },
          }),
        );
        history(
          step('step-1', 'restored', 'ok', {
            undo: {
              kind: 'restore',
              previousPath: original,
              originalPath: original,
              checksum: sha256('the original, from Cloud Backup').toString('hex'),
            },
          }),
        );
        vi.mocked(mediaHealthRepository.undoFix).mockImplementation(async (input) => {
          await input.moveFiles?.();
          return 'undone';
        });

        await sut.undoFileProblemFix(owner, 'health-1');

        await expect(stat(original)).rejects.toThrow();
        await expect(readFile(join(care, 'asset-1-health-1.restored.jpg'), 'utf8')).resolves.toBe(
          'the original, from Cloud Backup',
        );
        expect(mediaHealthRepository.undoFix).toHaveBeenCalledWith(
          expect.objectContaining({
            status: MediaHealthStatus.Missing,
            evidence: { fixState: 'missing', partSaved: false },
          }),
        );
      });

      it('puts the files back where they were when the undo cannot be recorded', async () => {
        const original = join(root, 'library', 'IMG_5520.jpg');
        const changed = join(care, 'asset-1-0badc0de.damaged.jpg');
        await mkdir(join(root, 'library'), { recursive: true });
        await writeFile(original, 'the original, from Cloud Backup');
        await writeFile(changed, 'the changed file');
        photo({ originalPath: original, checksum: sha256('the original, from Cloud Backup') });
        shows(problem({ originalPath: original, evidence: { fixState: 'restored' } }));
        history(
          step('step-1', 'restored', 'ok', {
            undo: {
              kind: 'restore',
              previousPath: original,
              originalPath: original,
              checksum: sha256('the original, from Cloud Backup').toString('hex'),
              retainedPath: changed,
            },
          }),
        );
        vi.mocked(mediaHealthRepository.undoFix).mockImplementation(async (input) => {
          await input.moveFiles?.();
          throw new Error('connection terminated');
        });

        await expect(sut.undoFileProblemFix(owner, 'health-1')).rejects.toThrow();

        await expect(readFile(original, 'utf8')).resolves.toBe('the original, from Cloud Backup');
        await expect(readFile(changed, 'utf8')).resolves.toBe('the changed file');
        await expect(stat(join(care, 'asset-1-health-1.restored.jpg'))).rejects.toThrow();
      });

      it('undo is refused after the photo changed', async () => {
        const repaired = join(care, 'asset-1-health-1-0123abcd.jpg');
        const damaged = join(care, 'asset-1-health-1.damaged.jpg');
        await writeFile(repaired, 'the repaired file');
        await writeFile(damaged, 'the damaged file');
        const undo = {
          kind: 'repair',
          previousPath: damaged,
          originalPath: repaired,
          checksum: sha256('the repaired file').toString('hex'),
        };
        shows(problem({ originalPath: repaired }));
        history(step('step-1', 'repaired', 'ok'), step('step-2', 'kept-damaged', 'info', { undo }));

        // re-uploaded: its checksum is not the one the repair left
        photo({ originalPath: repaired, checksum: sha256('a new upload') });
        await refused(sut.undoFileProblemFix(owner, 'health-1'));
        // in the Trash, or another account's now
        photo({ originalPath: repaired, checksum: sha256('the repaired file'), deletedAt: new Date() });
        await refused(sut.undoFileProblemFix(owner, 'health-1'));
        expect(mediaHealthRepository.undoFix).not.toHaveBeenCalled();

        // an edit saved since the repair: the repository finds it under its lock, and changes nothing
        photo({ originalPath: repaired, checksum: sha256('the repaired file') });
        vi.mocked(mediaHealthRepository.undoFix).mockResolvedValue('changed');
        await refused(sut.undoFileProblemFix(owner, 'health-1'));

        await expect(readFile(repaired, 'utf8')).resolves.toBe('the repaired file');
        await expect(readFile(damaged, 'utf8')).resolves.toBe('the damaged file');
        expect(mocks.job.queueOutsideRun).not.toHaveBeenCalled();
      });

      it('undoes a repair after Folder layout moved the repaired file, by its checksum (F9)', async () => {
        const repaired = join(care, 'asset-1-health-1-0123abcd.jpg');
        const damaged = join(care, 'asset-1-health-1.damaged.jpg');
        const moved = join(root, 'library', '2026', 'IMG_2041.jpg');
        await mkdir(join(root, 'library', '2026'), { recursive: true });
        await writeFile(moved, 'the repaired file');
        await writeFile(damaged, 'the damaged file');
        shows(problem({ originalPath: repaired, evidence: { fixState: 'repaired', partSaved: false } }));
        history(
          step('step-1', 'repaired', 'ok'),
          step('step-2', 'kept-damaged', 'info', {
            undo: {
              kind: 'repair',
              previousPath: damaged,
              originalPath: repaired,
              checksum: sha256('the repaired file').toString('hex'),
            },
          }),
        );
        // Folder layout moved it to its template path right after the fix; the file is the one the repair left
        photo({ originalPath: moved, checksum: sha256('the repaired file') });

        await sut.undoFileProblemFix(owner, 'health-1');

        // held to where the photo is now, under the repository's lock
        expect(mediaHealthRepository.undoFix).toHaveBeenCalledWith(
          expect.objectContaining({
            stepId: 'step-2',
            expectedOriginalPath: moved,
            expectedChecksum: sha256('the repaired file'),
            relinkTo: expect.objectContaining({ path: damaged, takeChecksum: true }),
          }),
        );
        await expect(readFile(moved, 'utf8')).resolves.toBe('the repaired file');
      });

      it('moves nothing for a restore the repository refuses', async () => {
        const original = join(root, 'library', 'IMG_5520.jpg');
        const changed = join(care, 'asset-1-0badc0de.damaged.jpg');
        await mkdir(join(root, 'library'), { recursive: true });
        await writeFile(original, 'the original, from Cloud Backup');
        await writeFile(changed, 'the changed file');
        photo({ originalPath: original, checksum: sha256('the original, from Cloud Backup') });
        shows(problem({ originalPath: original, evidence: { fixState: 'restored' } }));
        history(
          step('step-1', 'restored', 'ok', {
            undo: {
              kind: 'restore',
              previousPath: original,
              originalPath: original,
              checksum: sha256('the original, from Cloud Backup').toString('hex'),
              retainedPath: changed,
            },
          }),
        );
        vi.mocked(mediaHealthRepository.undoFix).mockResolvedValue('changed');

        await refused(sut.undoFileProblemFix(owner, 'health-1'));

        await expect(readFile(original, 'utf8')).resolves.toBe('the original, from Cloud Backup');
        await expect(readFile(changed, 'utf8')).resolves.toBe('the changed file');
      });

      it('refuses to undo a fix of a photo that is Locked now, before any file moves (Task 11b)', async () => {
        const LOCKED = "This photo is locked, so this fix can't be undone.";
        // a restore, whose Undo would move the restored file aside and put the changed one back
        const original = join(root, 'library', 'IMG_5520.jpg');
        const changed = join(care, 'asset-1-0badc0de.damaged.jpg');
        await mkdir(join(root, 'library'), { recursive: true });
        await writeFile(original, 'the original, from Cloud Backup');
        await writeFile(changed, 'the changed file');
        photo({
          originalPath: original,
          checksum: sha1('the original, from Cloud Backup'),
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          isLocked: true,
        });
        shows(problem({ originalPath: original, evidence: { fixState: 'restored' } }));
        history(
          step('step-1', 'restored', 'ok', {
            undo: {
              kind: 'restore',
              previousPath: original,
              originalPath: original,
              checksum: sha1('the original, from Cloud Backup').toString('hex'),
              retainedPath: changed,
            },
          }),
        );
        vi.mocked(mediaHealthRepository.undoFix).mockImplementation(async (input) => {
          await input.moveFiles?.();
          return 'undone';
        });

        // the owner sees it in an unlocked session, and still can't undo it
        await refused(sut.undoFileProblemFix(elevatedOwner, 'health-1'), LOCKED);

        await expect(readFile(original, 'utf8')).resolves.toBe('the original, from Cloud Backup');
        await expect(readFile(changed, 'utf8')).resolves.toBe('the changed file');
        await expect(stat(join(care, 'asset-1-health-1.restored.jpg'))).rejects.toThrow();
        expect(mediaHealthRepository.undoFix).not.toHaveBeenCalled();
        expect(mocks.crypto.hashFileMatching).not.toHaveBeenCalled();
        expect(mocks.job.queueOutsideRun).not.toHaveBeenCalled();

        // a repair is refused the same way: the photo stays the repaired file
        const damaged = join(care, 'asset-1-health-1.damaged.jpg');
        const repaired = join(care, 'asset-1-health-1-0123abcd.jpg');
        await writeFile(damaged, 'the damaged file');
        await writeFile(repaired, 'the repaired file');
        photo({ originalPath: repaired, checksum: sha256('the repaired file'), isLocked: true });
        shows(problem({ originalPath: repaired, evidence: { fixState: 'repaired', retainedPath: damaged } }));
        history(
          step('step-1', 'repaired', 'ok'),
          step('step-2', 'kept-damaged', 'info', {
            undo: {
              kind: 'repair',
              previousPath: damaged,
              originalPath: repaired,
              checksum: sha256('the repaired file').toString('hex'),
            },
          }),
        );
        await refused(sut.undoFileProblemFix(elevatedOwner, 'health-1'), LOCKED);
        expect(mediaHealthRepository.undoFix).not.toHaveBeenCalled();
      });

      it('refuses to undo a fix of a photo put in Locked while the undo waited for it (Task 11b)', async () => {
        const damaged = join(care, 'asset-1-health-1.damaged.jpg');
        const repaired = join(care, 'asset-1-health-1-0123abcd.jpg');
        await writeFile(damaged, 'the damaged file');
        await writeFile(repaired, 'the repaired file');
        photo({ originalPath: repaired, checksum: sha256('the repaired file') });
        shows(problem({ originalPath: repaired, evidence: { fixState: 'repaired', retainedPath: damaged } }));
        history(
          step('step-1', 'repaired', 'ok'),
          step('step-2', 'kept-damaged', 'info', {
            undo: {
              kind: 'repair',
              previousPath: damaged,
              originalPath: repaired,
              checksum: sha256('the repaired file').toString('hex'),
            },
          }),
        );
        // the repository holds the photo and finds it Locked now
        vi.mocked(mediaHealthRepository.undoFix).mockResolvedValue('locked');

        await refused(sut.undoFileProblemFix(owner, 'health-1'), "This photo is locked, so this fix can't be undone.");
        expect(mocks.job.queueAll).not.toHaveBeenCalled();
        expect(mocks.job.queueOutsideRun).not.toHaveBeenCalled();
      });

      it('refuses to undo a restore while the drive that keeps the copies is not there', async () => {
        const original = join(root, 'library', 'IMG_5520.jpg');
        await mkdir(join(root, 'library'), { recursive: true });
        await writeFile(original, 'the original, from Cloud Backup');
        photo({ originalPath: original, checksum: sha256('the original, from Cloud Backup') });
        shows(problem({ originalPath: original, evidence: { fixState: 'restored' } }));
        history(
          step('step-1', 'restored', 'ok', {
            undo: {
              kind: 'restore',
              previousPath: original,
              originalPath: original,
              checksum: sha256('the original, from Cloud Backup').toString('hex'),
            },
          }),
        );
        // the uploads drive has no mount file: it is not there
        const uploads = join(root, 'upload');
        const baseFolder = StorageCore.getBaseFolder.bind(StorageCore);
        const base = vi
          .spyOn(StorageCore, 'getBaseFolder')
          .mockImplementation((folder) => (folder === StorageFolder.Upload ? uploads : baseFolder(folder)));
        onTestFinished(() => base.mockRestore());

        await refused(
          sut.undoFileProblemFix(owner, 'health-1'),
          "Frameleaf can't reach the drive that keeps its copies right now. Try again later.",
        );
        await expect(readFile(original, 'utf8')).resolves.toBe('the original, from Cloud Backup');
        expect(mediaHealthRepository.undoFix).not.toHaveBeenCalled();
      });

      it('waits for the photo’s other open problem before it undoes a fix', async () => {
        const repaired = join(care, 'asset-1-health-1-0123abcd.jpg');
        const damaged = join(care, 'asset-1-health-1.damaged.jpg');
        await writeFile(repaired, 'the repaired file');
        await writeFile(damaged, 'the damaged file');
        photo({ originalPath: repaired, checksum: sha256('the repaired file') });
        shows(problem({ originalPath: repaired }));
        history(
          step('step-1', 'repaired', 'ok'),
          step('step-2', 'kept-damaged', 'info', {
            undo: {
              kind: 'repair',
              previousPath: damaged,
              originalPath: repaired,
              checksum: sha256('the repaired file').toString('hex'),
            },
          }),
        );
        const otherOpen = "This photo has another problem open, so this fix can't be undone yet.";
        // the same photo went missing since: that open problem is the one that counts
        vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue([
          problem(),
          problem({ id: 'health-2', category: MediaHealthCategory.Missing, resolvedAt: null }),
        ] as never);
        await expect(sut.undoFileProblemFix(owner, 'health-1')).rejects.toMatchObject({
          message: otherOpen,
          status: 409,
        });
        expect(mediaHealthRepository.undoFix).not.toHaveBeenCalled();

        // one opened meanwhile: the repository finds it under its lock
        vi.mocked(mediaHealthRepository.getFindingsForAsset).mockResolvedValue([problem()] as never);
        vi.mocked(mediaHealthRepository.undoFix).mockResolvedValue('open');
        await expect(sut.undoFileProblemFix(owner, 'health-1')).rejects.toMatchObject({
          message: otherOpen,
          status: 409,
        });
        expect(mocks.job.queueOutsideRun).not.toHaveBeenCalled();
      });

      it('has nothing to undo on a problem that is not fixed', async () => {
        shows(problem({ status: MediaHealthStatus.Missing, resolvedAt: null, evidence: { fixState: 'missing' } }));

        await expect(sut.undoFileProblemFix(owner, 'health-1')).rejects.toThrow(
          'There is nothing to undo for this photo.',
        );
        expect(mediaHealthRepository.undoFix).not.toHaveBeenCalled();
      });

      it('lets only the photo’s owner undo it', async () => {
        shows(problem({ ownerId: 'user-2', ownerName: 'Emma' }));

        await expect(sut.undoFileProblemFix(admin, 'health-1')).rejects.toThrow("Only the photo's owner can do that");
        expect(mediaHealthRepository.undoFix).not.toHaveBeenCalled();
      });
    });

    describe('the damaged file a repair kept (Task 11b)', () => {
      const NO_FILE = "Frameleaf didn't keep a damaged file for this photo.";
      let damaged: string;
      let repaired: string;
      const keptDamaged = (previousPath: string) =>
        step('step-3', 'kept-damaged', 'info', {
          undo: {
            kind: 'repair',
            previousPath,
            originalPath: repaired,
            checksum: sha256('the repaired file').toString('hex'),
          },
        });

      beforeEach(async () => {
        damaged = join(care, 'asset-1-health-1.damaged.jpg');
        repaired = join(care, 'asset-1-health-1-0123abcd.jpg');
        await writeFile(damaged, 'the damaged file');
        await writeFile(repaired, 'the repaired file');
        photo({ originalPath: repaired, checksum: sha256('the repaired file') });
        shows(problem({ originalPath: repaired, evidence: { fixState: 'part-saved', retainedPath: damaged } }));
        history(step('step-1', 'wont-open', 'failed'), step('step-2', 'repaired', 'ok'), keptDamaged(damaged));
      });

      it('gives the owner the damaged file their repair kept in Library care', async () => {
        await expect(sut.getFileProblemKeptFile(owner, 'health-1')).resolves.toEqual({
          // the file itself, as the folder check resolved it
          path: await realpath(damaged),
          // named so it is never taken for the repaired photo
          fileName: 'IMG_2041 (damaged).jpg',
          contentType: 'image/jpeg',
          // the route keeps it out of every cache (private, no-store), as a sealed file is
          cacheControl: CacheControl.None,
        });
        // reading it changes nothing
        await expect(readFile(damaged, 'utf8')).resolves.toBe('the damaged file');
        expect(mediaHealthRepository.getFileProblem).toHaveBeenCalledWith('health-1', owner.user.id, expect.anything());
      });

      it('names a photo without an extension after the kept file’s own', async () => {
        shows(
          problem({
            originalPath: repaired,
            originalFileName: 'Scan 12',
            evidence: { fixState: 'part-saved', retainedPath: damaged },
          }),
        );
        await expect(sut.getFileProblemKeptFile(owner, 'health-1')).resolves.toMatchObject({
          fileName: 'Scan 12 (damaged).jpg',
        });
      });

      it('also for a repair that stopped before it recorded its kept-damaged step', async () => {
        history(step('step-1', 'wont-open', 'failed'), step('step-2', 'repaired', 'ok'));
        await expect(sut.getFileProblemKeptFile(owner, 'health-1')).resolves.toMatchObject({
          path: await realpath(damaged),
        });
      });

      it('is only for the owner', async () => {
        // an administrator sees the problem, but the file is the owner's
        shows(problem({ ownerId: 'someone-else', ownerName: 'Emma' }));
        await expect(sut.getFileProblemKeptFile(admin, 'health-1')).rejects.toMatchObject({
          status: 403,
          message: "Only the photo's owner can do that.",
        });
        // another member never sees the problem at all
        shows(undefined as never);
        const member = { user: { ...owner.user, id: 'user-2', name: 'Emma' } } as never;
        await expect(sut.getFileProblemKeptFile(member, 'health-1')).rejects.toMatchObject({ status: 404 });
      });

      it('is refused for a photo that is Locked now, even in its owner’s unlocked session', async () => {
        photo({ originalPath: repaired, checksum: sha256('the repaired file'), isLocked: true });
        await expect(sut.getFileProblemKeptFile(elevatedOwner, 'health-1')).rejects.toMatchObject({
          status: 409,
          message: "This photo is locked, so the damaged file Frameleaf kept can't be downloaded.",
        });
      });

      it('is refused, and Undo too, while the kept file is still sealed for Locked (FL-1364)', async () => {
        // the photo left Locked while the kept file's drive was away, so it was never opened again
        await writeFile(damaged, Buffer.concat([Buffer.from('FLLK', 'latin1'), Buffer.alloc(64, 1)]));
        await expect(sut.getFileProblemKeptFile(owner, 'health-1')).rejects.toMatchObject({
          status: 409,
          message: "The damaged file Frameleaf kept can't be opened yet. Frameleaf will try again; try later.",
        });
        await expect(sut.undoFileProblemFix(owner, 'health-1')).rejects.toMatchObject({
          status: 409,
          message:
            "A file Frameleaf kept for this photo can't be opened yet, so this fix can't be undone now. Frameleaf will try again; try later.",
        });
        expect(mediaHealthRepository.undoFix).not.toHaveBeenCalled();
        // the owner's Locked sweep opens it as soon as their key is loaded
        expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LockedSweep, data: { userId: owner.user.id } });
      });

      it('refuses an Undo whose kept file is there but can’t be read: it may be sealed (FL-1364)', async () => {
        await rm(damaged);
        await mkdir(damaged);

        await expect(sut.undoFileProblemFix(owner, 'health-1')).rejects.toMatchObject({
          status: 409,
          message:
            "A file Frameleaf kept for this photo can't be opened yet, so this fix can't be undone now. Frameleaf will try again; try later.",
        });
        expect(mediaHealthRepository.undoFix).not.toHaveBeenCalled();
      });

      it('refuses an Undo whose kept file was sealed after the check, found under its path lock (FL-1364)', async () => {
        const crypto = new CryptoRepository();
        vi.mocked(mocks.crypto.hashFileDigests).mockImplementation((file) => crypto.hashFileDigests(file));
        vi.mocked(mediaHealthRepository.undoFix).mockResolvedValue('sealed');

        await expect(sut.undoFileProblemFix(owner, 'health-1')).rejects.toMatchObject({
          status: 409,
          message:
            "A file Frameleaf kept for this photo can't be opened yet, so this fix can't be undone now. Frameleaf will try again; try later.",
        });
        // the repository holds and re-reads the kept file itself
        expect(mediaHealthRepository.undoFix).toHaveBeenCalledWith(expect.objectContaining({ keptPaths: [damaged] }));
        expect(mocks.job.queueOutsideRun).not.toHaveBeenCalled();
      });

      it.each([
        [
          'the latest fix is not a repair',
          () =>
            history(
              step('step-1', 'not-on-drive', 'failed'),
              step('step-2', 'put-back', 'ok', {
                undo: { kind: 'relink', previousPath: damaged, originalPath: repaired },
              }),
            ),
        ],
        [
          'the repair was undone',
          () => history(step('step-2', 'repaired', 'ok'), keptDamaged(damaged), step('step-4', 'undone', 'info')),
        ],
        ['no fix was made', () => history(step('step-1', 'wont-open', 'failed'))],
        ['the kept file is gone', async () => rm(damaged)],
        [
          'the kept file is not in the photo’s Library care folder',
          async () => {
            const elsewhere = join(root, 'library', 'IMG_2041.jpg');
            await mkdir(join(root, 'library'), { recursive: true });
            await writeFile(elsewhere, 'some other file');
            history(step('step-2', 'repaired', 'ok'), keptDamaged(elsewhere));
          },
        ],
        [
          'the kept file is a link out of Library care',
          async () => {
            const outside = join(root, 'outside.jpg');
            await writeFile(outside, 'not the damaged file');
            await rm(damaged);
            await symlink(outside, damaged);
          },
        ],
      ])('has nothing to give when %s', async (_, arrange) => {
        await arrange();
        await expect(sut.getFileProblemKeptFile(owner, 'health-1')).rejects.toMatchObject({
          status: 404,
          message: NO_FILE,
        });
      });
    });

    describe('keep, try again and look in a folder', () => {
      const needsYou = (overrides: Record<string, unknown> = {}) =>
        problem({
          category: MediaHealthCategory.Missing,
          status: MediaHealthStatus.Missing,
          resolvedAt: null,
          evidence: { fixState: 'missing' },
          ...overrides,
        });

      it('keeps a problem that needs the person as it is', async () => {
        shows(needsYou(), needsYou({ evidence: { fixState: 'left-as-is' } }));

        await expect(sut.keepFileProblem(owner, 'health-1')).resolves.toMatchObject({ fixState: 'left-as-is' });

        expect(mediaHealthRepository.settleFinding).toHaveBeenCalledWith({
          healthId: 'health-1',
          // the time of the choice: a fix that put itself back before it leaves the photo as it is
          evidence: { fixState: 'left-as-is', keptAt: expect.any(String) },
          steps: [{ step: 'kept-as-is', outcome: 'info' }],
        });
      });

      it('keeps only a problem that needs the person, and only for its owner', async () => {
        shows(problem());
        await expect(sut.keepFileProblem(owner, 'health-1')).rejects.toThrow(
          'Only a photo that still needs you can be kept as it is.',
        );
        shows(needsYou({ ownerId: 'user-2', ownerName: 'Emma' }));
        await expect(sut.keepFileProblem(admin, 'health-1')).rejects.toThrow("Only the photo's owner can do that");
        expect(mediaHealthRepository.settleFinding).not.toHaveBeenCalled();
      });

      it('tries again from the start, keeping a declined repair declined', async () => {
        shows(needsYou({ evidence: { fixState: 'cant-repair', autoRepairDeclined: true } }));

        await sut.tryFileProblemAgain(owner, 'health-1');

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.MediaHealthFixAsset,
          data: { id: 'asset-1', from: 'person', attempt: 0, retry: expect.any(String) },
        });
        // only the time of the choice is recorded; the decline and the fix state stay as they are
        expect(mediaHealthRepository.settleFinding).toHaveBeenCalledWith({
          healthId: 'health-1',
          evidence: { retriedAt: expect.any(String) },
        });
        expect(mediaHealthRepository.undoFix).not.toHaveBeenCalled();
      });

      it('queues its own fix, then supersedes the fixes of the photo that wait (FL-1337)', async () => {
        shows(needsYou());

        await sut.tryFileProblemAgain(owner, 'health-1');

        const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0];
        expect(mocks.job.cancelWaitingFixes).toHaveBeenCalledWith('asset-1');
        // the choice first, then its own fix, and only then are the waiting ones cancelled
        expect(order(vi.mocked(mediaHealthRepository.settleFinding))).toBeLessThan(order(vi.mocked(mocks.job.queue)));
        expect(order(vi.mocked(mocks.job.queue))).toBeLessThan(order(vi.mocked(mocks.job.cancelWaitingFixes)));
      });

      it('leaves the waiting fixes as they are when its own fix cannot be queued (FL-1337)', async () => {
        shows(needsYou());
        vi.mocked(mocks.job.queue).mockRejectedValueOnce(new Error('queue unavailable'));

        await expect(sut.tryFileProblemAgain(owner, 'health-1')).rejects.toThrow('queue unavailable');

        expect(mocks.job.cancelWaitingFixes).not.toHaveBeenCalled();
      });

      it('changes nothing when the problem was closed meanwhile (FL-1337)', async () => {
        shows(needsYou());
        vi.mocked(mediaHealthRepository.settleFinding).mockResolvedValueOnce(false);

        await expect(sut.tryFileProblemAgain(owner, 'health-1')).rejects.toThrow('This photo changed meanwhile');

        expect(mocks.job.queue).not.toHaveBeenCalled();
        expect(mocks.job.cancelWaitingFixes).not.toHaveBeenCalled();
      });

      it('records nothing on a problem already resolved, and still tries again (FL-1337)', async () => {
        shows(needsYou({ resolvedAt: new Date(), evidence: { fixState: 'repaired' } }));

        await sut.tryFileProblemAgain(owner, 'health-1');

        expect(mediaHealthRepository.settleFinding).not.toHaveBeenCalled();
        expect(mocks.job.queue).toHaveBeenCalled();
      });

      it('lets an administrator try another account’s file again, and nothing else', async () => {
        shows(needsYou({ ownerId: 'user-2', ownerName: 'Emma' }));

        await expect(sut.tryFileProblemAgain(admin, 'health-1')).resolves.toMatchObject({ canAct: false });
        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.MediaHealthFixAsset,
          data: { id: 'asset-1', from: 'person', attempt: 0, retry: expect.any(String) },
        });
        await expect(sut.lookInFolderForFileProblem(admin, 'health-1', { folderId: MANAGED_ROOT_ID })).rejects.toThrow(
          "Only the photo's owner can do that",
        );
        expect(mediaOperationRepository.create).not.toHaveBeenCalled();
      });

      it('a member can only look in their own folders', async () => {
        vi.mocked(mocks.library.getAll).mockResolvedValue([
          { id: 'library-1', ownerId: owner.user.id, name: 'Holiday drive', importPaths: ['/mnt/holiday'] },
          { id: 'library-2', ownerId: 'user-2', name: 'Emma’s drive', importPaths: ['/mnt/emma'] },
        ] as never);
        recoveryRoots.push({ label: 'Old NAS', path: '/mnt/old-nas' });
        shows(needsYou());
        const finding = needsYou();
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([finding] as never);
        photo({ originalPath: '/data/upload/user-id/IMG_3310.jpg', checksum: sha1('the photo') });
        vi.mocked(mediaHealthRepository.createRun).mockResolvedValue({ id: 'run-1' } as never);

        for (const folderId of [libraryRootId('library-2'), recoveryRootId('/mnt/old-nas'), 'somewhere-else']) {
          await expect(sut.lookInFolderForFileProblem(owner, 'health-1', { folderId })).rejects.toThrow(
            "That folder isn't one you can search.",
          );
        }
        expect(mediaOperationRepository.create).not.toHaveBeenCalled();

        await sut.lookInFolderForFileProblem(owner, 'health-1', { folderId: MANAGED_ROOT_ID });

        // a one-off search of that folder, as a search Activity shows, which records what it found
        expect(mediaOperationRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            ownerId: owner.user.id,
            kind: MediaOperationKind.MediaHealth,
            snapshot: expect.objectContaining({
              mode: 'locate',
              userId: owner.user.id,
              findingIds: ['health-1'],
              rootIds: [MANAGED_ROOT_ID],
              anyOwner: false,
              lookIn: { folder: 'Library storage' },
            }),
          }),
        );
      });

      it('looks only in a folder the search walks for this photo', async () => {
        const refusedHere = "Frameleaf can't look for this photo in that folder.";
        vi.mocked(mocks.library.getAll).mockResolvedValue([
          { id: 'library-1', ownerId: owner.user.id, name: 'Holiday drive', importPaths: ['/mnt/holiday'] },
          { id: 'library-3', ownerId: owner.user.id, name: 'Camera card', importPaths: ['/mnt/card'] },
        ] as never);
        shows(needsYou());
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([needsYou()] as never);
        vi.mocked(mediaHealthRepository.createRun).mockResolvedValue({ id: 'run-1' } as never);

        // a stored photo is never searched for in an external library
        photo({ originalPath: '/data/upload/user-id/IMG_3310.jpg', checksum: sha1('the photo') });
        await expect(
          sut.lookInFolderForFileProblem(owner, 'health-1', { folderId: libraryRootId('library-1') }),
        ).rejects.toThrow(refusedHere);

        // an external photo only in its own library
        photo({
          originalPath: '/mnt/holiday/IMG_3310.jpg',
          isExternal: true,
          libraryId: 'library-1',
          checksum: sha1('x'),
        });
        for (const folderId of [MANAGED_ROOT_ID, libraryRootId('library-3')]) {
          const error = await sut.lookInFolderForFileProblem(owner, 'health-1', { folderId }).catch((error_) => error_);
          expect(error).toMatchObject({ message: refusedHere, status: 400 });
        }
        expect(mediaOperationRepository.create).not.toHaveBeenCalled();

        await sut.lookInFolderForFileProblem(owner, 'health-1', { folderId: libraryRootId('library-1') });
        expect(mediaOperationRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            snapshot: expect.objectContaining({
              rootIds: [libraryRootId('library-1')],
              lookIn: { folder: 'Holiday drive' },
            }),
          }),
        );

        // a changed external photo: the search never looks behind it, so the button would do nothing, ever
        vi.mocked(mediaOperationRepository.create).mockClear();
        shows(needsYou({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.CorruptConfirmed }));
        const error = await sut
          .lookInFolderForFileProblem(owner, 'health-1', { folderId: libraryRootId('library-1') })
          .catch((error_) => error_);
        expect(error).toMatchObject({
          message: "Frameleaf can only look for an external library's photo when it is missing.",
          status: 400,
        });
        expect(mediaOperationRepository.create).not.toHaveBeenCalled();
      });

      it('keeps what earlier searches found in other folders when it looks in one', async () => {
        recoveryRoots.push({ label: 'Old NAS', path: '/mnt/old-nas' });
        vi.mocked(mocks.user.getList).mockResolvedValue([{ id: 'user-id', storageLabel: null }] as never);
        const managed = StorageCore.getFolderLocation(StorageFolder.Upload, 'user-id');
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([needsYou()] as never);
        photo({ originalPath: join(managed, 'IMG_3310.jpg'), checksum: sha1('the photo') });
        // earlier: a copy in a recovery folder, and one in library storage that is gone now
        const earlier = (candidatePath: string, rootId: string) => ({
          id: `candidate-${rootId}`,
          healthId: 'health-1',
          candidatePath,
          status: MediaHealthStatus.Found,
          visualMatchScore: 1,
          evidence: { path: candidatePath, rootId },
          resolution: { autoRelinkable: true },
          checkedAt: at('2026-11-01T00:00:00Z'),
        });
        const elsewhere = earlier('/mnt/old-nas/IMG_3310.jpg', recoveryRootId('/mnt/old-nas'));
        vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
          elsewhere,
          earlier(join(managed, 'gone.jpg'), MANAGED_ROOT_ID),
        ] as never);
        const fresh = join(managed, 'IMG_3310+1.jpg');
        vi.spyOn(sut as any, 'locateManagedCandidates').mockResolvedValue({
          candidates: new Map([
            [
              'asset-1',
              [
                {
                  status: MediaHealthStatus.Found,
                  score: 1,
                  evidence: { path: fresh },
                  resolution: { autoRelinkable: true },
                },
              ],
            ],
          ]),
          continuation: undefined,
        });
        const snapshot = {
          mode: 'locate' as const,
          userId: owner.user.id,
          runId: 'run-1',
          findingIds: ['health-1'],
          rootIds: [MANAGED_ROOT_ID],
          anyOwner: false,
        };

        const step = await sut.locateStep({ ...snapshot, lookIn: { folder: 'Library storage' } }, null);

        expect(step.checkedIds).toEqual(['health-1']);
        const [, written] = vi.mocked(mediaHealthRepository.replaceCandidates).mock.calls[0];
        expect(written.map(({ candidatePath }) => candidatePath)).toEqual(['/mnt/old-nas/IMG_3310.jpg', fresh]);
        expect(written[0]).toMatchObject({ status: MediaHealthStatus.Found, evidence: elsewhere.evidence });
        // two copies now: the person chooses, nothing is relinked by itself
        expect(mediaHealthRepository.recordSearchResult).toHaveBeenCalledWith(
          expect.objectContaining({
            found: expect.objectContaining({ status: MediaHealthStatus.Found }),
            resolution: expect.objectContaining({ autoRelinkable: false }),
            evidence: expect.objectContaining({ candidateCount: 2, validatedCandidateCount: 2 }),
          }),
        );

        // any other search replaces the whole list, as before
        vi.mocked(mediaHealthRepository.replaceCandidates).mockClear();
        await sut.locateStep(snapshot, null);
        expect(vi.mocked(mediaHealthRepository.replaceCandidates).mock.calls[0][1]).toHaveLength(1);
      });

      it('also walks the folders an import read from, while they are mounted', async () => {
        vi.mocked(mocks.user.getList).mockResolvedValue([{ id: 'user-id', storageLabel: null }] as never);
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([needsYou()] as never);
        photo({
          originalPath: join(StorageCore.getFolderLocation(StorageFolder.Upload, 'user-id'), 'IMG_3310.jpg'),
          checksum: sha1('the photo'),
        });
        vi.mocked(mocks.systemMetadata.get).mockImplementation(((key: SystemMetadataKey) =>
          Promise.resolve(
            key === SystemMetadataKey.FileFixSourceRoots ? ['/mnt/immich/library', '/mnt/unplugged'] : undefined,
          )) as never);
        vi.mocked(mocks.storage.stat).mockImplementation(((path: string) =>
          path === '/mnt/unplugged'
            ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
            : Promise.resolve(settledStat({ size: 10 }))) as never);
        const walk = vi
          .spyOn(sut as any, 'locateManagedCandidates')
          .mockResolvedValue({ candidates: new Map(), continuation: undefined });

        await sut.locateStep(
          {
            mode: 'locate' as const,
            userId: owner.user.id,
            runId: 'run-1',
            findingIds: ['health-1'],
            rootIds: [MANAGED_ROOT_ID],
            anyOwner: false,
          },
          null,
        );

        const starts = walk.mock.calls[0][2] as string[];
        expect(starts).toContain('/mnt/immich/library');
        expect(starts).not.toContain('/mnt/unplugged');
      });

      it('looks only for a photo that is still missing or changed', async () => {
        shows(problem());
        await expect(sut.lookInFolderForFileProblem(owner, 'health-1', { folderId: MANAGED_ROOT_ID })).rejects.toThrow(
          'Frameleaf only looks for a photo that still needs you.',
        );
        shows(needsYou({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.CorruptSuspect }));
        await expect(sut.lookInFolderForFileProblem(owner, 'health-1', { folderId: MANAGED_ROOT_ID })).rejects.toThrow(
          'Frameleaf can only look for an exact copy of a missing photo, or of one that changed.',
        );
        expect(mediaOperationRepository.create).not.toHaveBeenCalled();
      });

      it('puts back the one exact copy the search of a folder found, saying where it looked', async () => {
        const copy = join(root, 'library', 'IMG_3310+1.jpg');
        await mkdir(join(root, 'library'), { recursive: true });
        await writeFile(copy, 'the photo');
        const lost = join(root, 'library', 'IMG_3310.jpg');
        photo({ originalPath: lost, checksum: sha1('the photo'), checksumAlgorithm: ChecksumAlgorithm.sha1File });
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
          { ...needsYou({ status: MediaHealthStatus.Found }), originalPath: lost },
        ] as never);
        vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
          {
            id: 'candidate-1',
            healthId: 'health-1',
            candidatePath: copy,
            status: MediaHealthStatus.Found,
            evidence: { rootId: MANAGED_ROOT_ID, decodeValid: true },
            resolution: { autoRelinkable: true },
          },
        ] as never);
        vi.mocked(mediaHealthRepository.relinkManagedAsset).mockResolvedValue(true);

        await sut.finishLookIn(
          {
            mode: 'locate',
            userId: owner.user.id,
            runId: 'run-1',
            findingIds: ['health-1'],
            rootIds: [MANAGED_ROOT_ID],
            anyOwner: false,
            lookIn: { folder: 'Library storage' },
          },
          ['health-1'],
        );

        expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['health-1'], owner.user.id);
        expect(vi.mocked(mediaHealthRepository.relinkManagedAsset).mock.calls[0][0]).toMatchObject({
          originalPath: copy,
          evidence: { fixState: 'found-again' },
          steps: [
            { step: 'searched-copy', outcome: 'ok', facts: { folder: 'Library storage', copies: 1 } },
            { step: 'put-back', outcome: 'ok', undo: { kind: 'relink', previousPath: lost } },
          ],
        });
      });

      it('says when the folder held no copy', async () => {
        photo({ originalPath: '/data/upload/user-id/IMG_3310.jpg', checksum: sha1('the photo') });
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([needsYou()] as never);
        vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([]);

        await sut.finishLookIn(
          {
            mode: 'locate',
            userId: owner.user.id,
            runId: 'run-1',
            findingIds: ['health-1'],
            rootIds: [libraryRootId('library-1')],
            anyOwner: false,
            lookIn: { folder: 'Holiday drive' },
          },
          ['health-1'],
        );

        expect(mediaHealthRepository.appendSteps).toHaveBeenCalledWith([
          {
            healthId: 'health-1',
            assetId: 'asset-1',
            step: 'searched-copy',
            outcome: 'not-found',
            facts: { folder: 'Holiday drive' },
          },
        ]);
        expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
      });

      it('says nothing for a problem its search did not check', async () => {
        photo({ originalPath: '/data/upload/user-id/IMG_3310.jpg', checksum: sha1('the photo') });
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([needsYou()] as never);

        await sut.finishLookIn(
          {
            mode: 'locate',
            userId: owner.user.id,
            runId: 'run-1',
            findingIds: ['health-1'],
            rootIds: [MANAGED_ROOT_ID],
            anyOwner: false,
            lookIn: { folder: 'Library storage' },
          },
          [],
        );

        expect(mediaHealthRepository.appendSteps).not.toHaveBeenCalled();
        expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
      });

      it('counts and puts back only the copies in the folder it looked in', async () => {
        const copy = join(root, 'library', 'IMG_3310+1.jpg');
        await mkdir(join(root, 'library'), { recursive: true });
        await writeFile(copy, 'the photo');
        photo({ originalPath: join(root, 'library', 'IMG_3310.jpg'), checksum: sha1('the photo') });
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
          needsYou({ status: MediaHealthStatus.Found }),
        ] as never);
        // the one copy Frameleaf could use by itself is in library storage, found by an earlier search
        vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
          {
            id: 'candidate-1',
            healthId: 'health-1',
            candidatePath: copy,
            status: MediaHealthStatus.Found,
            evidence: { rootId: MANAGED_ROOT_ID, decodeValid: true },
            resolution: { autoRelinkable: true },
          },
        ] as never);

        await sut.finishLookIn(
          {
            mode: 'locate',
            userId: owner.user.id,
            runId: 'run-1',
            findingIds: ['health-1'],
            rootIds: [libraryRootId('library-1')],
            anyOwner: false,
            lookIn: { folder: 'Holiday drive' },
          },
          ['health-1'],
        );

        expect(mediaHealthRepository.appendSteps).toHaveBeenCalledWith([
          expect.objectContaining({ step: 'searched-copy', outcome: 'not-found', facts: { folder: 'Holiday drive' } }),
        ]);
        expect(mediaHealthRepository.relinkManagedAsset).not.toHaveBeenCalled();
      });
    });

    it('records that a photo was removed when it goes to the trash', async () => {
      await sut.onAssetTrashAll({ assetIds: ['asset-1', 'asset-2'], userId: owner.user.id });

      expect(mediaHealthRepository.recordRemoved).toHaveBeenCalledWith(['asset-1', 'asset-2'], {
        by: owner.user.name,
      });
    });
  });
});

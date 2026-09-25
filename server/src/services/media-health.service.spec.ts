import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import { CORRUPT_MEDIA_DELETE_CONFIRM_TEXT } from 'src/dtos/media-health.dto.js';
import {
  AssetType,
  AssetVisibility,
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
} from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { MANAGED_ROOT_ID, recoveryRootId } from 'src/utils/media-health-roots.js';
import { classifyImageDecodeFailure } from 'src/utils/media-health.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

/** A non-administrator in an unlocked (PIN-elevated) session. */
const elevatedOwner = { ...authStub.user1, session: { id: 'token-id-elevated', hasElevatedPermission: true } } as never;

describe(MediaHealthService.name, () => {
  let sut: MediaHealthService;
  let mocks: ServiceMocks;
  let mediaHealthRepository: MediaHealthRepository;
  let mediaOperationRepository: MediaOperationRepository;
  let mediaOperationService: MediaOperationService;
  let recoveryRoots: Array<{ label: string; path: string }>;

  beforeEach(() => {
    mocks = getMocks();
    recoveryRoots = [];
    mediaHealthRepository = {
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
    );
    clearConfigCache();
    vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([]);
    vi.mocked(mediaHealthRepository.count).mockResolvedValue(0);
    vi.mocked(mocks.user.getList).mockResolvedValue([]);
    vi.mocked(mocks.library.getAll).mockResolvedValue([]);
    vi.mocked(mocks.storage.stat).mockResolvedValue({ size: 10, mtime: new Date() } as never);
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
        expect.objectContaining({ ownerId: undefined, privacy: { lockedOwnerId: authStub.admin.user.id } }),
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

      const privacy = { lockedOwnerId: authStub.user1.user.id };
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
      const privacy = { lockedOwnerId: authStub.user1.user.id };
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
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SidecarCheck, data: { id: 'asset-1', source: 'upload' } },
        { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
      ]);
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
      vi.mocked(mocks.storage.stat).mockResolvedValue({ mtime: new Date('2026-09-04T00:00:00Z') } as never);
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
        }),
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
          originalPath: '/library/missing.jpg',
          originalFileName: 'missing.jpg',
          type: AssetType.Image,
          isExternal: true,
          libraryId: 'library-1',
        },
        {
          id: 'corrupt-asset',
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
        expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
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
        expect(mediaHealthRepository.upsertFinding).toHaveBeenLastCalledWith(
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
      expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith(
        expect.objectContaining({
          status: MediaHealthStatus.Found,
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
      expect(mediaHealthRepository.upsertFinding).toHaveBeenCalledWith({
        runId: 'run-1',
        assetId: 'asset-1',
        category: MediaHealthCategory.Missing,
        status: MediaHealthStatus.Found,
        severity: MediaHealthSeverity.Warning,
        originalPath: '/library/missing.jpg',
        originalFileName: 'missing.jpg',
        evidence: {
          reason: 'source_file_missing_or_unreadable',
          candidateCount: 1,
          validatedCandidateCount: 1,
          searchTruncated: false,
        },
        resolution: { autoRelinkable: true },
        checkedAt: expect.any(Date),
      });
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

    it('schedules the health scan on the server that holds the lock, as the settings say', async () => {
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
        start: true,
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
        // Last full scan eight days ago: full, whatever the incremental ones since.
        stale: [
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

    it('keeps a scan an account already has instead of starting a second one', async () => {
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
                      snapshot: { mode: 'scan', userId: 'user-a', missingRunId: 'm', corruptRunId: 'c' },
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
});

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
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
} from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { classifyImageDecodeFailure } from 'src/utils/media-health.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

describe(MediaHealthService.name, () => {
  let sut: MediaHealthService;
  let mocks: ServiceMocks;
  let mediaHealthRepository: MediaHealthRepository;

  beforeEach(() => {
    mocks = getMocks();
    mediaHealthRepository = {
      createRun: vi.fn(),
      finishRun: vi.fn(),
      getByIds: vi.fn(),
      getAssets: vi.fn(),
      getAssetChecksums: vi.fn(),
      getCandidatesByHealthIds: vi.fn(),
      getLatestRun: vi.fn(),
      getInternalAssetByOriginalPath: vi.fn(),
      getTrackedPaths: vi.fn(),
      list: vi.fn(),
      count: vi.fn(),
      markStatus: vi.fn(),
      markDismissed: vi.fn(),
      markResolved: vi.fn(),
      markResolvedCategories: vi.fn(),
      markResolvedForAssets: vi.fn(),
      trashCorruptIfUnchanged: vi.fn().mockResolvedValue(true),
      replaceCandidates: vi.fn(),
      relinkManagedAsset: vi.fn(),
      relinkExternalAsset: vi.fn(),
      streamAssets: vi.fn(),
      upsertFinding: vi.fn(),
    } as unknown as MediaHealthRepository;

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
    );
    vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([]);
    vi.mocked(mediaHealthRepository.count).mockResolvedValue(0);
    vi.mocked(mocks.user.getList).mockResolvedValue([]);
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

  it('lists and dismisses only findings owned by the authenticated user', async () => {
    vi.mocked(mediaHealthRepository.list).mockResolvedValue([]);
    vi.mocked(mediaHealthRepository.count).mockResolvedValue(50_000);
    vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue(undefined);
    vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([]);
    vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([]);
    vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([]);

    await expect(sut.list(authStub.admin, { size: 10 })).resolves.toEqual({ buckets: [], total: 50_000, run: null });
    await sut.dismiss(authStub.admin, { ids: ['health-1'] });

    expect(mediaHealthRepository.list).toHaveBeenCalledWith({
      category: undefined,
      ownerId: authStub.admin.user.id,
      privacy: {},
      size: 10,
      status: undefined,
    });
    expect(mediaHealthRepository.count).toHaveBeenCalledWith({
      category: undefined,
      ownerId: authStub.admin.user.id,
      privacy: {},
      status: undefined,
    });
    expect(mediaHealthRepository.getLatestRun).toHaveBeenCalledWith(undefined, authStub.admin.user.id);
    expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['health-1'], authStub.admin.user.id, {});
    expect(mediaHealthRepository.markDismissed).toHaveBeenCalledWith([], authStub.admin.user.id);
  });

  it("includes the caller's Locked media only in an elevated session (FL-34)", async () => {
    const auth = authStub.adminWithElevatedPermission;
    vi.mocked(mediaHealthRepository.list).mockResolvedValue([]);
    vi.mocked(mediaHealthRepository.getLatestRun).mockResolvedValue(undefined);
    vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([]);
    vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([]);
    vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([]);

    await sut.list(auth, { size: 10 });
    await sut.dismiss(auth, { ids: ['health-1'] });

    const privacy = { lockedOwnerId: auth.user.id };
    expect(mediaHealthRepository.list).toHaveBeenCalledWith(expect.objectContaining({ privacy }));
    expect(mediaHealthRepository.count).toHaveBeenCalledWith(expect.objectContaining({ privacy }));
    expect(mediaHealthRepository.getAssets).toHaveBeenCalledWith([], auth.user.id, privacy);
    expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['health-1'], auth.user.id, privacy);
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

  it('queues candidate lookup only for the authenticated user', async () => {
    vi.mocked(mediaHealthRepository.createRun).mockResolvedValue({ id: 'run-1' } as never);
    vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([{ id: 'health-1' }] as never);

    await expect(sut.locateMissing(authStub.admin, { ids: ['health-1'] })).resolves.toEqual({ runId: 'run-1' });

    expect(mocks.job.queue).toHaveBeenCalledWith({
      name: JobName.MediaHealthLocateMissing,
      data: { runId: 'run-1', ids: ['health-1'], userId: authStub.admin.user.id },
    });
    expect(mediaHealthRepository.createRun).toHaveBeenCalledWith(
      MediaHealthCategory.Missing,
      authStub.admin.user.id,
      300_000,
    );
    expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['health-1'], authStub.admin.user.id, {});
  });

  it('does not queue hidden findings from a non-elevated privacy session', async () => {
    const auth = { ...authStub.admin, hideNsfwAssets: true };
    vi.mocked(mediaHealthRepository.createRun).mockResolvedValue({ id: 'run-1' } as never);
    vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([{ id: 'visible-health' }] as never);

    await sut.locateMissing(auth, { ids: ['visible-health', 'hidden-health'] });

    expect(mediaHealthRepository.getByIds).toHaveBeenCalledWith(['visible-health', 'hidden-health'], auth.user.id, {
      excludeNsfw: true,
    });
    expect(mocks.job.queue).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ids: ['visible-health'] }) }),
    );
  });

  it('rejects rate-limited lookup requests without queueing another job', async () => {
    vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([]);
    vi.mocked(mediaHealthRepository.createRun).mockResolvedValue(undefined as never);

    await expect(sut.locateMissing(authStub.admin, { ids: [] })).rejects.toMatchObject({ status: 429 });
    expect(mocks.job.queue).not.toHaveBeenCalled();
  });

  it('finishes a lookup run when queue submission fails', async () => {
    vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([]);
    vi.mocked(mediaHealthRepository.createRun).mockResolvedValue({ id: 'run-1' } as never);
    vi.mocked(mocks.job.queue).mockRejectedValue(new Error('queue unavailable'));

    await expect(sut.locateMissing(authStub.admin, { ids: [] })).rejects.toThrow('queue unavailable');
    expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      error: 'queue unavailable',
    });
  });

  it('redacts candidates found in another user directory', () => {
    const mapped = (
      sut as any as { mapCandidateForRoots: (candidate: unknown, roots: string[]) => unknown }
    ).mapCandidateForRoots(
      {
        id: 'candidate-1',
        healthId: 'health-1',
        candidatePath: '/data/upload/user-2/private.jpg',
        status: MediaHealthStatus.Found,
        visualMatchScore: 1,
        evidence: { path: '/data/upload/user-2/private.jpg', reason: 'checksum_match' },
        resolution: { autoRelinkable: true },
        checkedAt: new Date('2026-09-04T00:00:00Z'),
      },
      ['/data/upload/user-1', '/data/library/user-1'],
    );

    expect(mapped).toEqual(
      expect.objectContaining({
        candidatePath: 'Exact checksum match in another user directory',
        evidence: { reason: 'checksum_match' },
      }),
    );
    expect(JSON.stringify(mapped)).not.toContain('user-2');
  });

  it('keeps external-library candidate paths visible', () => {
    const candidate = {
      id: 'candidate-1',
      healthId: 'health-1',
      candidatePath: '/external/photos/found.jpg',
      status: MediaHealthStatus.Found,
      evidence: { path: '/external/photos/found.jpg' },
      checkedAt: new Date('2026-09-04T00:00:00Z'),
    };

    const mapped = (
      sut as any as {
        mapCandidateForRoots: (candidate: unknown, roots: string[] | null) => { candidatePath: string };
      }
    ).mapCandidateForRoots(candidate, null);

    expect(mapped.candidatePath).toBe(candidate.candidatePath);
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

  describe('deleteCorrupt', () => {
    it('queues a trash move after revalidating confirmed corrupt media', async () => {
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
        sut.deleteCorrupt(authStub.admin, { ids: ['health-1'], confirmText: CORRUPT_MEDIA_DELETE_CONFIRM_TEXT }),
      ).resolves.toEqual({
        results: [{ id: 'health-1', success: true, status: MediaHealthStatus.TrashQueued }],
      });

      expect(mediaHealthRepository.markStatus).toHaveBeenCalledWith(['health-1'], MediaHealthStatus.TrashQueued);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.MediaHealthDeleteCorrupt,
        data: { ids: ['health-1'], userId: authStub.admin.user.id },
      });
    });
  });

  describe('relinkMissing', () => {
    it.each([
      { type: AssetType.Image, matches: true, candidatePath: '/external/migrated/renamed', pathHash: false },
      { type: AssetType.Video, matches: true, candidatePath: '/external/migrated/renamed.dat', pathHash: false },
      { type: AssetType.Image, matches: true, candidatePath: '/external/migrated/path.jpg', pathHash: true },
      { type: AssetType.Video, matches: false, candidatePath: '/external/migrated/original.mp4' },
    ])(
      'requires a fresh hash match for external $type relinking',
      async ({ type, matches, candidatePath, pathHash }) => {
        const sha1 = Buffer.alloc(20, 1);
        const sha256 = Buffer.alloc(32, 2);
        vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([{ id: 'health-1', assetId: 'asset-1' }] as never);
        vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
          {
            id: 'asset-1',
            ownerId: authStub.admin.user.id,
            checksum: sha1,
            checksumAlgorithm: pathHash ? ChecksumAlgorithm.sha1Path : ChecksumAlgorithm.sha1File,
            originalPath: '/external/old/original.mp4',
            originalFileName: 'original.mp4',
            type,
            isExternal: true,
            libraryId: 'library-1',
            duration: 1000,
            previewPath: null,
            thumbnailPath: null,
          },
        ] as never);
        vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
          { id: 'candidate-1', healthId: 'health-1', candidatePath, status: MediaHealthStatus.Found },
        ] as never);
        vi.mocked(mocks.asset.getByLibraryIdAndOriginalPath).mockResolvedValue(undefined);
        vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({
          sha1: matches ? sha1 : Buffer.alloc(20, 9),
          sha256,
          sizeInBytes: 10,
        });
        vi.mocked(mocks.media.probe).mockResolvedValue({ format: { duration: 1 } } as never);
        vi.mocked(mediaHealthRepository.relinkExternalAsset).mockResolvedValue(true);

        const { results } = await sut.relinkMissing(authStub.admin, { ids: ['health-1'] });

        expect(results[0].success).toBe(matches && !pathHash);
        expect(mediaHealthRepository.relinkExternalAsset).toHaveBeenCalledTimes(matches && !pathHash ? 1 : 0);
      },
    );

    it('continues bulk relinking when a candidate disappears after hashing', async () => {
      const sha1 = Buffer.alloc(20, 1);
      const sha256 = Buffer.alloc(32, 2);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1' },
        { id: 'health-2', assetId: 'asset-2' },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue(
        ['asset-1', 'asset-2'].map((id) => ({
          id,
          checksum: sha1,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          type: AssetType.Image,
          isExternal: false,
        })) as never,
      );
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue(
        [1, 2].map((id) => ({
          id: `candidate-${id}`,
          healthId: `health-${id}`,
          candidatePath: `/data/upload/other/${id}.jpg`,
          status: MediaHealthStatus.Found,
        })) as never,
      );
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({ sha1, sha256, sizeInBytes: 10 });
      vi.mocked(mocks.storage.stat)
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce({ mtime: new Date() } as never);
      vi.mocked(mediaHealthRepository.relinkManagedAsset).mockResolvedValue(true);

      await expect(sut.relinkMissing(authStub.admin, { ids: ['health-1', 'health-2'] })).resolves.toMatchObject({
        results: [
          { id: 'health-1', success: false },
          { id: 'health-2', success: true },
        ],
      });
      expect(mediaHealthRepository.relinkManagedAsset).toHaveBeenCalledTimes(1);
      expect(mediaHealthRepository.relinkManagedAsset).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: 'asset-2' }),
      );
    });
    it('keeps the missing asset filename when relinking to another user file', async () => {
      const sha1 = Buffer.alloc(20, 1);
      const sha256 = Buffer.alloc(32, 2);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          ownerId: authStub.admin.user.id,
          checksum: sha1,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalPath: '/data/upload/admin_id/missing.jpg',
          originalFileName: 'missing.jpg',
          type: AssetType.Image,
          isExternal: false,
          libraryId: null,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: '/data/upload/user-2/private-name.jpg',
          status: MediaHealthStatus.Found,
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

      await sut.relinkMissing(authStub.admin, { ids: ['health-1'] });

      // The transaction callback must not acquire another database connection while holding locks.
      expect(mediaHealthRepository.getAssetChecksums).toHaveBeenCalledTimes(1);
      expect(mocks.crypto.hashFileDigests).toHaveBeenCalledTimes(2);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SidecarCheck, data: { id: 'asset-1', source: 'upload' } },
        { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
      ]);

      expect(mediaHealthRepository.relinkManagedAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: 'asset-1',
          candidateId: 'candidate-1',
          ownerId: authStub.admin.user.id,
          healthId: 'health-1',
          expectedOriginalPath: '/data/upload/admin_id/missing.jpg',
          originalPath: '/data/upload/user-2/private-name.jpg',
          originalFileName: 'missing.jpg',
        }),
      );
    });

    it('links an owned missing asset to a foreign-user exact match without deleting the source', async () => {
      const sha1 = Buffer.alloc(20, 1);
      const sha256 = Buffer.alloc(32, 2);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          ownerId: authStub.admin.user.id,
          checksum: sha1,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalPath: '/data/upload/admin_id/missing.jpg',
          originalFileName: 'missing.jpg',
          type: AssetType.Image,
          isExternal: false,
          libraryId: null,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: '/data/upload/user-2/found.jpg',
          status: MediaHealthStatus.Found,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([
        { assetId: 'asset-1', sha1, sha256, sizeInBytes: 10 },
      ]);
      vi.mocked(mediaHealthRepository.getInternalAssetByOriginalPath).mockResolvedValue({ id: 'asset-2' });
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({ sha1, sha256, sizeInBytes: 10 });
      vi.mocked(mocks.storage.stat).mockResolvedValue({ mtime: new Date('2026-09-04T00:00:00Z') } as never);
      vi.mocked(mediaHealthRepository.relinkManagedAsset).mockResolvedValue(true);
      vi.mocked(mocks.physicalFile.ensureOriginalPhysicalFile).mockResolvedValue({
        id: 'physical-1',
        path: '/data/upload/user-2/found.jpg',
      } as never);

      await expect(sut.relinkMissing(authStub.admin, { ids: ['health-1'] })).resolves.toEqual({
        results: [{ id: 'health-1', success: true, status: MediaHealthStatus.Relinked }],
      });

      expect(mediaHealthRepository.relinkManagedAsset).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: 'asset-1', sha1, sha256, sizeInBytes: 10 }),
      );
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.FileDelete }));
    });

    it('registers and links an exact foreign-user file that is not already an asset', async () => {
      const sha1 = Buffer.alloc(20, 1);
      const sha256 = Buffer.alloc(32, 2);
      vi.mocked(mediaHealthRepository.getByIds).mockResolvedValue([
        { id: 'health-1', assetId: 'asset-1', category: MediaHealthCategory.Missing },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssets).mockResolvedValue([
        {
          id: 'asset-1',
          ownerId: authStub.admin.user.id,
          checksum: sha1,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalPath: '/data/upload/admin_id/missing.jpg',
          originalFileName: 'missing.jpg',
          type: AssetType.Image,
          isExternal: false,
          libraryId: null,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getCandidatesByHealthIds).mockResolvedValue([
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: '/data/upload/user-2/untracked.jpg',
          status: MediaHealthStatus.Found,
        },
      ] as never);
      vi.mocked(mediaHealthRepository.getAssetChecksums).mockResolvedValue([]);
      vi.mocked(mediaHealthRepository.getInternalAssetByOriginalPath).mockResolvedValue(undefined);
      vi.mocked(mocks.crypto.hashFileDigests).mockResolvedValue({ sha1, sha256, sizeInBytes: 10 });
      vi.mocked(mocks.storage.stat).mockResolvedValue({ mtime: new Date('2026-09-04T00:00:00Z') } as never);
      vi.mocked(mediaHealthRepository.relinkManagedAsset).mockResolvedValue(true);

      await expect(sut.relinkMissing(authStub.admin, { ids: ['health-1'] })).resolves.toEqual({
        results: [{ id: 'health-1', success: true, status: MediaHealthStatus.Relinked }],
      });

      expect(mediaHealthRepository.relinkManagedAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: 'asset-1',
          originalPath: '/data/upload/user-2/untracked.jpg',
          sha256,
          sizeInBytes: 10,
        }),
      );
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.FileDelete }));
    });
  });

  describe('startMissingScan', () => {
    it('queues one owner-scoped combined scan for missing and corrupt media', async () => {
      vi.mocked(mediaHealthRepository.createRun)
        .mockResolvedValueOnce({ id: 'missing-run' } as never)
        .mockResolvedValueOnce({ id: 'corrupt-run' } as never);

      await expect(sut.startMissingScan(authStub.admin)).resolves.toEqual({ runId: 'missing-run' });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.MediaHealthScanMissing,
        data: {
          missingRunId: 'missing-run',
          corruptRunId: 'corrupt-run',
          force: undefined,
          userId: authStub.admin.user.id,
        },
      });
    });

    it('marks both runs failed when queueing the scan throws', async () => {
      vi.mocked(mediaHealthRepository.createRun)
        .mockResolvedValueOnce({ id: 'missing-run' } as never)
        .mockResolvedValueOnce({ id: 'corrupt-run' } as never);
      vi.mocked(mocks.job.queue).mockRejectedValueOnce(new Error('queue down'));

      await expect(sut.startMissingScan(authStub.admin)).rejects.toThrow('queue down');

      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'missing-run',
        expect.objectContaining({ status: 'failed' }),
      );
      expect(mediaHealthRepository.finishRun).toHaveBeenCalledWith(
        'corrupt-run',
        expect.objectContaining({ status: 'failed' }),
      );
    });
  });

  describe('startCorruptScan', () => {
    it('returns the corrupt run id from the queued scan', async () => {
      vi.mocked(mediaHealthRepository.createRun)
        .mockResolvedValueOnce({ id: 'missing-run' } as never)
        .mockResolvedValueOnce({ id: 'corrupt-run' } as never);

      await expect(sut.startCorruptScan(authStub.admin)).resolves.toEqual({ runId: 'corrupt-run' });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.MediaHealthScanMissing,
        data: {
          missingRunId: 'missing-run',
          corruptRunId: 'corrupt-run',
          force: undefined,
          userId: authStub.admin.user.id,
        },
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

        expect(mocks.user.getList).toHaveBeenCalledTimes(1);
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
          evidence: { path: '/library/found.jpg' },
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
});

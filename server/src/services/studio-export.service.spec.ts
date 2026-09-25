import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StorageCore } from 'src/cores/storage.core.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AssetLockReason,
  AssetType,
  JobName,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  StudioExportRemoteReason,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import {
  StudioExportPublished,
  StudioExportRefusal,
  StudioExportVersion,
  StudioExportVersionSource,
} from 'src/repositories/studio-export.repository.js';
import { StudioExportService, settleStudioExportPublication } from 'src/services/studio-export.service.js';
import { StudioAuthorizedEntry } from 'src/services/studio-resource.service.js';
import { studioExportStagingFolder } from 'src/utils/studio-export.js';
import { StudioResourceKind } from 'src/utils/studio-resources.js';

vi.mock('src/utils/config.js', () => ({
  getConfig: vi.fn().mockResolvedValue({ machineLearning: { nsfwDetection: { hideFromLibrary: true } } }),
}));

const OWNER = '0195e2a0-0000-4000-8000-00000000000a';
const PARTNER = '0195e2a0-0000-4000-8000-00000000000b';
const PROJECT = '0195e2a0-0000-7000-8000-0000000000p1'.replace('p1', '01');
const RENDER = '0195e2a0-0000-7000-8000-0000000000r1'.replace('r1', '02');
const PUBLISH = '0195e2a0-0000-7000-8000-000000000003';
const VERSION = '0195e2a0-0000-7000-8000-000000000004';
const CLIP = '0195e2a0-0000-4000-8000-000000000011';
const SHARED_CLIP = '0195e2a0-0000-4000-8000-000000000012';

const auth = (overrides: Partial<AuthDto> = {}): AuthDto =>
  ({
    user: {
      id: OWNER,
      name: 'Owner',
      email: 'o@example.com',
      isAdmin: false,
      quotaSizeInBytes: null,
      quotaUsageInBytes: 0,
    },
    session: { id: 'session-1', hasElevatedPermission: false },
    ...overrides,
  }) as AuthDto;

const elevated = () => auth({ session: { id: 'session-1', hasElevatedPermission: true } } as never);

const entry = (overrides: Partial<StudioAuthorizedEntry> = {}): StudioAuthorizedEntry => ({
  key: `library-asset:${CLIP}`,
  kind: StudioResourceKind.LibraryAsset,
  id: CLIP,
  graphPath: '$.clips[0]',
  ownerId: OWNER,
  checksum: 'c3VtLTE=',
  path: '/data/library/clip.mov',
  sourceAccess: 'owner',
  grant: 'render',
  ...overrides,
});

const sourceRow = (overrides: Partial<StudioExportVersionSource> = {}): StudioExportVersionSource => ({
  versionId: VERSION,
  key: `library-asset:${CLIP}`,
  kind: StudioResourceKind.LibraryAsset,
  resourceId: CLIP,
  assetId: CLIP,
  ownerId: OWNER,
  checksum: 'c3VtLTE=',
  sourceAccess: 'owner',
  locked: null,
  lockReason: null,
  sensitive: null,
  ...overrides,
});

const versionRow = (overrides: Partial<StudioExportVersion> = {}): StudioExportVersion =>
  ({
    id: VERSION,
    ownerId: OWNER,
    projectId: PROJECT,
    revision: 3,
    revisionDigest: 'digest-3',
    renderOperationId: RENDER,
    publishOperationId: PUBLISH,
    state: StudioExportVersionState.Staged,
    version: null,
    scope: null,
    destination: MediaOperationDestination.Lan,
    settings: { format: 'mp4-h264', color: 'preserve', resolution: '1080p' },
    workerId: 'worker-1',
    engineDigest: 'engine-1',
    outputPath: '',
    outputChecksum: Buffer.from('ab'.repeat(32), 'hex'),
    outputSizeInBytes: '1024',
    outputContentType: 'video/mp4',
    outputRemoteRef: null,
    outputRemovedAt: null,
    resultAssetId: null,
    privacy: null,
    errorCode: null,
    error: null,
    createdAt: new Date('2026-09-23T10:00:00.000Z'),
    updatedAt: new Date('2026-09-23T10:00:00.000Z'),
    publishedAt: null,
    cancelledAt: null,
    ...overrides,
  }) as unknown as StudioExportVersion;

const operation = (overrides: Partial<MediaOperation> = {}): MediaOperation =>
  ({
    id: RENDER,
    ownerId: OWNER,
    kind: MediaOperationKind.StudioExport,
    status: MediaOperationStatus.Validating,
    claimToken: 'render-claim',
    destination: MediaOperationDestination.Lan,
    label: 'Lake trip',
    projectId: PROJECT,
    snapshot: {},
    settings: {},
    ...overrides,
  }) as unknown as MediaOperation;

describe(StudioExportService.name, () => {
  let sut: StudioExportService;
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let operations: Record<string, ReturnType<typeof vi.fn>>;
  let projects: Record<string, ReturnType<typeof vi.fn>>;
  let studio: Record<string, ReturnType<typeof vi.fn>>;
  let resources: Record<string, ReturnType<typeof vi.fn>>;
  let users: Record<string, ReturnType<typeof vi.fn>>;
  let access: { asset: Record<string, ReturnType<typeof vi.fn>> };
  let storage: Record<string, ReturnType<typeof vi.fn>> & {
    checkFileExists: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>;
  };
  let crypto: Record<string, ReturnType<typeof vi.fn>>;
  let jobs: Record<string, ReturnType<typeof vi.fn>>;
  let staged: string;

  beforeAll(() => StorageCore.setMediaLocation('/data'));

  beforeEach(() => {
    staged = `${studioExportStagingFolder(OWNER, RENDER)}/out.mp4`;
    repository = {
      createWithRender: vi.fn(),
      getById: vi.fn(),
      getForOwner: vi.fn(),
      getByRenderOperation: vi.fn(),
      getSources: vi.fn().mockResolvedValue([sourceRow()]),
      getSourcesFor: vi.fn((ids: string[]) =>
        Promise.resolve(new Map(ids.map((id) => [id, [sourceRow({ versionId: id })]]))),
      ),
      listForProject: vi.fn(),
      recordRenderClaim: vi.fn().mockResolvedValue(true),
      stage: vi.fn(),
      markFailed: vi.fn().mockResolvedValue(undefined),
      cancel: vi
        .fn()
        .mockImplementation((id) => Promise.resolve(versionRow({ id, state: StudioExportVersionState.Cancelled }))),
      publish: vi.fn(),
      listOrphanedWork: vi.fn().mockResolvedValue([]),
      listSettledWork: vi.fn().mockResolvedValue([]),
      listRemovableOutputs: vi.fn().mockResolvedValue([]),
      markOutputRemoved: vi.fn(),
      recordRemoteReference: vi.fn().mockResolvedValue(undefined),
      acknowledgeRemoteCancel: vi.fn().mockResolvedValue(true),
      listRemoteReferences: vi.fn(),
      acknowledgeRemoteReference: vi.fn(),
    };
    operations = {
      getByRequestKey: vi.fn().mockResolvedValue(undefined),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('retrying'),
      requestCancel: vi.fn().mockResolvedValue(operation({ status: MediaOperationStatus.Cancelling })),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      claimNext: vi.fn(),
    };
    projects = {
      getById: vi.fn().mockResolvedValue({ id: PROJECT, ownerId: OWNER, name: 'Lake trip', deletedAt: null }),
      getRevision: vi.fn().mockResolvedValue({ revision: 3, digest: 'digest-3', envelope: { graph: { clips: [] } } }),
    };
    studio = { authorizeRevision: vi.fn() };
    resources = {
      resolveProjectResources: vi.fn().mockResolvedValue({
        manifest: { complete: true, refusedCount: 0, entries: [entry()] },
        refused: [],
      }),
    };
    users = { get: vi.fn().mockResolvedValue({ id: OWNER, name: 'Owner', email: 'o@example.com', isAdmin: false }) };
    access = {
      asset: {
        checkOwnerAccess: vi.fn().mockImplementation((_user, ids: Set<string>) => Promise.resolve(new Set(ids))),
        checkAlbumAccess: vi.fn().mockResolvedValue(new Set()),
        checkPartnerAccess: vi.fn().mockResolvedValue(new Set()),
      },
    };
    const files = new Map<string, number>([[staged, 1024]]);
    storage = {
      mkdirSync: vi.fn(),
      stat: vi.fn((path: string) =>
        files.has(path)
          ? Promise.resolve({ size: files.get(path), isFile: () => true })
          : Promise.reject(new Error('ENOENT')),
      ),
      realpath: vi.fn((path: string) => Promise.resolve(path)),
      checkFileExists: vi.fn((path: string) => Promise.resolve(files.has(path))),
      rename: vi.fn((from: string, to: string) => {
        files.set(to, files.get(from)!);
        files.delete(from);
        return Promise.resolve();
      }),
      unlink: vi.fn().mockResolvedValue(undefined),
      unlinkDir: vi.fn().mockResolvedValue(undefined),
    };
    crypto = { hashFile: vi.fn().mockResolvedValue(Buffer.from('ab'.repeat(32), 'hex')) };
    jobs = { queue: vi.fn().mockResolvedValue(undefined) };

    sut = new StudioExportService(
      { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      repository as never,
      operations as never,
      projects as never,
      studio as never,
      resources as never,
      users as never,
      access as never,
      storage as never,
      crypto as never,
      jobs as never,
      {} as never,
      {} as never,
    );
  });

  describe('create', () => {
    const authorized = (overrides: Record<string, unknown> = {}) => ({
      project: { id: PROJECT, name: 'Lake trip' },
      access: 'owner',
      revision: { id: 'rev-row', revision: 3, digest: 'digest-3' },
      manifest: { complete: true, refusedCount: 0, digest: 'm', entries: [entry()] },
      ...overrides,
    });
    const dto = {
      destination: MediaOperationDestination.Lan,
      format: 'mp4-h264',
      color: 'preserve',
      resolution: '1080p',
    } as never;

    it('refuses anybody but the owner', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized({ access: 'reviewer' }));
      await expect(sut.create(auth(), PROJECT, dto)).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it('refuses a stale revision and a manifest with a refused source', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      await expect(
        sut.create(auth(), PROJECT, { ...(dto as object), expectedRevision: 2 } as never),
      ).rejects.toBeInstanceOf(ConflictException);
      studio.authorizeRevision.mockResolvedValue(
        authorized({ manifest: { complete: false, refusedCount: 1, digest: 'm', entries: [] } }),
      );
      await expect(sut.create(auth(), PROJECT, dto)).rejects.toBeInstanceOf(ConflictException);
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it('refuses Dolby Vision output while no worker is qualified with the approved Dolby tools (FL-86, FL-145)', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      const dolby = { ...(dto as object), color: 'dolby-vision' } as never;
      await expect(sut.create(auth(), PROJECT, dolby)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'studio_export_dolby_unqualified', resource: 'tool:dolby-portal' }),
      });
      expect(studio.authorizeRevision).not.toHaveBeenCalled();
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it('hides a Locked export on request-key replay after the session locks', async () => {
      const version = versionRow({ privacy: { lockReason: AssetLockReason.Marked } });
      operations.getByRequestKey.mockResolvedValue(operation());
      repository.getByRenderOperation.mockResolvedValue(version);
      repository.getForOwner.mockResolvedValue(version);
      const replay = { ...(dto as object), requestKey: 'export-request' } as never;
      await expect(sut.create(elevated(), PROJECT, replay)).resolves.toHaveProperty('version.id', VERSION);
      await expect(sut.create(auth(), PROJECT, replay)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it('queues a render bound to the stored revision, with no graph in the job', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      repository.createWithRender.mockResolvedValue({
        operation: operation({ status: MediaOperationStatus.Queued }),
        version: versionRow({ state: StudioExportVersionState.Rendering }),
      });

      await sut.create(auth(), PROJECT, dto);

      const [job, version] = repository.createWithRender.mock.calls[0];
      expect(job).toEqual(
        expect.objectContaining({
          kind: MediaOperationKind.StudioExport,
          resultAssetId: null,
          snapshot: expect.objectContaining({ studio: { stored: true, revision: 3, cloudConsent: false } }),
        }),
      );
      expect(job.snapshot.studio).not.toHaveProperty('graph');
      expect(version).toEqual(expect.objectContaining({ ownerId: OWNER, projectId: PROJECT, revision: 3 }));
    });
  });

  describe('render contract', () => {
    it('records provenance and a remote stop obligation when a remote worker claims', async () => {
      repository.getByRenderOperation.mockResolvedValue(versionRow({ state: StudioExportVersionState.Rendering }));

      await sut.onRenderClaimed(operation({ status: MediaOperationStatus.Preparing }), {
        workerId: 'worker-1',
        engineDigest: 'engine-1',
        entries: [
          entry(),
          entry({
            key: 'font:inter',
            kind: StudioResourceKind.Font,
            id: 'inter',
            ownerId: null,
            sourceAccess: 'deployment',
          }),
        ],
      });

      expect(repository.recordRenderClaim).toHaveBeenCalledWith(RENDER, {
        workerId: 'worker-1',
        engineDigest: 'engine-1',
        sources: [
          expect.objectContaining({
            key: `library-asset:${CLIP}`,
            assetId: CLIP,
            ownerId: OWNER,
            checksum: 'c3VtLTE=',
          }),
          expect.objectContaining({ key: 'font:inter', assetId: null, ownerId: null }),
        ],
      });
      expect(repository.recordRemoteReference).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: RENDER, workerId: 'worker-1', reason: StudioExportRemoteReason.Cancel }),
      );
    });

    it('refuses an output outside the render directory, or of another size', async () => {
      const output = {
        path: '/data/library/owner/original.mov',
        checksum: 'ab'.repeat(32),
        sizeInBytes: '1024',
        contentType: 'video/mp4',
      };
      await expect(sut.onRenderCompleted(operation(), 'worker-1', output)).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.onRenderCompleted(operation(), 'worker-1', { ...output, path: `${staged}/../../x.mp4` }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.onRenderCompleted(operation(), 'worker-1', { ...output, path: staged, sizeInBytes: '9' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.onRenderCompleted(operation(), 'worker-1', { ...output, path: staged, contentType: 'text/html' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.stage).not.toHaveBeenCalled();
    });

    it('stages a good output, queues its publication and keeps a remote copy on record for deletion', async () => {
      repository.stage = vi.fn(
        (_id: string, _claimToken: string, _output: unknown, publish: (version: StudioExportVersion) => object) => {
          const job = publish(versionRow({ state: StudioExportVersionState.Rendering }));
          return Promise.resolve({ version: versionRow(), operation: { id: PUBLISH, ...job } });
        },
      );

      const result = await sut.onRenderCompleted(operation(), 'worker-1', {
        path: staged,
        checksum: 'ab'.repeat(32),
        sizeInBytes: '1024',
        contentType: 'video/mp4',
        remoteRef: 'worker-cache/out.mp4',
      });

      expect(result).toEqual({ accepted: true });
      const publish = repository.stage.mock.calls[0][3](versionRow());
      expect(publish).toEqual(
        expect.objectContaining({
          kind: MediaOperationKind.StudioExportPublish,
          destination: MediaOperationDestination.Local,
          maxAttempts: 1,
          snapshot: expect.objectContaining({
            kind: 'studio-export-publish',
            versionId: VERSION,
            renderOperationId: RENDER,
          }),
        }),
      );
      expect(repository.acknowledgeRemoteCancel).toHaveBeenCalledWith(RENDER, 'worker-1');
      expect(repository.recordRemoteReference).toHaveBeenCalledWith(
        expect.objectContaining({ reason: StudioExportRemoteReason.Delete, remoteRef: 'worker-cache/out.mp4' }),
      );
    });
  });

  describe('publication', () => {
    const job = () => ({
      operation: operation({
        id: PUBLISH,
        kind: MediaOperationKind.StudioExportPublish,
        destination: MediaOperationDestination.Local,
        snapshot: {
          kind: 'studio-export-publish',
          versionId: VERSION,
          renderOperationId: RENDER,
          projectId: PROJECT,
          revision: 3,
        },
      }),
      claimToken: 'claim-p',
    });
    const published = (overrides: Partial<StudioExportPublished> = {}): StudioExportPublished => ({
      status: 'published',
      version: versionRow({ state: StudioExportVersionState.Published, version: 1, resultAssetId: 'asset-new' }),
      privacy: {
        lockReason: AssetLockReason.Marked,
        sensitive: false,
        includesSharedSources: false,
        scope: StudioExportScope.Library,
        sourceCount: 1,
        lockedSourceCount: 1,
        sensitiveSourceCount: 0,
      },
      createdAssetId: 'asset-new',
      reusedAssetId: null,
      ...overrides,
    });

    beforeEach(() => {
      repository.getById.mockResolvedValue(versionRow({ outputPath: staged }));
    });

    it('does not prepare or publish after losing the validation gate', async () => {
      operations.beginValidation.mockResolvedValue(false);
      await sut.run(job());
      expect(storage.rename).not.toHaveBeenCalled();
      expect(repository.publish).not.toHaveBeenCalled();
      expect(operations.requestCancel).not.toHaveBeenCalled();
    });

    it('does not cancel a replacement claim when publication rejects a stale token', async () => {
      repository.publish.mockRejectedValue(new StudioExportRefusal('claim-lost', 'stale token'));
      await sut.run(job());
      expect(operations.requestCancel).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('leaves the prepared output in place when a replacement runner has verified it', async () => {
      const firstPrepared = Promise.withResolvers<void>();
      const replacementPrepared = Promise.withResolvers<void>();
      const firstFinished = Promise.withResolvers<void>();
      let finalPath = '';
      repository.publish = vi.fn(async (input: { claimToken: string; path: string }) => {
        if (input.claimToken === 'claim-p') {
          firstPrepared.resolve();
          await replacementPrepared.promise;
          throw new StudioExportRefusal('claim-lost', 'replacement claimed the operation');
        }
        finalPath = input.path;
        replacementPrepared.resolve();
        await firstFinished.promise;
        expect(await storage.checkFileExists(finalPath)).toBe(true);
        return published();
      });

      const first = sut.run(job());
      await firstPrepared.promise;
      const replacement = sut.run({ ...job(), claimToken: 'replacement-claim' });
      await first;
      firstFinished.resolve();
      await replacement;

      expect(crypto.hashFile).toHaveBeenCalledWith(finalPath, 'sha256');
      expect(storage.rename).toHaveBeenCalledExactlyOnceWith(staged, finalPath);
      expect(operations.complete).toHaveBeenCalledExactlyOnceWith(PUBLISH, 'replacement-claim', {
        resultAssetId: 'asset-new',
      });
      expect(operations.fail).not.toHaveBeenCalled();
      expect(operations.requestCancel).not.toHaveBeenCalled();
    });

    it('verifies the file, moves it into the library and publishes it with the sources re-checked', async () => {
      repository.publish.mockResolvedValue(published());

      await sut.run(job());

      expect(crypto.hashFile).toHaveBeenCalledWith(staged, 'sha256');
      const input = repository.publish.mock.calls[0][0];
      expect(input).toEqual(
        expect.objectContaining({
          versionId: VERSION,
          operationId: PUBLISH,
          claimToken: 'claim-p',
          expectedScope: StudioExportScope.Library,
          nsfwHiding: true,
          assetType: AssetType.Video,
          originalFileName: 'Lake trip.mp4',
          sources: [expect.objectContaining({ assetId: CLIP })],
        }),
      );
      expect(input.path).toContain('/upload/');
      expect(storage.rename).toHaveBeenCalledWith(staged, input.path);
      expect(jobs.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: 'asset-new', source: 'upload' },
      });
      expect(operations.complete).toHaveBeenCalledWith(PUBLISH, 'claim-p', { resultAssetId: 'asset-new' });
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('keeps a result made with shared media with the project', async () => {
      repository.getSources.mockResolvedValue([
        sourceRow(),
        sourceRow({
          key: `library-asset:${SHARED_CLIP}`,
          resourceId: SHARED_CLIP,
          assetId: SHARED_CLIP,
          ownerId: PARTNER,
          sourceAccess: 'shared',
        }),
      ]);
      resources.resolveProjectResources.mockResolvedValue({
        manifest: {
          complete: true,
          entries: [
            entry(),
            entry({ key: `library-asset:${SHARED_CLIP}`, id: SHARED_CLIP, ownerId: PARTNER, sourceAccess: 'shared' }),
          ],
        },
        refused: [],
      });
      repository.publish.mockResolvedValue(published());

      await sut.run(job());

      const input = repository.publish.mock.calls[0][0];
      expect(input.expectedScope).toBe(StudioExportScope.Project);
      expect(input.path).toContain('/exports/');
      expect(input.path).not.toContain('/upload/');
    });

    it('cancels, without publishing, when the project went to the trash', async () => {
      projects.getById.mockResolvedValue({ id: PROJECT, ownerId: OWNER, name: 'Lake trip', deletedAt: new Date() });

      await sut.run(job());

      expect(repository.publish).not.toHaveBeenCalled();
      expect(repository.cancel).toHaveBeenCalledWith(
        VERSION,
        expect.objectContaining({ errorCode: 'studio_export_project_unavailable' }),
      );
      expect(operations.fail).not.toHaveBeenCalled();
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(PUBLISH, 'claim-p', { released: true });
    });

    it('cancels when the owner is being deleted', async () => {
      users.get.mockResolvedValue(undefined);
      await sut.run(job());
      expect(repository.publish).not.toHaveBeenCalled();
      expect(repository.cancel).toHaveBeenCalledWith(
        VERSION,
        expect.objectContaining({ errorCode: 'studio_export_owner_unavailable' }),
      );
    });

    it('fails the attempt when a source changed since the render, never publishing the stale render', async () => {
      resources.resolveProjectResources.mockResolvedValue({
        manifest: { complete: true, entries: [entry({ checksum: 'b3RoZXI=' })] },
        refused: [],
      });

      await sut.run(job());

      expect(repository.publish).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        PUBLISH,
        'claim-p',
        expect.objectContaining({ errorCode: 'studio_export_source_changed' }),
      );
    });

    it('refuses a file whose bytes do not match what the render reported', async () => {
      crypto.hashFile.mockResolvedValue(Buffer.from('cd'.repeat(32), 'hex'));
      operations.fail.mockResolvedValue('failed');

      await sut.run(job());

      expect(repository.publish).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        PUBLISH,
        'claim-p',
        expect.objectContaining({ errorCode: 'studio_export_output_invalid' }),
      );
      expect(repository.markFailed).toHaveBeenCalledWith(
        VERSION,
        expect.objectContaining({ errorCode: 'studio_export_output_invalid' }),
      );
    });

    it('returns the file to staging when the publication transaction refuses, so the retry finds it', async () => {
      repository.publish.mockRejectedValue(new StudioExportRefusal('source-access-lost', 'no longer shared'));
      repository.getById
        .mockResolvedValueOnce(versionRow({ outputPath: staged }))
        .mockResolvedValue(versionRow({ outputPath: staged }));

      await sut.run(job());

      const input = repository.publish.mock.calls[0][0];
      expect(storage.rename).toHaveBeenLastCalledWith(input.path, staged);
      expect(operations.fail).toHaveBeenCalledWith(
        PUBLISH,
        'claim-p',
        expect.objectContaining({ errorCode: 'studio_export_source_access_lost' }),
      );
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('treats a lost commit acknowledgement as published when the version says this job published it', async () => {
      repository.publish.mockRejectedValue(new Error('Connection terminated unexpectedly'));
      repository.getById.mockResolvedValueOnce(versionRow({ outputPath: staged })).mockResolvedValue(
        versionRow({
          state: StudioExportVersionState.Published,
          version: 1,
          resultAssetId: 'asset-new',
          publishOperationId: PUBLISH,
        }),
      );

      await sut.run(job());

      expect(operations.fail).not.toHaveBeenCalled();
      expect(operations.complete).toHaveBeenCalledWith(PUBLISH, 'claim-p', { resultAssetId: 'asset-new' });
      // The file stays where the committed result points.
      expect(storage.rename).toHaveBeenCalledTimes(1);
    });

    it('acknowledges a cancel that landed on an already published job instead of leaving it to the lease', async () => {
      repository.publish.mockResolvedValue(published());
      operations.complete.mockResolvedValue(false);

      await sut.run(job());

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(PUBLISH, 'claim-p', { released: true });
    });

    it('finishes only the job when an earlier attempt already published', async () => {
      repository.getById.mockResolvedValue(
        versionRow({ state: StudioExportVersionState.Published, version: 2, resultAssetId: 'asset-new' }),
      );

      await sut.run(job());

      expect(repository.publish).not.toHaveBeenCalled();
      expect(operations.complete).toHaveBeenCalledWith(PUBLISH, 'claim-p', { resultAssetId: 'asset-new' });
    });
  });

  describe('settleStudioExportPublication', () => {
    it('rethrows when the version did not commit, and never for a refusal', async () => {
      const repo = { getById: vi.fn().mockResolvedValue(versionRow()), getSources: vi.fn() };
      await expect(
        settleStudioExportPublication(repo, VERSION, PUBLISH, () => Promise.reject(new Error('lost'))),
      ).rejects.toThrow('lost');
      await expect(
        settleStudioExportPublication(repo, VERSION, PUBLISH, () =>
          Promise.reject(new StudioExportRefusal('source-changed', 'changed')),
        ),
      ).rejects.toBeInstanceOf(StudioExportRefusal);
      expect(repo.getById).toHaveBeenCalledTimes(1);
    });

    it('does not claim another job’s publication as its own', async () => {
      const repo = {
        getById: vi
          .fn()
          .mockResolvedValue(versionRow({ state: StudioExportVersionState.Published, publishOperationId: 'other' })),
        getSources: vi.fn(),
      };
      await expect(
        settleStudioExportPublication(repo, VERSION, PUBLISH, () => Promise.reject(new Error('lost'))),
      ).rejects.toThrow('lost');
    });
  });

  describe('download', () => {
    const projectResult = (overrides: Partial<StudioExportVersion> = {}) =>
      versionRow({
        state: StudioExportVersionState.Published,
        scope: StudioExportScope.Project,
        outputPath: '/data/exports/o/studio-exports/versions/v.mp4',
        privacy: { lockReason: null },
        ...overrides,
      });

    beforeEach(() => {
      repository.getSources.mockResolvedValue([
        sourceRow(),
        sourceRow({
          key: 'shared',
          resourceId: SHARED_CLIP,
          assetId: SHARED_CLIP,
          ownerId: PARTNER,
          sourceAccess: 'shared',
        }),
      ]);
    });

    it('serves the file only while every source is still available to the owner', async () => {
      repository.getForOwner.mockResolvedValue(projectResult());
      access.asset.checkAlbumAccess.mockResolvedValue(new Set([SHARED_CLIP]));

      await expect(sut.download(auth(), VERSION)).resolves.toEqual(
        expect.objectContaining({ path: '/data/exports/o/studio-exports/versions/v.mp4' }),
      );

      access.asset.checkAlbumAccess.mockResolvedValue(new Set());
      await expect(sut.download(auth(), VERSION)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers a Locked result only in an unlocked session, and a library result never', async () => {
      access.asset.checkPartnerAccess.mockResolvedValue(new Set([SHARED_CLIP]));
      repository.getForOwner.mockResolvedValue(projectResult({ privacy: { lockReason: AssetLockReason.Marked } }));
      await expect(sut.download(auth(), VERSION)).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.download(elevated(), VERSION)).resolves.toBeDefined();

      repository.getForOwner.mockResolvedValue(projectResult({ scope: StudioExportScope.Library }));
      await expect(sut.download(elevated(), VERSION)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers a Locked result only to an unlocked session, with its asset', async () => {
      repository.getForOwner.mockResolvedValue(
        projectResult({
          scope: StudioExportScope.Library,
          resultAssetId: 'asset-new',
          privacy: { lockReason: 'marked' },
        }),
      );
      await expect(sut.get(auth(), VERSION)).rejects.toBeInstanceOf(NotFoundException);
      const shown = await sut.get(elevated(), VERSION);
      expect(shown).toEqual(expect.objectContaining({ resultAssetId: 'asset-new', locked: true }));
    });
  });

  describe('list', () => {
    it('leaves Locked results out of an ordinary session’s list and count, and shows them when unlocked', async () => {
      repository.listForProject.mockResolvedValue({
        items: [versionRow({ state: StudioExportVersionState.Published })],
        total: 1,
      });

      const ordinary = await sut.list(auth(), PROJECT, {});
      expect(repository.listForProject).toHaveBeenLastCalledWith(PROJECT, OWNER, {
        take: 50,
        skip: 0,
        includeLocked: false,
      });
      expect(ordinary.total).toBe(1);

      await sut.list(elevated(), PROJECT, {});
      expect(repository.listForProject).toHaveBeenLastCalledWith(PROJECT, OWNER, {
        take: 50,
        skip: 0,
        includeLocked: true,
      });
    });

    it('reads the sources of the whole page in one query', async () => {
      repository.listForProject.mockResolvedValue({
        items: [versionRow({ id: 'v1' }), versionRow({ id: 'v2' })],
        total: 2,
      });

      const listed = await sut.list(auth(), PROJECT, {});

      expect(repository.getSourcesFor).toHaveBeenCalledTimes(1);
      expect(repository.getSourcesFor).toHaveBeenCalledWith(['v1', 'v2']);
      expect(repository.getSources).not.toHaveBeenCalled();
      expect(listed.items.map((item) => item.sourceCount)).toEqual([1, 1]);
    });
  });

  describe('sweep', () => {
    it('cancels orphaned work and its jobs, and settles versions whose jobs ended elsewhere', async () => {
      repository.listOrphanedWork.mockResolvedValue([
        { ...versionRow({ state: StudioExportVersionState.Rendering }), orphanReason: 'owner-unavailable' },
      ]);
      repository.listSettledWork.mockResolvedValue([
        {
          ...versionRow({ id: 'v2', state: StudioExportVersionState.Rendering }),
          jobStatus: MediaOperationStatus.Failed,
        },
        {
          ...versionRow({ id: 'v3', state: StudioExportVersionState.Staged }),
          jobStatus: MediaOperationStatus.Cancelled,
        },
      ]);

      await sut.sweep(new Date());

      expect(repository.cancel).toHaveBeenCalledWith(
        VERSION,
        expect.objectContaining({ errorCode: 'studio_export_owner_unavailable' }),
      );
      expect(operations.requestCancel).toHaveBeenCalledWith(RENDER, OWNER);
      expect(operations.requestCancel).toHaveBeenCalledWith(PUBLISH, OWNER);
      expect(repository.markFailed).toHaveBeenCalledWith('v2', expect.anything());
      expect(repository.cancel).toHaveBeenCalledWith('v3', expect.anything());
    });
  });
});

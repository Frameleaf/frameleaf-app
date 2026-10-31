import { MediaOperationKind } from 'src/enum.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioPreviewStreamService } from 'src/services/studio-preview-stream.service.js';
import { StudioPreviewService } from 'src/services/studio-preview.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioRevocationService } from 'src/services/studio-revocation.service.js';
import { getMocks } from 'test/utils.js';

const ASSET = '0195e2a0-0000-7000-8000-00000000a001';

describe(StudioRevocationService.name, () => {
  let sut: StudioRevocationService;
  let projectRepository: {
    getIdsReferencingAssets: ReturnType<typeof vi.fn>;
    getIdsInSpace: ReturnType<typeof vi.fn>;
    detachOwnerFromSpace: ReturnType<typeof vi.fn>;
  };
  let projects: {
    forgetResolutions: ReturnType<typeof vi.fn>;
    forgetSourceAdmissions: ReturnType<typeof vi.fn>;
    forgetInteractiveAdmissions: ReturnType<typeof vi.fn>;
  };
  let previews: { revokeForProjects: ReturnType<typeof vi.fn>; revokeAdmissions: ReturnType<typeof vi.fn> };
  let streams: { revokeForProjects: ReturnType<typeof vi.fn>; revokeAdmissions: ReturnType<typeof vi.fn> };
  let operations: {
    listUnfinishedForProjects: ReturnType<typeof vi.fn>;
    requestCancel: ReturnType<typeof vi.fn>;
    listRevokedSourceAdmissions: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    projectRepository = {
      getIdsReferencingAssets: vi.fn().mockResolvedValue(['project-1', 'project-2']),
      getIdsInSpace: vi.fn().mockResolvedValue(['project-3']),
      detachOwnerFromSpace: vi.fn().mockResolvedValue([]),
    };
    projects = { forgetResolutions: vi.fn(), forgetSourceAdmissions: vi.fn(), forgetInteractiveAdmissions: vi.fn() };
    previews = { revokeForProjects: vi.fn().mockResolvedValue(2), revokeAdmissions: vi.fn().mockResolvedValue(2) };
    streams = {
      revokeForProjects: vi.fn().mockResolvedValue(1),
      revokeAdmissions: vi.fn().mockResolvedValue(undefined),
    };
    operations = {
      listUnfinishedForProjects: vi.fn().mockResolvedValue([
        { id: 'export-1', ownerId: 'owner-1', kind: MediaOperationKind.StudioExport, projectId: 'project-1' },
        { id: 'preview-1', ownerId: 'reviewer-1', kind: MediaOperationKind.StudioPreview, projectId: 'project-2' },
      ]),
      requestCancel: vi.fn().mockResolvedValue({ id: 'any' }),
      listRevokedSourceAdmissions: vi.fn().mockResolvedValue([
        { id: 'admission-1', ownerId: 'owner-1', kind: MediaOperationKind.StudioPreview },
        { id: 'admission-2', ownerId: 'owner-2', kind: MediaOperationKind.StudioPreviewStream },
      ]),
    };
    sut = new StudioRevocationService(
      getMocks().logger as never,
      projectRepository as unknown as StudioProjectRepository,
      projects as unknown as StudioProjectService,
      previews as unknown as StudioPreviewService,
      streams as unknown as StudioPreviewStreamService,
      operations as unknown as MediaOperationRepository,
    );
  });

  it.each([
    ['trash', () => sut.onAssetTrash({ assetId: ASSET, userId: 'owner-1' })],
    ['bulk trash', () => sut.onAssetTrashAll({ assetIds: [ASSET], userId: 'owner-1' })],
    ['delete', () => sut.onAssetDelete({ assetId: ASSET, userId: 'owner-1' })],
    ['bulk delete', () => sut.onAssetDeleteAll({ assetIds: [ASSET], userId: 'owner-1' })],
  ])('stops previews, jobs and cached resolutions of every project using a source on %s', async (_, act) => {
    await act();

    expect(projectRepository.getIdsReferencingAssets).toHaveBeenCalledWith([ASSET]);
    expect(projects.forgetResolutions).toHaveBeenCalledWith(['project-1', 'project-2']);
    expect(previews.revokeForProjects).toHaveBeenCalledWith(['project-1', 'project-2']);
    // FL-96: streams stop with a recorded reason before the job pass.
    expect(streams.revokeForProjects).toHaveBeenCalledWith(['project-1', 'project-2']);
    expect(operations.listUnfinishedForProjects).toHaveBeenCalledWith(
      ['project-1', 'project-2'],
      [
        MediaOperationKind.StudioExport,
        MediaOperationKind.StudioReverseConform,
        MediaOperationKind.StudioPreview,
        MediaOperationKind.StudioPreviewStream,
        MediaOperationKind.StudioTranscription,
      ],
      undefined,
    );
    // Every account's job, each cancelled as its own owner.
    expect(operations.requestCancel).toHaveBeenCalledWith('export-1', 'owner-1');
    expect(operations.requestCancel).toHaveBeenCalledWith('preview-1', 'reviewer-1');
  });

  it('does nothing when no project uses the source', async () => {
    projectRepository.getIdsReferencingAssets.mockResolvedValue([]);
    await sut.onAssetTrash({ assetId: ASSET, userId: 'owner-1' });
    expect(previews.revokeForProjects).not.toHaveBeenCalled();
    expect(operations.requestCancel).not.toHaveBeenCalled();
  });

  it('stops interactive previews and streams of newly Locked sources but lets owner-submitted exports run', async () => {
    await sut.onAssetLocked({ assetIds: [ASSET] });
    expect(projects.forgetResolutions).toHaveBeenCalledWith(['project-1', 'project-2']);
    expect(previews.revokeForProjects).toHaveBeenCalledWith(['project-1', 'project-2']);
    expect(streams.revokeForProjects).toHaveBeenCalledWith(['project-1', 'project-2']);
    expect(operations.requestCancel).not.toHaveBeenCalled();
  });

  it("stops only the departing member's work on the space's projects", async () => {
    await sut.onAlbumUserRemove({ albumId: 'space-1', userId: 'reviewer-1', removedById: 'owner-9' });
    expect(projectRepository.getIdsInSpace).toHaveBeenCalledWith('space-1');
    expect(previews.revokeForProjects).toHaveBeenCalledWith(['project-3'], 'reviewer-1');
    expect(streams.revokeForProjects).toHaveBeenCalledWith(['project-3'], 'reviewer-1');
    expect(operations.listUnfinishedForProjects).toHaveBeenCalledWith(
      ['project-3'],
      [
        MediaOperationKind.StudioExport,
        MediaOperationKind.StudioReverseConform,
        MediaOperationKind.StudioPreview,
        MediaOperationKind.StudioPreviewStream,
        MediaOperationKind.StudioTranscription,
      ],
      'reviewer-1',
    );
  });

  it("keeps the departing member's own projects as private ones and ends their space sharing (FL-146)", async () => {
    projectRepository.detachOwnerFromSpace.mockResolvedValue(['project-9']);
    await sut.onAlbumUserRemove({ albumId: 'space-1', userId: 'owner-9', removedById: 'owner-9' });
    expect(projectRepository.detachOwnerFromSpace).toHaveBeenCalledWith('space-1', 'owner-9');
    // Nothing is deleted; every other member's view of the project stops.
    expect(projects.forgetResolutions).toHaveBeenCalledWith(['project-9']);
    expect(previews.revokeForProjects).toHaveBeenCalledWith(['project-9']);
    expect(streams.revokeForProjects).toHaveBeenCalledWith(['project-9']);
  });

  it('keeps going when one cancellation fails', async () => {
    operations.requestCancel.mockRejectedValueOnce(new Error('db down'));
    await expect(sut.onAssetDelete({ assetId: ASSET, userId: 'owner-1' })).resolves.toBeUndefined();
    expect(operations.requestCancel).toHaveBeenCalledTimes(2);
  });

  it.each(['preview', 'stream'])('still cancels source-bound work after %s revocation fails', async (failed) => {
    const error = new Error('revocation refused');
    (failed === 'preview' ? previews : streams).revokeForProjects.mockRejectedValueOnce(error);
    await expect(sut.onAssetDelete({ assetId: ASSET, userId: 'owner-1' })).rejects.toBe(error);
    expect(streams.revokeForProjects).toHaveBeenCalled();
    expect(operations.requestCancel).toHaveBeenCalledWith('export-1', 'owner-1');
    expect(operations.requestCancel).toHaveBeenCalledWith('preview-1', 'reviewer-1');
    expect(streams.revokeForProjects.mock.invocationCallOrder[0]).toBeLessThan(
      operations.requestCancel.mock.invocationCallOrder[0],
    );
  });

  it('still revokes both Locked preview paths after synchronous cache invalidation failure', async () => {
    const error = new Error('cache invalidation failed');
    projects.forgetResolutions.mockImplementationOnce(() => {
      throw error;
    });
    await expect(sut.onAssetLocked({ assetIds: [ASSET] })).rejects.toBe(error);
    expect(previews.revokeForProjects).toHaveBeenCalled();
    expect(streams.revokeForProjects).toHaveBeenCalled();
    expect(operations.requestCancel).not.toHaveBeenCalled();
  });

  it('continues departing-member revocation after detached-project preview failure', async () => {
    const error = new Error('preview cleanup failed');
    projectRepository.detachOwnerFromSpace.mockResolvedValue(['project-9']);
    previews.revokeForProjects.mockRejectedValueOnce(error);
    await expect(sut.onAlbumUserRemove({ albumId: 'space-1', userId: 'owner-9', removedById: 'owner-9' })).rejects.toBe(
      error,
    );
    expect(streams.revokeForProjects).toHaveBeenCalledWith(['project-9']);
    expect(projectRepository.getIdsInSpace).toHaveBeenCalledWith('space-1');
    expect(streams.revokeForProjects).toHaveBeenCalledWith(['project-3'], 'owner-9');
    expect(operations.requestCancel).toHaveBeenCalledTimes(2);
  });

  it.each(['preview', 'cancel'])('drains all admission revocation after one %s failure', async (failed) => {
    const error = new Error('admission revocation failed');
    if (failed === 'preview') previews.revokeAdmissions.mockRejectedValueOnce(error);
    else operations.requestCancel.mockRejectedValueOnce(error);
    await expect(sut.onAssetLocalEffects({ revocations: [] } as never)).rejects.toBe(error);
    expect(projects.forgetSourceAdmissions).toHaveBeenCalledWith([]);
    expect(streams.revokeAdmissions).toHaveBeenCalled();
    expect(operations.requestCancel).toHaveBeenCalledWith('admission-1', 'owner-1');
    expect(operations.requestCancel).toHaveBeenCalledWith('admission-2', 'owner-2');
  });

  it('retains every independent failure after attempting streams and cancellation', async () => {
    const first = new Error('preview failed');
    const second = new Error('streams failed');
    previews.revokeForProjects.mockRejectedValueOnce(first);
    streams.revokeForProjects.mockRejectedValueOnce(second);
    await expect(sut.onAssetDelete({ assetId: ASSET, userId: 'owner-1' })).rejects.toMatchObject({
      errors: [first, second],
    });
    expect(operations.requestCancel).toHaveBeenCalledTimes(2);
  });

  it('revokes known Locked admissions even if removed-source lookup fails', async () => {
    const error = new Error('lookup failed');
    operations.listRevokedSourceAdmissions.mockRejectedValueOnce(error);
    const admission = { id: 'locked-preview', ownerId: 'owner-1', kind: MediaOperationKind.StudioPreview };
    await expect(
      sut.onAssetLocalEffects({
        ownerId: 'owner-1',
        streamEpoch: 'epoch',
        sequence: '3',
        revocations: [],
        lockedCascade: { assetIds: [ASSET], interactiveAdmissions: [admission] },
      } as never),
    ).rejects.toBe(error);
    expect(projects.forgetSourceAdmissions).toHaveBeenCalled();
    expect(projects.forgetInteractiveAdmissions).toHaveBeenCalled();
    expect(previews.revokeAdmissions).toHaveBeenCalledWith(['locked-preview']);
    expect(streams.revokeAdmissions).toHaveBeenCalledWith([admission]);
    expect(operations.requestCancel).toHaveBeenCalledWith('locked-preview', 'owner-1');
  });
});

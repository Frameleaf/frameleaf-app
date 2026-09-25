import { MediaOperationKind } from 'src/enum.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioPreviewService } from 'src/services/studio-preview.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioRevocationService } from 'src/services/studio-revocation.service.js';
import { getMocks } from 'test/utils.js';

const ASSET = '0195e2a0-0000-7000-8000-00000000a001';

describe(StudioRevocationService.name, () => {
  let sut: StudioRevocationService;
  let projectRepository: { getIdsReferencingAssets: ReturnType<typeof vi.fn>; getIdsInSpace: ReturnType<typeof vi.fn> };
  let projects: { forgetResolutions: ReturnType<typeof vi.fn> };
  let previews: { revokeForProjects: ReturnType<typeof vi.fn> };
  let operations: { listUnfinishedForProjects: ReturnType<typeof vi.fn>; requestCancel: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    projectRepository = {
      getIdsReferencingAssets: vi.fn().mockResolvedValue(['project-1', 'project-2']),
      getIdsInSpace: vi.fn().mockResolvedValue(['project-3']),
    };
    projects = { forgetResolutions: vi.fn() };
    previews = { revokeForProjects: vi.fn().mockResolvedValue(2) };
    operations = {
      listUnfinishedForProjects: vi.fn().mockResolvedValue([
        { id: 'export-1', ownerId: 'owner-1', kind: MediaOperationKind.StudioExport, projectId: 'project-1' },
        { id: 'preview-1', ownerId: 'reviewer-1', kind: MediaOperationKind.StudioPreview, projectId: 'project-2' },
      ]),
      requestCancel: vi.fn().mockResolvedValue({ id: 'any' }),
    };
    sut = new StudioRevocationService(
      getMocks().logger as never,
      projectRepository as unknown as StudioProjectRepository,
      projects as unknown as StudioProjectService,
      previews as unknown as StudioPreviewService,
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
    expect(operations.listUnfinishedForProjects).toHaveBeenCalledWith(
      ['project-1', 'project-2'],
      [MediaOperationKind.StudioExport, MediaOperationKind.StudioPreview],
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

  it('stops interactive previews of newly Locked sources but lets owner-submitted exports run', async () => {
    await sut.onAssetLocked({ assetIds: [ASSET] });
    expect(projects.forgetResolutions).toHaveBeenCalledWith(['project-1', 'project-2']);
    expect(previews.revokeForProjects).toHaveBeenCalledWith(['project-1', 'project-2']);
    expect(operations.requestCancel).not.toHaveBeenCalled();
  });

  it("stops only the departing member's work on the space's projects", async () => {
    await sut.onAlbumUserRemove({ albumId: 'space-1', userId: 'reviewer-1' });
    expect(projectRepository.getIdsInSpace).toHaveBeenCalledWith('space-1');
    expect(previews.revokeForProjects).toHaveBeenCalledWith(['project-3'], 'reviewer-1');
    expect(operations.listUnfinishedForProjects).toHaveBeenCalledWith(
      ['project-3'],
      [MediaOperationKind.StudioExport, MediaOperationKind.StudioPreview],
      'reviewer-1',
    );
  });

  it('keeps going when one cancellation fails', async () => {
    operations.requestCancel.mockRejectedValueOnce(new Error('db down'));
    await expect(sut.onAssetDelete({ assetId: ASSET, userId: 'owner-1' })).resolves.toBeUndefined();
    expect(operations.requestCancel).toHaveBeenCalledTimes(2);
  });
});

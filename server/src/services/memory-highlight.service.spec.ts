import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MemoryExport } from 'src/database.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  MediaOperationDestination,
  MemoryExportFormat,
  MemoryExportStatus,
  MemoryHighlightAudio,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { StudioExportVersion } from 'src/repositories/studio-export.repository.js';
import { MemoryHighlightService } from 'src/services/memory-highlight.service.js';
import { STUDIO_ENGINE_REVISION } from 'src/utils/studio-commands.generated.js';
import { extractStudioResourceReferences } from 'src/utils/studio-resources.js';

const OWNER = '0195e2a0-0000-4000-8000-00000000000a';
const MEMORY = '0195e2a0-0000-4000-8000-0000000000m1'.replace('m1', '21');
const RUN = '0195e2a0-0000-4000-8000-000000000031';
const PROJECT = '0195e2a0-0000-7000-8000-000000000041';
const VERSION = '0195e2a0-0000-7000-8000-000000000051';
const RENDER = '0195e2a0-0000-7000-8000-000000000061';
const PHOTO = '0195e2a0-0000-4000-8000-000000000071';
const CLIP = '0195e2a0-0000-4000-8000-000000000072';

const auth = { user: { id: OWNER }, session: { id: 'session-1', hasElevatedPermission: false } } as unknown as AuthDto;

const memory = {
  id: MEMORY,
  title: 'Lake trip',
  assets: [
    { id: PHOTO, type: 'IMAGE', duration: null },
    { id: CLIP, type: 'VIDEO', duration: 12_000 },
  ],
};

const runRow = (overrides: Partial<MemoryExport> = {}): MemoryExport => ({
  id: RUN,
  ownerId: OWNER,
  memoryId: MEMORY,
  title: 'Lake trip',
  format: MemoryExportFormat.Highlight,
  status: MemoryExportStatus.Running,
  assetIds: [PHOTO, CLIP],
  assetCount: 2,
  processedAssets: 0,
  path: null,
  sizeInBytes: null,
  error: null,
  cancelRequestedAt: null,
  startedAt: new Date(),
  finishedAt: null,
  expiresAt: null,
  settings: {
    lengthSeconds: 60,
    resolution: '2160p',
    audio: 'original',
    destination: 'local',
    progress: 0,
    savedAssetId: null,
  },
  studioProjectId: PROJECT,
  studioExportVersionId: VERSION,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const versionRow = (overrides: Partial<StudioExportVersion> = {}) =>
  ({
    id: VERSION,
    ownerId: OWNER,
    projectId: PROJECT,
    state: StudioExportVersionState.Rendering,
    scope: null,
    renderOperationId: RENDER,
    outputPath: null,
    outputSizeInBytes: null,
    outputContentType: null,
    outputRemovedAt: null,
    resultAssetId: null,
    error: null,
    ...overrides,
  }) as unknown as StudioExportVersion;

const published = (overrides: Partial<StudioExportVersion> = {}) =>
  versionRow({
    state: StudioExportVersionState.Published,
    scope: StudioExportScope.Project,
    outputPath: '/data/exports/o/studio-exports/versions/v.mp4',
    outputSizeInBytes: '2048' as never,
    outputContentType: 'video/mp4',
    ...overrides,
  });

describe(MemoryHighlightService.name, () => {
  let sut: MemoryHighlightService;
  let memories: Record<string, ReturnType<typeof vi.fn>>;
  let studioProjects: Record<string, ReturnType<typeof vi.fn>>;
  let studioExports: Record<string, ReturnType<typeof vi.fn>>;
  let projects: Record<string, ReturnType<typeof vi.fn>>;
  let versions: Record<string, ReturnType<typeof vi.fn>>;
  let operations: Record<string, ReturnType<typeof vi.fn>>;
  let assets: Record<string, ReturnType<typeof vi.fn>>;
  let access: { asset: Record<string, ReturnType<typeof vi.fn>> };
  let storage: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    memories = {
      createExport: vi.fn().mockResolvedValue(runRow({ status: MemoryExportStatus.Pending, studioProjectId: null })),
      updateExport: vi.fn((id: string, patch: object) => Promise.resolve({ ...runRow({ id }), ...patch })),
      deleteExport: vi.fn().mockResolvedValue(undefined),
      requestExportCancel: vi.fn(() => Promise.resolve(runRow({ cancelRequestedAt: new Date() }))),
      searchExports: vi.fn().mockResolvedValue([]),
      getHighlightsOfExpiredMemories: vi.fn().mockResolvedValue([]),
    };
    studioProjects = {
      create: vi.fn().mockResolvedValue({ id: PROJECT }),
      update: vi.fn().mockResolvedValue({ id: PROJECT }),
      forgetResolutions: vi.fn(),
    };
    studioExports = {
      create: vi.fn().mockResolvedValue({ version: { id: VERSION }, operation: { id: RENDER } }),
      cancelVersion: vi.fn().mockResolvedValue(undefined),
      download: vi
        .fn()
        .mockResolvedValue({ path: '/data/exports/o/studio-exports/versions/v.mp4', contentType: 'video/mp4' }),
      saveToLibrary: vi.fn().mockResolvedValue({ id: VERSION, resultAssetId: 'asset-saved' }),
    };
    projects = { delete: vi.fn().mockResolvedValue(undefined) };
    versions = {
      getById: vi.fn().mockResolvedValue(versionRow()),
      getForOwner: vi.fn().mockResolvedValue(published()),
    };
    operations = { getForOwner: vi.fn().mockResolvedValue({ id: RENDER, progress: 42.4 }) };
    assets = { getByIds: vi.fn().mockResolvedValue([]) };
    access = { asset: { checkOwnerAccess: vi.fn((_user, ids: Set<string>) => Promise.resolve(new Set(ids))) } };
    storage = {
      createReadStream: vi.fn((path: string, type: string) => Promise.resolve({ stream: path, type, length: 2048 })),
      unlink: vi.fn().mockResolvedValue(undefined),
    };

    sut = new MemoryHighlightService(
      { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      memories as never,
      studioProjects as never,
      studioExports as never,
      projects as never,
      versions as never,
      operations as never,
      assets as never,
      access as never,
      storage as never,
    );
  });

  describe('create', () => {
    it("renders the memory as a Studio export with the prototype's defaults, kept out of the library", async () => {
      const run = await sut.create(auth, memory);

      expect(memories.createExport).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: OWNER,
          memoryId: MEMORY,
          format: MemoryExportFormat.Highlight,
          assetIds: [PHOTO, CLIP],
          settings: {
            lengthSeconds: 60,
            resolution: '2160p',
            audio: MemoryHighlightAudio.Original,
            destination: MediaOperationDestination.Local,
            progress: 0,
            savedAssetId: null,
          },
        }),
      );

      const [, project] = studioProjects.create.mock.calls[0];
      expect(project).toEqual(
        expect.objectContaining({
          name: 'Lake trip',
          envelope: expect.objectContaining({ engine: 'freecut', engineRevision: STUDIO_ENGINE_REVISION }),
        }),
      );
      const references = extractStudioResourceReferences(project.envelope.graph).references;
      expect(references.filter((ref) => ref.kind === 'library-asset').map((ref) => ref.id)).toEqual([PHOTO, CLIP]);
      expect(studioProjects.update).toHaveBeenCalledWith(auth, PROJECT, { archived: true });

      expect(studioExports.create).toHaveBeenCalledWith(
        auth,
        PROJECT,
        expect.objectContaining({
          destination: MediaOperationDestination.Local,
          format: 'mp4-hevc-main10',
          color: 'preserve',
          resolution: '2160p',
        }),
        { retainInProject: true },
      );
      expect(run).toEqual(
        expect.objectContaining({ status: MemoryExportStatus.Running, studioExportVersionId: VERSION }),
      );
    });

    it("uses the owner's length, resolution, sound and destination", async () => {
      await sut.create(auth, memory, {
        lengthSeconds: 30,
        resolution: '1080p',
        audio: MemoryHighlightAudio.Silent,
        destination: MediaOperationDestination.Lan,
      });

      const graph = studioProjects.create.mock.calls[0][1].envelope.graph;
      expect(graph.sequences[0]).toMatchObject({ width: 1920, height: 1080 });
      const audio = graph.sequences[0].tracks.find((track: { kind: string }) => track.kind === 'audio');
      expect(audio.clips).toEqual([]);
      expect(studioExports.create).toHaveBeenCalledWith(
        auth,
        PROJECT,
        expect.objectContaining({ destination: MediaOperationDestination.Lan, resolution: '1080p' }),
        { retainInProject: true },
      );
    });

    it("leaves nothing behind when the render is refused, and passes the export's reason on", async () => {
      const refusal = new ConflictException({ code: 'studio_export_unsupported' });
      studioExports.create.mockRejectedValue(refusal);

      await expect(sut.create(auth, memory)).rejects.toBe(refusal);

      expect(projects.delete).toHaveBeenCalledWith(PROJECT);
      expect(memories.deleteExport).toHaveBeenCalledWith(RUN, OWNER);
    });
  });

  describe('refresh', () => {
    it('follows the render job while it renders', async () => {
      const run = await sut.refresh(runRow());
      expect(run.status).toBe(MemoryExportStatus.Running);
      expect(run.settings).toEqual(expect.objectContaining({ progress: 42 }));
    });

    it('is ready once published, kept with the memory until saved', async () => {
      versions.getById.mockResolvedValue(published());
      const run = await sut.refresh(runRow());
      expect(run).toEqual(
        expect.objectContaining({
          status: MemoryExportStatus.Ready,
          path: '/data/exports/o/studio-exports/versions/v.mp4',
          sizeInBytes: 2048,
        }),
      );
      expect(run.settings).toEqual(expect.objectContaining({ progress: 100, savedAssetId: null }));
      expect(projects.delete).not.toHaveBeenCalled();
    });

    it('fails with the render, and lets its project go', async () => {
      versions.getById.mockResolvedValue(versionRow({ state: StudioExportVersionState.Failed, error: 'GPU lost' }));
      const run = await sut.refresh(runRow());
      expect(run).toEqual(expect.objectContaining({ status: MemoryExportStatus.Failed, error: 'GPU lost' }));
      expect(projects.delete).toHaveBeenCalledWith(PROJECT);
    });

    it('leaves a finished run and an archive alone', async () => {
      await sut.refresh(runRow({ status: MemoryExportStatus.Ready }));
      await sut.refresh(runRow({ format: MemoryExportFormat.Archive }));
      expect(versions.getById).not.toHaveBeenCalled();
    });
  });

  describe('cancel and retry', () => {
    it('cancels the Studio export and ends the run as cancelled', async () => {
      // the version as cancel reads it, then as the refresh after the cancel reads it
      versions.getById
        .mockResolvedValueOnce(versionRow())
        .mockResolvedValueOnce(versionRow({ state: StudioExportVersionState.Cancelled }));

      const run = await sut.cancel(auth, runRow());

      expect(memories.requestExportCancel).toHaveBeenCalledWith(RUN, OWNER);
      expect(studioExports.cancelVersion).toHaveBeenCalledWith(
        expect.objectContaining({ id: VERSION }),
        'cancelled',
        expect.any(String),
      );
      expect(run).toEqual(expect.objectContaining({ status: MemoryExportStatus.Cancelled, error: null }));
      expect(projects.delete).toHaveBeenCalledWith(PROJECT);
    });

    it('answers a finished run with its final state', async () => {
      const done = runRow({ status: MemoryExportStatus.Failed });
      await expect(sut.cancel(auth, done)).resolves.toBe(done);
      expect(studioExports.cancelVersion).not.toHaveBeenCalled();
    });
  });

  describe('download and save', () => {
    it('serves a result kept with the memory through the Studio export checks', async () => {
      versions.getById.mockResolvedValue(published());
      const file = await sut.download(auth, runRow({ status: MemoryExportStatus.Ready }));
      expect(studioExports.download).toHaveBeenCalledWith(auth, VERSION);
      expect(file).toEqual(
        expect.objectContaining({ disposition: "attachment; filename*=UTF-8''Lake%20trip.mp4", type: 'video/mp4' }),
      );
    });

    it('serves a saved result from its library asset while the owner still has it', async () => {
      const saved = published({ scope: StudioExportScope.Library, resultAssetId: 'asset-saved' });
      versions.getForOwner.mockResolvedValue(saved);
      assets.getByIds.mockResolvedValue([{ id: 'asset-saved', originalPath: '/data/upload/v.mp4', deletedAt: null }]);
      await sut.download(auth, runRow({ status: MemoryExportStatus.Ready }));
      expect(storage.createReadStream).toHaveBeenCalledWith('/data/upload/v.mp4', 'video/mp4');

      assets.getByIds.mockResolvedValue([{ id: 'asset-saved', originalPath: '/x', deletedAt: new Date() }]);
      await expect(sut.download(auth, runRow({ status: MemoryExportStatus.Ready }))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses before the render is ready, and a version that is not the owner’s', async () => {
      await expect(sut.download(auth, runRow())).rejects.toBeInstanceOf(BadRequestException);
      versions.getForOwner.mockResolvedValue(undefined);
      await expect(sut.download(auth, runRow({ status: MemoryExportStatus.Ready }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('saves to the library only when asked, and remembers the asset', async () => {
      const run = await sut.saveToLibrary(auth, runRow({ status: MemoryExportStatus.Ready }));
      expect(studioExports.saveToLibrary).toHaveBeenCalledWith(auth, VERSION);
      expect(run.settings).toEqual(expect.objectContaining({ savedAssetId: 'asset-saved' }));
    });
  });

  describe('cleanup', () => {
    it("removes a deleted memory's highlights: the render stops, the project and the kept file go", async () => {
      memories.searchExports.mockResolvedValue([runRow(), runRow({ format: MemoryExportFormat.Archive })]);
      versions.getById.mockResolvedValue(published());

      await sut.removeForMemory(OWNER, MEMORY);

      expect(studioExports.cancelVersion).toHaveBeenCalledTimes(1);
      expect(storage.unlink).toHaveBeenCalledWith('/data/exports/o/studio-exports/versions/v.mp4');
      expect(projects.delete).toHaveBeenCalledExactlyOnceWith(PROJECT);
    });

    it('keeps a copy the owner saved to the library', async () => {
      memories.searchExports.mockResolvedValue([runRow()]);
      versions.getById.mockResolvedValue(
        published({ scope: StudioExportScope.Library, outputPath: '/data/upload/v.mp4', resultAssetId: 'a' }),
      );
      await sut.removeForMemory(OWNER, MEMORY);
      expect(storage.unlink).not.toHaveBeenCalled();
      expect(projects.delete).toHaveBeenCalledWith(PROJECT);
    });

    it('removes the highlights of memories the 30-day cleanup is about to delete', async () => {
      memories.getHighlightsOfExpiredMemories.mockResolvedValue([runRow()]);
      await sut.removeForExpiredMemories();
      expect(projects.delete).toHaveBeenCalledWith(PROJECT);
    });

    it('deleting a run removes its project too', async () => {
      await sut.remove(auth, runRow());
      expect(studioExports.cancelVersion).toHaveBeenCalled();
      expect(projects.delete).toHaveBeenCalledWith(PROJECT);
      expect(memories.deleteExport).toHaveBeenCalledWith(RUN, OWNER);
    });
  });
});

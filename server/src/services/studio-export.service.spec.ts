import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { StudioExportCreateDto } from 'src/dtos/studio-export.dto.js';
import {
  AssetLockReason,
  AssetType,
  ColorMatrix,
  ColorPrimaries,
  ColorTransfer,
  JobName,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlDestinationKind,
  MlWorkload,
  PushEventType,
  StudioExportRemoteReason,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import {
  StudioExportPublished,
  StudioExportRefusal,
  StudioExportRepository,
  StudioExportVersion,
  StudioExportVersionSource,
} from 'src/repositories/studio-export.repository.js';
import { StudioExportService, settleStudioExportPublication } from 'src/services/studio-export.service.js';
import { StudioAuthorizedEntry } from 'src/services/studio-resource.service.js';
import { studioExportStagingFolder } from 'src/utils/studio-export.js';
import { StudioResourceKind } from 'src/utils/studio-resources.js';

vi.mock('src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/config.js')>()),
  getConfig: vi.fn().mockResolvedValue({ machineLearning: { nsfwDetection: { hideFromLibrary: true } } }),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const OWNER = '0195e2a0-0000-4000-8000-00000000000a';
const PARTNER = '0195e2a0-0000-4000-8000-00000000000b';
const PROJECT = '0195e2a0-0000-7000-8000-0000000000p1'.replace('p1', '01');
const RENDER = '0195e2a0-0000-7000-8000-0000000000r1'.replace('r1', '02');
const PUBLISH = '0195e2a0-0000-7000-8000-000000000003';
const VERSION = '0195e2a0-0000-7000-8000-000000000004';
const CLIP = '0195e2a0-0000-4000-8000-000000000011';
const SHARED_CLIP = '0195e2a0-0000-4000-8000-000000000012';
const SMOOTH_DESTINATION = '0195e2a0-0000-4000-8000-000000000021';
const LIBRARY_ONLY_DESTINATION = '0195e2a0-0000-4000-8000-000000000022';

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

/** A live render session for a LAN worker that verified 1080p H.264 in SDR (FL-42). */
const liveSession = (
  overrides: Partial<{
    destination: MediaOperationDestination;
    gpuMemoryBytes: string | null;
    codecs: string[] | null;
    formats: string[] | null;
    colorPrecision: { maxBitDepth: number; hdr10: boolean; dolbyVision: boolean } | null;
    conformanceReportedAt: Date;
  }> = {},
) => ({
  worker: {
    id: 'worker-1',
    status: 'active',
    destination: overrides.destination ?? MediaOperationDestination.Lan,
    engineDigest: 'engine-1',
    conformanceMaxAgeMs: 24 * 60 * 60 * 1000,
  },
  session: {
    id: 'session-1',
    scopes: [MediaOperationKind.StudioExport],
    gpuMemoryBytes: overrides.gpuMemoryBytes === undefined ? String(12 * 1024 ** 3) : overrides.gpuMemoryBytes,
    engineDigest: 'engine-1',
    conformanceReportedAt: overrides.conformanceReportedAt ?? new Date(),
    codecs: overrides.codecs === undefined ? ['h264_nvenc', 'hevc_nvenc'] : overrides.codecs,
    colorPrecision: overrides.colorPrecision ?? null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
  },
  capabilities: {
    codecs: overrides.codecs === undefined ? ['h264_nvenc', 'hevc_nvenc'] : (overrides.codecs ?? []),
    formats: overrides.formats === undefined ? ['mp4'] : (overrides.formats ?? []),
  },
});

/** A Freecut graph at 30000/1001 with one clip of CLIP and its linked audio. */
const clipGraph = (overrides: { items?: Record<string, unknown>[]; transitions?: unknown[] } = {}) => ({
  id: 'project',
  metadata: { fps: 30_000 / 1001, frameRate: { num: 30_000, den: 1001 } },
  timeline: {
    tracks: [{ id: 'v1' }, { id: 'a1' }],
    items: overrides.items ?? [
      { id: 'clip-v', type: 'video', trackId: 'v1', mediaId: CLIP, from: 0, durationInFrames: 300 },
      { id: 'clip-a', type: 'audio', trackId: 'a1', mediaId: CLIP, from: 0, durationInFrames: 300 },
    ],
    transitions: overrides.transitions ?? [],
    keyframes: [],
  },
});

/** What the library knows about a source: a time base, a packet scan and its audio. */
const facts = (
  assetId: string,
  overrides: { ownDuration?: number[]; startPts?: number; audio?: Record<string, unknown> | null } = {},
) => ({
  assetId,
  video: { timeBase: 30_000, pixelFormat: 'yuv420p', colorTransfer: 1 },
  packets: {
    keyframePts: [overrides.startPts ?? 0, 30_030],
    keyframeAccDuration: [1001, 31_031],
    keyframeOwnDuration: overrides.ownDuration ?? [1001, 1001],
    totalDuration: 300_300,
    packetCount: 300,
    outputFrames: 300,
  },
  audio:
    overrides.audio === undefined
      ? { codecName: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48_000 }
      : overrides.audio,
});

/** What the production probe reports for a rendered 8-bit SDR export with stereo audio. */
const renderedOutput = (overrides: { video?: Record<string, unknown>; audio?: Record<string, unknown>[] } = {}) => ({
  format: { duration: 10, bitrate: 0 },
  videoStreams: [
    {
      index: 0,
      width: 1920,
      height: 1080,
      codecName: 'h264',
      pixelFormat: 'yuv420p',
      colorTransfer: 1,
      duration: 10,
      frameRate: 30,
      frameRateRational: { num: 30, den: 1 },
      ...overrides.video,
    },
  ],
  audioStreams: overrides.audio ?? [
    { index: 1, codecName: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48_000, duration: 10 },
  ],
});

describe(StudioExportService.name, () => {
  let sut: StudioExportService;
  let repository: Record<string, ReturnType<typeof vi.fn>> & {
    publish: ReturnType<typeof vi.fn<StudioExportRepository['publish']>>;
  };
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
  let renderWorkers: {
    listLiveSessions: ReturnType<typeof vi.fn>;
    getSessionCapabilities: ReturnType<typeof vi.fn<RenderWorkerRepository['getSessionCapabilities']>>;
  };
  let media: {
    probe: ReturnType<typeof vi.fn>;
    probeHdrMastering: ReturnType<typeof vi.fn<MediaRepository['probeHdrMastering']>>;
    probePackets: ReturnType<typeof vi.fn>;
    inspectImageEncoding: ReturnType<typeof vi.fn>;
    getImageMetadata: ReturnType<typeof vi.fn>;
    generateHdrRenditions: ReturnType<typeof vi.fn>;
    writeStrippedStill: ReturnType<typeof vi.fn>;
  };
  let restorations: { queueExportSmoothMotion: ReturnType<typeof vi.fn> };
  let events: { emit: ReturnType<typeof vi.fn> };
  let mlDestinations: { getById: ReturnType<typeof vi.fn> };
  let staged: string;

  // Model the two production reads separately: official sessions and their fork-owned proof.
  const mockRenderSessions = (fixtures: ReturnType<typeof liveSession>[]) => {
    const sessions = fixtures.map(({ worker, session }, index) => ({
      worker,
      session: { ...session, id: `session-${index + 1}` },
    }));
    renderWorkers.listLiveSessions.mockResolvedValue(sessions);
    renderWorkers.getSessionCapabilities.mockImplementation((id: string) => {
      const index = sessions.findIndex(({ session }) => session.id === id);
      return Promise.resolve(index === -1 ? undefined : fixtures[index].capabilities);
    });
  };

  beforeAll(() => StorageCore.setMediaLocation('/data'));

  beforeEach(() => {
    staged = `${studioExportStagingFolder(OWNER, RENDER)}/out.mp4`;
    repository = {
      createWithRender: vi.fn(),
      getById: vi.fn(),
      getForOwner: vi.fn(),
      getByRenderOperation: vi.fn(),
      getSources: vi.fn().mockResolvedValue([sourceRow()]),
      getSourceMediaFacts: vi.fn().mockResolvedValue([]),
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
      publicationFollowups: vi
        .fn()
        .mockResolvedValue({ revision: 1, metadataAccepted: true, notification: 'accepted', smoothMotion: 'accepted' }),
      transitionPublicationFollowup: vi.fn().mockResolvedValue(true),
      publicationNeedsAttention: vi.fn().mockResolvedValue(undefined),
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
      listGeneratedResources: vi.fn().mockResolvedValue([]),
      listImportDeclarations: vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue({ id: PROJECT, ownerId: OWNER, name: 'Lake trip', deletedAt: null }),
      getRevision: vi.fn().mockResolvedValue({ revision: 3, digest: 'digest-3', envelope: { graph: { clips: [] } } }),
    };
    studio = {
      authorizeRevision: vi.fn(),
      // the owner rule of StudioProjectService.requireOwnedProject, for a stranger: 404 as if missing
      requireOwnedProject: vi.fn(async (actor: AuthDto, id: string) => {
        const project = (await (projects.getById as (id: string) => Promise<{ ownerId: string } | undefined>)(id)) as
          { ownerId: string } | undefined;
        if (!project || project.ownerId !== actor.user.id) {
          throw new NotFoundException('Studio project not found');
        }
        return project;
      }),
    };
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
    jobs = { queue: vi.fn().mockResolvedValue(undefined), queueInTransaction: vi.fn().mockResolvedValue(undefined) };
    renderWorkers = {
      listLiveSessions: vi.fn(),
      getSessionCapabilities: vi.fn<RenderWorkerRepository['getSessionCapabilities']>(),
    };
    mockRenderSessions([liveSession()]);
    media = {
      inspectImageEncoding: vi.fn(),
      getImageMetadata: vi.fn(),
      generateHdrRenditions: vi.fn((_input, outputs) => {
        for (const output of outputs) files.set(output.path, 2048);
        return Promise.resolve();
      }),
      writeStrippedStill: vi.fn((_input, output) => {
        files.set(output, 2048);
        return Promise.resolve();
      }),
      probe: vi.fn().mockResolvedValue(renderedOutput()),
      probeHdrMastering: vi.fn<MediaRepository['probeHdrMastering']>().mockResolvedValue([]),
      probePackets: vi.fn().mockResolvedValue(null),
    };
    restorations = {
      queueExportSmoothMotion: vi
        .fn()
        .mockResolvedValue({ id: 'restoration-1', previewOperationId: 'preview-operation-1' }),
    };
    events = { emit: vi.fn().mockResolvedValue(undefined) };
    mlDestinations = {
      getById: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(
            id === SMOOTH_DESTINATION
              ? { id, enabled: true, kind: MlDestinationKind.Lan, workloads: [MlWorkload.Interpolation] }
              : id === LIBRARY_ONLY_DESTINATION
                ? { id, enabled: true, kind: MlDestinationKind.Lan, workloads: [MlWorkload.Clip] }
                : undefined,
          ),
        ),
    };

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
      renderWorkers as never,
      media as never,
      restorations as never,
      mlDestinations as never,
      events as never,
    );
  });

  describe('create', () => {
    const authorized = (overrides: Record<string, unknown> = {}) => ({
      project: { id: PROJECT, name: 'Lake trip' },
      access: 'owner',
      revision: { id: 'rev-row', revision: 3, digest: 'digest-3' },
      envelope: { graph: clipGraph() },
      manifest: { complete: true, refusedCount: 0, digest: 'm', entries: [entry()] },
      ...overrides,
    });
    const dto = {
      destination: MediaOperationDestination.Lan,
      format: 'mp4-h264',
      color: 'preserve',
      resolution: '1080p',
    } as StudioExportCreateDto;

    it.each([{ subtitleMode: 'burn' }, { subtitleMode: 'off' }, { audio: 'stereo' }])(
      'refuses photo-only incompatible settings %j before creating work',
      async (settings) => {
        studio.authorizeRevision.mockResolvedValue(authorized());
        await expect(
          sut.create(auth(), PROJECT, {
            ...dto,
            format: 'sdr-jpeg',
            resolution: 'original',
            ...settings,
          } as StudioExportCreateDto),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(repository.createWithRender).not.toHaveBeenCalled();
        expect(renderWorkers.getSessionCapabilities).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['decoder only', ['h264_cuvid'], ['mp4']],
      ['bare codec name', ['h264'], ['mp4']],
      ['wrong container', ['webcodecs-avc'], ['webm']],
      ['missing container', ['webcodecs-avc'], []],
      ['null container evidence', ['webcodecs-avc'], null],
    ])('refuses %s before creating an export or render job', async (_name, codecs, formats) => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      mockRenderSessions([liveSession({ codecs, formats })]);
      repository.createWithRender.mockResolvedValue({
        operation: operation({ status: MediaOperationStatus.Queued }),
        version: versionRow({ state: StudioExportVersionState.Rendering }),
      });

      await expect(sut.create(auth(), PROJECT, dto)).rejects.toMatchObject({
        response: { code: 'studio_export_unsupported', reason: 'codec-unavailable' },
      });
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it('refuses split encoder and container evidence before creating any work', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      mockRenderSessions([
        liveSession({ codecs: ['webcodecs-avc'], formats: ['webm'] }),
        liveSession({ codecs: ['libaom-av1'], formats: ['mp4'] }),
      ]);
      repository.createWithRender.mockResolvedValue({
        operation: operation({ status: MediaOperationStatus.Queued }),
        version: versionRow({ state: StudioExportVersionState.Rendering }),
      });

      await expect(sut.create(auth(), PROJECT, dto)).rejects.toMatchObject({
        response: { code: 'studio_export_unsupported', reason: 'codec-unavailable' },
      });
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it('refuses a live session with no persisted output proof even when its codec list names an encoder', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      renderWorkers.getSessionCapabilities.mockResolvedValue(undefined);

      await expect(sut.create(auth(), PROJECT, dto)).rejects.toMatchObject({
        response: { code: 'studio_export_unsupported', reason: 'codec-unavailable' },
      });
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it('never borrows output proof from a different session with insufficient memory', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      mockRenderSessions([
        liveSession({ codecs: ['webcodecs-avc'], formats: ['webm'] }),
        liveSession({ codecs: ['webcodecs-avc'], formats: ['mp4'], gpuMemoryBytes: String(2 * 1024 ** 3) }),
      ]);

      await expect(sut.create(auth(), PROJECT, dto)).rejects.toMatchObject({
        response: { code: 'studio_export_unsupported', reason: 'codec-unavailable' },
      });
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it.each([
      ['webcodecs-avc', 'mp4'],
      ['WEBCODECS-AVC', 'MP4'],
      ['LIBX264', 'MP4'],
    ])('queues an export when one session verified writer %s and container %s', async (codec, container) => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      mockRenderSessions([liveSession({ codecs: [codec], formats: [container] })]);
      repository.createWithRender.mockResolvedValue({
        operation: operation({ status: MediaOperationStatus.Queued }),
        version: versionRow({ state: StudioExportVersionState.Rendering }),
      });

      await expect(sut.create(auth(), PROJECT, dto)).resolves.toMatchObject({
        version: { id: VERSION, state: StudioExportVersionState.Rendering },
        operation: { id: RENDER, status: MediaOperationStatus.Queued },
      });
      expect(repository.createWithRender).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          settings: { format: 'mp4-h264', color: 'preserve', resolution: '1080p', quality: 'high', audio: 'preserve' },
        }),
        expect.objectContaining({ projectId: PROJECT, revision: 3 }),
      );
    });

    it('validates quality at admission and keeps the chosen preset in both durable records', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      repository.createWithRender.mockResolvedValue({
        operation: operation({ status: MediaOperationStatus.Queued }),
        version: versionRow({ state: StudioExportVersionState.Rendering }),
      });
      for (const quality of ['low', 'medium', 'high', 'ultra'] as const) {
        const request = StudioExportCreateDto.schema.parse({ ...(dto as object), quality });
        await sut.create(auth(), PROJECT, request);
        const [job, version] = repository.createWithRender.mock.calls.at(-1)!;
        expect(job.settings).toEqual(expect.objectContaining({ quality }));
        expect(version.settings).toEqual(job.settings);
      }
      for (const quality of ['lossless', null, 10, {}]) {
        expect(StudioExportCreateDto.schema.safeParse({ ...(dto as object), quality }).success).toBe(false);
      }
    });

    it('validates subtitle modes and preserves explicit choices in both durable records without changing legacy settings', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      repository.createWithRender.mockResolvedValue({
        operation: operation({ status: MediaOperationStatus.Queued }),
        version: versionRow({ state: StudioExportVersionState.Rendering }),
      });
      for (const subtitleMode of ['burn', 'off'] as const) {
        const request = StudioExportCreateDto.schema.parse({ ...(dto as object), subtitleMode });
        await sut.create(auth(), PROJECT, request);
        const [job, version] = repository.createWithRender.mock.calls.at(-1)!;
        expect(job.settings).toEqual(expect.objectContaining({ subtitleMode }));
        expect(version.settings).toEqual(job.settings);
      }
      await sut.create(auth(), PROJECT, dto);
      const [job, version] = repository.createWithRender.mock.calls.at(-1)!;
      expect(job.settings).not.toHaveProperty('subtitleMode');
      expect(version.settings).toEqual(job.settings);
      for (const subtitleMode of ['sidecar', 'embedded', null, 10, {}]) {
        expect(StudioExportCreateDto.schema.safeParse({ ...(dto as object), subtitleMode }).success).toBe(false);
      }
    });

    it('refuses a reviewer an export before resolving any source for them (FL-280)', async () => {
      studio.requireOwnedProject.mockRejectedValue(
        new ForbiddenException('Only the owner can export a Studio project'),
      );
      await expect(sut.create(auth(), PROJECT, dto)).rejects.toBeInstanceOf(ForbiddenException);
      expect(studio.authorizeRevision).not.toHaveBeenCalled();
    });

    it('renders only at home: a Frameleaf Cloud destination is refused before anything is resolved', async () => {
      await expect(
        sut.create(auth(), PROJECT, {
          ...(dto as object),
          destination: MediaOperationDestination.FrameleafCloud,
          cloudConsent: true,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(studio.authorizeRevision).not.toHaveBeenCalled();
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it.each([
      [[], {}, 'no-qualified-worker'],
      [[liveSession({ gpuMemoryBytes: String(2 * 1024 ** 3) })], {}, 'insufficient-memory'],
      [[liveSession({ codecs: ['h264_nvenc'] })], { format: 'prores-422-hq' }, 'codec-unavailable'],
      [[liveSession()], { format: 'mp4-hevc-main10', color: 'hdr10' }, 'incompatible-color'],
      [[liveSession({ destination: MediaOperationDestination.Local })], {}, 'no-qualified-worker'],
      [[liveSession({ conformanceReportedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })], {}, 'no-qualified-worker'],
    ])(
      'refuses an export no qualified render session verified, with an actionable reason (FL-42) %#',
      async (sessions, settings, reason) => {
        studio.authorizeRevision.mockResolvedValue(authorized());
        mockRenderSessions(sessions);

        const error = await sut
          .create(auth(), PROJECT, { ...(dto as object), ...settings } as never)
          .catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({ code: 'studio_export_unsupported', reason });
        expect(repository.createWithRender).not.toHaveBeenCalled();
      },
    );

    it('queues an HDR10 export only on a session that verified 10-bit HDR10 and a HEVC encoder (FL-42)', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      mockRenderSessions([
        liveSession({
          codecs: ['hevc_nvenc', 'h264_nvenc'],
          colorPrecision: { maxBitDepth: 10, hdr10: true, dolbyVision: false },
        }),
      ]);
      repository.createWithRender.mockRejectedValue(new Error('created'));

      await expect(
        sut.create(auth(), PROJECT, {
          ...(dto as object),
          format: 'mp4-hevc-main10',
          color: 'hdr10',
          mastering: { primaries: 'bt2020', maxNits: 1000, minNits: 0.005 },
        } as never),
      ).rejects.toThrow('created');
    });

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

    it('keeps Smooth motion out of the render: it rides along as its own job for after publication (FL-162)', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      repository.createWithRender.mockResolvedValue({
        operation: operation({ status: MediaOperationStatus.Queued }),
        version: versionRow({ state: StudioExportVersionState.Rendering }),
      });

      await sut.create(auth(), PROJECT, {
        ...(dto as object),
        smoothMotion: { factor: 4, destinationId: SMOOTH_DESTINATION },
      } as never);

      const [job] = repository.createWithRender.mock.calls[0];
      // the render itself stays on the home network destination it was asked for
      expect(job.destination).toBe(MediaOperationDestination.Lan);
      expect(job.snapshot.smoothMotion).toEqual({ factor: 4, destinationId: SMOOTH_DESTINATION });
      expect(job.settings).not.toHaveProperty('smoothMotion');
    });

    it('refuses Smooth motion on a destination that does not run it, before anything is queued', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      for (const destinationId of [LIBRARY_ONLY_DESTINATION, '0199aaaa-bbbb-4ccc-8ddd-eeeeffff00ff']) {
        await expect(
          sut.create(auth(), PROJECT, { ...(dto as object), smoothMotion: { factor: 2, destinationId } } as never),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it('keeps the result with its project when asked, for a render the owner saves to the library later (FL-194)', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized());
      repository.createWithRender.mockResolvedValue({
        operation: operation({ status: MediaOperationStatus.Queued }),
        version: versionRow({ state: StudioExportVersionState.Rendering }),
      });

      await sut.create(auth(), PROJECT, dto, { retainInProject: true });
      expect(repository.createWithRender.mock.calls[0][0].snapshot).toEqual(
        expect.objectContaining({ retain: 'project' }),
      );

      await sut.create(auth(), PROJECT, dto);
      expect(repository.createWithRender.mock.calls[1][0].snapshot).not.toHaveProperty('retain');
    });
  });

  describe('declared timing and output contract (FL-93, FL-102)', () => {
    const authorizedWith = (graph: unknown, entries = [entry()]) => ({
      project: { id: PROJECT, name: 'Lake trip' },
      access: 'owner',
      revision: { id: 'rev-row', revision: 3, digest: 'digest-3' },
      envelope: { graph },
      manifest: { complete: true, refusedCount: 0, digest: 'm', entries },
    });
    const dto = {
      destination: MediaOperationDestination.Lan,
      format: 'mp4-h264',
      color: 'preserve',
      resolution: '1080p',
    };
    const snapshotOf = async (graph: unknown, overrides: Record<string, unknown> = {}, entries = [entry()]) => {
      studio.authorizeRevision.mockResolvedValue(authorizedWith(graph, entries));
      repository.createWithRender.mockResolvedValue({
        operation: operation({ status: MediaOperationStatus.Queued }),
        version: versionRow({ state: StudioExportVersionState.Rendering }),
      });
      await sut.create(auth(), PROJECT, { ...dto, ...overrides } as never);
      const [job, version] = repository.createWithRender.mock.calls.at(-1)!;
      return { snapshot: job.snapshot, version };
    };

    it('binds frame ranges to the stored graph and refuses invalid bounds and timestamp passthrough before jobs', async () => {
      const graph = clipGraph({
        items: [{ id: 'still', type: 'image', mediaId: CLIP, from: 0, durationInFrames: 30 }],
      });
      const range = { inPoint: 5, outPoint: 7 };
      const parsed = StudioExportCreateDto.schema.parse({ ...dto, range });
      const { snapshot, version } = await snapshotOf(graph, parsed);
      expect(version.settings.range).toEqual(range);
      expect(snapshot.contract.range).toEqual({ ...range, cadence: '30000/1001' });
      expect(snapshot.studio).not.toHaveProperty('graph');
      repository.createWithRender.mockClear();
      for (const invalid of [
        { inPoint: 2, outPoint: 2 },
        { inPoint: 0.5, outPoint: 2 },
        null,
        { inPoint: 1, outPoint: 2, extra: true },
      ]) {
        expect(StudioExportCreateDto.schema.safeParse({ ...dto, range: invalid }).success).toBe(false);
      }
      await expect(snapshotOf(graph, { range: { inPoint: 0, outPoint: 31 } })).rejects.toThrow('exceeds');
      repository.getSourceMediaFacts.mockResolvedValue([facts(CLIP)]);
      await expect(snapshotOf(clipGraph(), { range })).rejects.toThrow('timestamp passthrough');
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it('keeps the presentation timestamps of one variable-rate source the edit does not retime', async () => {
      repository.getSourceMediaFacts.mockResolvedValue([facts(CLIP, { ownDuration: [1001, 1502], startPts: 2002 })]);
      const { snapshot } = await snapshotOf(clipGraph());
      expect(snapshot.timing).toEqual({
        cadence: '30000/1001',
        decision: expect.objectContaining({ mode: 'passthrough', cadence: null }),
        timeBase: '1/30000',
        sources: [
          {
            key: `library-asset:${CLIP}`,
            assetId: CLIP,
            timeBase: '1/30000',
            originTicks: 2002,
            cadence: null,
            variableFrameRate: true,
            trackTimescale: 30_000,
            audio: { sampleRate: 48_000, channels: 2, channelLayout: 'stereo' },
          },
        ],
      });
    });

    it('records a conversion onto the declared cadence for a composition, with one tick per frame', async () => {
      repository.getSourceMediaFacts.mockResolvedValue([
        facts(CLIP),
        {
          ...facts(SHARED_CLIP, { ownDuration: [1, 1] }),
          video: { timeBase: 25, pixelFormat: 'yuv420p', colorTransfer: 1 },
        },
      ]);
      const graph = clipGraph({
        items: [
          { id: 'a', type: 'video', trackId: 'v1', mediaId: CLIP, from: 0, durationInFrames: 30 },
          { id: 'b', type: 'video', trackId: 'v1', mediaId: SHARED_CLIP, from: 30, durationInFrames: 30 },
        ],
      });
      const entries = [entry(), entry({ key: `library-asset:${SHARED_CLIP}`, id: SHARED_CLIP })];
      const { snapshot } = await snapshotOf(graph, {}, entries);
      expect(snapshot.timing.decision).toEqual(
        expect.objectContaining({
          mode: 'convert',
          cadence: '30000/1001',
          reason: expect.stringContaining('2 sources'),
        }),
      );
      expect(snapshot.timing.timeBase).toBe('1001/30000');
      expect(snapshot.timing.sources.map((source: { cadence: string }) => source.cadence)).toEqual([
        '30000/1001',
        '25/1',
      ]);
    });

    it('records a retimed single source as a conversion even at its own cadence', async () => {
      repository.getSourceMediaFacts.mockResolvedValue([facts(CLIP)]);
      const graph = clipGraph({
        items: [{ id: 'a', type: 'video', trackId: 'v1', mediaId: CLIP, from: 0, durationInFrames: 150, speed: 2 }],
      });
      const { snapshot } = await snapshotOf(graph);
      expect(snapshot.timing.decision).toEqual(
        expect.objectContaining({ mode: 'convert', cadence: '30000/1001', reason: expect.stringContaining('retimes') }),
      );
    });

    it('refuses a project whose frame rate has no exact reading, and a source never scanned', async () => {
      repository.getSourceMediaFacts.mockResolvedValue([facts(CLIP)]);
      studio.authorizeRevision.mockResolvedValue(authorizedWith({ ...clipGraph(), metadata: { fps: 27.3 } }));
      await expect(sut.create(auth(), PROJECT, dto as never)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'studio_export_timing_unknown' }),
      });

      repository.getSourceMediaFacts.mockResolvedValue([{ ...facts(CLIP), packets: null }]);
      studio.authorizeRevision.mockResolvedValue(authorizedWith(clipGraph()));
      await expect(sut.create(auth(), PROJECT, dto as never)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'studio_export_timing_unknown' }),
      });
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });

    it('promises the widest source layout, or a stereo downmix only when asked for', async () => {
      const surround = { codecName: 'eac3', channels: 6, channelLayout: '5.1(side)', sampleRate: 48_000 };
      repository.getSourceMediaFacts.mockResolvedValue([facts(CLIP, { audio: surround })]);
      mockRenderSessions([
        liveSession({
          codecs: ['hevc_nvenc', 'h264_nvenc'],
          colorPrecision: { maxBitDepth: 10, hdr10: false, dolbyVision: false },
        }),
      ]);

      const preserved = await snapshotOf(clipGraph(), { format: 'mp4-hevc-main10' });
      expect(preserved.snapshot.contract).toEqual({
        video: { minBitDepth: 10, transfer: null },
        audio: { policy: 'preserve', channels: 6, channelLayout: '5.1(side)', sampleRate: 48_000 },
      });
      expect(preserved.version.settings).toEqual(expect.objectContaining({ audio: 'preserve' }));

      const stereo = await snapshotOf(clipGraph(), { audio: 'stereo' });
      expect(stereo.snapshot.contract.audio).toEqual({
        policy: 'stereo',
        channels: 2,
        channelLayout: 'stereo',
        sampleRate: 48_000,
      });
    });

    it('promises no audio when every audio clip is muted, and 10-bit PQ for HDR10', async () => {
      repository.getSourceMediaFacts.mockResolvedValue([facts(CLIP)]);
      mockRenderSessions([
        liveSession({ codecs: ['hevc_nvenc'], colorPrecision: { maxBitDepth: 10, hdr10: true, dolbyVision: false } }),
      ]);
      const graph = clipGraph({
        items: [
          { id: 'v', type: 'video', trackId: 'v1', mediaId: CLIP, from: 0, durationInFrames: 30 },
          { id: 'a', type: 'audio', trackId: 'a1', mediaId: CLIP, from: 0, durationInFrames: 30, muted: true },
        ],
      });
      const mastering = { primaries: 'bt2020', maxNits: 1000, minNits: 0.005 };
      const { snapshot, version } = await snapshotOf(graph, { format: 'mp4-hevc-main10', color: 'hdr10', mastering });
      expect(snapshot.contract).toEqual({ video: { minBitDepth: 10, transfer: 'smpte2084', mastering }, audio: null });
      expect(version.settings).toMatchObject({ mastering });
      mastering.maxNits = 4000;
      expect(version.settings.mastering.maxNits).toBe(1000);
      expect(snapshot.contract.video.mastering.maxNits).toBe(1000);
    });

    it('refuses PQ submission with unknown mastering instead of guessing a display (FL-107)', async () => {
      mockRenderSessions([
        liveSession({ codecs: ['hevc_nvenc'], colorPrecision: { maxBitDepth: 10, hdr10: true, dolbyVision: false } }),
      ]);
      await expect(snapshotOf(clipGraph(), { format: 'mp4-hevc-main10', color: 'hdr10' })).rejects.toMatchObject({
        response: { code: 'studio_export_mastering_unknown' },
      });
      expect(repository.createWithRender).not.toHaveBeenCalled();
    });
  });

  describe('render contract', () => {
    it('binds transport bytes to the recorded revision and source checksums', async () => {
      repository.getByRenderOperation.mockResolvedValue(versionRow());
      await expect(sut.verifyRenderSources(operation({ revisionId: 'digest-3' }), [entry()])).resolves.toBeUndefined();
      await expect(
        sut.verifyRenderSources(operation({ revisionId: 'digest-3' }), [entry({ checksum: 'changed' })]),
      ).rejects.toThrow('changed');
      await expect(sut.verifyRenderSources(operation({ revisionId: 'other' }), [entry()])).rejects.toBeInstanceOf(
        BadRequestException,
      );
      repository.getByRenderOperation.mockResolvedValue(undefined);
      await expect(sut.verifyRenderSources(operation({ revisionId: 'digest-3' }), [entry()])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

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

    it('carries Smooth motion into its publication (FL-162)', async () => {
      repository.stage = vi.fn(() => Promise.resolve({ version: versionRow(), operation: { id: PUBLISH } }));

      await sut.onRenderCompleted(
        operation({
          snapshot: { kind: 'studio-export', smoothMotion: { factor: 8, destinationId: SMOOTH_DESTINATION } },
        }),
        'worker-1',
        { path: staged, checksum: 'ab'.repeat(32), sizeInBytes: '1024', contentType: 'video/mp4' },
      );

      const publish = repository.stage.mock.calls[0][3](versionRow());
      expect(publish.snapshot.smoothMotion).toEqual({ factor: 8, destinationId: SMOOTH_DESTINATION });
    });

    it('carries a render that stays with its project into its publication (FL-194)', async () => {
      repository.stage = vi.fn(() => Promise.resolve({ version: versionRow(), operation: { id: PUBLISH } }));

      await sut.onRenderCompleted(operation({ snapshot: { kind: 'studio-export', retain: 'project' } }), 'worker-1', {
        path: staged,
        checksum: 'ab'.repeat(32),
        sizeInBytes: '1024',
        contentType: 'video/mp4',
      });

      const publish = repository.stage.mock.calls[0][3](versionRow());
      expect(publish.snapshot).toEqual(expect.objectContaining({ retain: 'project' }));
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

    it.each(['sdr-jpeg', 'hdr-jpeg', 'hdr-heic'])(
      'publishes %s only after server sanitization and stores its new identity',
      async (format) => {
        const photo = {
          version: 1,
          format,
          width: 128,
          height: 64,
          frame: 0,
          dynamicRange: format === 'sdr-jpeg' ? 'sdr' : 'hdr',
          outputIntent: 'hdr',
          referenceWhite: 203,
          renderer: 'frameleaf-studio-image-v1',
        };
        const request = job();
        request.operation.snapshot = {
          ...(request.operation.snapshot as object),
          contract: { image: photo, video: { minBitDepth: 8, transfer: null }, audio: null },
        };
        repository.getById.mockResolvedValue(
          versionRow({
            outputPath: staged,
            settings: { format, color: 'preserve', resolution: 'original' },
            outputContentType: format === 'hdr-heic' ? 'image/heic' : 'image/jpeg',
          }),
        );
        media.inspectImageEncoding.mockResolvedValue({
          width: 128,
          height: 64,
          dynamicRange: photo.dynamicRange,
          container: format === 'hdr-heic' ? 'heif' : 'jpeg',
          codec: format === 'hdr-heic' ? 'hevc' : 'jpeg',
          bitDepth: format === 'hdr-heic' ? 10 : 8,
          transfer: format === 'hdr-heic' ? 16 : 'adaptive',
          reconstructionAvailable: true,
        });
        crypto.hashFile
          .mockResolvedValueOnce(Buffer.from('ab'.repeat(32), 'hex'))
          .mockResolvedValue(Buffer.from('cd'.repeat(32), 'hex'));
        repository.publish.mockResolvedValue(published());
        await sut.run(request);
        const input = repository.publish.mock.calls[0]?.[0];
        expect(input).toMatchObject({
          assetType: AssetType.Image,
          checksum: Buffer.from('cd'.repeat(32), 'hex'),
          sizeInBytes: 2048,
          originalFileName: `Lake trip_still.${format === 'hdr-heic' ? 'heic' : 'jpg'}`,
        });
        expect(input.path).toContain(VERSION + '-');
        expect(storage.rename).not.toHaveBeenCalledWith(staged, expect.anything());
        expect(await storage.checkFileExists(staged)).toBe(true);
        expect(media.probe).not.toHaveBeenCalled();
        if (format === 'sdr-jpeg') {
          expect(media.writeStrippedStill).toHaveBeenCalledWith(
            staged,
            expect.stringContaining('canonical-'),
            'jpeg',
            'srgb',
          );
          expect(media.generateHdrRenditions).not.toHaveBeenCalled();
        } else
          expect(media.generateHdrRenditions).toHaveBeenCalledWith(
            staged,
            [expect.objectContaining({ dynamicRange: 'hdr', format: format === 'hdr-heic' ? 'heic' : 'jpeg' })],
            undefined,
            undefined,
            Buffer.from('ab'.repeat(32), 'hex'),
          );
        expect(operations.fail).not.toHaveBeenCalled();
      },
    );

    it('refuses unavailable HDR or a sanitization failure without publishing or moving its original artifact', async () => {
      const photo = {
        version: 1,
        format: 'hdr-jpeg',
        width: 128,
        height: 64,
        frame: 0,
        dynamicRange: 'hdr',
        outputIntent: 'hdr',
        referenceWhite: 203,
        renderer: 'frameleaf-studio-image-v1',
      };
      const request = job();
      request.operation.snapshot = {
        ...(request.operation.snapshot as object),
        contract: { image: photo, video: { minBitDepth: 8, transfer: null }, audio: null },
      };
      repository.getById.mockResolvedValue(
        versionRow({
          outputPath: staged,
          settings: { format: 'hdr-jpeg', color: 'preserve', resolution: 'original' },
          outputContentType: 'image/jpeg',
        }),
      );
      media.inspectImageEncoding.mockResolvedValue({
        width: 128,
        height: 64,
        dynamicRange: 'hdr',
        container: 'jpeg',
        reconstructionAvailable: false,
      });
      await sut.run(request);
      expect(repository.publish).not.toHaveBeenCalled();
      expect(media.generateHdrRenditions).not.toHaveBeenCalled();
      media.inspectImageEncoding.mockResolvedValue({
        width: 128,
        height: 64,
        dynamicRange: 'hdr',
        container: 'jpeg',
        reconstructionAvailable: true,
      });
      media.generateHdrRenditions.mockRejectedValueOnce(new Error('privacy processing failed'));
      await sut.run(request);
      expect(repository.publish).not.toHaveBeenCalled();
      expect(storage.rename).not.toHaveBeenCalled();
      expect(await storage.checkFileExists(staged)).toBe(true);
    });

    it('removes only its canonical attempt when sanitized HDR validation fails', async () => {
      const request = job();
      request.operation.snapshot = {
        ...(request.operation.snapshot as object),
        contract: {
          image: {
            version: 1,
            format: 'hdr-jpeg',
            width: 128,
            height: 64,
            frame: 0,
            dynamicRange: 'hdr',
            outputIntent: 'hdr',
            referenceWhite: 203,
            renderer: 'frameleaf-studio-image-v1',
          },
          video: { minBitDepth: 8, transfer: null },
          audio: null,
        },
      };
      repository.getById.mockResolvedValue(
        versionRow({
          outputPath: staged,
          settings: { format: 'hdr-jpeg', color: 'preserve', resolution: 'original' },
          outputContentType: 'image/jpeg',
        }),
      );
      media.inspectImageEncoding
        .mockResolvedValueOnce({
          width: 128,
          height: 64,
          dynamicRange: 'hdr',
          container: 'jpeg',
          reconstructionAvailable: true,
        })
        .mockResolvedValue({ width: 128, height: 64, dynamicRange: 'sdr', container: 'jpeg' });
      await sut.run(request);
      const attempt = media.generateHdrRenditions.mock.calls[0][1][0].path;
      expect(repository.publish).not.toHaveBeenCalled();
      expect(storage.unlink).toHaveBeenCalledWith(attempt);
      expect(await storage.checkFileExists(staged)).toBe(true);
      expect(storage.rename).not.toHaveBeenCalled();
    });

    it('releases only its unique canonical file after losing a photo publication claim', async () => {
      const request = job();
      request.operation.snapshot = {
        ...(request.operation.snapshot as object),
        contract: {
          image: {
            version: 1,
            format: 'sdr-jpeg',
            width: 128,
            height: 64,
            frame: 0,
            dynamicRange: 'sdr',
            outputIntent: 'sdr',
            referenceWhite: 203,
            renderer: 'frameleaf-studio-image-v1',
          },
          video: { minBitDepth: 8, transfer: null },
          audio: null,
        },
      };
      repository.getById.mockResolvedValue(
        versionRow({
          outputPath: staged,
          settings: { format: 'sdr-jpeg', color: 'preserve', resolution: 'original' },
          outputContentType: 'image/jpeg',
        }),
      );
      media.inspectImageEncoding.mockResolvedValue({ width: 128, height: 64, dynamicRange: 'sdr', container: 'jpeg' });
      repository.publish.mockRejectedValue(new StudioExportRefusal('claim-lost', 'stale claim'));
      await sut.run(request);
      const finalPath = repository.publish.mock.calls[0][0].path;
      expect(finalPath).toContain(VERSION + '-');
      expect(storage.unlink).toHaveBeenCalledWith(finalPath);
      expect(await storage.checkFileExists(staged)).toBe(true);
      expect(operations.requestCancel).not.toHaveBeenCalled();
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
      expect(operations.complete).toHaveBeenCalledExactlyOnceWith(
        PUBLISH,
        'replacement-claim',
        {
          resultAssetId: 'asset-new',
        },
        undefined,
        true,
      );
      expect(operations.fail).not.toHaveBeenCalled();
      expect(operations.requestCancel).not.toHaveBeenCalled();
    });

    it('admits the render-finished notification inside the publication transaction', async () => {
      const tx = { isTransaction: true };
      repository.publish.mockImplementation((_input, _metadata, notification) =>
        Promise.try(() => notification!(tx as never, published().version, 'Lake trip')).then(() => published()),
      );
      await sut.run(job());
      expect(jobs.queueInTransaction).toHaveBeenCalledWith(tx, {
        name: JobName.PushDeliver,
        data: {
          notice: expect.objectContaining({
            type: PushEventType.RenderFinished,
            userIds: [OWNER],
            assetIds: ['asset-new'],
            data: expect.objectContaining({ versionId: VERSION, status: 'published', jobType: 'media-operation' }),
            systemTemplate: { version: 1, key: 'studio-export-ready-named', args: { label: 'Lake trip' } },
          }),
        },
      });
      expect(events.emit).not.toHaveBeenCalled();
      expect(jobs.queueInTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        operations.complete.mock.invocationCallOrder[0],
      );
    });

    it('tells the owner by push that the render failed (FL-228)', async () => {
      crypto.hashFile.mockResolvedValue(Buffer.from('cd'.repeat(32), 'hex'));
      operations.fail.mockResolvedValue('failed');

      await sut.run(job());

      expect(events.emit).toHaveBeenCalledWith(
        'PushNotify',
        expect.objectContaining({
          type: PushEventType.RenderFinished,
          userIds: [OWNER],
          // native apps offer Retry for the failed render job
          data: expect.objectContaining({
            versionId: VERSION,
            status: 'failed',
            job: RENDER,
            jobType: 'media-operation',
            jobActions: 'retry',
          }),
          systemTemplate: { version: 1, key: 'studio-export-failed-named', args: { label: 'Lake trip' } },
        }),
      );
    });

    it('queues Smooth motion of the published video as its own job, only after publication (FL-162)', async () => {
      repository.publicationFollowups.mockResolvedValue({ notification: 'accepted', smoothMotion: 'pending' });
      repository.publish.mockResolvedValue(published());
      const smooth = job();
      (smooth.operation.snapshot as Record<string, unknown>).smoothMotion = {
        factor: 4,
        destinationId: SMOOTH_DESTINATION,
      };

      await sut.run(smooth);

      expect(operations.complete).toHaveBeenCalledWith(
        PUBLISH,
        'claim-p',
        { resultAssetId: 'asset-new' },
        undefined,
        true,
      );
      expect(restorations.queueExportSmoothMotion).toHaveBeenCalledWith({
        ownerId: OWNER,
        assetId: 'asset-new',
        exportName: expect.any(String),
        factor: 4,
        destinationId: SMOOTH_DESTINATION,
      });
      expect(restorations.queueExportSmoothMotion.mock.invocationCallOrder[0]).toBeLessThan(
        operations.complete.mock.invocationCallOrder[0],
      );
    });

    it('queues no Smooth motion for an export that was not asked for it, or that stays with its project', async () => {
      repository.publish.mockResolvedValue(published());
      await sut.run(job());
      expect(restorations.queueExportSmoothMotion).not.toHaveBeenCalled();

      repository.publish.mockResolvedValue(
        published({
          version: versionRow({ state: StudioExportVersionState.Published, version: 1, resultAssetId: null }),
        }),
      );
      const smooth = job();
      (smooth.operation.snapshot as Record<string, unknown>).smoothMotion = {
        factor: 2,
        destinationId: SMOOTH_DESTINATION,
      };
      await sut.run(smooth);
      expect(restorations.queueExportSmoothMotion).not.toHaveBeenCalled();
    });

    it('verifies the file, moves it into the library and publishes it with the sources re-checked', async () => {
      repository.publish.mockImplementation((_input, metadata) =>
        Promise.try(() => metadata!({ isTransaction: true } as never, 'asset-new')).then(() => published()),
      );

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
      expect(jobs.queueInTransaction).toHaveBeenCalledWith(
        { isTransaction: true },
        {
          name: JobName.AssetExtractMetadata,
          data: { id: 'asset-new', source: 'upload' },
        },
      );
      expect(operations.complete).toHaveBeenCalledWith(
        PUBLISH,
        'claim-p',
        { resultAssetId: 'asset-new' },
        undefined,
        true,
      );
      expect(operations.fail).not.toHaveBeenCalled();
    });

    describe('holds the rendered file to its contract (FL-102)', () => {
      const probePacketRecords = async (records: string, index: number) => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: vi.fn(),
        });
        vi.mocked(spawn).mockReturnValueOnce(child as never);
        const probe = new MediaRepository({ setContext: vi.fn() } as never).probePackets(staged, index);
        child.stdout.write(records.slice(0, 5));
        child.stdout.write(records.slice(5));
        child.emit('close', 0);
        return probe;
      };

      const contracted = (contract: Record<string, unknown>) => {
        const run = job();
        (run.operation.snapshot as Record<string, unknown>).contract = contract;
        return run;
      };
      const tenBitSurround = {
        video: { minBitDepth: 10, transfer: null },
        audio: { policy: 'preserve', channels: 6, channelLayout: '5.1(side)', sampleRate: 48_000 },
      };
      const surroundTrack = {
        index: 1,
        codecName: 'eac3',
        channels: 6,
        channelLayout: '5.1(side)',
        sampleRate: 48_000,
        duration: 10,
      };

      it.each([
        [
          'the exact selected span',
          { presentation: { startPts: 0, endPts: 8 }, packetCount: 8, totalDuration: 8 },
          true,
        ],
        ['the whole movie', { presentation: { startPts: 0, endPts: 24 }, packetCount: 24, totalDuration: 24 }, false],
        ['a nonzero origin', { presentation: { startPts: 4, endPts: 12 }, packetCount: 8, totalDuration: 8 }, false],
        ['missing packet proof', null, false],
      ])('accepts only range proof before moving or publishing: %s', async (_, packets, accepted) => {
        const range = { inPoint: 4, outPoint: 12 };
        repository.getById.mockResolvedValue(
          versionRow({
            outputPath: staged,
            settings: { format: 'mp4-h264', color: 'preserve', resolution: '720p', range },
          }),
        );
        repository.publish.mockResolvedValue(published());
        media.probe.mockResolvedValue(renderedOutput({ video: { timeBaseRational: { num: 1, den: 24 } }, audio: [] }));
        media.probePackets.mockResolvedValue(
          packets && { ...packets, variableFrameRate: false, presentationCadenceTicks: 1 },
        );
        await sut.run(
          contracted({ video: { minBitDepth: 8, transfer: null }, audio: null, range: { ...range, cadence: '24/1' } }),
        );
        expect(media.probePackets).toHaveBeenCalledWith(staged, 0);
        if (accepted) {
          expect(repository.publish).toHaveBeenCalledOnce();
        } else {
          expect(repository.publish).not.toHaveBeenCalled();
          expect(storage.rename).not.toHaveBeenCalled();
          expect(operations.fail).toHaveBeenCalledWith(
            PUBLISH,
            'claim-p',
            expect.objectContaining({ errorCode: 'studio_export_output_rejected' }),
          );
        }
      });

      it('refuses a requested range with no matching immutable contract before probing or publishing', async () => {
        repository.getById.mockResolvedValue(
          versionRow({
            outputPath: staged,
            settings: {
              format: 'mp4-h264',
              color: 'preserve',
              resolution: '720p',
              range: { inPoint: 4, outPoint: 12 },
            },
          }),
        );
        await sut.run(contracted({ video: { minBitDepth: 8, transfer: null }, audio: null }));
        expect(media.probe).not.toHaveBeenCalled();
        expect(storage.rename).not.toHaveBeenCalled();
        expect(repository.publish).not.toHaveBeenCalled();
        expect(operations.fail).toHaveBeenCalledWith(
          PUBLISH,
          'claim-p',
          expect.objectContaining({ errorCode: 'studio_export_output_rejected' }),
        );
      });

      it.each([
        ['decode-order reordering', '0,1,K_\n2,1,__\n1,1,__', 24, true],
        ['duplicate and missing cadence slots', '0,1,K_\n0,1,__\n2,1,__', 24, false],
        ['off-grid presentation slots', '0,2,K_\n1,2,__\n4,2,__', 48, false],
      ])('checks actual probe packet records before range publication: %s', async (_, records, timescale, accepted) => {
        const packets = await probePacketRecords(records, 0);
        expect(packets?.presentationCadenceTicks).toBe(accepted ? timescale / 24 : null);
        const ticks = (3 * timescale) / 24;
        expect(packets).toMatchObject({
          packetCount: 3,
          totalDuration: ticks,
          presentation: { startPts: 0, endPts: ticks },
          variableFrameRate: false,
        });
        const range = { inPoint: 4, outPoint: 7 };
        repository.getById.mockResolvedValue(
          versionRow({
            outputPath: staged,
            settings: { format: 'mp4-h264', color: 'preserve', resolution: '720p', range },
          }),
        );
        repository.publish.mockResolvedValue(published());
        media.probe.mockResolvedValue(
          renderedOutput({ video: { timeBaseRational: { num: 1, den: timescale } }, audio: [] }),
        );
        media.probePackets.mockResolvedValue(packets);
        await sut.run(
          contracted({ video: { minBitDepth: 8, transfer: null }, audio: null, range: { ...range, cadence: '24/1' } }),
        );
        if (accepted) {
          expect(repository.publish).toHaveBeenCalledOnce();
        } else {
          expect(repository.publish).not.toHaveBeenCalled();
          expect(storage.rename).not.toHaveBeenCalled();
          expect(operations.fail).toHaveBeenCalledWith(
            PUBLISH,
            'claim-p',
            expect.objectContaining({ errorCode: 'studio_export_output_rejected' }),
          );
        }
      });

      it('publishes a result that kept its precision and its 5.1 audio', async () => {
        repository.publish.mockResolvedValue(published());
        media.probe.mockResolvedValue(
          renderedOutput({ video: { pixelFormat: 'yuv420p10le' }, audio: [surroundTrack] }),
        );
        await sut.run(contracted(tenBitSurround));
        expect(media.probe).toHaveBeenCalledWith(staged);
        expect(repository.publish).toHaveBeenCalledOnce();
      });

      it.each([
        ['an 8-bit result for a Main10 export', { audio: [surroundTrack] }, 'below the 10-bit'],
        [
          'a 9-bit result for a ten-bit export',
          { video: { pixelFormat: 'yuv420p9le' }, audio: [surroundTrack] },
          'below the 10-bit',
        ],
        ['a stereo downmix nobody chose', { video: { pixelFormat: 'yuv420p10le' } }, 'audio channels instead of 6'],
        [
          'audio that stops early',
          { video: { pixelFormat: 'yuv420p10le' }, audio: [{ ...surroundTrack, duration: 8 }] },
          'misaligned',
        ],
        ['a result with no audio', { video: { pixelFormat: 'yuv420p10le' }, audio: [] }, 'missing'],
      ])('refuses %s instead of publishing it', async (_, output, reason) => {
        media.probe.mockResolvedValue(renderedOutput(output));
        await sut.run(contracted(tenBitSurround));
        expect(repository.publish).not.toHaveBeenCalled();
        expect(operations.fail).toHaveBeenCalledWith(
          PUBLISH,
          'claim-p',
          expect.objectContaining({
            errorCode: 'studio_export_output_rejected',
            error: expect.stringContaining(reason),
          }),
        );
        expect(storage.rename).not.toHaveBeenCalled();
      });

      it.each([
        ['mp4-h264', 'av1'],
        ['mp4-hevc-main10', 'h264'],
        ['webm-av1', 'vp9'],
        ['prores-422-hq', 'hevc'],
        ['mp4-h264', null],
      ])('refuses %s rendered with codec %s before moving or publishing it', async (format, codecName) => {
        repository.getById.mockResolvedValue(
          versionRow({ outputPath: staged, settings: { format, color: 'preserve', resolution: '1080p' } }),
        );
        media.probe.mockResolvedValue(renderedOutput({ video: { codecName, pixelFormat: 'yuv420p10le' } }));

        await sut.run(contracted({ video: { minBitDepth: 8, transfer: null }, audio: null }));

        expect(storage.rename).not.toHaveBeenCalled();
        expect(repository.publish).not.toHaveBeenCalled();
        expect(operations.fail).toHaveBeenCalledWith(
          PUBLISH,
          'claim-p',
          expect.objectContaining({
            errorCode: 'studio_export_output_rejected',
            error: expect.stringContaining('video codec'),
          }),
        );
      });

      it('refuses a missing HDR transfer', async () => {
        media.probe.mockResolvedValue(renderedOutput({ video: { pixelFormat: 'yuv420p10le' } }));
        await sut.run(contracted({ video: { minBitDepth: 10, transfer: 'smpte2084' }, audio: null }));
        expect(operations.fail).toHaveBeenCalledWith(
          PUBLISH,
          'claim-p',
          expect.objectContaining({ error: expect.stringContaining('smpte2084') }),
        );
      });

      it.each([
        ['missing', false],
        ['unreadable', false],
        ['different', false],
        ['matching', false],
        ['different default stream', false],
        ['matching', true],
        ['different default stream', true],
        ['different packet cadence', true],
        ['different packet span', true],
      ] as const)('checks %s mastering with range=%s before publication (FL-105/FL-107)', async (mode, withRange) => {
        repository.publish.mockResolvedValue(published());
        const selectedIndex = withRange || mode === 'different default stream' ? 1 : 0;
        const range = { inPoint: 4, outPoint: 12 };
        const mastering = { primaries: 'bt2020' as const, maxNits: 1000, minNits: 0.005 };
        if (withRange) {
          repository.getById.mockResolvedValue(
            versionRow({
              outputPath: staged,
              settings: { format: 'mp4-hevc-main10', color: 'hdr10', resolution: '720p', mastering, range },
            }),
          );
          const records = Array.from({ length: 8 }, (_, i) => {
            const pts =
              mode === 'different packet cadence' && i === 1 ? 0 : i + Number(mode === 'different packet span');
            return `${pts},1,${i === 0 ? 'K_' : '__'}`;
          }).join('\n');
          media.probePackets.mockResolvedValue(await probePacketRecords(records, selectedIndex));
        }
        const output = renderedOutput({
          video: {
            index: selectedIndex,
            ...(withRange && { codecName: 'hevc', timeBaseRational: { num: 1, den: 24 } }),
            pixelFormat: 'yuv420p10le',
            colorTransfer: ColorTransfer.Smpte2084,
            colorPrimaries: ColorPrimaries.Bt2020,
            colorMatrix: ColorMatrix.Bt2020Nc,
          },
          audio: [],
        });
        if (selectedIndex === 1) output.videoStreams.push({ ...output.videoStreams[0], index: 0 });
        media.probe.mockResolvedValue(output);
        const metadata = {
          side_data_type: 'Mastering display metadata',
          red_x: '35400/50000',
          red_y: '14600/50000',
          green_x: '8500/50000',
          green_y: '39850/50000',
          blue_x: '6550/50000',
          blue_y: '2300/50000',
          white_point_x: '15635/50000',
          white_point_y: '16450/50000',
          max_luminance: mode === 'different' ? '40000000/10000' : '10000000/10000',
          min_luminance: '50/10000',
        };
        if (mode === 'unreadable') {
          media.probeHdrMastering.mockRejectedValue(new Error('probe failed'));
        } else if (mode === 'different default stream') {
          media.probeHdrMastering.mockImplementation((_path, index) =>
            Promise.resolve([
              {
                ...metadata,
                max_luminance: index === 1 ? '40000000/10000' : '10000000/10000',
              },
            ]),
          );
        } else {
          media.probeHdrMastering.mockResolvedValue(mode === 'missing' ? [] : [metadata]);
        }
        await sut.run(
          contracted({
            video: {
              minBitDepth: 10,
              transfer: 'smpte2084',
              mastering,
            },
            audio: null,
            ...(withRange && { range: { ...range, cadence: '24/1' } }),
          }),
        );
        if (mode === 'matching') {
          expect(storage.rename).toHaveBeenCalledWith(staged, expect.any(String));
          expect(repository.publish).toHaveBeenCalledOnce();
          expect(operations.fail).not.toHaveBeenCalled();
        } else {
          expect(storage.rename).not.toHaveBeenCalled();
          expect(repository.publish).not.toHaveBeenCalled();
          expect(operations.fail).toHaveBeenCalledWith(
            PUBLISH,
            'claim-p',
            expect.objectContaining({
              errorCode: 'studio_export_output_rejected',
              error: expect.stringMatching(
                mode.startsWith('different packet') ? /frame count|presentation span/ : /mastering display/,
              ),
            }),
          );
        }
        expect(media.probeHdrMastering).toHaveBeenCalledWith(staged, selectedIndex);
        if (withRange && mode !== 'different default stream') {
          expect(media.probePackets).toHaveBeenCalledWith(staged, selectedIndex);
        }
      });

      describe.each([
        ['PQ', 'smpte2084', ColorTransfer.Smpte2084],
        ['HLG', 'arib-std-b67', ColorTransfer.AribStdB67],
      ] as const)('HDR publication signalling (%s, FL-107)', (_, transfer, colorTransfer) => {
        const hdrVideo = {
          pixelFormat: 'yuv420p10le',
          colorTransfer,
          colorPrimaries: ColorPrimaries.Bt2020,
          colorMatrix: ColorMatrix.Bt2020Nc,
        };
        const hdrContract = { video: { minBitDepth: 10, transfer }, audio: null };

        it.each([
          ['BT.709 primaries', { colorPrimaries: ColorPrimaries.Bt709 }, /primaries/i],
          ['unknown primaries', { colorPrimaries: ColorPrimaries.Unknown }, /primaries/i],
          ['BT.709 matrix', { colorMatrix: ColorMatrix.Bt709 }, /matrix/i],
          ['unknown matrix', { colorMatrix: ColorMatrix.Unknown }, /matrix/i],
        ])('refuses %s before moving or publishing the rendered file', async (_, tags, reason) => {
          repository.publish.mockResolvedValue(published());
          media.probe.mockResolvedValue(renderedOutput({ video: { ...hdrVideo, ...tags }, audio: [] }));

          await sut.run(contracted(hdrContract));

          expect(storage.rename).not.toHaveBeenCalled();
          expect(repository.publish).not.toHaveBeenCalled();
          expect(operations.fail).toHaveBeenCalledWith(
            PUBLISH,
            'claim-p',
            expect.objectContaining({
              errorCode: 'studio_export_output_rejected',
              error: expect.stringMatching(reason),
            }),
          );
        });

        it('publishes ten-bit BT.2020 with the BT.2020 non-constant-luminance matrix', async () => {
          repository.publish.mockResolvedValue(published());
          media.probe.mockResolvedValue(renderedOutput({ video: hdrVideo, audio: [] }));

          await sut.run(contracted(hdrContract));

          expect(storage.rename).toHaveBeenCalledWith(staged, expect.any(String));
          expect(repository.publish).toHaveBeenCalledOnce();
          expect(operations.fail).not.toHaveBeenCalled();
        });
      });

      it('still publishes an SDR BT.709 result without an HDR gamut requirement (FL-107)', async () => {
        repository.publish.mockResolvedValue(published());
        media.probe.mockResolvedValue(
          renderedOutput({
            video: {
              pixelFormat: 'yuv420p',
              colorTransfer: ColorTransfer.Bt709,
              colorPrimaries: ColorPrimaries.Bt709,
              colorMatrix: ColorMatrix.Bt709,
            },
            audio: [],
          }),
        );

        await sut.run(contracted({ video: { minBitDepth: 8, transfer: null }, audio: null }));

        expect(storage.rename).toHaveBeenCalledWith(staged, expect.any(String));
        expect(repository.publish).toHaveBeenCalledOnce();
        expect(operations.fail).not.toHaveBeenCalled();
      });

      it('holds an export from before the contract to the precision of its settings', async () => {
        repository.getById.mockResolvedValue(
          versionRow({
            outputPath: staged,
            settings: { format: 'mp4-hevc-main10', color: 'preserve', resolution: '1080p' },
          }),
        );
        await sut.run(job());
        expect(operations.fail).toHaveBeenCalledWith(
          PUBLISH,
          'claim-p',
          expect.objectContaining({ errorCode: 'studio_export_output_rejected' }),
        );
      });
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

    it('keeps a result the owner asked to keep with its project out of the library (FL-194)', async () => {
      const generated = [
        {
          id: 'reverse',
          producer: 'reverse-conform',
          checksum: 'ab'.repeat(32),
          path: '/private/generated.mp4',
          derivedFrom: [entry().key],
        },
      ];
      projects.listGeneratedResources.mockResolvedValue(generated);
      repository.publish.mockResolvedValue(published({ createdAssetId: null }));
      const kept = job();
      kept.operation.snapshot = { ...kept.operation.snapshot, retain: 'project' };

      await sut.run(kept);
      expect(projects.listGeneratedResources).toHaveBeenCalledWith(PROJECT);
      expect(resources.resolveProjectResources).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ generated }),
      );

      const input = repository.publish.mock.calls[0][0];
      expect(input).toEqual(
        expect.objectContaining({ expectedScope: StudioExportScope.Project, retainInProject: true }),
      );
      expect(input.path).toContain('/exports/');
      expect(input.path).not.toContain('/upload/');
      expect(jobs.queue).not.toHaveBeenCalled();
    });

    it('keeps the accepted output when replay scheduling fails and uses only the operation retry', async () => {
      repository.publish.mockResolvedValue(published());
      repository.publicationFollowups.mockRejectedValue(new Error('database unavailable after commit'));
      await sut.run(job());
      expect(repository.publish).toHaveBeenCalledOnce();
      expect(storage.rename).toHaveBeenCalledTimes(1);
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        PUBLISH,
        'claim-p',
        expect.objectContaining({ error: 'database unavailable after commit' }),
      );
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it.each(['dispatching', 'needs_attention'])(
      'does not repeat a %s Smooth motion attempt after a crash',
      async (state) => {
        repository.getById.mockResolvedValue(published().version);
        repository.publicationFollowups.mockResolvedValue({ notification: 'accepted', smoothMotion: state });
        const replay = job();
        replay.operation.snapshot.smoothMotion = { factor: 4, destinationId: SMOOTH_DESTINATION };
        await sut.run(replay);
        expect(restorations.queueExportSmoothMotion).not.toHaveBeenCalled();
        expect(repository.publish).not.toHaveBeenCalled();
        expect(storage.rename).not.toHaveBeenCalled();
        expect(operations.complete).not.toHaveBeenCalled();
        expect(repository.publicationNeedsAttention).toHaveBeenCalledWith(PUBLISH, 'claim-p');
        expect(operations.fail).toHaveBeenCalledWith(
          PUBLISH,
          'claim-p',
          expect.objectContaining({ errorCode: 'studio_export_followup_needs_attention' }),
          { retry: false },
        );
      },
    );

    it('resumes a pending Smooth motion intent with its exact destination after a lost commit acknowledgement', async () => {
      repository.publish.mockRejectedValue(new Error('lost commit acknowledgement'));
      repository.getById
        .mockResolvedValueOnce(versionRow({ outputPath: staged }))
        .mockResolvedValue(published().version);
      repository.publicationFollowups.mockResolvedValue({ notification: 'accepted', smoothMotion: 'pending' });
      const replay = job();
      replay.operation.snapshot.smoothMotion = { factor: 8, destinationId: SMOOTH_DESTINATION };
      await sut.run(replay);
      expect(restorations.queueExportSmoothMotion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ factor: 8, destinationId: SMOOTH_DESTINATION }),
      );
      expect(repository.transitionPublicationFollowup).toHaveBeenNthCalledWith(
        1,
        PUBLISH,
        'claim-p',
        'smoothMotion',
        'pending',
        'dispatching',
      );
      expect(repository.transitionPublicationFollowup).toHaveBeenNthCalledWith(
        2,
        PUBLISH,
        'claim-p',
        'smoothMotion',
        'dispatching',
        'accepted',
        { restorationId: 'restoration-1', operationId: 'preview-operation-1' },
      );
      expect(operations.complete).toHaveBeenCalledOnce();
      expect(storage.rename).toHaveBeenCalledTimes(1);
    });

    it('exposes cloud confirmation or unconfirmed submission without silently completing or retrying', async () => {
      repository.getById.mockResolvedValue(published().version);
      repository.publicationFollowups.mockResolvedValue({ notification: 'accepted', smoothMotion: 'pending' });
      restorations.queueExportSmoothMotion.mockResolvedValue(null);
      const replay = job();
      replay.operation.snapshot.smoothMotion = { factor: 2, destinationId: SMOOTH_DESTINATION };
      await sut.run(replay);
      expect(operations.complete).not.toHaveBeenCalled();
      expect(repository.transitionPublicationFollowup).toHaveBeenLastCalledWith(
        PUBLISH,
        'claim-p',
        'smoothMotion',
        'dispatching',
        'needs_attention',
        undefined,
      );
      expect(operations.fail).toHaveBeenCalledWith(PUBLISH, 'claim-p', expect.anything(), { retry: false });
    });

    it('does not dispatch twice when the external acknowledgement cannot be checkpointed', async () => {
      repository.getById.mockResolvedValue(published().version);
      repository.publicationFollowups.mockResolvedValue({ notification: 'accepted', smoothMotion: 'pending' });
      repository.transitionPublicationFollowup
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('lost acknowledgement'));
      const replay = job();
      replay.operation.snapshot.smoothMotion = { factor: 2, destinationId: SMOOTH_DESTINATION };
      await sut.run(replay);
      expect(operations.complete).not.toHaveBeenCalled();
      repository.publicationFollowups.mockResolvedValue({ notification: 'accepted', smoothMotion: 'dispatching' });
      await sut.run({ ...replay, claimToken: 'replacement' });
      expect(restorations.queueExportSmoothMotion).toHaveBeenCalledTimes(1);
      expect(repository.publish).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenLastCalledWith(PUBLISH, 'replacement', expect.anything(), { retry: false });
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
      expect(operations.complete).toHaveBeenCalledWith(
        PUBLISH,
        'claim-p',
        { resultAssetId: 'asset-new' },
        undefined,
        true,
      );
      // The file stays where the committed result points.
      expect(storage.rename).toHaveBeenCalledTimes(1);
    });

    it('acknowledges a cancel that landed on an already published job instead of leaving it to the lease', async () => {
      repository.publish.mockResolvedValue(published());
      operations.complete.mockResolvedValue(false);

      await sut.run(job());

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(PUBLISH, 'claim-p', { released: true });
    });

    it('resumes durable follow-ups without republishing when an earlier attempt already published', async () => {
      repository.getById.mockResolvedValue(
        versionRow({ state: StudioExportVersionState.Published, version: 2, resultAssetId: 'asset-new' }),
      );

      await sut.run(job());

      expect(repository.publish).not.toHaveBeenCalled();
      expect(operations.complete).toHaveBeenCalledWith(
        PUBLISH,
        'claim-p',
        { resultAssetId: 'asset-new' },
        undefined,
        true,
      );
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
      access.asset.checkAlbumAccess.mockResolvedValue(new Set([SHARED_CLIP]));
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

  describe('saveToLibrary', () => {
    const kept = '/data/exports/o/studio-exports/versions/v.mp4';
    const projectResult = (overrides: Partial<StudioExportVersion> = {}) =>
      versionRow({
        state: StudioExportVersionState.Published,
        scope: StudioExportScope.Project,
        outputPath: kept,
        privacy: { lockReason: null },
        ...overrides,
      });
    const saved = (assetId = 'asset-saved') => ({
      version: projectResult({ scope: StudioExportScope.Library, resultAssetId: assetId }),
      createdAssetId: assetId,
      reusedAssetId: null,
    });

    beforeEach(() => {
      repository.saveToLibrary = vi.fn();
      storage.stat = vi.fn((path: string) =>
        path === kept ? Promise.resolve({ size: 1024, isFile: () => true }) : Promise.reject(new Error('ENOENT')),
      );
    });

    it('moves the kept file into the library as a new asset of the owner, only when asked', async () => {
      repository.getForOwner.mockResolvedValue(projectResult());
      repository.saveToLibrary.mockResolvedValue(saved());

      const result = await sut.saveToLibrary(auth(), VERSION);

      const input = repository.saveToLibrary.mock.calls[0][0];
      expect(input).toEqual(
        expect.objectContaining({
          versionId: VERSION,
          ownerId: OWNER,
          nsfwHiding: true,
          assetType: AssetType.Video,
          originalFileName: 'Lake trip.mp4',
          sources: [expect.objectContaining({ assetId: CLIP })],
        }),
      );
      expect(input.path).toContain('/upload/');
      expect(storage.rename).toHaveBeenCalledWith(kept, input.path);
      expect(jobs.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: 'asset-saved', source: 'upload' },
      });
      expect(result).toEqual(
        expect.objectContaining({ scope: StudioExportScope.Library, resultAssetId: 'asset-saved' }),
      );
    });

    it('saves a retained still as an image with its still filename and canonical identity', async () => {
      repository.getForOwner.mockResolvedValue(projectResult({ outputContentType: 'image/jpeg' }));
      repository.saveToLibrary.mockResolvedValue(saved());
      await sut.saveToLibrary(auth(), VERSION);
      expect(repository.saveToLibrary).toHaveBeenCalledWith(
        expect.objectContaining({
          assetType: AssetType.Image,
          originalFileName: 'Lake trip_still.jpg',
          checksum: Buffer.from('ab'.repeat(32), 'hex'),
          sizeInBytes: 1024,
        }),
      );
    });

    it('answers a result already in the library with it again', async () => {
      repository.getForOwner.mockResolvedValue(
        projectResult({ scope: StudioExportScope.Library, resultAssetId: 'asset-saved' }),
      );
      await expect(sut.saveToLibrary(auth(), VERSION)).resolves.toEqual(
        expect.objectContaining({ resultAssetId: 'asset-saved' }),
      );
      expect(repository.saveToLibrary).not.toHaveBeenCalled();
      expect(storage.rename).not.toHaveBeenCalled();
    });

    it('refuses a result that is not published or whose file is gone', async () => {
      repository.getForOwner.mockResolvedValue(projectResult({ state: StudioExportVersionState.Staged }));
      await expect(sut.saveToLibrary(auth(), VERSION)).rejects.toBeInstanceOf(ConflictException);
      repository.getForOwner.mockResolvedValue(projectResult({ outputRemovedAt: new Date() } as never));
      await expect(sut.saveToLibrary(auth(), VERSION)).rejects.toBeInstanceOf(ConflictException);
      expect(repository.saveToLibrary).not.toHaveBeenCalled();
    });

    it('never makes media shared with the owner into a permanent copy', async () => {
      repository.getForOwner.mockResolvedValue(projectResult());
      repository.getSources.mockResolvedValue([
        sourceRow(),
        sourceRow({ key: 'shared', resourceId: SHARED_CLIP, assetId: SHARED_CLIP, ownerId: PARTNER }),
      ]);
      await expect(sut.saveToLibrary(auth(), VERSION)).rejects.toBeInstanceOf(ConflictException);
      expect(storage.rename).not.toHaveBeenCalled();
    });

    it('returns the file to where it was when the library refuses it', async () => {
      repository.getForOwner.mockResolvedValue(projectResult());
      repository.saveToLibrary.mockRejectedValue(new StudioExportRefusal('quota-exceeded', 'full'));

      await expect(sut.saveToLibrary(auth(), VERSION)).rejects.toBeInstanceOf(ConflictException);

      const moved = repository.saveToLibrary.mock.calls[0][0].path;
      expect(storage.rename).toHaveBeenLastCalledWith(moved, kept);
      expect(jobs.queue).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('answers a reviewer 403 from the shared owner check (FL-112)', async () => {
      studio.requireOwnedProject.mockRejectedValue(
        new ForbiddenException('Only the owner can export a Studio project'),
      );
      await expect(sut.list(auth(), PROJECT, {})).rejects.toBeInstanceOf(ForbiddenException);
      expect(studio.requireOwnedProject).toHaveBeenCalledWith(
        expect.anything(),
        PROJECT,
        'Only the owner can export a Studio project',
      );
    });

    it('leaves Locked results out of an ordinary session’s list and count, and shows them when unlocked', async () => {
      repository.listForProject.mockResolvedValue({
        items: [versionRow({ state: StudioExportVersionState.Published })],
        total: 1,
      });

      const ordinary = await sut.list(auth(), PROJECT, {});
      expect(repository.listForProject).toHaveBeenLastCalledWith(PROJECT, OWNER, {
        take: 50,
        skip: 0,
        visibility: { revealed: false },
      });
      expect(ordinary.total).toBe(1);

      await sut.list(elevated(), PROJECT, {});
      expect(repository.listForProject).toHaveBeenLastCalledWith(PROJECT, OWNER, {
        take: 50,
        skip: 0,
        visibility: { revealed: true, revealLockedOwnerId: OWNER },
      });
    });

    it('judges a version by its sources as they stand now, for this session (FL-195)', async () => {
      repository.getForOwner.mockResolvedValue(undefined);
      await expect(sut.get(auth(), VERSION)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.getForOwner).toHaveBeenLastCalledWith(VERSION, OWNER, { revealed: false });
      await expect(sut.download(elevated(), VERSION)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.getForOwner).toHaveBeenLastCalledWith(VERSION, OWNER, {
        revealed: true,
        revealLockedOwnerId: OWNER,
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

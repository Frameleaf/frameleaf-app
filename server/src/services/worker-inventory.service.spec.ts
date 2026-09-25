import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MediaOperationDestination,
  MediaOperationKind,
  MlAdmissionRefusal,
  MlDestinationHealth,
  MlWorkerAcceleration,
  MlWorkerReadiness,
  MlWorkerRole,
  MlWorkload,
  QueueName,
  RenderWorkerStatus,
  WorkerCredentialState,
  WorkerInventorySource,
} from 'src/enum.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { RenderWorkerService } from 'src/services/render-worker.service.js';
import { RENDER_WORKER_STALE_MS, WorkerInventoryService } from 'src/services/worker-inventory.service.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const counts = (active: number, waiting: number) => ({
  active,
  waiting,
  completed: 0,
  failed: 0,
  delayed: 0,
  paused: 0,
});

const renderWorker = (overrides: Record<string, unknown> = {}) => ({
  id: '0199a000-0000-7000-8000-000000000001',
  name: 'Studio box',
  destination: MediaOperationDestination.Lan,
  status: RenderWorkerStatus.Active,
  kinds: [MediaOperationKind.StudioExport],
  engineDigest: 'sha256:abc',
  conformanceMaxAgeMs: 86_400_000,
  maxConcurrentOperations: 2,
  maxWallClockMs: null,
  maxOutputBytes: null,
  gpuMemoryBytes: '17179869184',
  activeOperations: 1,
  lastAdmittedAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  revokedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

/** Frameleaf Cloud, consented and routed for enrichment, whose last check found the server unlinked (FL-159). */
const cloudUnlinked = {
  ...mlDestinationStub.frameleafCloudConsented,
  workloads: [MlWorkload.Enrichment],
  lastProbeHealth: MlDestinationHealth.Unhealthy,
  lastProbeSummary: 'Unreachable: This server is not linked to a Frameleaf account',
  lastProbeWorkloads: null,
  lastProbeCloud: {
    ...mlDestinationStub.frameleafCloudConsented.lastProbeCloud!,
    refusal: {
      refusal: MlAdmissionRefusal.CloudUnavailable,
      detail: 'This server is not linked to a Frameleaf account',
    },
  },
};

describe(WorkerInventoryService.name, () => {
  let sut: WorkerInventoryService;
  let mocks: ServiceMocks;
  let operations: { getDestinationLoad: ReturnType<typeof vi.fn>; getClaimants: ReturnType<typeof vi.fn> };
  let renderWorkers: { list: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mocks = getMocks();
    operations = { getDestinationLoad: vi.fn().mockResolvedValue([]), getClaimants: vi.fn().mockResolvedValue([]) };
    renderWorkers = { list: vi.fn().mockResolvedValue([]) };

    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, mlDestinationStub.lan, cloudUnlinked]);
    mocks.mlDestination.getRoutes.mockResolvedValue([
      { workload: MlWorkload.Face, destinationId: mlDestinationStub.local.id, modelId: null, updatedAt: new Date() },
      { workload: MlWorkload.Clip, destinationId: mlDestinationStub.local.id, modelId: null, updatedAt: new Date() },
      { workload: MlWorkload.Enrichment, destinationId: cloudUnlinked.id, modelId: null, updatedAt: new Date() },
      {
        workload: MlWorkload.RestorationFaithful,
        destinationId: mlDestinationStub.lan.id,
        modelId: null,
        updatedAt: new Date(),
      },
    ]);
    mocks.mlDestination.getById.mockImplementation((id: string) =>
      Promise.resolve([mlDestinationStub.local, mlDestinationStub.lan, cloudUnlinked].find((row) => row.id === id)),
    );
    mocks.mlDestination.getSpend.mockResolvedValue(0);
    mocks.job.getJobCounts.mockResolvedValue(counts(0, 0));
    mocks.job.isPaused.mockResolvedValue(false);

    sut = new WorkerInventoryService(
      mocks.logger as never,
      mocks.config as never,
      mocks.systemMetadata as never,
      mocks.mlDestination as never,
      mocks.machineLearning as never,
      operations as unknown as MediaOperationRepository,
      mocks.job as never,
      renderWorkers as unknown as RenderWorkerService,
    );
  });

  it('lists every ML destination with its role, routes and admission, and never contacts a worker', async () => {
    const inventory = await sut.getInventory();

    const local = inventory.entries.find((entry) => entry.id === mlDestinationStub.local.id)!;
    expect(local).toMatchObject({
      source: WorkerInventorySource.MlDestination,
      role: MlWorkerRole.LibraryAnalysis,
      routedWorkloads: [MlWorkload.Face, MlWorkload.Clip],
      credential: WorkerCredentialState.None,
      leavesNetwork: false,
      configured: true,
      readiness: MlWorkerReadiness.ModelReady,
      acceleration: MlWorkerAcceleration.Unknown,
    });
    expect(local.admission.find((entry) => entry.workload === MlWorkload.Face)).toMatchObject({ admitted: true });

    const lan = inventory.entries.find((entry) => entry.id === mlDestinationStub.lan.id)!;
    expect(lan).toMatchObject({
      role: MlWorkerRole.Restoration,
      routedWorkloads: [MlWorkload.RestorationFaithful],
      credential: WorkerCredentialState.Stored,
    });
    expect(JSON.stringify(inventory)).not.toContain('lan-token');

    expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
    expect(mocks.machineLearning.getRestorationModels).not.toHaveBeenCalled();
  });

  it('shows cloud-first library routing as routed to Frameleaf Cloud, not as local', async () => {
    const inventory = await sut.getInventory();

    expect(inventory.libraryRoutes.find((route) => route.workload === MlWorkload.Enrichment)).toEqual({
      workload: MlWorkload.Enrichment,
      destinationId: cloudUnlinked.id,
      queues: [QueueName.ImageDescription, QueueName.NsfwDetection],
    });
    const cloud = inventory.entries.find((entry) => entry.id === cloudUnlinked.id)!;
    expect(cloud).toMatchObject({
      leavesNetwork: true,
      consentGranted: true,
      credential: WorkerCredentialState.Managed,
      url: null,
      routedWorkloads: [MlWorkload.Enrichment],
    });
    // Not linked: admission would refuse rather than send the work anywhere else.
    expect(cloud.admission).toEqual([
      expect.objectContaining({
        workload: MlWorkload.Enrichment,
        admitted: false,
        refusal: MlAdmissionRefusal.CloudUnavailable,
      }),
    ]);
  });

  it('distinguishes unreachable, not serving and CPU-only workers', async () => {
    mocks.mlDestination.getAll.mockResolvedValue([
      {
        ...mlDestinationStub.local,
        id: 'down',
        lastProbeHealth: MlDestinationHealth.Unhealthy,
        lastProbeWorkloads: null,
      },
      { ...mlDestinationStub.local, id: 'idle', lastProbeWorkloads: [MlWorkload.StudioAi] },
      {
        ...mlDestinationStub.local,
        id: 'cpu',
        lastProbeHardware: {
          preferredAcceleration: 'auto',
          providers: ['CPUExecutionProvider'],
          cudaDeviceCount: 0,
          gpus: [],
        },
      },
      { ...mlDestinationStub.local, id: 'new', lastProbeHealth: MlDestinationHealth.Unknown, lastProbeAt: null },
    ]);

    const { entries } = await sut.getInventory();
    const readiness = Object.fromEntries(entries.map((entry) => [entry.id, entry.readiness]));

    expect(readiness).toEqual({
      down: MlWorkerReadiness.Unreachable,
      idle: MlWorkerReadiness.NotServing,
      cpu: MlWorkerReadiness.Cpu,
      new: MlWorkerReadiness.Unknown,
    });
    expect(entries.find((entry) => entry.id === 'cpu')?.acceleration).toBe(MlWorkerAcceleration.Cpu);
  });

  it('reports the library backlog of the routed queues and ignores paused ones', async () => {
    const byQueue: Partial<Record<QueueName, [number, number]>> = {
      [QueueName.FaceDetection]: [2, 30],
      [QueueName.Ocr]: [0, 99],
    };
    mocks.job.getJobCounts.mockImplementation((queue) => Promise.resolve(counts(...(byQueue[queue] ?? [0, 0]))));
    mocks.job.isPaused.mockImplementation((queue) => Promise.resolve(queue === QueueName.Ocr));

    const inventory = await sut.getInventory();

    expect(inventory.libraryBacklog).toBe(32);
    const local = inventory.entries.find((entry) => entry.id === mlDestinationStub.local.id)!;
    expect(local).toMatchObject({ activeOperations: 2, queuedOperations: 30 });
  });

  it('shows restoration load, and a shared-GPU restoration worker waiting for library analysis', async () => {
    mocks.mlDestination.getAll.mockResolvedValue([
      mlDestinationStub.local,
      { ...mlDestinationStub.lan, sharesLibraryHardware: true },
    ]);
    operations.getDestinationLoad.mockResolvedValue([
      { destinationId: mlDestinationStub.lan.id, queued: 3, active: 1 },
    ]);
    mocks.job.getJobCounts.mockImplementation((queue) =>
      Promise.resolve(queue === QueueName.SmartSearch ? counts(1, 5) : counts(0, 0)),
    );

    const inventory = await sut.getInventory();

    expect(inventory.entries.find((entry) => entry.id === mlDestinationStub.lan.id)).toMatchObject({
      sharesLibraryHardware: true,
      waitingForLibraryAnalysis: true,
      activeOperations: 1,
      queuedOperations: 3,
    });
  });

  it('marks restoration refused on an endpoint library analysis uses', async () => {
    const sameUrl = { ...mlDestinationStub.lan, url: mlDestinationStub.local.url };
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, sameUrl]);
    mocks.mlDestination.getById.mockImplementation((id: string) =>
      Promise.resolve(id === mlDestinationStub.local.id ? mlDestinationStub.local : sameUrl),
    );

    const { entries } = await sut.getInventory();

    expect(entries.find((entry) => entry.id === sameUrl.id)?.admission).toEqual([
      expect.objectContaining({
        workload: MlWorkload.RestorationFaithful,
        admitted: false,
        refusal: MlAdmissionRefusal.RoleConflict,
      }),
    ]);
  });

  it('lists render workers by check-in and never with an address', async () => {
    renderWorkers.list.mockResolvedValue([
      renderWorker(),
      renderWorker({ id: 'stale', lastSeenAt: new Date(Date.now() - RENDER_WORKER_STALE_MS - 1000).toISOString() }),
      renderWorker({ id: 'revoked', status: RenderWorkerStatus.Revoked }),
    ]);

    const { entries } = await sut.getInventory();
    const render = entries.filter((entry) => entry.source === WorkerInventorySource.RenderWorker);

    expect(render.map((entry) => [entry.id, entry.readiness])).toEqual([
      ['0199a000-0000-7000-8000-000000000001', MlWorkerReadiness.ModelReady],
      ['stale', MlWorkerReadiness.Unreachable],
      ['revoked', MlWorkerReadiness.Disabled],
    ]);
    expect(render[0]).toMatchObject({
      url: null,
      credential: WorkerCredentialState.Enrolled,
      gpuMemoryBytes: 17_179_869_184,
      activeOperations: 1,
      maxConcurrentOperations: 2,
    });
  });

  it('names the server processes running restorations, merged per process', async () => {
    const heartbeat = new Date('2026-09-23T10:00:00.000Z');
    operations.getClaimants.mockResolvedValue([
      { workerId: 'restoration:server:42', kind: MediaOperationKind.Restoration, count: 1, lastHeartbeatAt: heartbeat },
      {
        workerId: 'restoration:server:42',
        kind: MediaOperationKind.RestorationPreview,
        count: 1,
        lastHeartbeatAt: null,
      },
    ]);

    const { runners } = await sut.getInventory();

    expect(runners).toEqual([
      {
        workerId: 'restoration:server:42',
        kinds: [MediaOperationKind.Restoration, MediaOperationKind.RestorationPreview],
        activeOperations: 2,
        lastHeartbeatAt: heartbeat.toISOString(),
      },
    ]);
  });
});

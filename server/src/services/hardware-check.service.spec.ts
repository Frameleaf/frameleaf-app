import type { MlSelection } from 'src/repositories/machine-learning.repository.js';
import { MlWorkload, RenderWorkerStatus, SystemMetadataKey } from 'src/enum.js';
import { HardwareCheckService } from 'src/services/hardware-check.service.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(HardwareCheckService.name, () => {
  let sut: HardwareCheckService;
  let mocks: ServiceMocks;
  let stored: unknown;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(HardwareCheckService));
    stored = undefined;
    mocks.systemMetadata.get.mockImplementation(() => Promise.resolve(stored as never));
    mocks.systemMetadata.set.mockImplementation((_key, value) => {
      stored = value;
      return Promise.resolve();
    });
    mocks.hardwareProbe.readServer.mockResolvedValue({
      nvidia: { name: 'NVIDIA GeForce RTX 3060', memoryTotalBytes: 12 * 1024 ** 3, driver: 'Driver 550.107' },
      nvidiaError: null,
      nvidiaRequested: true,
      nvidiaDevice: true,
      renderNodes: [],
      encoders: ['h264_nvenc'],
      test: { encoder: 'h264_nvenc', gpu: true, speed: 9, error: null },
      host: { kernel: '6.8.0-45-generic', gpus: [], dxg: false, groups: [0], root: true },
    });
    mocks.renderWorker.listWorkers.mockResolvedValue([]);
    mocks.renderWorker.listLiveSessions.mockResolvedValue([]);
    mocks.hardwareProbe.withTestImage.mockImplementation((use) => use('/tmp/test.jpg'));
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local]);
    mocks.machineLearning.getContainerHardware.mockResolvedValue({
      image: 'cuda',
      backend: 'CUDA',
      gpus: [{ name: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', memoryTotalBytes: 12 * 1024 ** 3 }],
      driver: 'Driver 550.107 · CUDA 12.4',
      nvidiaError: null,
      devices: { renderNodes: [], kfd: false, kfdAccessible: false, nvidia: true, nvidiaRequested: true },
    });
    mocks.mlDestination.getRoute.mockResolvedValue(undefined);
  });

  it('checks both containers and keeps the result', async () => {
    const result = await sut.runCheck();

    expect(result).toMatchObject({
      server: { backend: 'NVENC', model: 'NVIDIA GeForce RTX 3060', test: { value: 9 } },
      ml: { backend: 'CUDA', vramGb: 12 },
      mlImage: 'cuda',
      issues: [],
      findings: [],
      workers: [],
      benchmark: null,
    });
    expect(result.server.gpu).toEqual({ present: true, visible: true, usable: true });
    expect(result.ml.gpu).toEqual({ present: true, visible: true, usable: true });
    expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.HardwareCheck, result);
    expect(mocks.machineLearning.getContainerHardware).toHaveBeenCalledWith(
      expect.objectContaining({ url: mlDestinationStub.local.url }),
    );
  });

  it('returns the kept check without checking again', async () => {
    await sut.runCheck();
    mocks.hardwareProbe.readServer.mockClear();

    await expect(sut.getCheck()).resolves.toMatchObject({ server: { backend: 'NVENC' } });
    expect(mocks.hardwareProbe.readServer).not.toHaveBeenCalled();
  });

  it('keeps a benchmark only while the hardware is the same', async () => {
    const benchmarked = await sut.runBenchmark();
    expect(benchmarked.benchmark).toMatchObject({ transcodeSpeed: 9, serverFactor: 1 });

    await expect(sut.runCheck()).resolves.toMatchObject({ benchmark: { transcodeSpeed: 9 } });

    mocks.machineLearning.getContainerHardware.mockResolvedValue(null);
    await expect(sut.runCheck()).resolves.toMatchObject({ benchmark: null, ml: { reachable: false } });
  });

  it('checks again when the kept check predates the per-container facts', async () => {
    stored = { checkedAt: 'old', server: {}, ml: {}, issues: [], benchmark: null };

    await expect(sut.getCheck()).resolves.toMatchObject({ findings: [], workers: [] });
    expect(mocks.hardwareProbe.readServer).toHaveBeenCalled();
  });

  it('shows enrolled render workers and restoration workers from what they reported', async () => {
    mocks.renderWorker.listWorkers.mockResolvedValue([
      { id: 'render-1', name: 'Studio PC', status: RenderWorkerStatus.Active },
      { id: 'render-2', name: 'Old laptop', status: RenderWorkerStatus.Active },
      { id: 'render-3', name: 'Gone', status: RenderWorkerStatus.Revoked },
    ] as never);
    mocks.renderWorker.listLiveSessions.mockResolvedValue([
      { worker: { id: 'render-1' }, session: { gpuMemoryBytes: String(8 * 1024 ** 3) } },
    ] as never);
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, mlDestinationStub.lan]);
    mocks.machineLearning.getRestorationModels.mockResolvedValue({
      protocol: 'restoration-v1',
      workloads: [MlWorkload.RestorationFaithful],
      gpus: [{ name: 'NVIDIA GeForce RTX 4090', memoryTotalBytes: 24 * 1024 ** 3, driverVersion: '560.35' }],
      models: [],
      configurationProblems: [],
      checkedAt: '2026-09-27T00:00:00.000Z',
    } as never);

    const result = await sut.runCheck();

    expect(result.workers).toEqual([
      expect.objectContaining({
        id: 'render-1',
        kind: 'render',
        vramGb: 8,
        gpu: { present: true, visible: true, usable: true },
      }),
      expect.objectContaining({
        id: 'render-2',
        reachable: false,
        gpu: { present: null, visible: null, usable: null },
      }),
      expect.objectContaining({
        id: mlDestinationStub.lan.id,
        kind: 'restoration',
        model: 'NVIDIA GeForce RTX 4090',
        // Present and visible, but no model is ready to run on it.
        gpu: { present: true, visible: true, usable: false },
      }),
    ]);
  });

  it('records throughput per workload, timing descriptions on this server only', async () => {
    const selection = { destinationId: mlDestinationStub.local.id } as MlSelection;
    const select = vi
      .spyOn(sut as unknown as { selectMlDestination: () => Promise<MlSelection> }, 'selectMlDestination')
      .mockResolvedValue(selection);
    vi.spyOn(
      sut as unknown as { selectRoutedMlDestination: () => Promise<MlSelection> },
      'selectRoutedMlDestination',
    ).mockResolvedValue(selection);
    mocks.machineLearning.describeImage.mockResolvedValue({} as never);
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, mlDestinationStub.lan]);
    mocks.machineLearning.getRestorationModels.mockResolvedValue({
      protocol: 'restoration-v1',
      workloads: [MlWorkload.RestorationFaithful],
      gpus: [{ name: 'NVIDIA GeForce RTX 4090', memoryTotalBytes: 24 * 1024 ** 3, driverVersion: '560.35' }],
      models: [{ state: 'available', measured: [{ gpu: 'NVIDIA GeForce RTX 4090', framesPerSecond: 4 }] }],
      configurationProblems: [],
      checkedAt: '2026-09-27T00:00:00.000Z',
    } as never);

    const { benchmark } = await sut.runBenchmark();

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ workload: MlWorkload.Enrichment, destinationId: mlDestinationStub.local.id }),
    );
    // One photo loads the model, the next two are timed.
    expect(mocks.machineLearning.describeImage).toHaveBeenCalledTimes(3);
    expect(benchmark!.workloads.map((entry) => [entry.workload, entry.unavailable ?? entry.source])).toEqual([
      ['descriptions', 'benchmark'],
      ['upscale', 'no-local-runner'],
      ['restoration', 'qualification'],
      ['studio', 'no-local-worker'],
      ['interpolation', 'no-local-runner'],
    ]);
    expect(benchmark!.workloads[0]).toMatchObject({ unit: 'photo', runsOn: 'gpu', worker: 'This server' });
    expect(benchmark!.workloads[2]).toMatchObject({ unit: 'frame', perHour: 14_400, worker: 'Workshop GPU' });
  });

  it('records why descriptions could not be timed', async () => {
    vi.spyOn(
      sut as unknown as { selectMlDestination: () => Promise<MlSelection> },
      'selectMlDestination',
    ).mockRejectedValue(new Error('does not serve enrichment'));

    const { benchmark } = await sut.runBenchmark();

    expect(benchmark!.workloads[0]).toMatchObject({
      workload: 'descriptions',
      unavailable: 'failed',
      error: 'does not serve enrichment',
    });
    expect(benchmark!.workloads[2]).toMatchObject({ workload: 'restoration', unavailable: 'no-local-worker' });
  });
});

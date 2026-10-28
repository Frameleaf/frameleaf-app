import type { MlSelection } from 'src/repositories/machine-learning.repository.js';
import { MediaOperationKind, MlWorkload, RenderWorkerStatus, SystemMetadataKey } from 'src/enum.js';
import { HardwareCheckService } from 'src/services/hardware-check.service.js';
import { withSyntheticGpuBudget } from 'test/fixtures/gpu-working-budget.stub.js';
import { mlDestinationStub, mlSelectionStub } from 'test/fixtures/ml-destination.stub.js';
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
    expect(mocks.systemMetadata.set).toHaveBeenCalledWith(
      SystemMetadataKey.HardwareCheck,
      expect.objectContaining(result),
    );
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

  it.each(['destination', 'url', 'credential', 'clip-model', 'description-model'] as const)(
    'does not retain another source calibration after changing its %s',
    async (change) => {
      const config = await sut['getConfig']({ withCache: true });
      const readConfig = vi
        .spyOn(sut as unknown as { getConfig: () => Promise<typeof config> }, 'getConfig')
        .mockResolvedValue(config);
      await sut.runBenchmark();
      const replacement = { ...mlDestinationStub.local };
      switch (change) {
        case 'destination': {
          replacement.id = 'replacement-worker';
          break;
        }
        case 'url': {
          replacement.url = 'http://replacement-worker:3003';
          break;
        }
        case 'credential': {
          replacement.authToken = 'replacement-test-credential';
          break;
        }
        case 'clip-model': {
          readConfig.mockResolvedValue({
            ...config,
            machineLearning: {
              ...config.machineLearning,
              clip: { ...config.machineLearning.clip, modelName: 'replacement-clip' },
            },
          } as never);

          break;
        }
        case 'description-model': {
          readConfig.mockResolvedValue({
            ...config,
            machineLearning: {
              ...config.machineLearning,
              imageDescription: { ...config.machineLearning.imageDescription, modelName: 'replacement-description' },
            },
          } as never);

          break;
        }
        // No default
      }
      mocks.mlDestination.getAll.mockResolvedValue([replacement]);

      await expect(sut.runCheck()).resolves.toMatchObject({ benchmark: null });
    },
  );

  it('rechecks an older saved benchmark whose source was never bound', async () => {
    const benchmark = await sut.runBenchmark();
    stored = benchmark;
    mocks.hardwareProbe.readServer.mockClear();

    await expect(sut.getCheck()).resolves.toMatchObject({ benchmark: null });

    expect(mocks.hardwareProbe.readServer).toHaveBeenCalledOnce();
  });

  it('invalidates calibration when another enabled local destination becomes first', async () => {
    const other = { ...mlDestinationStub.local, id: 'other-local', url: 'http://other-local:3003' };
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, other]);
    await sut.runBenchmark();
    mocks.mlDestination.getAll.mockResolvedValue([other, mlDestinationStub.local]);

    await expect(sut.runCheck()).resolves.toMatchObject({ benchmark: null });
  });

  it('retains same-source calibration when unrelated destination rows are reordered', async () => {
    mocks.machineLearning.getRestorationModels.mockRejectedValue(new Error('worker unavailable'));
    mocks.mlDestination.getAll.mockResolvedValue([
      mlDestinationStub.local,
      mlDestinationStub.libraryLan,
      mlDestinationStub.lan,
    ]);
    const result = await sut.runBenchmark();
    mocks.mlDestination.getAll.mockResolvedValue([
      mlDestinationStub.lan,
      mlDestinationStub.local,
      mlDestinationStub.libraryLan,
    ]);

    await expect(sut.runCheck()).resolves.toMatchObject({ benchmark: result.benchmark });
  });

  it('measures embeddings and descriptions from one model configuration snapshot', async () => {
    const config = await sut['getConfig']({ withCache: true });
    const readConfig = vi
      .spyOn(sut as unknown as { getConfig: () => Promise<typeof config> }, 'getConfig')
      .mockResolvedValueOnce(config)
      .mockResolvedValue({
        ...config,
        machineLearning: {
          ...config.machineLearning,
          clip: { ...config.machineLearning.clip, modelName: 'later-model' },
        },
      });
    vi.spyOn(
      sut as unknown as { selectRoutedMlDestination: () => Promise<MlSelection> },
      'selectRoutedMlDestination',
    ).mockResolvedValue(mlSelectionStub(MlWorkload.Clip));
    vi.spyOn(
      sut as unknown as { selectMlDestination: () => Promise<MlSelection> },
      'selectMlDestination',
    ).mockResolvedValue(mlSelectionStub(MlWorkload.Enrichment));
    mocks.machineLearning.describeImageRun.mockResolvedValue({
      result: {} as never,
      model: config.machineLearning.imageDescription.modelName,
      device: 'cuda:0',
    });

    await sut.runBenchmark();

    expect(readConfig).toHaveBeenCalledOnce();
    expect(mocks.machineLearning.encodeText).toHaveBeenCalledWith(expect.anything(), expect.any(String), {
      modelName: config.machineLearning.clip.modelName,
    });
    expect(mocks.machineLearning.describeImageRun).toHaveBeenCalledWith(
      expect.anything(),
      '/tmp/test.jpg',
      config.machineLearning.imageDescription,
    );
  });

  it('keeps only a private fingerprint and omits it from fresh and cached responses', async () => {
    const destination = { ...mlDestinationStub.local, authToken: 'private-test-credential' };
    mocks.mlDestination.getAll.mockResolvedValue([destination]);

    const result = await sut.runBenchmark();
    const cached = await sut.getCheck();

    expect(stored).toMatchObject({ benchmarkScope: expect.stringMatching(/^[a-f\d]{64}$/) });
    expect(JSON.stringify(stored)).not.toContain(destination.authToken);
    expect(result).not.toHaveProperty('benchmarkScope');
    expect(cached).not.toHaveProperty('benchmarkScope');
    expect(cached).toEqual(result);
  });

  it.each(['other-worker', 'changed-url', 'changed-credential'] as const)(
    'does not calibrate this server from an embedding routed to %s',
    async (change) => {
      const destination = change === 'other-worker' ? mlDestinationStub.libraryLan : mlDestinationStub.local;
      const selection = mlSelectionStub(MlWorkload.Clip, destination);
      if (change === 'changed-url') selection.endpoint.url = 'http://replacement-worker:3003';
      else if (change === 'changed-credential') selection.endpoint.authToken = 'replacement-test-credential';
      vi.spyOn(
        sut as unknown as { selectRoutedMlDestination: () => Promise<MlSelection> },
        'selectRoutedMlDestination',
      ).mockResolvedValue(selection);

      const result = await sut.runBenchmark();

      expect(result.ml.test).toBeNull();
      expect(result.benchmark).toMatchObject({ embeddingMs: null, mlFactor: null });
      expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
    },
  );

  it('still measures five embeddings for a matching local destination', async () => {
    vi.spyOn(
      sut as unknown as { selectRoutedMlDestination: () => Promise<MlSelection> },
      'selectRoutedMlDestination',
    ).mockResolvedValue(mlSelectionStub(MlWorkload.Clip));

    const result = await sut.runBenchmark();

    expect(mocks.machineLearning.encodeText).toHaveBeenCalledTimes(5);
    expect(result.ml.test).toMatchObject({
      kind: 'embedding',
      ok: true,
      gpu: true,
      value: expect.any(Number),
      error: null,
    });
    expect(result.benchmark!.embeddingMs).toBe(result.ml.test!.value);
  });

  it('does not attribute description timing to hardware probed at another endpoint', async () => {
    const selection = mlSelectionStub(MlWorkload.Enrichment);
    selection.endpoint.url = 'http://replacement-worker:3003';
    vi.spyOn(
      sut as unknown as { selectMlDestination: () => Promise<MlSelection> },
      'selectMlDestination',
    ).mockResolvedValue(selection);

    const result = await sut.runBenchmark();

    expect(result.benchmark!.workloads[0]).toMatchObject({ workload: 'descriptions', unavailable: 'failed' });
    expect(mocks.machineLearning.describeImageRun).not.toHaveBeenCalled();
    expect(mocks.hardwareProbe.withTestImage).not.toHaveBeenCalled();
  });

  it('uses one destination snapshot for hardware and workload measurements', async () => {
    const replacement = { ...mlDestinationStub.local, id: 'replacement-worker', name: 'Replacement worker' };
    mocks.mlDestination.getAll.mockResolvedValueOnce([mlDestinationStub.local]).mockResolvedValue([replacement]);
    vi.spyOn(
      sut as unknown as { selectRoutedMlDestination: () => Promise<MlSelection> },
      'selectRoutedMlDestination',
    ).mockResolvedValue(mlSelectionStub(MlWorkload.Clip));
    vi.spyOn(
      sut as unknown as { selectMlDestination: (input: { destinationId: string }) => Promise<MlSelection> },
      'selectMlDestination',
    ).mockImplementation(({ destinationId }) =>
      Promise.resolve(
        mlSelectionStub(
          MlWorkload.Enrichment,
          destinationId === replacement.id ? replacement : mlDestinationStub.local,
        ),
      ),
    );
    mocks.machineLearning.describeImageRun.mockResolvedValue({
      result: {} as never,
      model: 'Qwen/Qwen2.5-VL-3B-Instruct',
      device: 'cuda:0',
    });

    const result = await sut.runBenchmark();

    expect(result.benchmark!.workloads[0]).toMatchObject({ worker: 'This server' });
    expect(mocks.mlDestination.getAll).toHaveBeenCalledOnce();
  });

  it('checks again when the kept check predates the per-container facts', async () => {
    stored = { checkedAt: 'old', server: {}, ml: {}, issues: [], benchmark: null };

    await expect(sut.getCheck()).resolves.toMatchObject({ findings: [], workers: [] });
    expect(mocks.hardwareProbe.readServer).toHaveBeenCalled();
  });

  it('does not label an unmeasured live session as usable GPU evidence or physical VRAM', async () => {
    mocks.renderWorker.listWorkers.mockResolvedValue([
      { id: 'legacy', name: 'Legacy worker', status: RenderWorkerStatus.Active },
    ] as never);
    mocks.renderWorker.listLiveSessions.mockResolvedValue([
      { worker: { id: 'legacy' }, session: { workerId: 'legacy', gpuMemoryBytes: '8589934592' } },
    ] as never);
    mocks.renderWorker.getSessionCapabilities.mockResolvedValue({ codecs: ['webcodecs-avc'], formats: ['mp4'] });
    const result = await sut.runCheck();
    expect(result.workers).toEqual([
      expect.objectContaining({
        id: 'legacy',
        vramGb: null,
        reachable: false,
        gpu: { present: null, visible: null, usable: null },
      }),
    ]);
  });

  it('shows enrolled render workers and restoration workers from what they reported', async () => {
    mocks.renderWorker.listWorkers.mockResolvedValue([
      {
        id: '0195e2a0-0000-7000-8000-00000000aaa1',
        name: 'Studio PC',
        status: RenderWorkerStatus.Active,
        lastSeenAt: new Date(),
      },
      { id: 'render-2', name: 'Old laptop', status: RenderWorkerStatus.Active },
      { id: 'render-3', name: 'Gone', status: RenderWorkerStatus.Revoked },
    ] as never);
    mocks.renderWorker.listLiveSessions.mockResolvedValue([
      withSyntheticGpuBudget(
        {
          worker: {
            id: '0195e2a0-0000-7000-8000-00000000aaa1',
            name: 'Studio PC',
            status: RenderWorkerStatus.Active,
            engineDigest: 'engine',
            gpuMemoryBytes: null,
            maxConcurrentOperations: 1,
            kinds: [MediaOperationKind.StudioExport],
            conformanceMaxAgeMs: 60_000,
          },
          session: {
            workerId: '0195e2a0-0000-7000-8000-00000000aaa1',
            id: 'session',
            engineDigest: 'engine',
            scopes: [MediaOperationKind.StudioExport],
            gpuMemoryBytes: '2147483648',
            codecs: ['webcodecs-avc'],
            colorPrecision: null,
            conformanceReportedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
          },
        } as never,
        { codecs: ['webcodecs-avc'], formats: ['mp4'] },
      ),
    ] as never);
    mocks.renderWorker.getSessionCapabilities.mockResolvedValue({ codecs: ['webcodecs-avc'], formats: ['mp4'] });
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
        id: '0195e2a0-0000-7000-8000-00000000aaa1',
        kind: 'render',
        vramGb: null,
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

    // FL-589: a session outlives a worker that stopped; one not seen for over ten minutes is not answering.
    mocks.renderWorker.listWorkers.mockResolvedValue([
      {
        id: '0195e2a0-0000-7000-8000-00000000aaa1',
        name: 'Studio PC',
        status: RenderWorkerStatus.Active,
        lastSeenAt: new Date(Date.now() - 11 * 60 * 1000),
      },
    ] as never);
    expect((await sut.runCheck()).workers[0]).toMatchObject({ reachable: false, gpu: { usable: null } });
  });

  it('records throughput per workload, timing descriptions on this server only', async () => {
    const selection = mlSelectionStub(MlWorkload.Clip);
    const select = vi
      .spyOn(sut as unknown as { selectMlDestination: () => Promise<MlSelection> }, 'selectMlDestination')
      .mockResolvedValue(selection);
    mocks.machineLearning.describeImageRun.mockResolvedValue({
      result: {} as never,
      model: 'Qwen/Qwen2.5-VL-3B-Instruct',
      device: 'cuda:0',
    });
    mocks.renderWorker.getSessionCapabilities.mockResolvedValue({ codecs: ['webcodecs-avc'], formats: ['mp4'] });
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, mlDestinationStub.lan]);
    mocks.machineLearning.getRestorationModels.mockResolvedValue({
      protocol: 'restoration-v1',
      workloads: [MlWorkload.RestorationFaithful],
      gpus: [{ name: 'NVIDIA GeForce RTX 4090', memoryTotalBytes: 24 * 1024 ** 3, driverVersion: '560.35' }],
      models: [
        { state: 'available', mode: 'faithful', measured: [{ gpu: 'NVIDIA GeForce RTX 4090', framesPerSecond: 4 }] },
      ],
      configurationProblems: [],
      checkedAt: '2026-09-27T00:00:00.000Z',
    } as never);

    const { benchmark } = await sut.runBenchmark();

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ workload: MlWorkload.Enrichment, destinationId: mlDestinationStub.local.id }),
    );
    // One photo loads the model, the next two are timed.
    expect(mocks.machineLearning.describeImageRun).toHaveBeenCalledTimes(3);
    expect(benchmark!.workloads.map((entry) => [entry.workload, entry.unavailable ?? entry.source])).toEqual([
      ['descriptions', 'benchmark'],
      ['upscale', 'no-local-runner'],
      ['restoration', 'qualification'],
      ['studio', 'no-local-worker'],
      // The worker is not allowed to run Smooth motion, so nothing here runs it.
      ['interpolation', 'no-local-worker'],
    ]);
    expect(benchmark!.workloads[0]).toMatchObject({
      unit: 'photo',
      runsOn: 'gpu',
      worker: 'This server',
      model: 'Qwen/Qwen2.5-VL-3B-Instruct',
      fallbackFrom: null,
    });
    expect(benchmark!.workloads[2]).toMatchObject({ unit: 'frame', perHour: 14_400, worker: 'Workshop GPU' });
  });

  it('records Smooth motion from the RIFE model the restoration worker measured (FL-162)', async () => {
    vi.spyOn(
      sut as unknown as { selectMlDestination: () => Promise<MlSelection> },
      'selectMlDestination',
    ).mockResolvedValue(mlSelectionStub(MlWorkload.Clip));
    mocks.machineLearning.describeImageRun.mockRejectedValue(new Error('no description model'));
    mocks.renderWorker.getSessionCapabilities.mockResolvedValue({ codecs: ['webcodecs-avc'], formats: ['mp4'] });
    const smooth = { ...mlDestinationStub.lan, workloads: [MlWorkload.RestorationFaithful, MlWorkload.Interpolation] };
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, smooth]);
    mocks.machineLearning.getRestorationModels.mockResolvedValue({
      protocol: 'restoration-v1',
      workloads: [MlWorkload.RestorationFaithful, MlWorkload.Interpolation],
      gpus: [{ name: 'NVIDIA GeForce RTX 4090', memoryTotalBytes: 24 * 1024 ** 3, driverVersion: '560.35' }],
      models: [
        { state: 'available', mode: 'faithful', measured: [{ gpu: 'NVIDIA GeForce RTX 4090', framesPerSecond: 4 }] },
        {
          state: 'available',
          mode: 'smooth_motion',
          measured: [{ gpu: 'NVIDIA GeForce RTX 4090', framesPerSecond: 60 }],
        },
      ],
      configurationProblems: [],
      checkedAt: '2026-09-27T00:00:00.000Z',
    } as never);

    const { benchmark } = await sut.runBenchmark();

    expect(benchmark!.workloads.find((entry) => entry.workload === 'restoration')).toMatchObject({
      source: 'qualification',
      perHour: 14_400,
    });
    expect(benchmark!.workloads.find((entry) => entry.workload === 'interpolation')).toMatchObject({
      source: 'qualification',
      unit: 'frame',
      perHour: 216_000,
      runsOn: 'gpu',
      worker: 'Workshop GPU',
      unavailable: null,
    });
  });

  it('records the fallback model and the device the worker ran it on, not the GPUs present (FL-427)', async () => {
    vi.spyOn(
      sut as unknown as { selectMlDestination: () => Promise<MlSelection> },
      'selectMlDestination',
    ).mockResolvedValue(mlSelectionStub(MlWorkload.Enrichment));
    // A CUDA container whose configured Qwen model failed, so Florence answered on the processor.
    mocks.machineLearning.describeImageRun.mockResolvedValue({
      result: {} as never,
      model: 'microsoft/Florence-2-base-ft',
      device: 'cpu',
    });

    const { benchmark } = await sut.runBenchmark();

    expect(benchmark!.workloads[0]).toMatchObject({
      workload: 'descriptions',
      runsOn: 'cpu',
      model: 'microsoft/Florence-2-base-ft',
      fallbackFrom: 'Qwen/Qwen2.5-VL-3B-Instruct',
    });
  });

  it('leaves the device unknown when the worker does not say where it ran', async () => {
    vi.spyOn(
      sut as unknown as { selectMlDestination: () => Promise<MlSelection> },
      'selectMlDestination',
    ).mockResolvedValue(mlSelectionStub(MlWorkload.Enrichment));
    mocks.machineLearning.describeImageRun.mockResolvedValue({
      result: {} as never,
      model: 'Qwen/Qwen2.5-VL-3B-Instruct',
      device: null,
    });

    const { benchmark } = await sut.runBenchmark();

    expect(benchmark!.workloads[0]).toMatchObject({ workload: 'descriptions', source: 'benchmark', runsOn: null });
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

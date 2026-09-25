import { SystemMetadataKey } from 'src/enum.js';
import { HardwareCheckService } from 'src/services/hardware-check.service.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { newTestService, ServiceMocks } from 'test/utils.js';

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
    });
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
      benchmark: null,
    });
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
});

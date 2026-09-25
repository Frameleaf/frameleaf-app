import {
  benchmarkFactors,
  detectHardwareIssues,
  median,
  mlCheckFrom,
  serverCheckFrom,
  testEncoderFor,
  type MlContainerReport,
  type ServerHardwareFacts,
} from 'src/utils/hardware-check.js';

const GB = 1024 ** 3;

const server = (overrides: Partial<ServerHardwareFacts> = {}): ServerHardwareFacts => ({
  nvidia: null,
  nvidiaError: null,
  nvidiaRequested: false,
  nvidiaDevice: false,
  renderNodes: [],
  encoders: ['libx264', 'h264_nvenc', 'h264_vaapi'],
  test: { encoder: 'libx264', gpu: false, speed: 1.3, error: null },
  ...overrides,
});

const ml = (overrides: Partial<MlContainerReport> = {}, devices: Partial<MlContainerReport['devices']> = {}) =>
  ({
    image: 'cpu',
    backend: 'CPU',
    gpus: [],
    driver: null,
    nvidiaError: null,
    ...overrides,
    devices: { renderNodes: [], kfd: false, kfdAccessible: false, nvidia: false, nvidiaRequested: false, ...devices },
  }) as MlContainerReport;

describe('hardware check (FL-159)', () => {
  it('tests NVENC with an NVIDIA card, VA-API with an accessible render node, else the processor', () => {
    const nvidia = { name: 'NVIDIA GeForce RTX 3060', memoryTotalBytes: 12 * GB, driver: 'Driver 550.107' };
    expect(testEncoderFor(server({ nvidia })).encoder).toBe('h264_nvenc');
    const node = { node: 'renderD128', vendor: 'Intel', accessible: true, memoryTotalBytes: null };
    expect(testEncoderFor(server({ renderNodes: [node] }))).toEqual({
      encoder: 'h264_vaapi',
      node: '/dev/dri/renderD128',
    });
    expect(testEncoderFor(server({ renderNodes: [{ ...node, accessible: false }] })).encoder).toBe('libx264');
  });

  it('reports the server container by what its test transcode actually used', () => {
    const nvidia = { name: 'NVIDIA GeForce RTX 3060', memoryTotalBytes: 12 * GB, driver: 'Driver 550.107' };
    expect(
      serverCheckFrom(server({ nvidia, test: { encoder: 'h264_nvenc', gpu: true, speed: 9.6, error: null } })),
    ).toMatchObject({
      vendor: 'NVIDIA',
      model: 'NVIDIA GeForce RTX 3060',
      vramGb: 12,
      backend: 'NVENC',
      test: { kind: 'transcode', ok: true, gpu: true, value: 9.6 },
    });
    // The card is there but the encoder failed: the processor did the work, and the check says so.
    const fellBack = serverCheckFrom(
      server({
        nvidia,
        test: { encoder: 'libx264', gpu: false, speed: 1.4, error: 'Cannot load libnvidia-encode.so.1' },
      }),
    );
    expect(fellBack).toMatchObject({ backend: 'CPU', test: { ok: false, gpu: false } });
  });

  it('reports the ML container by the GPU it reaches, or the processor', () => {
    const cuda = ml({
      image: 'cuda',
      backend: 'CUDA',
      gpus: [{ name: 'NVIDIA GeForce GTX 1650', vendor: 'NVIDIA', memoryTotalBytes: 4 * GB }],
      driver: 'Driver 550.107 · CUDA 12.4',
    });
    expect(mlCheckFrom(cuda, null)).toMatchObject({ vendor: 'NVIDIA', vramGb: 4, backend: 'CUDA' });
    expect(mlCheckFrom(ml(), null).backend).toBe('CPU');
    expect(mlCheckFrom(null, null).reachable).toBe(false);
  });

  it('names a problem only from evidence in the container', () => {
    expect(detectHardwareIssues(server(), ml())).toEqual([]);
    const node = { node: 'renderD128', vendor: 'Intel', accessible: true, memoryTotalBytes: null };
    expect(detectHardwareIssues(null, ml({ image: 'openvino' }, { renderNodes: [node] }))).toEqual([
      'openvino-cpu-only',
    ]);
    expect(detectHardwareIssues(null, ml({ image: 'openvino' }))).toEqual(['dri-missing']);
    expect(
      detectHardwareIssues(server({ renderNodes: [{ ...node, vendor: 'AMD', accessible: false }] }), null),
    ).toEqual(['render-permission']);
    expect(detectHardwareIssues(null, ml({ image: 'rocm' }, { renderNodes: [{ ...node, vendor: 'AMD' }] }))).toEqual([
      'kfd-missing',
    ]);
    expect(detectHardwareIssues(null, ml({ image: 'cpu' }, { nvidia: true }))).toEqual(['cpu-image']);
    expect(detectHardwareIssues(server({ nvidiaRequested: true }), null)).toEqual(['nvidia-toolkit']);
    expect(
      detectHardwareIssues(
        server({ nvidiaError: 'CUDA driver version is insufficient for CUDA runtime version' }),
        null,
      ),
    ).toEqual(['nvidia-driver-old']);
    expect(detectHardwareIssues(server({ renderNodes: [{ ...node, vendor: 'NVIDIA' }] }), null)).toEqual([
      'nvidia-dri',
    ]);
  });

  it('turns the benchmark into bounded speed factors against the estimates', () => {
    expect(benchmarkFactors({ backend: 'CUDA', embeddingMs: 60 }, { backend: 'NVENC', transcodeSpeed: 9 })).toEqual({
      ml: 2,
      server: 1,
    });
    expect(benchmarkFactors({ backend: 'CPU', embeddingMs: 4000 }, { backend: 'CPU', transcodeSpeed: null })).toEqual({
      ml: 3,
      server: null,
    });
    expect(median([30, 10, 20])).toBe(20);
    expect(median([])).toBeNull();
  });
});

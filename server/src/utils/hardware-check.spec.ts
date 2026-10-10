import {
  type HostFacts,
  type HostGpu,
  type MlContainerReport,
  type RenderNode,
  type ServerHardwareFacts,
  benchmarkFactors,
  detectHardwareFindings,
  detectHardwareIssues,
  isIntegratedGpu,
  measuredWorkload,
  median,
  mlCheckFrom,
  renderWorkerCheckFrom,
  restorationThroughput,
  restorationWorkerCheckFrom,
  serverCheckFrom,
  testEncoderFor,
  unavailableWorkload,
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
  host: null,
  ...overrides,
});

const host = (overrides: Partial<HostFacts> = {}): HostFacts => ({
  kernel: '6.8.0-45-generic',
  gpus: [],
  dxg: false,
  groups: [0],
  root: true,
  ...overrides,
});

const intelIgpu: HostGpu = {
  pciAddress: '0000:00:02.0',
  vendor: 'Intel',
  renderNode: 'renderD128',
  integrated: true,
  memoryTotalBytes: null,
};
const radeon: HostGpu = {
  pciAddress: '0000:03:00.0',
  vendor: 'AMD',
  renderNode: 'renderD129',
  integrated: false,
  memoryTotalBytes: 16 * GB,
};
const rtx: HostGpu = {
  pciAddress: '0000:01:00.0',
  vendor: 'NVIDIA',
  renderNode: 'renderD128',
  integrated: false,
  memoryTotalBytes: null,
};
const node = (overrides: Partial<RenderNode> = {}): RenderNode => ({
  node: 'renderD128',
  vendor: 'Intel',
  accessible: true,
  memoryTotalBytes: null,
  gid: 993,
  hostNode: 'renderD128',
  ...overrides,
});
const idsOf = (findings: ReturnType<typeof detectHardwareFindings>) =>
  findings.map((finding) => `${finding.container}:${finding.id}`);

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

  describe('three facts per container', () => {
    it('reports a GPU present, visible and usable when the test ran on it', () => {
      const nvidia = { name: 'NVIDIA GeForce RTX 3060', memoryTotalBytes: 12 * GB, driver: 'Driver 550.107' };
      const check = serverCheckFrom(
        server({ nvidia, nvidiaDevice: true, test: { encoder: 'h264_nvenc', gpu: true, speed: 9.6, error: null } }),
      );
      expect(check.gpu).toEqual({ present: true, visible: true, usable: true });
    });

    it('separates a GPU on the host that the container cannot see', () => {
      const check = serverCheckFrom(server({ host: host({ gpus: [rtx] }) }));
      expect(check.gpu).toEqual({ present: true, visible: false, usable: false });
    });

    it('separates a GPU the container sees that the runtime did not use', () => {
      const check = serverCheckFrom(
        server({
          renderNodes: [node()],
          host: host({ gpus: [intelIgpu] }),
          test: { encoder: 'libx264', gpu: false, speed: 1.2, error: 'No VA display found for device' },
        }),
      );
      expect(check.gpu).toEqual({ present: true, visible: true, usable: false });
    });

    it('does not guess the host when the PCI list is unreadable or hidden by a virtual machine', () => {
      expect(serverCheckFrom(server()).gpu.present).toBeNull();
      expect(serverCheckFrom(server({ host: host({ kernel: '6.10.14-linuxkit' }) })).gpu.present).toBeNull();
      expect(serverCheckFrom(server({ host: host({ gpus: [] }) })).gpu.present).toBe(false);
      expect(serverCheckFrom(server({ test: null })).gpu.usable).toBeNull();
    });

    it('reports the ML container facts, and nothing when it did not answer', () => {
      const cuda = ml(
        {
          image: 'cuda',
          backend: 'CUDA',
          gpus: [{ name: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', memoryTotalBytes: 12 * GB }],
        },
        { nvidia: true },
      );
      expect(mlCheckFrom(cuda, null).gpu).toEqual({ present: true, visible: true, usable: true });
      expect(mlCheckFrom(ml({ image: 'rocm', host: host({ gpus: [radeon] }) }, { kfd: true }), null).gpu).toEqual({
        present: true,
        visible: true,
        usable: false,
      });
      expect(mlCheckFrom(null, null).gpu).toEqual({ present: null, visible: null, usable: null });
    });

    it('tells integrated GPUs from graphics cards', () => {
      expect(isIntegratedGpu('Intel', '0000:00:02.0', null)).toBe(true);
      expect(isIntegratedGpu('Intel', '0000:03:00.0', null)).toBe(false);
      expect(isIntegratedGpu('AMD', '0000:05:00.0', 512 * 1024 ** 2)).toBe(true);
      expect(isIntegratedGpu('AMD', '0000:03:00.0', 16 * GB)).toBe(false);
      expect(isIntegratedGpu('NVIDIA', '0000:01:00.0', null)).toBe(false);
    });
  });

  describe('workers', () => {
    it('shows a render worker from its admitted session, and nothing without one', () => {
      expect(renderWorkerCheckFrom({ id: 'w1', name: 'Studio PC' }, { gpuMemoryBytes: String(8 * GB) })).toEqual({
        id: 'w1',
        name: 'Studio PC',
        kind: 'render',
        reachable: true,
        model: null,
        vramGb: 8,
        gpu: { present: true, visible: true, usable: true },
      });
      expect(renderWorkerCheckFrom({ id: 'w1', name: 'Studio PC' }, null)).toMatchObject({
        reachable: false,
        gpu: { present: null, visible: null, usable: null },
      });
    });

    it('shows a restoration worker from its report, "not reported" when the driver lists no GPU', () => {
      const report = {
        gpus: [{ name: 'NVIDIA GeForce RTX 4090', memoryTotalBytes: 24 * GB }],
        models: [
          { state: 'available', measured: [{ gpu: 'NVIDIA GeForce RTX 4090', framesPerSecond: 3.2 }] },
          { state: 'available', measured: [{ gpu: 'NVIDIA A100', framesPerSecond: 11 }] },
          { state: 'weights-missing', measured: [{ gpu: 'NVIDIA GeForce RTX 4090', framesPerSecond: 20 }] },
        ],
      };
      expect(restorationWorkerCheckFrom({ id: 'd1', name: 'Restoration' }, report)).toMatchObject({
        kind: 'restoration',
        reachable: true,
        model: 'NVIDIA GeForce RTX 4090',
        vramGb: 24,
        gpu: { present: true, visible: true, usable: true },
      });
      // Only a ready model measured on the GPU the worker has now counts.
      expect(restorationThroughput(report)).toBe(3.2);
      expect(restorationWorkerCheckFrom({ id: 'd1', name: 'Restoration' }, { gpus: [], models: [] }).gpu).toEqual({
        present: null,
        visible: null,
        usable: null,
      });
      expect(restorationWorkerCheckFrom({ id: 'd1', name: 'Restoration' }, null).reachable).toBe(false);
    });
  });

  describe('set-up problems (fixtures per misconfiguration)', () => {
    it('wrong-gpu: only the integrated GPU is passed in on a host with a graphics card', () => {
      const facts = server({
        renderNodes: [node()],
        host: host({ gpus: [intelIgpu, radeon] }),
      });
      expect(detectHardwareFindings(facts, null)).toEqual([
        {
          id: 'wrong-gpu',
          container: 'server',
          gid: null,
          pciAddress: '0000:03:00.0',
          gfxVersion: null,
          computeCapability: null,
        },
      ]);
    });

    it('wrong-gpu: both passed in, and the integrated GPU is the first node the runtime picks', () => {
      const facts = ml(
        { image: 'openvino', host: host({ gpus: [intelIgpu, radeon] }) },
        { renderNodes: [node(), node({ node: 'renderD129', hostNode: 'renderD129', vendor: 'AMD' })] },
      );
      expect(idsOf(detectHardwareFindings(null, facts))).toContain('ml:wrong-gpu');
    });

    it('wrong-gpu: not when the graphics card is the one in use, or the card is NVIDIA', () => {
      expect(
        detectHardwareFindings(
          server({
            renderNodes: [node({ node: 'renderD128', hostNode: 'renderD129', vendor: 'AMD' })],
            host: host({ gpus: [intelIgpu, radeon] }),
          }),
          null,
        ),
      ).toEqual([]);
      expect(
        detectHardwareFindings(server({ renderNodes: [node()], host: host({ gpus: [intelIgpu, rtx] }) }), null),
      ).toEqual([]);
    });

    it('rocm-gfx: an RX 6000 card without HSA_OVERRIDE_GFX_VERSION', () => {
      const report = ml(
        { image: 'rocm', rocm: { gfxTargets: ['gfx1032'], hsaOverride: null } },
        { renderNodes: [node({ vendor: 'AMD' })], kfd: true, kfdAccessible: true },
      );
      expect(detectHardwareFindings(null, report)).toEqual([
        expect.objectContaining({ id: 'rocm-gfx', container: 'ml', gfxVersion: '10.3.0' }),
      ]);
      // Set, or a card ROCm supports as it is: nothing to fix.
      expect(
        detectHardwareFindings(null, { ...report, rocm: { gfxTargets: ['gfx1032'], hsaOverride: '10.3.0' } }),
      ).toEqual([]);
      expect(detectHardwareFindings(null, { ...report, rocm: { gfxTargets: ['gfx1100'], hsaOverride: null } })).toEqual(
        [],
      );
    });

    it('wsl2: the container runs under WSL2 and does not reach the GPU', () => {
      const wsl = host({ kernel: '5.15.153.1-microsoft-standard-WSL2', gpus: null });
      expect(idsOf(detectHardwareFindings(server({ host: wsl }), null))).toEqual(['server:wsl2']);
      const working = server({
        host: wsl,
        nvidia: { name: 'NVIDIA GeForce RTX 3060', memoryTotalBytes: 12 * GB, driver: 'Driver 560' },
        test: { encoder: 'h264_nvenc', gpu: true, speed: 9, error: null },
      });
      expect(detectHardwareFindings(working, null)).toEqual([]);
    });

    it('unraid: the host has the card but the container does not see it', () => {
      const unraid = host({ kernel: '6.1.106-Unraid', gpus: [rtx] });
      expect(idsOf(detectHardwareFindings(server({ host: unraid }), ml({ host: unraid })))).toEqual([
        'server:unraid',
        'ml:unraid',
      ]);
      expect(detectHardwareFindings(server({ host: host({ kernel: '6.1.106-Unraid', gpus: [] }) }), null)).toEqual([]);
    });

    it('macos: Docker Desktop runs containers in a virtual machine without the GPU', () => {
      const desktop = host({ kernel: '6.10.14-linuxkit', gpus: [] });
      expect(idsOf(detectHardwareFindings(server({ host: desktop }), ml({ host: desktop })))).toEqual([
        'server:macos',
        'ml:macos',
      ]);
      expect(
        idsOf(detectHardwareFindings(server({ host: host({ kernel: '6.12.10-orbstack-00282-gd1783374c25e' }) }), null)),
      ).toEqual(['server:macos']);
    });

    it('nvidia-bf16: a Turing card runs without bf16 and FlashAttention', () => {
      const turing = ml(
        {
          image: 'cuda',
          backend: 'CUDA',
          gpus: [{ name: 'NVIDIA GeForce GTX 1650', vendor: 'NVIDIA', memoryTotalBytes: 4 * GB }],
          computeCapability: '7.5',
        },
        { nvidia: true },
      );
      expect(detectHardwareFindings(null, turing)).toEqual([
        expect.objectContaining({ id: 'nvidia-bf16', container: 'ml', computeCapability: '7.5' }),
      ]);
      expect(detectHardwareFindings(null, { ...turing, computeCapability: '8.6' })).toEqual([]);
    });

    it('render-group: the render node belongs to a group the container does not run with', () => {
      const facts = server({
        renderNodes: [node({ accessible: false, gid: 993 })],
        host: host({ gpus: [intelIgpu], groups: [1000, 44], root: false }),
      });
      expect(detectHardwareFindings(facts, null)).toEqual([expect.objectContaining({ id: 'render-group', gid: 993 })]);
      // In the group but still not allowed: a plain permission problem, not the group.
      const inGroup = server({
        renderNodes: [node({ accessible: false, gid: 993 })],
        host: host({ gpus: [intelIgpu], groups: [993], root: false }),
      });
      expect(idsOf(detectHardwareFindings(inGroup, null))).toEqual(['server:render-permission']);
    });
  });

  it('records throughput per workload, or why there is none', () => {
    expect(
      measuredWorkload('descriptions', {
        unit: 'photo',
        secondsPerUnit: 2.4,
        source: 'benchmark',
        runsOn: 'gpu',
        worker: 'Local',
      }),
    ).toEqual({
      workload: 'descriptions',
      source: 'benchmark',
      unit: 'photo',
      perHour: 1500,
      secondsPerUnit: 2.4,
      runsOn: 'gpu',
      worker: 'Local',
      unavailable: null,
      error: null,
    });
    expect(unavailableWorkload('upscale', 'no-local-runner')).toMatchObject({
      perHour: null,
      unavailable: 'no-local-runner',
    });
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

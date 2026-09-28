/**
 * Hardware & GPU (FL-159, CLD-201, handoff §3.2): what the server container (video transcoding and
 * Studio export) and the machine-learning container (AI features) can each actually use. Detection
 * runs inside each container: the server reads its own devices and runs a short test transcode; the
 * ML container reports through `GET /hardware` (`container`) and a test search embedding is timed.
 *
 * Pure functions: they turn what was read into one result per container and the set-up problems
 * that result shows, by the ids of the web catalogue's `gpuProblems`. Nothing here guesses at a card
 * the container cannot see; a problem is named only when the container gives evidence of it.
 */

export type HardwareBackend = 'CUDA' | 'ROCm' | 'OpenVINO' | 'NVENC' | 'VA-API' | 'QSV' | 'CPU';

export type RenderNode = {
  node: string;
  vendor: string | null;
  accessible: boolean;
  memoryTotalBytes: number | null;
  /** Group that owns the node, as a number: the host's render group when /dev/dri is passed in. */
  gid?: number | null;
  /** The host render node this is (by device number); it can differ from the name inside. */
  hostNode?: string | null;
};

/** A GPU on the host, from the PCI list the container reads in `/sys` (not only what was passed in). */
export type HostGpu = {
  pciAddress: string;
  vendor: string;
  /** Its render node on the host, when it has one. */
  renderNode: string | null;
  /** An integrated GPU (Intel at 00:02.0, or AMD with little dedicated memory). */
  integrated: boolean;
  memoryTotalBytes: number | null;
};

/** What a container can read about the machine it runs on. */
export type HostFacts = {
  /** `/proc/sys/kernel/osrelease`: names WSL2, Docker Desktop's virtual machine and Unraid. */
  kernel: string | null;
  /** GPUs on the host; null when the PCI list cannot be read. */
  gpus: HostGpu[] | null;
  /** `/dev/dxg` is passed in (WSL2's GPU device). */
  dxg: boolean;
  /** The groups the container's process runs with. */
  groups: number[];
  /** The process runs as root, which opens any device node regardless of its group. */
  root: boolean;
};

/** What the server container read about itself. */
export type ServerHardwareFacts = {
  nvidia: { name: string; memoryTotalBytes: number | null; driver: string } | null;
  nvidiaError: string | null;
  nvidiaRequested: boolean;
  nvidiaDevice: boolean;
  renderNodes: RenderNode[];
  encoders: string[];
  test: TestTranscode | null;
  host: HostFacts | null;
};

export type TestTranscode = {
  /** The encoder the test used. */
  encoder: string;
  /** True when it ran on the GPU's video engine. */
  gpu: boolean;
  /** Real-time multiple for 1080p (e.g. 9.6 = 9.6× real time), or null when it failed. */
  speed: number | null;
  /** The first line ffmpeg wrote when the GPU encoder failed. */
  error: string | null;
};

/** What the ML container reported (`GET /hardware` → `container`). */
export type MlContainerReport = {
  image: string;
  backend: string;
  gpus: Array<{ name: string; vendor: string | null; memoryTotalBytes: number | null }>;
  driver: string | null;
  nvidiaError: string | null;
  devices: {
    renderNodes: RenderNode[];
    kfd: boolean;
    kfdAccessible: boolean;
    nvidia: boolean;
    nvidiaRequested: boolean;
  };
  /** Absent from an older ML image. */
  host?: HostFacts | null;
  /** CUDA compute capability of the first GPU, such as "7.5"; bf16 and FlashAttention need 8.0. */
  computeCapability?: string | null;
  /** ROCm: the gfx targets of the GPUs and the `HSA_OVERRIDE_GFX_VERSION` set, if any. */
  rocm?: { gfxTargets: string[]; hsaOverride: string | null } | null;
};

/**
 * The three separate facts per container (FL-159): a GPU is on the host, the container can see it,
 * and the runtime actually used it. Null when the container cannot tell (never a guess).
 */
export type GpuFacts = { present: boolean | null; visible: boolean | null; usable: boolean | null };

export type ContainerTest = {
  kind: 'transcode' | 'embedding';
  ok: boolean;
  /** True when the test ran on the GPU. */
  gpu: boolean;
  /** Transcode: real-time multiple. Embedding: milliseconds. */
  value: number | null;
  error: string | null;
};

export type ContainerCheck = {
  reachable: boolean;
  vendor: string | null;
  model: string | null;
  vramGb: number | null;
  driver: string | null;
  backend: HardwareBackend;
  test: ContainerTest | null;
  gpu: GpuFacts;
};

export type HardwareContainer = 'server' | 'ml';

/** One set-up problem the check found, with what a copy-ready fix needs to name. */
export type HardwareFinding = {
  id: string;
  container: HardwareContainer;
  /** render-group: the group number that owns the render node. */
  gid: number | null;
  /** wrong-gpu: the PCI address of the graphics card to pass in. */
  pciAddress: string | null;
  /** rocm-gfx: the `HSA_OVERRIDE_GFX_VERSION` value the card needs. */
  gfxVersion: string | null;
  /** nvidia-bf16: the card's compute capability. */
  computeCapability: string | null;
};

const GB = 1024 ** 3;
const ML_BACKENDS: ReadonlySet<string> = new Set(['CUDA', 'ROCm', 'OpenVINO']);
const gb = (bytes: number | null | undefined) => (bytes && bytes > 0 ? Math.round((bytes / GB) * 10) / 10 : null);

/** The encoder a server test transcode should try first: NVENC, then VA-API, else the processor. */
export const testEncoderFor = (facts: Pick<ServerHardwareFacts, 'nvidia' | 'renderNodes' | 'encoders'>) => {
  if (facts.nvidia && facts.encoders.includes('h264_nvenc')) {
    return { encoder: 'h264_nvenc', node: null };
  }
  const node = facts.renderNodes.find((entry) => entry.accessible);
  if (node && facts.encoders.includes('h264_vaapi')) {
    return { encoder: 'h264_vaapi', node: `/dev/dri/${node.node}` };
  }
  return { encoder: 'libx264', node: null };
};

/**
 * An integrated GPU: Intel's always sits at PCI 00:02.0; an AMD APU has only a small memory
 * carve-out (a graphics card has 2 GB or more of its own). NVIDIA makes no integrated GPUs here.
 */
export const isIntegratedGpu = (vendor: string, pciAddress: string, memoryTotalBytes: number | null) => {
  if (vendor === 'Intel') {
    return pciAddress.endsWith('00:02.0');
  }
  return vendor === 'AMD' && (memoryTotalBytes ?? 0) < 2 * GB;
};

export type HostEnvironment = 'wsl2' | 'docker-desktop' | 'unraid' | null;

/** Where the container runs, from the kernel it shares with the host (or the host's virtual machine). */
export const hostEnvironment = (host: HostFacts | null | undefined): HostEnvironment => {
  const kernel = host?.kernel ?? '';
  if (/microsoft/i.test(kernel)) {
    return 'wsl2';
  }
  // Docker Desktop (as on a Mac) and OrbStack run containers in their own Linux virtual machine.
  if (/linuxkit|orbstack/i.test(kernel)) {
    return 'docker-desktop';
  }
  return /unraid/i.test(kernel) ? 'unraid' : null;
};

export const UNKNOWN_FACTS: GpuFacts = Object.freeze({ present: null, visible: null, usable: null });

/**
 * A GPU on the host: yes when the container sees one; otherwise what the host's PCI list says,
 * unless the container runs in a virtual machine (WSL2, Docker Desktop) that hides the host's GPUs.
 */
const presentOnHost = (host: HostFacts | null | undefined, visible: boolean): boolean | null => {
  if (visible) {
    return true;
  }
  if (!host?.gpus || hostEnvironment(host) === 'wsl2' || hostEnvironment(host) === 'docker-desktop') {
    return null;
  }
  return host.gpus.length > 0;
};

export const serverGpuFacts = (facts: ServerHardwareFacts): GpuFacts => {
  const visible = !!facts.nvidia || facts.nvidiaDevice || facts.renderNodes.length > 0 || !!facts.host?.dxg;
  return {
    present: presentOnHost(facts.host, visible),
    visible,
    usable: facts.test ? facts.test.gpu && facts.test.speed !== null : null,
  };
};

export const mlGpuFacts = (report: MlContainerReport | null): GpuFacts => {
  if (!report) {
    return UNKNOWN_FACTS;
  }
  const visible =
    report.devices.nvidia ||
    report.devices.kfd ||
    report.devices.renderNodes.length > 0 ||
    report.gpus.length > 0 ||
    !!report.host?.dxg;
  return {
    present: presentOnHost(report.host, visible),
    visible,
    usable: report.gpus.length > 0 && ML_BACKENDS.has(report.backend),
  };
};

export const serverCheckFrom = (facts: ServerHardwareFacts): ContainerCheck => {
  const node = facts.renderNodes[0] ?? null;
  const onGpu = !!facts.test?.gpu && facts.test.speed !== null;
  const backend: HardwareBackend = onGpu ? (facts.test!.encoder === 'h264_nvenc' ? 'NVENC' : 'VA-API') : 'CPU';
  const test: ContainerTest | null = facts.test
    ? {
        kind: 'transcode',
        ok: facts.test.error === null && facts.test.speed !== null,
        gpu: onGpu,
        value: facts.test.speed,
        error: facts.test.error,
      }
    : null;
  const gpu = serverGpuFacts(facts);
  if (facts.nvidia) {
    return {
      reachable: true,
      vendor: 'NVIDIA',
      model: facts.nvidia.name,
      vramGb: gb(facts.nvidia.memoryTotalBytes),
      driver: facts.nvidia.driver,
      backend,
      test,
      gpu,
    };
  }
  return {
    reachable: true,
    vendor: node?.vendor ?? null,
    model: null,
    vramGb: gb(node?.memoryTotalBytes),
    driver: facts.nvidiaError,
    backend,
    test,
    gpu,
  };
};

export const mlCheckFrom = (report: MlContainerReport | null, embedding: ContainerTest | null): ContainerCheck => {
  if (!report) {
    return {
      reachable: false,
      vendor: null,
      model: null,
      vramGb: null,
      driver: null,
      backend: 'CPU',
      test: embedding,
      gpu: UNKNOWN_FACTS,
    };
  }
  const gpu = report.gpus[0] ?? null;
  const node = report.devices.renderNodes[0] ?? null;
  return {
    reachable: true,
    vendor: gpu?.vendor ?? node?.vendor ?? null,
    model: gpu?.name ?? null,
    vramGb: gb(gpu?.memoryTotalBytes ?? node?.memoryTotalBytes),
    driver: report.driver ?? report.nvidiaError,
    backend: gpu && ML_BACKENDS.has(report.backend) ? (report.backend as HardwareBackend) : 'CPU',
    test: embedding,
    gpu: mlGpuFacts(report),
  };
};

/**
 * ROCm targets that are not built into the ROCm runtime and run only as the nearest supported
 * target, with the `HSA_OVERRIDE_GFX_VERSION` that selects it (RX 6000 → 10.3.0, RX 7600 and the
 * 780M → 11.0.0, Vega APUs → 9.0.0).
 */
export const ROCM_GFX_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  gfx90c: '9.0.0',
  gfx1031: '10.3.0',
  gfx1032: '10.3.0',
  gfx1033: '10.3.0',
  gfx1034: '10.3.0',
  gfx1035: '10.3.0',
  gfx1036: '10.3.0',
  gfx1102: '11.0.0',
  gfx1103: '11.0.0',
});

/** Compute capability from which bf16 and FlashAttention run (Ampere); Turing is 7.5. */
const BF16_COMPUTE_CAPABILITY = 8;

type Finder = (id: string, extra?: Partial<Omit<HardwareFinding, 'id' | 'container'>>) => void;

const NVIDIA_MESSAGES: ReadonlyArray<[RegExp, string]> = [
  [/could not select device driver/i, 'nvidia-toolkit'],
  [/unknown or invalid runtime name/i, 'nvidia-runtime'],
  [/driver version is insufficient/i, 'nvidia-driver-old'],
  [/no kernel image is available/i, 'nvidia-arch'],
  [/failed to initialize nvml/i, 'nvml-lost'],
];

const fromMessages = (text: string, add: Finder) => {
  for (const [pattern, id] of NVIDIA_MESSAGES) {
    if (pattern.test(text)) {
      add(id);
    }
  }
};

/**
 * A render node the container cannot open: its own finding when the node's group is not one the
 * container runs with (the host's render group number was not added), otherwise a plain permission
 * problem. Root opens any node, so a group can only be missing for another user.
 */
const renderAccess = (nodes: RenderNode[], host: HostFacts | null | undefined, add: Finder) => {
  for (const node of nodes) {
    if (node.accessible) {
      continue;
    }
    const gid = node.gid ?? null;
    if (host && !host.root && gid !== null && !host.groups.includes(gid)) {
      add('render-group', { gid });
    } else {
      add('render-permission');
    }
  }
};

/**
 * On a host with an integrated GPU and a graphics card (not NVIDIA, which is shared through the
 * toolkit, not /dev/dri): the first render node in the container is the one VA-API and OpenVINO use
 * by default, so the card is not used when that node is the integrated GPU. Returns the card's PCI
 * address, to map it by path.
 */
const wrongRenderNode = (nodes: RenderNode[], host: HostFacts | null | undefined): string | null => {
  const candidates = (host?.gpus ?? []).filter((gpu) => gpu.vendor !== 'NVIDIA' && gpu.renderNode);
  const card = candidates.find((gpu) => !gpu.integrated);
  if (!card || candidates.every((gpu) => !gpu.integrated) || nodes.length === 0) {
    return null;
  }
  const first = candidates.find((gpu) => gpu.renderNode === (nodes[0].hostNode ?? nodes[0].node));
  return first?.integrated ? card.pciAddress : null;
};

/** Findings that follow from where the container runs rather than from how it was set up. */
const environmentFindings = (host: HostFacts | null | undefined, facts: GpuFacts, add: Finder) => {
  const environment = hostEnvironment(host);
  if (environment === 'wsl2' && facts.usable === false) {
    add('wsl2');
  }
  if (environment === 'docker-desktop' && facts.usable !== true) {
    add('macos');
  }
  if (environment === 'unraid' && facts.present === true && facts.visible === false) {
    add('unraid');
  }
};

/**
 * The set-up problems the evidence shows, per container, without duplicates. A container that runs
 * on the processor with no GPU passed in and no sign of one wanted has no problem: that is a
 * processor-only server, not a misconfiguration. `nvidia-bf16` is a limit of the card rather than a
 * set-up mistake; the web shows it as a note.
 */
export const detectHardwareFindings = (
  server: ServerHardwareFacts | null,
  ml: MlContainerReport | null,
): HardwareFinding[] => {
  const findings = new Map<string, HardwareFinding>();
  const finder =
    (container: HardwareContainer): Finder =>
    (id, extra = {}) => {
      const key = `${container}:${id}`;
      if (!findings.has(key)) {
        findings.set(key, {
          id,
          container,
          gid: null,
          pciAddress: null,
          gfxVersion: null,
          computeCapability: null,
          ...extra,
        });
      }
    };

  if (server) {
    const add = finder('server');
    fromMessages(`${server.nvidiaError ?? ''} ${server.test?.error ?? ''}`, add);
    if (server.nvidiaRequested && !server.nvidiaDevice && !server.nvidia) {
      add('nvidia-toolkit');
    }
    // An NVIDIA card handed over as /dev/dri instead of through the toolkit: the common mix-up.
    if (!server.nvidia && server.renderNodes.some((node) => node.vendor === 'NVIDIA')) {
      add('nvidia-dri');
    }
    if (server.nvidia && /libnvidia-encode/i.test(server.test?.error ?? '')) {
      add('nvenc-video');
    }
    renderAccess(server.renderNodes, server.host, add);
    if (/no va display/i.test(server.test?.error ?? '')) {
      add('dri-missing');
    }
    const card = server.nvidia ? null : wrongRenderNode(server.renderNodes, server.host);
    if (card) {
      add('wrong-gpu', { pciAddress: card });
    }
    environmentFindings(server.host, serverGpuFacts(server), add);
  }

  if (ml) {
    const add = finder('ml');
    fromMessages(ml.nvidiaError ?? '', add);
    const image = ml.image.toLowerCase();
    const facts = mlGpuFacts(ml);
    const gpuUsed = facts.usable === true;
    const nodes = ml.devices.renderNodes;
    if (ml.devices.nvidiaRequested && !ml.devices.nvidia && !gpuUsed) {
      add('nvidia-toolkit');
    }
    if (image === 'cpu' && (ml.devices.nvidia || nodes.length > 0)) {
      add('cpu-image');
    }
    if (image === 'openvino' && !gpuUsed) {
      add(nodes.length === 0 ? 'dri-missing' : 'openvino-cpu-only');
    }
    if (image === 'rocm' && !gpuUsed) {
      if (!ml.devices.kfd || !ml.devices.kfdAccessible) {
        add('kfd-missing');
      }
      if (nodes.length === 0) {
        add('dri-missing');
      }
      if (!ml.rocm?.hsaOverride) {
        const target = ml.rocm?.gfxTargets.find((entry) => ROCM_GFX_OVERRIDES[entry]);
        if (target) {
          add('rocm-gfx', { gfxVersion: ROCM_GFX_OVERRIDES[target] });
        }
      }
    }
    if (image === 'cuda' && !gpuUsed && !ml.devices.nvidia) {
      add('nvidia-toolkit');
    }
    if (!image.includes('cuda') && !ml.devices.nvidia && nodes.some((node) => node.vendor === 'NVIDIA')) {
      add('nvidia-dri');
    }
    renderAccess(nodes, ml.host, add);
    if (image === 'openvino' || image === 'rocm') {
      const card = wrongRenderNode(nodes, ml.host);
      if (card) {
        add('wrong-gpu', { pciAddress: card });
      }
    }
    const capability = Number(ml.computeCapability);
    if (gpuUsed && ml.backend === 'CUDA' && capability > 0 && capability < BF16_COMPUTE_CAPABILITY) {
      add('nvidia-bf16', { computeCapability: ml.computeCapability! });
    }
    environmentFindings(ml.host, facts, add);
  }
  return findings.values().toArray();
};

/** The problem ids of the findings, without duplicates (the web catalogue's `gpuProblems`). */
export const detectHardwareIssues = (server: ServerHardwareFacts | null, ml: MlContainerReport | null): string[] => [
  ...new Set(detectHardwareFindings(server, ml).map((finding) => finding.id)),
];

// ------------------------------------------------------------------ other GPU workers

/** A GPU worker besides the two containers: an enrolled Studio render worker or a restoration worker. */
export type WorkerCheck = {
  id: string;
  name: string;
  kind: 'render' | 'restoration';
  /** It has a live session (render) or answered its report (restoration). */
  reachable: boolean;
  model: string | null;
  vramGb: number | null;
  gpu: GpuFacts;
};

/**
 * An enrolled render worker, from the evidence its admission verified. A session exists only for a
 * worker whose conformance check rendered on a hardware (not software) renderer, so a live session
 * shows the GPU visible and usable; the worker never reports its host, so a GPU there is known only
 * through that. Without a live session nothing is known.
 */
export const renderWorkerCheckFrom = (
  worker: { id: string; name: string },
  session: { gpuMemoryBytes: string | number | null } | null,
): WorkerCheck => ({
  id: worker.id,
  name: worker.name,
  kind: 'render',
  reachable: !!session,
  model: null,
  vramGb: session ? gb(session.gpuMemoryBytes === null ? null : Number(session.gpuMemoryBytes)) : null,
  gpu: session ? { present: true, visible: true, usable: true } : UNKNOWN_FACTS,
});

type RestorationReport = {
  gpus: Array<{ name: string; memoryTotalBytes: number }>;
  models: Array<{
    state: string;
    measured: Array<{ gpu: string; framesPerSecond: number }>;
  }>;
};

/**
 * A restoration worker, from its own report: the GPUs the driver lists (none can also mean the
 * driver tool is missing, so no GPU is "not reported", not "none") and whether any model is ready
 * to run on them.
 */
export const restorationWorkerCheckFrom = (
  destination: { id: string; name: string },
  report: RestorationReport | null,
): WorkerCheck => {
  if (!report) {
    return {
      id: destination.id,
      name: destination.name,
      kind: 'restoration',
      reachable: false,
      model: null,
      vramGb: null,
      gpu: UNKNOWN_FACTS,
    };
  }
  const gpu = report.gpus[0] ?? null;
  const ready = report.models.some((model) => model.state === 'available');
  return {
    id: destination.id,
    name: destination.name,
    kind: 'restoration',
    reachable: true,
    model: gpu?.name ?? null,
    vramGb: gb(gpu?.memoryTotalBytes),
    gpu: {
      present: gpu ? true : null,
      visible: gpu ? true : null,
      usable: ready ? true : gpu ? false : null,
    },
  };
};

// ------------------------------------------------------------------ benchmark per workload

/** The kinds of work the model sliders estimate (the routing keys; `studio` is transcription). */
export const BENCHMARK_WORKLOADS = ['descriptions', 'upscale', 'restoration', 'studio', 'interpolation'] as const;
export type BenchmarkWorkload = (typeof BENCHMARK_WORKLOADS)[number];

export type WorkloadUnavailable =
  /** Nothing on this server runs it: it is Frameleaf Cloud only. */
  | 'no-local-runner'
  /** It needs a dedicated worker, and none is set up and enabled. */
  | 'no-local-worker'
  /** Machine learning is turned off. */
  | 'machine-learning-off'
  /** It can run here, but its worker reported no measurement for this hardware. */
  | 'not-measured'
  /** The test run failed. */
  | 'failed';

/** Throughput of one kind of work on this server's hardware, or why it cannot run or was not measured. */
export type WorkloadBenchmark = {
  workload: BenchmarkWorkload;
  /** `benchmark`: timed now; `qualification`: measured on this GPU when the worker was qualified. */
  source: 'benchmark' | 'qualification' | null;
  unit: 'photo' | 'frame' | null;
  /** Units per hour. */
  perHour: number | null;
  secondsPerUnit: number | null;
  runsOn: 'gpu' | 'cpu' | null;
  /** The worker that ran it. */
  worker: string | null;
  unavailable: WorkloadUnavailable | null;
  error: string | null;
};

export const unavailableWorkload = (
  workload: BenchmarkWorkload,
  unavailable: WorkloadUnavailable,
  error: string | null = null,
): WorkloadBenchmark => ({
  workload,
  source: null,
  unit: null,
  perHour: null,
  secondsPerUnit: null,
  runsOn: null,
  worker: null,
  unavailable,
  error,
});

export const measuredWorkload = (
  workload: BenchmarkWorkload,
  {
    unit,
    secondsPerUnit,
    source,
    runsOn,
    worker,
  }: {
    unit: 'photo' | 'frame';
    secondsPerUnit: number;
    source: 'benchmark' | 'qualification';
    runsOn: 'gpu' | 'cpu' | null;
    worker: string;
  },
): WorkloadBenchmark => ({
  workload,
  source,
  unit,
  perHour: secondsPerUnit > 0 ? Math.round(3600 / secondsPerUnit) : null,
  secondsPerUnit: Math.round(secondsPerUnit * 1000) / 1000,
  runsOn,
  worker,
  unavailable: null,
  error: null,
});

/**
 * Restoration throughput from a worker's report: the fastest ready model measured on the GPU the
 * worker has now. A measurement on another GPU says nothing about this one.
 */
export const restorationThroughput = (report: RestorationReport): number | null => {
  const names = new Set(report.gpus.map((gpu) => gpu.name));
  const rates = report.models
    .filter((model) => model.state === 'available')
    .flatMap((model) => model.measured)
    .filter((entry) => names.has(entry.gpu) && entry.framesPerSecond > 0)
    .map((entry) => entry.framesPerSecond);
  return rates.length > 0 ? Math.max(...rates) : null;
};

/**
 * Speed factors from the benchmark: how much slower (> 1) or faster (< 1) this server measured than
 * the estimates assume for its backend. Applied to the local time estimates of the model sliders;
 * clamped, because one short measurement must not swing an estimate by more than that.
 */
const EXPECTED_EMBEDDING_MS: Record<string, number> = { CUDA: 30, ROCm: 40, OpenVINO: 80, CPU: 400 };
const EXPECTED_TRANSCODE_SPEED: Record<string, number> = { NVENC: 9, 'VA-API': 6, QSV: 6, CPU: 1.3 };
const clamp = (value: number) => Math.round(Math.min(3, Math.max(0.33, value)) * 100) / 100;

export const benchmarkFactors = (
  ml: { backend: string; embeddingMs: number | null },
  server: { backend: string; transcodeSpeed: number | null },
) => ({
  ml:
    ml.embeddingMs !== null && ml.embeddingMs > 0
      ? clamp(ml.embeddingMs / (EXPECTED_EMBEDDING_MS[ml.backend] ?? EXPECTED_EMBEDDING_MS.CPU))
      : null,
  server:
    server.transcodeSpeed !== null && server.transcodeSpeed > 0
      ? clamp((EXPECTED_TRANSCODE_SPEED[server.backend] ?? EXPECTED_TRANSCODE_SPEED.CPU) / server.transcodeSpeed)
      : null,
});

/** The median of a few timings, so one slow first request (loading the model) does not decide. */
export const median = (values: number[]) => {
  const sorted = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

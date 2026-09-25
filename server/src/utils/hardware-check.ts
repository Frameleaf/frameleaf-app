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

export type RenderNode = { node: string; vendor: string | null; accessible: boolean; memoryTotalBytes: number | null };

/** What the server container read about itself. */
export type ServerHardwareFacts = {
  nvidia: { name: string; memoryTotalBytes: number | null; driver: string } | null;
  nvidiaError: string | null;
  nvidiaRequested: boolean;
  nvidiaDevice: boolean;
  renderNodes: RenderNode[];
  encoders: string[];
  test: TestTranscode | null;
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
};

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
};

const GB = 1024 ** 3;
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
  if (facts.nvidia) {
    return {
      reachable: true,
      vendor: 'NVIDIA',
      model: facts.nvidia.name,
      vramGb: gb(facts.nvidia.memoryTotalBytes),
      driver: facts.nvidia.driver,
      backend,
      test,
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
  };
};

const ML_BACKENDS: ReadonlySet<string> = new Set(['CUDA', 'ROCm', 'OpenVINO']);

export const mlCheckFrom = (report: MlContainerReport | null, embedding: ContainerTest | null): ContainerCheck => {
  if (!report) {
    return { reachable: false, vendor: null, model: null, vramGb: null, driver: null, backend: 'CPU', test: embedding };
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
  };
};

/**
 * The set-up problems the evidence shows, by problem id (web `gpuProblems`), without duplicates.
 * A container that runs on the processor with no GPU passed in and no sign of one wanted has no
 * problem: that is a processor-only server, not a misconfiguration.
 */
export const detectHardwareIssues = (server: ServerHardwareFacts | null, ml: MlContainerReport | null): string[] => {
  const issues = new Set<string>();
  const nvidiaText = `${server?.nvidiaError ?? ''} ${ml?.nvidiaError ?? ''} ${server?.test?.error ?? ''}`;
  if (/could not select device driver/i.test(nvidiaText)) {
    issues.add('nvidia-toolkit');
  }
  if (/unknown or invalid runtime name/i.test(nvidiaText)) {
    issues.add('nvidia-runtime');
  }
  if (/driver version is insufficient/i.test(nvidiaText)) {
    issues.add('nvidia-driver-old');
  }
  if (/no kernel image is available/i.test(nvidiaText)) {
    issues.add('nvidia-arch');
  }
  if (/failed to initialize nvml/i.test(nvidiaText)) {
    issues.add('nvml-lost');
  }

  if (server) {
    if (server.nvidiaRequested && !server.nvidiaDevice && !server.nvidia) {
      issues.add('nvidia-toolkit');
    }
    // An NVIDIA card handed over as /dev/dri instead of through the toolkit: the common mix-up.
    if (!server.nvidia && server.renderNodes.some((node) => node.vendor === 'NVIDIA')) {
      issues.add('nvidia-dri');
    }
    if (server.nvidia && /libnvidia-encode/i.test(server.test?.error ?? '')) {
      issues.add('nvenc-video');
    }
    if (server.renderNodes.some((node) => !node.accessible)) {
      issues.add('render-permission');
    }
    if (/no va display/i.test(server.test?.error ?? '')) {
      issues.add('dri-missing');
    }
  }

  if (ml) {
    const image = ml.image.toLowerCase();
    const gpuUsed = ml.gpus.length > 0 && ML_BACKENDS.has(ml.backend);
    const nodes = ml.devices.renderNodes;
    if (ml.devices.nvidiaRequested && !ml.devices.nvidia && !gpuUsed) {
      issues.add('nvidia-toolkit');
    }
    if (image === 'cpu' && (ml.devices.nvidia || nodes.length > 0)) {
      issues.add('cpu-image');
    }
    if (image === 'openvino' && !gpuUsed) {
      issues.add(nodes.length === 0 ? 'dri-missing' : 'openvino-cpu-only');
    }
    if (image === 'rocm' && !gpuUsed) {
      if (!ml.devices.kfd || !ml.devices.kfdAccessible) {
        issues.add('kfd-missing');
      }
      if (nodes.length === 0) {
        issues.add('dri-missing');
      }
    }
    if (image === 'cuda' && !gpuUsed && !ml.devices.nvidia) {
      issues.add('nvidia-toolkit');
    }
    if (!image.includes('cuda') && !ml.devices.nvidia && nodes.some((node) => node.vendor === 'NVIDIA')) {
      issues.add('nvidia-dri');
    }
    if (nodes.some((node) => !node.accessible)) {
      issues.add('render-permission');
    }
  }
  return [...issues];
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

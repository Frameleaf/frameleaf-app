import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * Hardware & GPU (FL-159, CLD-201, handoff §3.2): what the server container and the ML container
 * can each use, checked inside each container, the set-up problems that shows and the benchmark.
 */
const ContainerTestSchema = z
  .object({
    kind: z.enum(['transcode', 'embedding']).describe('transcode: the server container; embedding: the ML container'),
    ok: z.boolean().describe('The test finished without falling back'),
    gpu: z.boolean().describe('The test ran on the GPU'),
    value: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('transcode: 1080p real-time multiple; embedding: milliseconds; null when it did not run'),
    error: z.string().nullable().describe('What failed, as the container reported it'),
  })
  .meta({ id: 'HardwareContainerTestDto' });

const HardwareBackendSchema = z
  .enum(['CUDA', 'ROCm', 'OpenVINO', 'NVENC', 'VA-API', 'QSV', 'CPU'])
  .meta({ id: 'HardwareBackend' });

const GpuFactsSchema = z
  .object({
    present: z.boolean().nullable().describe('A GPU is on the host; null when the container cannot tell'),
    visible: z.boolean().nullable().describe('The container can see the GPU; null when not reported'),
    usable: z.boolean().nullable().describe('The runtime actually used the GPU; null when not reported'),
  })
  .meta({ id: 'HardwareGpuFactsDto' });

const ContainerCheckSchema = z
  .object({
    reachable: z.boolean().describe('The container answered the check'),
    vendor: z.string().nullable(),
    model: z.string().nullable(),
    vramGb: z.number().meta({ format: 'double' }).nullable(),
    driver: z.string().nullable().describe('Driver and runtime, or what the driver reported instead'),
    backend: HardwareBackendSchema,
    test: ContainerTestSchema.nullable(),
    gpu: GpuFactsSchema,
  })
  .meta({ id: 'HardwareContainerCheckDto' });

const HardwareWorkerKindSchema = z.enum(['render', 'restoration']).meta({ id: 'HardwareWorkerKind' });
const HardwareFindingContainerSchema = z.enum(['server', 'ml']).meta({ id: 'HardwareFindingContainer' });
const HardwareBenchmarkWorkloadSchema = z
  .enum(['descriptions', 'upscale', 'restoration', 'studio', 'interpolation'])
  .meta({ id: 'HardwareBenchmarkWorkload' });
const HardwareBenchmarkSourceSchema = z.enum(['benchmark', 'qualification']).meta({ id: 'HardwareBenchmarkSource' });
const HardwareBenchmarkUnitSchema = z.enum(['photo', 'frame']).meta({ id: 'HardwareBenchmarkUnit' });
const HardwareRunsOnSchema = z.enum(['gpu', 'cpu']).meta({ id: 'HardwareRunsOn' });
const HardwareWorkloadUnavailableSchema = z
  .enum(['no-local-runner', 'no-local-worker', 'machine-learning-off', 'not-measured', 'failed'])
  .meta({ id: 'HardwareWorkloadUnavailable' });

const WorkerCheckSchema = z
  .object({
    id: z.string().describe('Render worker ID or ML destination ID'),
    name: z.string(),
    kind: HardwareWorkerKindSchema.describe('An enrolled Studio render worker or a restoration worker'),
    reachable: z.boolean().describe('It has a live session (render) or answered its report (restoration)'),
    model: z.string().nullable(),
    vramGb: z.number().meta({ format: 'double' }).nullable(),
    gpu: GpuFactsSchema,
  })
  .meta({ id: 'HardwareWorkerCheckDto' });

const FindingSchema = z
  .object({
    id: z.string().describe('Problem id (web catalogue `gpuProblems`)'),
    container: HardwareFindingContainerSchema.describe('The container the problem was found in'),
    gid: z.int().nullable().describe('render-group: the group number that owns the render node'),
    pciAddress: z.string().nullable().describe('wrong-gpu: the PCI address of the graphics card to pass in'),
    gfxVersion: z.string().nullable().describe('rocm-gfx: the HSA_OVERRIDE_GFX_VERSION the card needs'),
    computeCapability: z.string().nullable().describe("nvidia-bf16: the card's CUDA compute capability"),
  })
  .meta({ id: 'HardwareFindingDto' });

const WorkloadBenchmarkSchema = z
  .object({
    workload: HardwareBenchmarkWorkloadSchema.describe('The kind of work (routing key; studio is transcription)'),
    source: HardwareBenchmarkSourceSchema.nullable().describe(
      'benchmark: timed now; qualification: measured on this GPU when the worker was qualified',
    ),
    unit: HardwareBenchmarkUnitSchema.nullable(),
    perHour: z.number().meta({ format: 'double' }).nullable().describe('Units per hour'),
    secondsPerUnit: z.number().meta({ format: 'double' }).nullable(),
    runsOn: HardwareRunsOnSchema.nullable(),
    worker: z.string().nullable().describe('The worker that ran it'),
    unavailable: HardwareWorkloadUnavailableSchema.nullable().describe('Why there is no throughput, or null'),
    error: z.string().nullable(),
  })
  .meta({ id: 'HardwareWorkloadBenchmarkDto' });

const HardwareBenchmarkSchema = z
  .object({
    ranAt: z.string(),
    embeddingMs: z.number().meta({ format: 'double' }).nullable().describe('Median time of a search embedding'),
    transcodeSpeed: z.number().meta({ format: 'double' }).nullable().describe('1080p test transcode, × real time'),
    mlFactor: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Measured ÷ estimated time for AI work here (applied to the local estimates)'),
    serverFactor: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Measured ÷ estimated time for video encoding here'),
    workloads: z.array(WorkloadBenchmarkSchema).describe('Throughput per kind of work, or why there is none'),
  })
  .meta({ id: 'HardwareBenchmarkDto' });

const HardwareCheckResponseSchema = z
  .object({
    checkedAt: z.string(),
    server: ContainerCheckSchema.describe('The server container: video playback and Studio export'),
    ml: ContainerCheckSchema.describe('The ML container: search, faces, descriptions and restoration'),
    mlImage: z.string().nullable().describe('The ML image flavour (cpu, cuda, rocm, openvino), when reported'),
    issues: z.array(z.string()).describe('Set-up problems the check found, by problem id'),
    findings: z.array(FindingSchema).describe('The same problems per container, with what their fix names'),
    workers: z.array(WorkerCheckSchema).describe('Render and restoration workers, from their reported evidence'),
    benchmark: HardwareBenchmarkSchema.nullable().describe('The last benchmark on this hardware, if any'),
  })
  .meta({ id: 'HardwareCheckResponseDto' });

export class HardwareCheckResponseDto extends createZodDto(HardwareCheckResponseSchema) {}
export type HardwareCheck = z.infer<typeof HardwareCheckResponseSchema>;

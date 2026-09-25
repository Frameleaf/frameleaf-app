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

const ContainerCheckSchema = z
  .object({
    reachable: z.boolean().describe('The container answered the check'),
    vendor: z.string().nullable(),
    model: z.string().nullable(),
    vramGb: z.number().meta({ format: 'double' }).nullable(),
    driver: z.string().nullable().describe('Driver and runtime, or what the driver reported instead'),
    backend: HardwareBackendSchema,
    test: ContainerTestSchema.nullable(),
  })
  .meta({ id: 'HardwareContainerCheckDto' });

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
  })
  .meta({ id: 'HardwareBenchmarkDto' });

const HardwareCheckResponseSchema = z
  .object({
    checkedAt: z.string(),
    server: ContainerCheckSchema.describe('The server container: video playback and Studio export'),
    ml: ContainerCheckSchema.describe('The ML container: search, faces, descriptions and restoration'),
    mlImage: z.string().nullable().describe('The ML image flavour (cpu, cuda, rocm, openvino), when reported'),
    issues: z.array(z.string()).describe('Set-up problems the check found, by problem id'),
    benchmark: HardwareBenchmarkSchema.nullable().describe('The last benchmark on this hardware, if any'),
  })
  .meta({ id: 'HardwareCheckResponseDto' });

export class HardwareCheckResponseDto extends createZodDto(HardwareCheckResponseSchema) {}
export type HardwareCheck = z.infer<typeof HardwareCheckResponseSchema>;

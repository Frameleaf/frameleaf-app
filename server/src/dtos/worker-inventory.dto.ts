import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  MediaOperationKindSchema,
  MlAdmissionRefusalSchema,
  MlWorkerAccelerationSchema,
  MlWorkerReadinessSchema,
  MlWorkerRoleSchema,
  MlWorkloadSchema,
  QueueNameSchema,
  WorkerCredentialStateSchema,
  WorkerInventorySourceSchema,
} from 'src/enum.js';

/**
 * The worker inventory (FL-72): every machine-learning, restoration and render endpoint with
 * its state, what it may run, what it reported it serves, where library work is routed and how
 * busy it is. Nothing here is a secret or names whose media a worker holds: credentials are a
 * state, and loads are counts.
 */

const WorkerGpuSchema = z
  .object({
    name: z.string(),
    memoryTotalBytes: z.number().meta({ format: 'double' }),
  })
  .meta({ id: 'WorkerGpuDto' });

const WorkerWorkloadAdmissionSchema = z
  .object({
    workload: MlWorkloadSchema,
    admitted: z.boolean().describe('Whether the last check would admit this workload here'),
    refusal: MlAdmissionRefusalSchema.nullable(),
    detail: z.string().nullable().describe('Why it would be refused, or null'),
  })
  .meta({ id: 'WorkerWorkloadAdmissionDto' });

const WorkerInventoryEntrySchema = z
  .object({
    id: z.string().describe('ML destination ID or render worker ID'),
    source: WorkerInventorySourceSchema,
    name: z.string(),
    kind: z.string().describe('ML destination kind, or the render worker destination'),
    role: MlWorkerRoleSchema.nullable().describe('What an ML destination is for; null for a render worker'),
    url: z.string().nullable().describe('Endpoint URL, or null when there is none to show'),
    configured: z
      .boolean()
      .describe('For a local destination: its URL is still in the machine-learning URL list. Always true otherwise'),
    enabled: z.boolean(),
    readiness: MlWorkerReadinessSchema,
    acceleration: MlWorkerAccelerationSchema,
    gpus: z.array(WorkerGpuSchema).describe('GPUs the worker reported, with memory; empty when not reported'),
    gpuMemoryBytes: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Largest GPU memory reported or qualified, or null when unknown'),
    credential: WorkerCredentialStateSchema,
    leavesNetwork: z.boolean().describe('Work sent here leaves the network'),
    consentGranted: z.boolean().describe('True when no consent is needed or it is recorded'),
    allowedWorkloads: z.array(MlWorkloadSchema),
    servedWorkloads: z
      .array(MlWorkloadSchema)
      .nullable()
      .describe('Workloads the worker reported on its last check, or null when it never answered'),
    routedWorkloads: z.array(MlWorkloadSchema).describe('Workloads whose route names this destination'),
    admission: z.array(WorkerWorkloadAdmissionSchema).describe('Per allowed workload, from the last check'),
    renderKinds: z.array(MediaOperationKindSchema).describe('Operation kinds a render worker may claim'),
    sharesLibraryHardware: z.boolean(),
    waitingForLibraryAnalysis: z
      .boolean()
      .describe('Full restorations bound here are waiting because library analysis has work'),
    activeOperations: z.int().describe('Jobs running here now'),
    queuedOperations: z.int().describe('Jobs waiting for this worker'),
    maxConcurrentOperations: z.int().nullable().describe('Render workers: the most they may hold at once'),
    checkedAt: z.string().meta({ format: 'date-time' }).nullable().describe('Last check or check-in'),
    latencyMs: z.int().nullable(),
    summary: z.string().nullable(),
  })
  .meta({ id: 'WorkerInventoryEntryDto' });

const WorkerRunnerSchema = z
  .object({
    workerId: z.string().describe('The server process holding the claims'),
    kinds: z.array(MediaOperationKindSchema),
    activeOperations: z.int(),
    lastHeartbeatAt: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'WorkerRunnerDto' });

const WorkerQueueBacklogSchema = z
  .object({
    queue: QueueNameSchema,
    active: z.int(),
    waiting: z.int(),
    paused: z.boolean(),
  })
  .meta({ id: 'WorkerQueueBacklogDto' });

const WorkerLibraryRouteSchema = z
  .object({
    workload: MlWorkloadSchema,
    destinationId: z.string().nullable(),
    queues: z.array(QueueNameSchema).describe('Queues whose jobs run this workload'),
  })
  .meta({ id: 'WorkerLibraryRouteDto' });

const WorkerInventoryResponseSchema = z
  .object({
    entries: z.array(WorkerInventoryEntrySchema),
    runners: z.array(WorkerRunnerSchema).describe('Server processes running restorations now'),
    libraryRoutes: z.array(WorkerLibraryRouteSchema),
    libraryQueues: z.array(WorkerQueueBacklogSchema),
    libraryBacklog: z.int().describe('Library-analysis jobs active or waiting, not counting paused queues'),
    machineLearningEnabled: z.boolean(),
    configuredUrls: z.array(z.string()).describe('The machine-learning URL list, in order'),
    checkedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'WorkerInventoryResponseDto' });

export class WorkerInventoryEntryDto extends createZodDto(WorkerInventoryEntrySchema) {}
export class WorkerRunnerDto extends createZodDto(WorkerRunnerSchema) {}
export class WorkerInventoryResponseDto extends createZodDto(WorkerInventoryResponseSchema) {}

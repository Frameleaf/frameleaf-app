import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  MediaOperationCheckpointStateSchema,
  MediaOperationDestinationSchema,
  MediaOperationKindSchema,
  MediaOperationStatusSchema,
} from 'src/enum.js';

const JsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * What a checkpoint shows the owner.
 *
 * Digests are included because they are what makes reuse safe and a person debugging a resumed
 * render needs to see which chunk stopped matching. The output path is not: where a chunk lives
 * on the server's disk is operator detail, and its size is enough for the interface.
 */
const MediaOperationCheckpointSchema = z
  .object({
    id: z.uuidv7().describe('Checkpoint ID'),
    sequence: z.int().describe('Chunk order within the render'),
    state: MediaOperationCheckpointStateSchema,
    chunkKey: z.string().describe('Digest over every input to this chunk; the reuse key'),
    timebase: z.string().describe('Rational timebase for the tick range, e.g. 30000/1001'),
    startTicks: z.string().describe('Chunk start, in ticks of the timebase'),
    endTicks: z.string().describe('Chunk end, in ticks of the timebase'),
    requiresSequentialContext: z.boolean().describe('A render may not start inside this chunk'),
    sizeInBytes: z.string().nullable(),
    completedAt: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'MediaOperationCheckpointDto' });

const MediaOperationEstimateSchema = z
  .object({
    seconds: z.number().meta({ format: 'double' }).describe('Measured estimate of remaining work'),
    sizeBytes: z.string().nullable().describe('Estimated output size'),
    cloudCost: JsonObjectSchema.nullable().describe('Configured cloud rate detail, when one applies'),
  })
  .meta({ id: 'MediaOperationEstimateDto' });

/**
 * One durable job, as its owner sees it.
 *
 * Deliberately absent: the claim token, the worker identity and the remote job handle. They are
 * how the server keeps the job honest, not something a browser needs or should be able to read.
 */
const MediaOperationSchema = z
  .object({
    id: z.uuidv7().describe('Media operation ID'),
    kind: MediaOperationKindSchema,
    status: MediaOperationStatusSchema,
    destination: MediaOperationDestinationSchema,
    destinationDetail: z.string().nullable().describe('Which worker or endpoint the destination resolved to'),
    label: z.string().describe('What the person sees in Activity'),
    assetId: z.uuidv4().nullable().describe('Source asset, when the workload has exactly one'),
    resultAssetId: z.uuidv4().nullable().describe('The asset a completed job published'),
    retryOfId: z.uuidv7().nullable().describe('The job this one retries'),
    projectId: z.string().nullable(),
    revisionId: z.string().nullable(),
    settings: JsonObjectSchema.describe('User-visible render settings'),
    estimate: MediaOperationEstimateSchema.nullable(),
    progress: z.number().meta({ format: 'double' }).describe('Percent complete, from counted work'),
    processedUnits: z.string(),
    totalUnits: z.string().nullable(),
    attempt: z.int(),
    maxAttempts: z.int(),
    error: z.string().nullable().describe('Operator detail about a failure'),
    errorCode: z.string().nullable().describe('Stable code the client turns into a message'),
    cancelRequestedAt: z.string().meta({ format: 'date-time' }).nullable(),
    cancelAcknowledgedAt: z.string().meta({ format: 'date-time' }).nullable(),
    startedAt: z.string().meta({ format: 'date-time' }).nullable(),
    finishedAt: z.string().meta({ format: 'date-time' }).nullable(),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'MediaOperationDto' });

const MediaOperationDetailSchema = MediaOperationSchema.extend({
  checkpoints: z.array(MediaOperationCheckpointSchema),
  /** The immutable binding. Present on the detail view so a render is auditable. */
  snapshot: JsonObjectSchema,
}).meta({ id: 'MediaOperationDetailDto' });

const MediaOperationListResponseSchema = z
  .object({
    items: z.array(MediaOperationSchema),
    total: z.int().describe('Matching jobs, before paging'),
  })
  .meta({ id: 'MediaOperationListResponseDto' });

const MediaOperationSearchSchema = z
  .object({
    kind: MediaOperationKindSchema.optional(),
    status: MediaOperationStatusSchema.optional().describe('Restrict to one status'),
    includeDismissed: z.coerce.boolean().optional().describe('Include jobs the owner cleared'),
    take: z.coerce.number().int().min(1).max(200).default(100).optional(),
    skip: z.coerce.number().int().min(0).default(0).optional(),
  })
  .meta({ id: 'MediaOperationSearchDto' });

/**
 * The administrator's operational view.
 *
 * Counts by kind, status and destination, and the age of the oldest job in each bucket. No owner,
 * no label, no asset: an administrator can see the queue without seeing anybody's media.
 */
const MediaOperationAggregateSchema = z
  .object({
    kind: MediaOperationKindSchema,
    status: MediaOperationStatusSchema,
    destination: MediaOperationDestinationSchema,
    count: z.int(),
    oldestCreatedAt: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'MediaOperationAggregateDto' });

const MediaOperationStatisticsSchema = z
  .object({
    buckets: z.array(MediaOperationAggregateSchema),
    active: z.int().describe('Jobs the server is still working on'),
    failed: z.int(),
    unreleasedRemote: z.int().describe('Remote jobs whose cleanup has not been acknowledged'),
  })
  .meta({ id: 'MediaOperationStatisticsDto' });

export class MediaOperationDto extends createZodDto(MediaOperationSchema) {}
export class MediaOperationDetailDto extends createZodDto(MediaOperationDetailSchema) {}
export class MediaOperationListResponseDto extends createZodDto(MediaOperationListResponseSchema) {}
export class MediaOperationSearchDto extends createZodDto(MediaOperationSearchSchema) {}
export class MediaOperationStatisticsDto extends createZodDto(MediaOperationStatisticsSchema) {}
export class MediaOperationCheckpointDto extends createZodDto(MediaOperationCheckpointSchema) {}
export class MediaOperationAggregateDto extends createZodDto(MediaOperationAggregateSchema) {}
export class MediaOperationEstimateDto extends createZodDto(MediaOperationEstimateSchema) {}

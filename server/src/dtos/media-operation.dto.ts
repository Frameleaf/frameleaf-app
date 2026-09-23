import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  DuplicateDecisionKindSchema,
  MediaOperationBulkActionSchema,
  MediaOperationCheckpointStateSchema,
  MediaOperationDestinationSchema,
  MediaOperationItemStatusSchema,
  MediaOperationKindSchema,
  MediaOperationStatusSchema,
} from 'src/enum.js';
import { BULK_MAX_ITEMS } from 'src/utils/bulk-operation.js';
import { DUPLICATE_DECISION_MAX_GROUPS } from 'src/utils/duplicate-review.js';

const JsonObjectSchema = z.record(z.string(), z.unknown());

/** One still + motion video pair to relink (FL-70). */
const MediaOperationLivePhotoPairSchema = z
  .object({
    photoId: z.uuidv4().describe('Still image asset ID'),
    videoId: z.uuidv4().describe('Motion video asset ID'),
  })
  .meta({ id: 'MediaOperationLivePhotoPairDto' });

/** One reviewed Library Care finding (FL-69): the item, the finding and the chosen candidate. */
const MediaOperationMediaHealthEntrySchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    findingId: z.uuidv4().describe('Media health finding ID'),
    candidateId: z.uuidv4().optional().describe('Reviewed candidate ID, for a relink or a recovery'),
  })
  .meta({ id: 'MediaOperationMediaHealthEntryDto' });

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
 * What a bulk operation has done so far (FL-32).
 *
 * Counts are exact at every point, including halfway through. A cancelled operation reports the
 * items it really did change rather than pretending none of it happened, because the changes are
 * real and the person has to be able to see them.
 */
const MediaOperationBulkSummarySchema = z
  .object({
    action: MediaOperationBulkActionSchema,
    requested: z.int().describe('Items in the frozen set'),
    succeeded: z.int(),
    failed: z.int().describe('Items the server attempted and could not apply; a retry covers these'),
    skipped: z.int().describe('Items refused before anything changed, e.g. no access'),
    /** The client's own matching set hit its bound, so the frozen set is short of the real total. */
    snapshotTruncated: z.boolean(),
    /** More refusals happened than are listed on the detail view; the counts above stay exact. */
    itemsTruncated: z.boolean(),
    retried: z.int().describe('Items that failed and were given their one automatic retry'),
  })
  .meta({ id: 'MediaOperationBulkSummaryDto' });

/** One recorded refusal. Successes are counted, not listed. */
const MediaOperationBulkItemSchema = z
  .object({
    id: z.uuidv4().describe('Asset ID'),
    status: MediaOperationItemStatusSchema,
    reasonKey: z.string().nullable().describe('Stable key the client turns into a message'),
    message: z.string().nullable().describe('Operator detail from the server'),
  })
  .meta({ id: 'MediaOperationBulkItemDto' });

/**
 * One duplicate group of a `resolve-duplicates` or `undo-duplicates` job (FL-61): the complete group
 * as the owner reviewed it and what they decided. The job's `assetIds` are these members, group by
 * group, and the worker compares each group with its current members before it changes anything.
 */
const MediaOperationDuplicateGroupSchema = z
  .object({
    duplicateId: z.uuidv4().describe('Duplicate group ID'),
    decision: DuplicateDecisionKindSchema,
    memberIds: z.array(z.uuidv4()).min(2).max(BULK_MAX_ITEMS).describe('Every photo of the group, as reviewed'),
    keepAssetIds: z
      .array(z.uuidv4())
      .max(BULK_MAX_ITEMS)
      .describe('Photos to keep; the first is a stack cover. Other members of a `keepers` group are trashed'),
    decisionId: z.uuidv7().optional().describe('For `undo-duplicates`: the recorded decision to reverse'),
  })
  .meta({ id: 'MediaOperationDuplicateGroupDto' });

/**
 * The payload a bulk action needs beyond its asset ids.
 *
 * Every field is optional here and required by the action that uses it; the service rejects a
 * submission whose action has no payload to work with rather than running it over the library with
 * a default.
 */
const MediaOperationBulkPayloadSchema = z
  .object({
    albumId: z.uuidv4().optional(),
    tagIds: z.array(z.uuidv4()).max(50).optional(),
    dateMode: z.enum(['set', 'shift']).optional(),
    dateTimeOriginal: z.string().optional(),
    timeZone: z.string().optional(),
    minutes: z.int().optional().describe('Relative shift in minutes, for `dateMode: shift`'),
    description: z.string().max(10_000).optional(),
    latitude: z.number().meta({ format: 'double' }).min(-90).max(90).optional(),
    longitude: z.number().meta({ format: 'double' }).min(-180).max(180).optional(),
    primaryId: z.uuidv4().optional(),
    stackIds: z.array(z.uuidv4()).max(1000).optional(),
    pairs: z.array(MediaOperationLivePhotoPairSchema).max(BULK_MAX_ITEMS).optional(),
    duplicateGroups: z
      .array(MediaOperationDuplicateGroupSchema)
      .max(DUPLICATE_DECISION_MAX_GROUPS)
      .optional()
      .describe('Duplicate review decisions, one complete group each (FL-61)'),
    mediaHealth: z.array(MediaOperationMediaHealthEntrySchema).max(1000).optional(),
    classificationRuleId: z
      .uuidv7()
      .optional()
      .describe('For `apply-classification-rule`: the rule to apply to the items (FL-60)'),
  })
  .meta({ id: 'MediaOperationBulkPayloadDto' });

/**
 * Submit a bulk operation to be run durably.
 *
 * The asset ids are the whole point: the client resolves the matching set once, against the view
 * the person was actually looking at, and hands the server that exact list. Nothing is re-resolved
 * later, so editing a filter — or somebody else adding a photo — cannot change what a running
 * operation touches. The server still checks access on every item as it applies it.
 */
const MediaOperationBulkCreateSchema = z
  .object({
    action: MediaOperationBulkActionSchema,
    assetIds: z.array(z.uuidv4()).min(1).max(BULK_MAX_ITEMS).describe('The frozen matching set, in order'),
    payload: MediaOperationBulkPayloadSchema.optional(),
    requestId: z
      .uuidv4()
      .optional()
      .describe('Client idempotency key; submitting the same key again returns the existing operation'),
    submittedTotal: z.int().min(0).nullable().optional().describe('The count shown to the person at submit'),
    truncated: z.boolean().optional().describe('The client could not resolve the whole matching set'),
    scope: JsonObjectSchema.optional().describe('A record of the view the set came from; never re-resolved'),
  })
  .meta({ id: 'MediaOperationBulkCreateDto' });

/**
 * One durable job, as its owner sees it.
 *
 * Deliberately absent: the claim token, the worker identity and the remote job handle. They are
 * how the server keeps the job honest, not something a browser needs or should be able to read.
 */
export const MediaOperationSchema = z
  .object({
    id: z.uuidv7().describe('Media operation ID'),
    kind: MediaOperationKindSchema,
    status: MediaOperationStatusSchema,
    destination: MediaOperationDestinationSchema,
    destinationDetail: z.string().nullable().describe('Which worker or endpoint the destination resolved to'),
    label: z.string().describe('What the person sees in Activity; empty when withheld'),
    withheld: z
      .boolean()
      .describe('The job is about a Locked item this session has not unlocked; its label and snapshot are withheld'),
    assetId: z.uuidv4().nullable().describe('Source asset, when the workload has exactly one'),
    resultAssetId: z.uuidv4().nullable().describe('The asset a completed job published'),
    retryOfId: z.uuidv7().nullable().describe('The job this one retries'),
    projectId: z.string().nullable(),
    revisionId: z.string().nullable(),
    settings: JsonObjectSchema.describe('User-visible render settings'),
    estimate: MediaOperationEstimateSchema.nullable(),
    /** Present only on `bulk` jobs. Null everywhere else rather than an empty object. */
    bulk: MediaOperationBulkSummarySchema.nullable(),
    progress: z.number().meta({ format: 'double' }).describe('Percent complete, from counted work'),
    processedUnits: z.string(),
    totalUnits: z.string().nullable(),
    attempt: z.int(),
    maxAttempts: z.int(),
    autoRetries: z
      .int()
      .describe('Automatic retries this job has used; every job gets one before a failure is reported'),
    retryAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When a job waiting for its automatic retry may run again'),
    error: z
      .string()
      .nullable()
      .describe('Operator detail about a failure; on a queued job, the failure it is being retried after'),
    errorCode: z.string().nullable().describe('Stable code the client turns into a message'),
    cancelRequestedAt: z.string().meta({ format: 'date-time' }).nullable(),
    cancelAcknowledgedAt: z.string().meta({ format: 'date-time' }).nullable(),
    pausable: z.boolean().describe('Whether this kind of job can pause and carry on later; one-shot kinds cannot'),
    pauseRequestedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When the owner asked to pause; a running job keeps working until its next checkpoint'),
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
  /** Recorded per-item refusals for a bulk job, bounded. Empty for every other kind. */
  bulkItems: z.array(MediaOperationBulkItemSchema),
  /**
   * Items waiting for their automatic retry that it has not reached yet. With `processedUnits` (the
   * first pass's cursor over the frozen set) and `bulkItems` this says where every item stands.
   */
  bulkRetryPending: z.array(z.uuidv4()).describe('Asset IDs waiting for their automatic retry'),
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
export class MediaOperationBulkCreateDto extends createZodDto(MediaOperationBulkCreateSchema) {}
export class MediaOperationBulkSummaryDto extends createZodDto(MediaOperationBulkSummarySchema) {}
export class MediaOperationBulkItemDto extends createZodDto(MediaOperationBulkItemSchema) {}
export class MediaOperationBulkPayloadDto extends createZodDto(MediaOperationBulkPayloadSchema) {}
export class MediaOperationDuplicateGroupDto extends createZodDto(MediaOperationDuplicateGroupSchema) {}

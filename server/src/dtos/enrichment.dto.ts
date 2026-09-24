import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ImageDescriptionPromptSchema } from 'src/dtos/config.dto.js';
import { MediaOperationSchema } from 'src/dtos/media-operation.dto.js';
import {
  EnrichmentItemStateSchema,
  EnrichmentPreviewStatusSchema,
  EnrichmentStageSchema,
  EnrichmentStaleReasonSchema,
  MlDestinationHealthSchema,
  MlDestinationKindSchema,
  VideoMomentIndexStateSchema,
  VideoMomentMatchSchema,
  VideoMomentSourceSchema,
} from 'src/enum.js';
import { ENRICHMENT_PLAN_MAX_ASSETS, ENRICHMENT_PREVIEW_MAX_SAMPLES } from 'src/utils/enrichment-plan.js';

/**
 * Sample-first enrichment and the timestamped moment workbench (FL-59, `REC-101`).
 *
 * A preview runs a draft model or prompt on a few chosen samples and writes nothing. A plan runs
 * chosen stages on a frozen set of assets as a durable media operation, pinned to the destinations
 * and configuration it was admitted with. Moments are a video's reusable frames, their timestamped
 * search index and the owner's own moments.
 */

/** Whether a destination would take one workload right now, from its persisted probe state. */
const EnrichmentDestinationAdmissionSchema = z
  .object({
    admitted: z.boolean(),
    refusal: z.string().nullable().describe('Stable refusal code when it would not'),
  })
  .meta({ id: 'EnrichmentDestinationAdmissionDto' });

/**
 * A destination the person may choose. Deliberately without its URL or credentials: the choice
 * is by name, and where it points is the administrator's configuration.
 */
const EnrichmentDestinationOptionSchema = z
  .object({
    id: z.uuidv4(),
    name: z.string(),
    kind: MlDestinationKindSchema,
    cloud: z.boolean().describe('Sends media off this network; needs recorded consent'),
    health: MlDestinationHealthSchema,
    enrichment: EnrichmentDestinationAdmissionSchema,
    search: EnrichmentDestinationAdmissionSchema,
  })
  .meta({ id: 'EnrichmentDestinationOptionDto' });

const EnrichmentOptionsResponseSchema = z
  .object({
    destinations: z.array(EnrichmentDestinationOptionSchema),
    routes: z
      .object({
        enrichment: z.uuidv4().nullable(),
        search: z.uuidv4().nullable(),
      })
      .describe('The destinations library work is routed to; a plan uses these unless another is chosen'),
    descriptionEnabled: z.boolean(),
    lockedCheckEnabled: z.boolean(),
    searchEnabled: z.boolean(),
    modelName: z.string().describe('Saved description model'),
    searchModelName: z.string().describe('Saved search model'),
    defaultStages: z.array(EnrichmentStageSchema).describe('Stages a new plan starts with; never moment captions'),
    maxSamples: z.int(),
    maxAssets: z.int(),
    framesPerVideo: z.int(),
  })
  .meta({ id: 'EnrichmentOptionsResponseDto' });

const EnrichmentPreviewRequestSchema = z
  .object({
    assetIds: z
      .array(z.uuidv4())
      .min(1)
      .max(ENRICHMENT_PREVIEW_MAX_SAMPLES)
      .describe('Samples to describe; run one at a time'),
    destinationId: z.uuidv4().optional().describe('Destination to run on; the routed one when omitted'),
    modelName: z.string().min(1).optional().describe('Draft model; the saved one when omitted'),
    fallbackModelName: z.string().optional(),
    prompt: ImageDescriptionPromptSchema.optional().describe('Draft prompt; the saved one when omitted'),
  })
  .meta({ id: 'EnrichmentPreviewRequestDto' });

const EnrichmentPreviewSampleSchema = z
  .object({
    assetId: z.uuidv4(),
    status: EnrichmentPreviewStatusSchema,
    current: z.string().nullable().describe('The stored generated description, unchanged'),
    candidate: z.string().nullable().describe('What the draft produced; stored nowhere'),
    tags: z.array(z.string()),
    hallucinatedNames: z.array(z.string()),
    ambiguousReferences: z.array(z.string()),
    warnings: z.array(z.string()),
    frameCount: z.int().describe('Video frames the draft saw; 0 for a photo'),
    durationMs: z.int(),
    reasonKey: z.string().nullable(),
    message: z.string().nullable(),
  })
  .meta({ id: 'EnrichmentPreviewSampleDto' });

const EnrichmentPreviewResponseSchema = z
  .object({
    destinationId: z.uuidv4(),
    destinationName: z.string(),
    cloud: z.boolean(),
    modelName: z.string(),
    samples: z.array(EnrichmentPreviewSampleSchema),
  })
  .meta({ id: 'EnrichmentPreviewResponseDto' });

const EnrichmentPlanCreateSchema = z
  .object({
    assetIds: z
      .array(z.uuidv4())
      .min(1)
      .max(ENRICHMENT_PLAN_MAX_ASSETS)
      .describe('The frozen set, in order; never re-resolved'),
    stages: z.array(EnrichmentStageSchema).min(1).describe('Chosen stages; the ones they need are added'),
    destinationId: z.uuidv4().optional().describe('Destination for descriptions, checks and captions'),
    searchDestinationId: z.uuidv4().optional().describe('Destination for search embeddings'),
    requestKey: z
      .uuidv4()
      .optional()
      .describe('Client idempotency key; submitting the same key again returns the existing plan'),
  })
  .meta({ id: 'EnrichmentPlanCreateDto' });

const EnrichmentPlanStageOutcomeSchema = z
  .object({
    stage: EnrichmentStageSchema,
    state: EnrichmentItemStateSchema,
    reasonKey: z.string().nullable(),
    message: z.string().nullable(),
    at: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'EnrichmentPlanStageOutcomeDto' });

const EnrichmentPlanItemSchema = z
  .object({
    assetId: z.uuidv4(),
    state: EnrichmentItemStateSchema,
    retryPending: z.boolean().describe('Waiting for its one automatic retry'),
    stages: z.array(EnrichmentPlanStageOutcomeSchema),
  })
  .meta({ id: 'EnrichmentPlanItemDto' });

const EnrichmentPlanCountsSchema = z
  .object({
    total: z.int(),
    queued: z.int(),
    running: z.int(),
    skipped: z.int(),
    failed: z.int(),
    completed: z.int(),
    cancelled: z.int(),
  })
  .meta({ id: 'EnrichmentPlanCountsDto' });

const EnrichmentPlanDestinationSchema = z
  .object({ id: z.uuidv4(), name: z.string(), cloud: z.boolean() })
  .meta({ id: 'EnrichmentPlanDestinationDto' });

const EnrichmentPlanResponseSchema = z
  .object({
    operation: MediaOperationSchema,
    requestedStages: z.array(EnrichmentStageSchema),
    stages: z.array(EnrichmentStageSchema),
    addedStages: z.array(EnrichmentStageSchema).describe('Stages run only because a chosen stage needs them'),
    enrichmentDestination: EnrichmentPlanDestinationSchema.nullable(),
    searchDestination: EnrichmentPlanDestinationSchema.nullable(),
    modelName: z.string(),
    searchModelName: z.string(),
    configHash: z.string(),
    items: z.array(EnrichmentPlanItemSchema),
    counts: EnrichmentPlanCountsSchema,
    hiddenCount: z.int().describe('Locked items not listed because this session is not unlocked'),
  })
  .meta({ id: 'EnrichmentPlanResponseDto' });

const VideoMomentFrameSchema = z
  .object({
    id: z.uuidv7(),
    frameIndex: z.int(),
    timestampMs: z.int(),
    width: z.int().nullable(),
    height: z.int().nullable(),
    score: z.number().meta({ format: 'double' }),
    rank: z.int().describe('1 is the best frame'),
    isCover: z.boolean(),
    indexed: z.boolean().describe('Has a search embedding from the saved search model'),
  })
  .meta({ id: 'VideoMomentFrameDto' });

const VideoMomentSchema = z
  .object({
    id: z.uuidv7(),
    source: VideoMomentSourceSchema,
    timestampMs: z.int(),
    endMs: z.int().nullable(),
    frameId: z.uuidv7().nullable(),
    caption: z.string().nullable(),
    transcript: z.string().nullable().describe('Typed by the owner; never generated'),
    staleReason: EnrichmentStaleReasonSchema.nullable(),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'VideoMomentDto' });

const VideoMomentsResponseSchema = z
  .object({
    assetId: z.uuidv4(),
    state: VideoMomentIndexStateSchema,
    staleReason: EnrichmentStaleReasonSchema.nullable(),
    frames: z.array(VideoMomentFrameSchema),
    moments: z.array(VideoMomentSchema),
    coverTimestampMs: z.int().nullable().describe("The owner's chosen cover time; null means the best frame"),
    coverFrameId: z.uuidv7().nullable(),
    extractorVersion: z.string().nullable(),
    framesExtractedAt: z.string().meta({ format: 'date-time' }).nullable(),
    embeddingModel: z.string().nullable(),
    indexedAt: z.string().meta({ format: 'date-time' }).nullable(),
    captionModel: z.string().nullable(),
    captionedAt: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'VideoMomentsResponseDto' });

const VideoMomentCoverSchema = z
  .object({
    timestampMs: z.int().min(0).nullable().describe('Time of the chosen frame; null returns to the best frame'),
  })
  .meta({ id: 'VideoMomentCoverDto' });

const VideoMomentCreateSchema = z
  .object({
    timestampMs: z.int().min(0),
    endMs: z.int().min(0).nullable().optional(),
    caption: z.string().trim().max(500).nullable().optional(),
    transcript: z.string().max(20_000).nullable().optional(),
  })
  .meta({ id: 'VideoMomentCreateDto' });

const VideoMomentUpdateSchema = z
  .object({
    timestampMs: z.int().min(0).optional(),
    endMs: z.int().min(0).nullable().optional(),
    caption: z.string().trim().max(500).nullable().optional(),
    transcript: z.string().max(20_000).nullable().optional(),
  })
  .meta({ id: 'VideoMomentUpdateDto' });

const VideoMomentSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.int().min(1).max(100).default(24).optional(),
  })
  .meta({ id: 'VideoMomentSearchDto' });

const VideoMomentSimilarSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(24).optional().describe('Most moments to return'),
  })
  .meta({ id: 'VideoMomentSimilarDto' });

const VideoMomentSearchHitSchema = z
  .object({
    assetId: z.uuidv4(),
    timestampMs: z.int(),
    frameId: z.uuidv7().nullable(),
    momentId: z.uuidv7().nullable(),
    caption: z.string().nullable(),
    match: VideoMomentMatchSchema,
    score: z.number().meta({ format: 'double' }).describe('Higher is closer'),
  })
  .meta({ id: 'VideoMomentSearchHitDto' });

const VideoMomentSearchResponseSchema = z
  .object({ hits: z.array(VideoMomentSearchHitSchema) })
  .meta({ id: 'VideoMomentSearchResponseDto' });

const VideoMomentParamSchema = z.object({
  id: z.uuidv4().describe('Asset ID'),
  momentId: z.uuidv7(),
});

export class EnrichmentOptionsResponseDto extends createZodDto(EnrichmentOptionsResponseSchema) {}
export class EnrichmentPreviewRequestDto extends createZodDto(EnrichmentPreviewRequestSchema) {}
export class EnrichmentPreviewResponseDto extends createZodDto(EnrichmentPreviewResponseSchema) {}
export class EnrichmentPlanCreateDto extends createZodDto(EnrichmentPlanCreateSchema) {}
export class EnrichmentPlanResponseDto extends createZodDto(EnrichmentPlanResponseSchema) {}
export class VideoMomentsResponseDto extends createZodDto(VideoMomentsResponseSchema) {}
export class VideoMomentDto extends createZodDto(VideoMomentSchema) {}
export class VideoMomentCoverDto extends createZodDto(VideoMomentCoverSchema) {}
export class VideoMomentCreateDto extends createZodDto(VideoMomentCreateSchema) {}
export class VideoMomentUpdateDto extends createZodDto(VideoMomentUpdateSchema) {}
export class VideoMomentSearchDto extends createZodDto(VideoMomentSearchSchema) {}
export class VideoMomentSimilarDto extends createZodDto(VideoMomentSimilarSchema) {}
export class VideoMomentSearchResponseDto extends createZodDto(VideoMomentSearchResponseSchema) {}
export class VideoMomentParamDto extends createZodDto(VideoMomentParamSchema) {}

export type EnrichmentPlanItemView = z.infer<typeof EnrichmentPlanItemSchema>;
export type VideoMomentFrameView = z.infer<typeof VideoMomentFrameSchema>;

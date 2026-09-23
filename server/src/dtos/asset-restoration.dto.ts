import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  MlAdmissionRefusalSchema,
  MlDestinationHealthSchema,
  MlDestinationKindSchema,
  MlWorkloadSchema,
} from 'src/enum.js';

/**
 * Preview-first restoration (FL-115).
 *
 * A restoration is requested as a *preview* first: a small crop of a still, or a few seconds of a
 * video, restored on an explicitly chosen destination. The owner reviews it before and after and
 * either accepts it — which renders the full-resolution derivative on the same destination with
 * the same model, mode and size — or rejects it. The result is a new revision of the asset; the
 * original file is never written.
 *
 * Nothing here chooses a destination. `destinationId` is required on every request and the server
 * refuses it rather than substituting another when it cannot be admitted.
 */

export enum AssetRestorationMode {
  /** Removes noise and compression while keeping the original look. */
  Faithful = 'faithful',
  /** Rebuilds fine detail and may invent texture; for very small sources. */
  Creative = 'creative',
}

export const AssetRestorationModeSchema = z
  .enum(AssetRestorationMode)
  .describe('Restoration model family')
  .meta({ id: 'AssetRestorationMode' });

export enum AssetRestorationStatus {
  PreviewQueued = 'preview_queued',
  PreviewRendering = 'preview_rendering',
  /** The preview exists and is waiting for the owner's decision. */
  PreviewReady = 'preview_ready',
  PreviewFailed = 'preview_failed',
  PreviewCancelled = 'preview_cancelled',
  /** Accepted; the full render is queued. */
  Accepted = 'accepted',
  Restoring = 'restoring',
  /** The full-resolution derivative exists. */
  Restored = 'restored',
  RestoreFailed = 'restore_failed',
  RestoreCancelled = 'restore_cancelled',
  /** The owner rejected the preview. Its files are kept briefly for comparison, then removed. */
  Rejected = 'rejected',
  /** The owner discarded the restoration; every file it produced has been removed. */
  Discarded = 'discarded',
  /** Nobody reviewed the preview inside the retention window; its files were removed. */
  Expired = 'expired',
}

export const AssetRestorationStatusSchema = z
  .enum(AssetRestorationStatus)
  .describe('Lifecycle state of a restoration')
  .meta({ id: 'AssetRestorationStatus' });

export enum AssetRestorationSourceType {
  Image = 'image',
  Video = 'video',
}

export const AssetRestorationSourceTypeSchema = z
  .enum(AssetRestorationSourceType)
  .describe('Whether the restored source is a still image or a video')
  .meta({ id: 'AssetRestorationSourceType' });

export enum AssetRestorationFileKind {
  /** The preview's input: the same crop or clip, untouched, for the before side of the compare. */
  Before = 'before',
  /** The restored preview. */
  After = 'after',
  /** The full-resolution restored derivative. */
  Result = 'result',
  /** A playback-sized rendition of the result; stills only. */
  ResultPreview = 'result_preview',
}

export const AssetRestorationFileKindSchema = z
  .enum(AssetRestorationFileKind)
  .describe('Which file of a restoration to fetch')
  .meta({ id: 'AssetRestorationFileKind' });

const unit = (description: string) => z.number().meta({ format: 'double' }).min(0).max(1).describe(description);

/**
 * Where the preview is taken from. Fractions of the oriented frame so the same region means the
 * same thing at every size. A video preview additionally names its start; its length is fixed by
 * the server so previews stay cheap and comparable.
 */
export const AssetRestorationRegionSchema = z
  .object({
    x: unit('Left edge of the preview area as a fraction of the frame width'),
    y: unit('Top edge of the preview area as a fraction of the frame height'),
    w: z.number().meta({ format: 'double' }).min(0.1).max(1).describe('Preview area width as a fraction of the frame'),
    h: z.number().meta({ format: 'double' }).min(0.1).max(1).describe('Preview area height as a fraction of the frame'),
    startSeconds: z
      .number()
      .meta({ format: 'double' })
      .min(0)
      .optional()
      .describe('Video only: where the preview clip starts. Ignored for stills.'),
  })
  .refine((rect) => rect.x + rect.w <= 1.00001 && rect.y + rect.h <= 1.00001, {
    error: 'The preview area must stay inside the frame',
  })
  .meta({ id: 'AssetRestorationRegionDto' });

export type AssetRestorationRegion = z.infer<typeof AssetRestorationRegionSchema>;

/** The centre half of the frame: enough to judge a model, small enough to be quick. */
export const DEFAULT_RESTORATION_REGION: AssetRestorationRegion = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

export const AssetRestorationUpscaleSchema = z
  .union([
    z.literal(1).meta({ format: 'double' }),
    z.literal(2).meta({ format: 'double' }),
    z.literal(4).meta({ format: 'double' }),
  ])
  .describe('Upscale factor. Output is additionally capped at 4K.');

const AssetRestorationRequestSchema = z
  .object({
    mode: AssetRestorationModeSchema,
    upscale: AssetRestorationUpscaleSchema.default(2),
    keepGrain: z.boolean().default(false).describe('Preserve fine film grain instead of smoothing it'),
    destinationId: z
      .uuidv4()
      .describe('The processing destination this restoration runs on. Required; never inferred.'),
    region: AssetRestorationRegionSchema.default(DEFAULT_RESTORATION_REGION),
  })
  .meta({ id: 'AssetRestorationRequestDto' });

const AssetRestorationOptionsQuerySchema = z
  .object({
    mode: AssetRestorationModeSchema.default(AssetRestorationMode.Faithful).optional(),
    upscale: z.coerce
      .number()
      .int()
      .refine((value) => [1, 2, 4].includes(value), { error: 'Upscale must be 1, 2 or 4' })
      .default(2)
      .optional(),
  })
  .meta({ id: 'AssetRestorationOptionsQueryDto' });

/**
 * A measured estimate. Every figure comes from this destination's own accounting rows for this
 * workload; with no samples the seconds are null and the client says so instead of guessing.
 */
const AssetRestorationEstimateSchema = z
  .object({
    sampleCount: z.int().describe('Successful requests the throughput was measured from'),
    bytesPerSecond: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Measured upload throughput for this destination and workload, or null with no samples'),
    windowDays: z.int().describe('Length of the measurement window'),
    previewBytes: z.number().meta({ format: 'double' }).describe('Approximate bytes the preview sends'),
    fullBytes: z.number().meta({ format: 'double' }).describe('Approximate bytes the full render sends'),
    previewSeconds: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Estimated preview time from measured throughput, or null when nothing is measured'),
    fullSeconds: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Estimated full render time from measured throughput, or null when nothing is measured'),
  })
  .meta({ id: 'AssetRestorationEstimateDto' });

/**
 * One destination as a choice. `available` mirrors the server's admission rule for the selected
 * mode's workload; `refusal` says why a destination cannot be chosen so the client can explain it
 * rather than hiding it.
 */
const AssetRestorationDestinationSchema = z
  .object({
    id: z.uuidv4(),
    kind: MlDestinationKindSchema,
    name: z.string(),
    health: MlDestinationHealthSchema,
    available: z.boolean().describe('The server would admit this workload on this destination right now'),
    leavesNetwork: z.boolean().describe('Media sent to this destination leaves the network'),
    consentRequired: z.boolean(),
    consentGranted: z.boolean().describe('True when no consent is needed or an administrator recorded it'),
    refusal: MlAdmissionRefusalSchema.nullable().describe('Why the destination cannot be chosen, or null'),
    refusalDetail: z.string().nullable(),
    estimate: AssetRestorationEstimateSchema,
  })
  .meta({ id: 'AssetRestorationDestinationDto' });

const AssetRestorationOptionsSchema = z
  .object({
    assetId: z.uuidv4(),
    sourceType: AssetRestorationSourceTypeSchema,
    sourceWidth: z.int(),
    sourceHeight: z.int(),
    durationSeconds: z.number().meta({ format: 'double' }).nullable().describe('Video length; null for stills'),
    mode: AssetRestorationModeSchema,
    workload: MlWorkloadSchema,
    upscale: z.int(),
    outputWidth: z.int().describe('Width the full render would produce after the 4K cap'),
    outputHeight: z.int().describe('Height the full render would produce after the 4K cap'),
    previewSeconds: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Length of a video preview clip; null for stills'),
    adapterInstalled: z
      .boolean()
      .describe(
        'Always true since the restoration adapter ships with the server; whether a model can run is reported per destination.',
      ),
    destinations: z.array(AssetRestorationDestinationSchema),
  })
  .meta({ id: 'AssetRestorationOptionsDto' });

const AssetRestorationResponseSchema = z
  .object({
    id: z.uuidv7().describe('Restoration ID'),
    assetId: z.uuidv4(),
    revision: z.int().min(1).describe('Per-asset sequence number, 1 for the first restoration'),
    status: AssetRestorationStatusSchema,
    mode: AssetRestorationModeSchema,
    upscale: z.int(),
    keepGrain: z.boolean(),
    workload: MlWorkloadSchema,
    destinationId: z.uuidv4().nullable().describe('The bound destination, or null once an administrator removed it'),
    destinationKind: MlDestinationKindSchema,
    destinationName: z.string(),
    sourceType: AssetRestorationSourceTypeSchema,
    sourceWidth: z.int(),
    sourceHeight: z.int(),
    sourceDurationSeconds: z.number().meta({ format: 'double' }).nullable(),
    previewRegion: AssetRestorationRegionSchema,
    previewOperationId: z.uuidv7().nullable().describe('The durable job that rendered the preview'),
    fullOperationId: z.uuidv7().nullable().describe('The durable job that renders the full result'),
    activeOperationId: z
      .uuidv7()
      .nullable()
      .describe('The job currently running for this restoration, for cancel and retry; null when idle'),
    hasPreview: z.boolean().describe('Both preview files exist'),
    hasResult: z.boolean().describe('The full-resolution result exists'),
    outputWidth: z.int().nullable(),
    outputHeight: z.int().nullable(),
    modelName: z.string().nullable().describe('Model the adapter reported, for provenance'),
    modelVersion: z.string().nullable(),
    estimate: AssetRestorationEstimateSchema.nullable(),
    error: z.string().nullable(),
    isCurrent: z.boolean().describe('The owner chose this result as the asset’s playback version'),
    previewReadyAt: z.string().meta({ format: 'date-time' }).nullable(),
    reviewedAt: z.string().meta({ format: 'date-time' }).nullable(),
    restoredAt: z.string().meta({ format: 'date-time' }).nullable(),
    previewExpiresAt: z.string().meta({ format: 'date-time' }).nullable(),
    resultExpiresAt: z.string().meta({ format: 'date-time' }).nullable(),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'AssetRestorationResponseDto' });

const AssetRestorationListResponseSchema = z
  .object({
    assetId: z.uuidv4(),
    currentRestorationId: z
      .uuidv7()
      .nullable()
      .describe('The restoration the owner chose as the playback version; null means the original'),
    items: z.array(AssetRestorationResponseSchema).describe('Every restoration of the asset, newest first'),
  })
  .meta({ id: 'AssetRestorationListResponseDto' });

const AssetRestorationSelectSchema = z
  .object({
    restorationId: z
      .uuidv7()
      .optional()
      .describe('Restored revision to use as the playback version; omitted, the original is used'),
  })
  .meta({ id: 'AssetRestorationSelectDto' });

const AssetRestorationFileQuerySchema = z
  .object({
    kind: AssetRestorationFileKindSchema.default(AssetRestorationFileKind.After),
  })
  .meta({ id: 'AssetRestorationFileQueryDto' });

const AssetRestorationParamSchema = z
  .object({
    id: z.uuidv4().describe('Asset ID'),
    restorationId: z.uuidv7().describe('Restoration ID'),
  })
  .meta({ id: 'AssetRestorationParamDto' });

export class AssetRestorationRegionDto extends createZodDto(AssetRestorationRegionSchema) {}
export class AssetRestorationRequestDto extends createZodDto(AssetRestorationRequestSchema) {}
export class AssetRestorationOptionsQueryDto extends createZodDto(AssetRestorationOptionsQuerySchema) {}
export class AssetRestorationEstimateDto extends createZodDto(AssetRestorationEstimateSchema) {}
export class AssetRestorationDestinationDto extends createZodDto(AssetRestorationDestinationSchema) {}
export class AssetRestorationOptionsDto extends createZodDto(AssetRestorationOptionsSchema) {}
export class AssetRestorationResponseDto extends createZodDto(AssetRestorationResponseSchema) {}
export class AssetRestorationListResponseDto extends createZodDto(AssetRestorationListResponseSchema) {}
export class AssetRestorationSelectDto extends createZodDto(AssetRestorationSelectSchema) {}
export class AssetRestorationFileQueryDto extends createZodDto(AssetRestorationFileQuerySchema) {}
export class AssetRestorationParamDto extends createZodDto(AssetRestorationParamSchema) {}

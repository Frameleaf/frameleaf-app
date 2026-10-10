import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetRestorationModeSchema, AssetRestorationRegionSchema } from 'src/dtos/asset-restoration.dto.js';
import { MlWorkloadSchema } from 'src/enum.js';
import {
  CLOUD_ML_JOB_ACTIVITY_STAGES,
  CLOUD_ML_JOB_PURPOSES,
  CLOUD_ML_JOB_STAGES,
  SMOOTH_MOTION_FACTORS,
} from 'src/utils/cloud-ml-job.js';
import { MODEL_SKU_PATTERN } from 'src/utils/frameleaf-cloud.js';

/**
 * Frameleaf Cloud restoration and Smooth motion jobs for their owner (FL-162, `CLD-202`): estimate,
 * confirm, then follow the job in Activity. Every amount is USD. An estimate is metered GPU time at
 * the model's rate plus a start fee per worker, shown as a p50–p90 range; per-photo and per-minute
 * figures are estimates, never fixed prices.
 */

const usd = (description: string) => z.number().meta({ format: 'double' }).describe(description);

export const CloudMlJobPurposeSchema = z
  .enum(CLOUD_ML_JOB_PURPOSES)
  .describe('restoration: restore or upscale; smooth-motion: frame interpolation for slow motion or frame rate')
  .meta({ id: 'CloudMlJobPurpose' });

export const CloudMlJobStageSchema = z
  .enum(CLOUD_ML_JOB_STAGES)
  .describe('preview: a short clip or a crop first; full: the whole file, after the preview was reviewed')
  .meta({ id: 'CloudMlJobStage' });

export const CloudMlJobActivityStageSchema = z
  .enum(CLOUD_ML_JOB_ACTIVITY_STAGES)
  .describe('Where the job is, as Activity shows it; starting is a worker cold start')
  .meta({ id: 'CloudMlJobActivityStage' });

const CloudMlJobEstimateRequestSchema = z
  .object({
    assetId: z.uuidv4().describe('The photo or video'),
    purpose: CloudMlJobPurposeSchema,
    stage: CloudMlJobStageSchema,
    destinationId: z.uuidv4().describe('The Frameleaf Cloud processing destination; never inferred'),
    restorationId: z
      .uuidv7()
      .optional()
      .describe(
        'For the full stage: the reviewed preview it renders in full, with the same model and settings. Omitted, a full-stage estimate is a quote for the whole file from the source alone (quoteOnly), priced with the given settings; it cannot be confirmed',
      ),
    mode: AssetRestorationModeSchema.optional().describe('Restoration preview: faithful or creative'),
    upscale: z
      .union([z.literal(2).meta({ format: 'double' }), z.literal(4).meta({ format: 'double' })])
      .optional()
      .describe('Restoration preview: 2× or 4×, capped at 4K'),
    keepGrain: z.boolean().optional().describe('Restoration preview: keep fine film grain'),
    factor: z
      .union([
        z.literal(SMOOTH_MOTION_FACTORS[0]).meta({ format: 'double' }),
        z.literal(SMOOTH_MOTION_FACTORS[1]).meta({ format: 'double' }),
        z.literal(SMOOTH_MOTION_FACTORS[2]).meta({ format: 'double' }),
      ])
      .optional()
      .describe('Smooth motion preview: how many frames each frame becomes (2×, 4× or 8×)'),
    region: AssetRestorationRegionSchema.optional().describe('Preview: the part of the frame to preview'),
    modelSku: z
      .string()
      .regex(MODEL_SKU_PATTERN)
      .optional()
      .describe('The model chosen on the slider; omitted, the chosen or recommended model for this work'),
  })
  .meta({ id: 'CloudMlJobEstimateRequestDto' });

const CloudMlJobModelSchema = z
  .object({
    sku: z.string().describe('The catalogue model SKU'),
    rev: z.string().describe('The model revision the estimate is bound to'),
    label: z.string().describe('The catalogue name'),
    gpu: z.string().describe('The GPU class it runs on, for people only'),
    rank: z.int().describe('Position on the model slider, 1 = lightest'),
    perSecondUsd: usd('The GPU rate per metered second, USD'),
    startFeeUsd: usd('One start fee, USD'),
  })
  .meta({ id: 'CloudMlJobModelDto' });

const CloudMlJobPerUnitSchema = z
  .object({
    unit: z.enum(['photo', 'minute']).describe('What one unit is'),
    quantity: z.number().meta({ format: 'double' }).describe('How many units the job has'),
    p50Usd: usd('Likely cost per unit, start fees included, USD; an estimate, never a price'),
    p90Usd: usd('Cost per unit at most, in nine cases out of ten, start fees included, USD'),
  })
  .meta({ id: 'CloudMlJobPerUnitDto' });

const CloudMlJobConsentSchema = z
  .object({
    version: z.string().describe('The consent version this job is confirmed under; send it back with the job'),
    summary: z.string().describe('What leaves this server and what is kept, as Frameleaf Cloud words it'),
    documentUrl: z.string().nullable().describe('The full text, when Frameleaf Cloud links one'),
  })
  .meta({ id: 'CloudMlJobConsentDto' });

const CloudMlJobRefusalSchema = z
  .object({
    code: z
      .string()
      .describe('insufficient-credits, daily-cap or budget-exceeded; nothing is sent and the model is never changed'),
    message: z.string(),
  })
  .meta({ id: 'CloudMlJobRefusalDto' });

const CloudMlJobPermissionSchema = z
  .object({
    canConfirm: z.boolean().describe('Whether this person may confirm the job; administrators always may'),
    reason: z
      .string()
      .nullable()
      .describe('not-allowed (an administrator has not allowed this person) or monthly-cap, when they may not'),
    monthlyCapUsd: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe("This person's monthly Frameleaf Cloud limit, USD, or null when none applies"),
    spentThisMonthUsd: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Settled this month plus the holds of their running jobs, USD, or null when no limit applies'),
  })
  .meta({ id: 'CloudMlJobPermissionDto' });

const CloudMlJobUpscaleSchema = z
  .object({
    requestedScale: z.int().describe('The upscale factor that was asked for (2 or 4)'),
    appliedScale: z
      .int()
      .describe('The factor Frameleaf Cloud will really use and prices: lower when the 64 MP output cap needs it'),
    lowered: z.boolean().describe('Whether the 64 MP output cap lowered the factor; shown before confirming'),
    outputWidth: z.int().describe('The width the result will have, in pixels'),
    outputHeight: z.int().describe('The height the result will have, in pixels'),
  })
  .meta({ id: 'CloudMlJobUpscaleDto' });

const CloudMlJobEstimateResponseSchema = z
  .object({
    estimateId: z.string().describe('What confirming the job names; the server keeps everything else'),
    expiresAt: z.string().meta({ format: 'date-time' }).describe('After this, estimate again; it is never reused'),
    workload: MlWorkloadSchema,
    model: CloudMlJobModelSchema,
    models: z
      .array(CloudMlJobModelSchema)
      .describe('Every model Frameleaf Cloud offers for this work here, light to heavy, for the model slider'),
    basis: z.string().describe("measured: from the model's measured GPU time; modelled: from its expected GPU time"),
    p50Usd: usd('Likely total: GPU time × rate + start fees, USD'),
    p90Usd: usd('High end, in nine cases out of ten, USD'),
    startupUsd: usd('Start fees: one start fee per planned worker, USD'),
    startFeeUsd: usd('One start fee, USD'),
    perSecondUsd: usd('The GPU rate per metered second, USD'),
    holdUsd: usd('What the AI Wallet holds while the job runs, USD; released when it settles'),
    minimumUsd: usd('The least the job can cost once a worker starts (one start fee), USD'),
    plannedWorkers: z.int().describe('Serverless workers the job is planned on, at most 5; each adds a start fee'),
    coldStartSeconds: z.number().meta({ format: 'double' }).describe('Expected time to start a worker'),
    runSeconds: z.number().meta({ format: 'double' }).describe('Expected GPU time once running (p50)'),
    perUnit: CloudMlJobPerUnitSchema,
    availableUsd: usd('AI Wallet balance minus holds, USD'),
    dailyCapUsd: z.number().meta({ format: 'double' }).nullable().describe('The daily AI Wallet limit, USD, or null'),
    spentTodayUsd: usd('Spent today, USD'),
    consent: CloudMlJobConsentSchema,
    refusal: CloudMlJobRefusalSchema.nullable().describe('Why the job cannot be sent now, or null when it can'),
    permission: CloudMlJobPermissionSchema,
    upscale: CloudMlJobUpscaleSchema.nullable().describe(
      'Photo upscales only (FC-46): the factor each photo really gets under the 64 MP output cap; null otherwise',
    ),
    quoteOnly: z
      .boolean()
      .describe(
        'A full-stage quote made without a reviewed preview (FL-348): what the whole file would cost with these settings. It cannot be confirmed; preview first, then estimate the reviewed preview in full',
      ),
  })
  .meta({ id: 'CloudMlJobEstimateResponseDto' });

const CloudMlJobCreateSchema = z
  .object({
    estimateId: z.string().min(1).max(64).describe('The estimate the owner saw and confirmed'),
    consentVersion: z.string().min(1).max(64).describe('The consent version shown with the estimate'),
    acknowledgeDataLeaves: z
      .literal(true)
      .describe('The owner confirmed that the preview or file leaves this server for Frameleaf Cloud'),
  })
  .meta({ id: 'CloudMlJobCreateDto' });

const CloudMlJobCostSchema = z
  .object({
    estimatedP50Usd: usd('The likely total the owner confirmed, USD'),
    estimatedP90Usd: usd('The high end the owner confirmed, USD'),
    holdUsd: usd('What the AI Wallet holds for the job, USD'),
    soFarUsd: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Metered so far, never above the hold, USD; null before a worker starts'),
    settledUsd: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('What the job was charged once settled, USD; null until then'),
    outcome: z
      .enum(['charged', 'not_charged', 'refunded'])
      .meta({ id: 'CloudMlJobCostOutcome' })
      .nullable()
      .describe('not_charged: the hold went back in full (a failure on the cloud side, or a job that never ran)'),
    note: z.string().nullable().describe('Frameleaf Cloud’s note on the settlement'),
  })
  .meta({ id: 'CloudMlJobCostDto' });

export const CloudMlJobActivitySchema = z
  .object({
    purpose: CloudMlJobPurposeSchema,
    stage: CloudMlJobStageSchema,
    activityStage: CloudMlJobActivityStageSchema,
    model: z.string().describe('The catalogue name of the model the job runs'),
    modelSku: z.string(),
    plannedWorkers: z.int(),
    workers: z.int().describe('Workers started so far'),
    cloudStatus: z.string().nullable().describe('Frameleaf Cloud’s own state of the job, or null before it was sent'),
    progressUnit: z.string().nullable().describe('items, seconds or segments, when Frameleaf Cloud reports progress'),
    cost: CloudMlJobCostSchema,
  })
  .meta({ id: 'CloudMlJobActivityDto' });

const CloudMlJobResponseSchema = z
  .object({
    operationId: z.uuidv7().describe('The job in Activity; cancel it there'),
    restorationId: z.uuidv7().describe('The restoration or Smooth motion version it renders'),
    stage: CloudMlJobStageSchema,
  })
  .meta({ id: 'CloudMlJobResponseDto' });

export class CloudMlJobEstimateRequestDto extends createZodDto(CloudMlJobEstimateRequestSchema) {}
export class CloudMlJobEstimateResponseDto extends createZodDto(CloudMlJobEstimateResponseSchema) {}
export class CloudMlJobCreateDto extends createZodDto(CloudMlJobCreateSchema) {}
export class CloudMlJobResponseDto extends createZodDto(CloudMlJobResponseSchema) {}
export class CloudMlJobActivityDto extends createZodDto(CloudMlJobActivitySchema) {}

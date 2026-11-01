import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  cloudLocationEstimateSchema,
  locationBillingSchema,
  locationInsightSchema,
} from 'src/utils/photo-locations.js';

export const LocationInsightSchema = locationInsightSchema.meta({ id: 'LocationInsightDto' });
export class LocationInsightDto extends createZodDto(LocationInsightSchema) {}

const LocationScanStateSchema = z
  .enum(['queued', 'preparing', 'uploading', 'running', 'paused', 'completed', 'failed', 'cancelled'])
  .meta({ id: 'LocationScanState' });

export const LocationScanSummarySchema = z
  .object({
    id: z.uuid(),
    status: LocationScanStateSchema,
    total: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    unmatched: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    eligiblePhotos: z.number().int().nonnegative(),
    selectedPhotos: z.number().int().nonnegative(),
    remainingPhotos: z.number().int().nonnegative(),
    estimatedMicros: z.number().int().nonnegative(),
    billing: locationBillingSchema.nullable(),
    error: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .meta({ id: 'LocationScanSummaryDto' });
export type LocationScanSummary = z.infer<typeof LocationScanSummarySchema>;

export class LocationScanStatusResponseDto extends createZodDto(
  z
    .object({
      enabled: z.boolean(),
      available: z.boolean(),
      scan: LocationScanSummarySchema.nullable(),
    })
    .meta({ id: 'LocationScanStatusResponseDto' }),
) {}

export class StartLocationScanDto extends createZodDto(
  z
    .strictObject({
      estimateId: z.uuid(),
      consent: z
        .literal(true)
        .meta({ id: 'LocationScanConsent' })
        .describe('Explicit permission for this paid GPS scan'),
    })
    .meta({ id: 'StartLocationScanDto' }),
) {}

export class LocationScanEstimateRequestDto extends createZodDto(
  z
    .strictObject({
      refresh: z.boolean().optional().default(false),
      maxPhotos: z.number().int().positive().max(2_147_483_647).optional(),
      maxSpendMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .refine(
      (value) => value.maxPhotos !== undefined || value.maxSpendMicros !== undefined,
      'Choose a photo or spending limit',
    )
    .meta({ id: 'LocationScanEstimateRequestDto' }),
) {}

export class LocationScanEstimateResponseDto extends createZodDto(
  cloudLocationEstimateSchema
    .extend({
      estimateId: z.uuid().nullable(),
      expiresAt: z.iso.datetime({ offset: true }).nullable(),
      selectedPhotos: z.number().int().nonnegative(),
      estimatedMicros: z.number().int().nonnegative(),
      availableMicros: z.number().int().nonnegative().nullable(),
      canStart: z.boolean(),
      refusal: z.string().nullable(),
      topUpUrl: z.url().nullable(),
    })
    .meta({ id: 'LocationScanEstimateResponseDto' }),
) {}

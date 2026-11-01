import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { locationInsightSchema } from 'src/utils/photo-locations.js';

export const LocationInsightSchema = locationInsightSchema.meta({ id: 'LocationInsightDto' });
export class LocationInsightDto extends createZodDto(LocationInsightSchema) {}

export const LocationScanSummarySchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['queued', 'preparing', 'uploading', 'running', 'paused', 'completed', 'failed', 'cancelled']),
    total: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    unmatched: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
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
      consent: z.literal(true).describe('Explicit permission to send photo coordinates to Frameleaf Cloud and Google'),
      refresh: z.boolean().optional().default(false),
    })
    .meta({ id: 'StartLocationScanDto' }),
) {}

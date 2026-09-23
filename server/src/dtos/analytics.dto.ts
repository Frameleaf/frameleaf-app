import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  AnalyticsGrainSchema,
  AnalyticsMeasurementScopeSchema,
  AnalyticsRange,
  AnalyticsRangeSchema,
  AnalyticsScopeKindSchema,
  AnalyticsSeriesIdSchema,
  AnalyticsStateSchema,
  AnalyticsUnitSchema,
} from 'src/enum.js';

const count = () => z.int().min(0);
const bytes = () => z.int().min(0).describe('Bytes');
const day = () => z.string().meta({ format: 'date' });
const dateTime = () => z.string().meta({ format: 'date-time' });

const AnalyticsQuerySchema = z
  .object({
    scope: z
      .string()
      .default('all')
      .describe('`all` (the whole server, administrators only), `account:<id>` or `library:<id>`'),
    range: AnalyticsRangeSchema.default(AnalyticsRange.Year),
  })
  .meta({ id: 'AnalyticsQueryDto' });

const AnalyticsScopeOptionSchema = z
  .object({
    value: z.string().describe('The value to pass as `scope`'),
    kind: AnalyticsScopeKindSchema,
    label: z.string().describe('Account or library name; empty for the whole server'),
    userId: z.string().nullable().describe('The account, or the library owner'),
    libraryId: z.string().nullable(),
    removed: z.boolean().describe('The account or library has been removed; its items may still count until deleted'),
  })
  .meta({ id: 'AnalyticsScopeOptionDto' });

const AnalyticsScopesResponseSchema = z
  .object({ scopes: z.array(AnalyticsScopeOptionSchema) })
  .meta({ id: 'AnalyticsScopesResponseDto' });

const AnalyticsSeriesDefinitionSchema = z
  .object({
    id: AnalyticsSeriesIdSchema,
    unit: AnalyticsUnitSchema,
    grain: AnalyticsGrainSchema,
    source: z.string().describe('Where the number comes from'),
    owner: z.enum(['library', 'host', 'processing']).describe('The part of the product that answers for it'),
    scopes: z.array(AnalyticsScopeKindSchema).describe('Selections the series can be read for'),
    measurementScope: AnalyticsMeasurementScopeSchema,
    collected: z.boolean().describe('Written by the local nightly collector rather than read live'),
    estimate: z.boolean().describe('An estimate, never a charge'),
    available: z.boolean().describe('Whether this report carries the series for the selected scope'),
  })
  .meta({ id: 'AnalyticsSeriesDefinitionDto' });

const AnalyticsSummarySchema = z
  .object({
    items: count().describe('Photos and videos, Trash included, Locked media and Live Photo motion parts excluded'),
    photos: count(),
    videos: count(),
    raw: count().describe('RAW photos; a subset of photos'),
    files: count().describe('Original files, Live Photo motion parts included'),
    unmeasuredFiles: count().describe('Original files whose size has not been read; excluded from byte totals'),
    logicalBytes: bytes().describe('Every original reference, before physical deduplication'),
    uploadedLogicalBytes: bytes(),
    externalLogicalBytes: bytes().describe('Originals in external libraries, usually outside the library volume'),
    physicalBytes: bytes().describe('Original files, each shared file counted once within this selection'),
    uploadedPhysicalBytes: bytes(),
    externalPhysicalBytes: bytes(),
    savedBytes: bytes().describe('logicalBytes minus physicalBytes of this same selection'),
    duplicateReferences: count().describe('Items sharing an original file with another item in this selection'),
  })
  .meta({ id: 'AnalyticsSummaryDto' });

const AnalyticsHostSchema = z
  .object({
    state: AnalyticsStateSchema,
    observedAt: dateTime().nullable(),
    volumeUsedBytes: bytes().nullable(),
    capacityBytes: bytes().nullable(),
    freeBytes: bytes().nullable(),
  })
  .describe('The library volume, always the whole host whatever is selected')
  .meta({ id: 'AnalyticsHostDto' });

const AnalyticsHistorySchema = z
  .object({
    state: AnalyticsStateSchema.describe('unknown: never collected; stale: last collection is too old'),
    lastObservedAt: dateTime().nullable(),
    staleAfterHours: count(),
    dayRetentionDays: count(),
    weekRetentionDays: count(),
  })
  .meta({ id: 'AnalyticsHistoryDto' });

const AnalyticsBucketSchema = z
  .object({
    key: z.string().describe('YYYY-MM for a month, the Monday for a week'),
    from: day(),
    through: day(),
    partial: z.boolean().describe('Cut short by the edge of the selected dates'),
    photos: count().describe('Photos added in this period and still in the library'),
    videos: count().describe('Videos added in this period and still in the library'),
    completed: count().nullable().describe('Completed processing attempts; null when not available for this scope'),
    failed: count().nullable().describe('Failed processing attempts; null when not available for this scope'),
    items: count().nullable().describe('Library items at the last observation in this period; null when none'),
    logicalBytes: bytes().nullable(),
    physicalBytes: bytes().nullable(),
    observedAt: dateTime().nullable().describe('When the growth values were read; null for a gap'),
  })
  .meta({ id: 'AnalyticsBucketDto' });

const AnalyticsDaySchema = z
  .object({
    date: day(),
    captured: count().describe('Items taken on this local date'),
    uploaded: count().describe('Items added on this UTC date'),
  })
  .meta({ id: 'AnalyticsDayDto' });

const AnalyticsCameraSchema = z
  .object({
    name: z.string().nullable().describe('Camera model; null for the other and unknown rows'),
    kind: z.enum(['model', 'other', 'unknown']),
    count: count(),
  })
  .meta({ id: 'AnalyticsCameraDto' });

const AnalyticsMetadataSchema = z
  .object({
    field: z.enum(['captureDate', 'location', 'cameraModel', 'aiDescription', 'checksum']),
    present: count(),
    missing: count(),
    total: count(),
  })
  .meta({ id: 'AnalyticsMetadataDto' });

const AnalyticsViewSchema = z
  .object({
    view: z.enum(['timeline', 'favorites', 'archive', 'trash']),
    photos: count(),
    videos: count(),
    total: count(),
    overlaps: z.boolean().describe('Also counted in another view'),
  })
  .meta({ id: 'AnalyticsViewDto' });

const AnalyticsAlbumSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    ownerName: z.string(),
    owned: z.boolean(),
    shared: z.boolean(),
  })
  .meta({ id: 'AnalyticsAlbumDto' });

const AnalyticsAlbumsSchema = z
  .object({
    total: count(),
    owned: count(),
    shared: count(),
    ownedShared: count(),
    notShared: count(),
    unlisted: count().describe('Albums counted but not listed, because the viewer neither owns nor belongs to them'),
    albums: z.array(AnalyticsAlbumSchema).describe('Albums the viewer owns or belongs to'),
  })
  .meta({ id: 'AnalyticsAlbumsDto' });

const AnalyticsProcessingSchema = z
  .object({
    available: z.boolean().describe('Processing is recorded for the whole server only'),
    attempts: count(),
    completed: count(),
    failed: count(),
    durationMs: count(),
    estimatedCostUsd: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Estimate from configured hourly rates; never a bill. Null when no attempt had a rate'),
    costedAttempts: count(),
    uncostedAttempts: count().describe('Attempts without a configured rate; not included in the estimate'),
  })
  .meta({ id: 'AnalyticsProcessingDto' });

const AnalyticsReportSchema = z
  .object({
    scope: z.string(),
    scopeKind: AnalyticsScopeKindSchema,
    scopeLabel: z.string().describe('Account or library name; empty for the whole server'),
    range: AnalyticsRangeSchema,
    from: day(),
    through: day(),
    generatedAt: dateTime(),
    definitions: z.array(AnalyticsSeriesDefinitionSchema),
    summary: AnalyticsSummarySchema,
    host: AnalyticsHostSchema,
    history: AnalyticsHistorySchema,
    series: z.array(AnalyticsBucketSchema),
    days: z.array(AnalyticsDaySchema),
    cameras: z.array(AnalyticsCameraSchema),
    metadata: z.array(AnalyticsMetadataSchema),
    views: z.array(AnalyticsViewSchema),
    albums: AnalyticsAlbumsSchema,
    processing: AnalyticsProcessingSchema,
  })
  .meta({ id: 'AnalyticsReportResponseDto' });

export class AnalyticsQueryDto extends createZodDto(AnalyticsQuerySchema) {}
export class AnalyticsScopesResponseDto extends createZodDto(AnalyticsScopesResponseSchema) {}
export class AnalyticsReportResponseDto extends createZodDto(AnalyticsReportSchema) {}
export type AnalyticsScopeOption = z.infer<typeof AnalyticsScopeOptionSchema>;
export type AnalyticsSeriesDefinitionDto = z.infer<typeof AnalyticsSeriesDefinitionSchema>;
export type AnalyticsBucketDto = z.infer<typeof AnalyticsBucketSchema>;

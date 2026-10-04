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
    owner: z
      .enum(['library', 'host', 'processing'])
      .describe('The part of the product that answers for it')
      .meta({ id: 'AnalyticsSeriesOwner' }),
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

const AnalyticsVolumeBreakdownSchema = z
  .object({
    originalsBytes: bytes().describe(
      'Uploaded original files on the volume, each shared file counted once (Locked excluded)',
    ),
    previewsBytes: bytes()
      .nullable()
      .describe('Thumbnail and preview folder, from the nightly collector; null before its first reading'),
    encodedVideoBytes: bytes()
      .nullable()
      .describe('Encoded video folder, from the nightly collector; null before its first reading'),
    generatedObservedAt: dateTime().nullable().describe('When the generated folders were last measured'),
    databaseBytes: bytes().describe('This server database on disk (pg_database_size)'),
    otherBytes: bytes().describe(
      'volumeUsedBytes minus every measured part: other files on the volume, Locked originals and anything unmeasured',
    ),
    onOtherDisk: z
      .array(z.enum(['previews', 'encodedVideo']).meta({ id: 'AnalyticsVolumePart' }))
      .describe('Generated folders the collector found on another disk than the library; not part of volumeUsedBytes'),
    exceedsUsed: z
      .boolean()
      .describe(
        'The measured parts add up to more than the volume used, for example a database on another disk; otherBytes is then 0',
      ),
  })
  .describe(
    'What uses the library volume, only in the whole-server report; the parts and otherBytes add up to volumeUsedBytes',
  )
  .meta({ id: 'AnalyticsVolumeBreakdownDto' });

const AnalyticsHostSchema = z
  .object({
    state: AnalyticsStateSchema,
    observedAt: dateTime().nullable(),
    volumeUsedBytes: bytes().nullable(),
    capacityBytes: bytes().nullable(),
    freeBytes: bytes().nullable(),
    // optional so clients built before the breakdown keep compiling; always sent, null outside the host scope
    breakdown: AnalyticsVolumeBreakdownSchema.nullable().optional(),
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
    kind: z.enum(['model', 'other', 'unknown']).meta({ id: 'AnalyticsCameraKind' }),
    count: count(),
  })
  .meta({ id: 'AnalyticsCameraDto' });

const AnalyticsMetadataSchema = z
  .object({
    field: z
      .enum(['captureDate', 'location', 'cameraModel', 'aiDescription', 'checksum'])
      .meta({ id: 'AnalyticsMetadataField' }),
    present: count(),
    missing: count(),
    total: count(),
  })
  .meta({ id: 'AnalyticsMetadataDto' });

const AnalyticsViewSchema = z
  .object({
    view: z.enum(['timeline', 'favorites', 'archive', 'trash']).meta({ id: 'AnalyticsView' }),
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

// ── FL-79 insights: every partition adds up to summary.items (or summary.photos / summary.videos) ──

export const ANALYTICS_FOCAL_BUCKETS = [
  '0-16',
  '17-28',
  '29-40',
  '41-70',
  '71-135',
  '136-300',
  '301+',
  'unknown',
] as const;
export const ANALYTICS_PHOTO_FORMATS = ['HEIC', 'JPEG', 'RAW', 'PNG', 'OTHER'] as const;
export const ANALYTICS_VIDEO_RESOLUTIONS = ['4K', '1080p', '720p', 'SD', 'unknown'] as const;
export const ANALYTICS_ORIENTATIONS = ['landscape', 'portrait', 'square', 'panorama', 'unknown'] as const;

const AnalyticsNamedCountSchema = z
  .object({
    name: z.string().nullable().describe('Null for the other and unknown rows'),
    kind: z.enum(['named', 'other', 'unknown']).meta({ id: 'AnalyticsNamedCountKind' }),
    count: count(),
  })
  .meta({ id: 'AnalyticsNamedCountDto' });

const AnalyticsYearCountSchema = z.object({ year: z.int(), count: count() }).meta({ id: 'AnalyticsYearCountDto' });

const AnalyticsPunchcardCellSchema = z
  .object({
    weekday: z.int().min(1).max(7).describe('ISO weekday of the local capture time, 1 = Monday'),
    hour: z.int().min(0).max(23).describe('Hour of the local capture time'),
    count: count(),
  })
  .meta({ id: 'AnalyticsPunchcardCellDto' });

const bucketCount = <T extends readonly [string, ...string[]]>(values: T, id: string, description: string) =>
  z
    .object({ key: z.enum(values).meta({ id: `${id}Key` }), count: count() })
    .describe(description)
    .meta({ id });

const AnalyticsPersonCountSchema = z
  .object({ id: z.string().describe('Person id'), name: z.string(), count: count().describe('Items showing them') })
  .meta({ id: 'AnalyticsPersonCountDto' });

const AnalyticsPeopleAndPlacesSchema = z
  .object({
    faces: count().describe('Visible faces on the items'),
    itemsWithFaces: count(),
    itemsWithoutFaces: count().describe('itemsWithFaces plus itemsWithoutFaces is summary.items minus hiddenItems'),
    namedPeople: count().describe('Named, visible people of the owner seen on the items'),
    pets: count().describe("The owner's visible pets confirmed on the items"),
    topPeople: z
      .array(AnalyticsPersonCountSchema)
      .describe('Most photographed named people; overlapping, as one item can show several'),
    geotagged: count(),
    countries: count(),
    cities: count(),
    places: z.array(AnalyticsNamedCountSchema).describe('Items per city, then every other city, then no city'),
  })
  .describe("The owner's own people and places, only when the owner reads their own scope")
  .meta({ id: 'AnalyticsPeopleAndPlacesDto' });

const AnalyticsHdrSchema = z
  .object({
    probedVideos: count().describe('Videos whose stream metadata has been read; the only ones HDR can be told for'),
    hdrVideos: count().describe('PQ or HLG transfer, or Dolby Vision'),
    dolbyVisionVideos: count(),
  })
  .meta({ id: 'AnalyticsHdrDto' });

const AnalyticsRecordSchema = z
  .object({
    name: z.string().nullable().describe('File name; null unless the owner reads their own scope'),
  })
  .meta({ id: 'AnalyticsRecordDto' });

const AnalyticsRecordsSchema = z
  .object({
    oldestCapture: AnalyticsRecordSchema.extend({ date: day() }).meta({ id: 'AnalyticsOldestCaptureDto' }).nullable(),
    largestFile: AnalyticsRecordSchema.extend({ bytes: bytes() }).meta({ id: 'AnalyticsLargestFileDto' }).nullable(),
    longestVideo: AnalyticsRecordSchema.extend({ durationMs: count() })
      .meta({ id: 'AnalyticsLongestVideoDto' })
      .nullable(),
    videoDurationMs: count().describe('All videos together'),
    videoHours: z.number().meta({ format: 'double' }).min(0).describe('videoDurationMs in hours, one decimal'),
  })
  .meta({ id: 'AnalyticsRecordsDto' });

const AnalyticsCoverageSchema = z
  .object({
    facesChecked: count().describe('Items face detection has run on'),
    searchIndexed: count().describe('Items with a smart-search embedding'),
  })
  .describe('Out of summary.items minus hiddenItems')
  .meta({ id: 'AnalyticsCoverageDto' });

const AnalyticsInsightsSchema = z
  .object({
    hiddenItems: count().describe(
      'Items this session keeps hidden (Locked people and tags, sensitive content). They are left out of every breakdown here, which adds up to summary.items minus hiddenItems (summary.photos and summary.videos likewise)',
    ),
    capturesByYear: z.array(AnalyticsYearCountSchema).describe('Items per local capture year, all time'),
    punchcard: z
      .array(AnalyticsPunchcardCellSchema)
      .describe('All 168 weekday and hour cells of the local capture time'),
    lenses: z.array(AnalyticsNamedCountSchema).describe('Items per lens model, then every other lens, then no lens'),
    focalLengths: z
      .array(bucketCount(ANALYTICS_FOCAL_BUCKETS, 'AnalyticsFocalLengthDto', 'Items per recorded focal length (mm)'))
      .describe('Every bucket, in order; adds up to summary.items'),
    photoFormats: z
      .array(bucketCount(ANALYTICS_PHOTO_FORMATS, 'AnalyticsPhotoFormatDto', 'Photos per original file format'))
      .describe('Every format; adds up to summary.photos, and RAW equals summary.raw'),
    videoResolutions: z
      .array(bucketCount(ANALYTICS_VIDEO_RESOLUTIONS, 'AnalyticsVideoResolutionDto', 'Videos per resolution'))
      .describe('Every bucket; adds up to summary.videos'),
    orientation: z
      .array(bucketCount(ANALYTICS_ORIENTATIONS, 'AnalyticsOrientationDto', 'Items per displayed orientation'))
      .describe('Every bucket; adds up to summary.items. Panorama is 2:1 or wider'),
    livePhotos: count().describe('Photos with a Live Photo motion part'),
    hdr: AnalyticsHdrSchema.nullable().describe('Null when no video stream has been read, so HDR cannot be told'),
    coverage: AnalyticsCoverageSchema,
    peopleAndPlaces: AnalyticsPeopleAndPlacesSchema.nullable(),
    records: AnalyticsRecordsSchema,
  })
  .meta({ id: 'AnalyticsInsightsDto' });

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
    // always sent; optional in the schema so clients built before these insights keep compiling
    insights: AnalyticsInsightsSchema.optional().describe(
      'Dashboard breakdowns of the same items as summary. People, places and file names are only for the owner reading their own scope',
    ),
  })
  .meta({ id: 'AnalyticsReportResponseDto' });

export class AnalyticsQueryDto extends createZodDto(AnalyticsQuerySchema) {}
export class AnalyticsScopesResponseDto extends createZodDto(AnalyticsScopesResponseSchema) {}
export class AnalyticsReportResponseDto extends createZodDto(AnalyticsReportSchema) {}
export type AnalyticsScopeOption = z.infer<typeof AnalyticsScopeOptionSchema>;
export type AnalyticsSeriesDefinitionDto = z.infer<typeof AnalyticsSeriesDefinitionSchema>;
export type AnalyticsBucketDto = z.infer<typeof AnalyticsBucketSchema>;
export type AnalyticsInsightsDto = z.infer<typeof AnalyticsInsightsSchema>;
export type AnalyticsVolumeBreakdownDto = z.infer<typeof AnalyticsVolumeBreakdownSchema>;

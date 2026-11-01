import { DateTime } from 'luxon';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { BBoxSchema } from 'src/dtos/bbox.dto.js';
import { BEST_PHOTOS_MIN_SCORE } from 'src/dtos/best-photos.dto.js';
import { SearchFilterSchema } from 'src/dtos/search.dto.js';
import {
  AssetLockReason,
  AssetLockReasonSchema,
  AssetOrderBySchema,
  AssetOrderSchema,
  AssetTypeSchema,
  AssetVisibilitySchema,
  ImageEnrichmentFilterSchema,
  LibraryViewScopeSchema,
  TimeBucketDateTypeSchema,
} from 'src/enum.js';
import { stringToBool } from 'src/validation.js';

export const TIMELINE_HIGHLIGHT_DEFAULT = 4;
export const TIMELINE_HIGHLIGHT_MAX = 12;
/** FL-425: the longest JSON-encoded search filter a timeline request may carry */
export const TIMELINE_FILTER_MAX_LENGTH = 16_384;

const TimeBucketQueryBaseSchema = z
  .object({
    libraryScope: LibraryViewScopeSchema.optional(),
    userId: z.uuidv4().optional().describe('Filter assets by specific user ID'),
    albumId: z.uuidv4().optional().describe('Filter assets belonging to a specific album'),
    assetType: AssetTypeSchema.optional().describe('Filter assets by media type'),
    personId: z.uuidv4().optional().describe('Filter assets containing a specific person (face recognition)'),
    petId: z.uuidv4().optional().describe('Filter assets in which the caller confirmed one of their own pets'),
    tagId: z.uuidv4().optional().describe('Filter assets with a specific tag'),
    withChildTags: stringToBool
      .optional()
      .describe(
        'With tagId: also match assets tagged with a tag inside it. Defaults to true; false matches only assets tagged with this tag itself.',
      ),
    bestPhotos: stringToBool
      .optional()
      .describe(
        `Only your own Best Photos: your own images and videos with a Best Photos score of at least ${BEST_PHOTOS_MIN_SCORE}. Always scoped to your own library; not available through a shared link or with visibility LOCKED`,
      ),
    isFavorite: stringToBool
      .optional()
      .describe('Filter by favorite status (true for favorites only, false for non-favorites only)'),
    isTrashed: stringToBool
      .optional()
      .describe('Filter by trash status (true for trashed assets only, false for non-trashed only)'),
    withStacked: stringToBool
      .optional()
      .describe('Include stacked assets in the response. When true, only primary assets from stacks are returned.'),
    order: AssetOrderSchema.optional().describe(
      'Sort order for assets within time buckets (ASC for oldest first, DESC for newest first)',
    ),
    dateType: TimeBucketDateTypeSchema.optional().describe(
      'Date source for timeline bucket grouping. Defaults to taken date.',
    ),
    suppressedOnly: stringToBool.optional().describe('Return only suppressed content. Requires an elevated session.'),
    orderBy: AssetOrderBySchema.optional().describe(
      'Date to group and order assets by (takenAt for date taken, createdAt for date added to Frameleaf)',
    ),
    visibility: AssetVisibilitySchema.optional().describe(
      'Filter by asset visibility status (ARCHIVE, TIMELINE, HIDDEN, LOCKED)',
    ),
    lockReason: z
      .union([
        AssetLockReasonSchema,
        z.literal('immich-locked-folder').transform(() => AssetLockReason.FrameleafLockedFolder),
      ])
      .optional()
      .describe(
        'With visibility LOCKED only: return only assets locked for this reason. Requires an elevated session.',
      ),
    withCoordinates: stringToBool.optional().describe('Include location data in the response'),
    filter: z
      .string()
      .max(TIMELINE_FILTER_MAX_LENGTH)
      .transform((value, ctx): unknown => {
        try {
          return JSON.parse(value);
        } catch {
          ctx.issues.push({ code: 'custom', message: 'filter must be a JSON-encoded SearchFilter', input: value });
          return z.NEVER;
        }
      })
      .pipe(SearchFilterSchema)
      .optional()
      .describe(
        'A SearchFilter, JSON-encoded: the structured filter POST /search/metadata takes in `filter`, with the same meaning (dates, places, cameras, rating, people, pets, tags, albums, media type, favourites, statuses and `or` branches). It only narrows what this timeline may show: its own owner, album, visibility and Locked rules still apply. Its top-level personIds, like personId, also include those people in albums shared with the viewer. Neither it nor imageEnrichment is available through a shared link',
      )
      .meta({ example: '{"make":{"eq":"Canon"},"rating":{"gte":4}}' }),
    imageEnrichment: ImageEnrichmentFilterSchema.optional(),
    key: z.string().optional(),
    slug: z.string().optional(),
    bbox: z
      .string()
      .transform((value, ctx) => {
        const parts = value.split(',');
        if (parts.length !== 4) {
          ctx.issues.push({
            code: 'custom',
            message: 'bbox must have 4 comma-separated numbers: west,south,east,north',
            input: value,
          });
          return z.NEVER;
        }

        const [west, south, east, north] = parts.map(Number);
        if (parts.some((part) => part.trim() === '') || [west, south, east, north].some((part) => Number.isNaN(part))) {
          ctx.issues.push({
            code: 'custom',
            message: 'bbox parts must be valid numbers',
            input: value,
          });
          return z.NEVER;
        }

        return { west, south, east, north };
      })
      .pipe(BBoxSchema)
      .optional()
      .describe('Bounding box coordinates as west,south,east,north (WGS84)')
      .meta({ example: '11.075683,49.416711,11.117589,49.454875' }),
  })
  .meta({ id: 'TimeBucketDto' });

export const TIMELINE_CALENDAR_MAX_TAKE = 1000;
export const TIMELINE_CALENDAR_MIN_PAGE_SIZE = 100;
const TimeBucketSchema = TimeBucketQueryBaseSchema.extend({
  pageSize: z.coerce
    .number()
    .int()
    .min(TIMELINE_CALENDAR_MIN_PAGE_SIZE)
    .max(TIMELINE_CALENDAR_MAX_TAKE)
    .optional()
    .describe('Return bounded calendar-page summaries instead of whole-month counts'),
  locateAssetId: z
    .uuid()
    .optional()
    .describe('Return only the page containing this accessible asset; requires pageSize'),
  sort: z
    .enum(['filename', 'rating', 'quality'])
    .optional()
    .describe(
      'Locate an asset in this flat timeline order; requires locateAssetId and pageSize. Retrieve the result with GET /timeline/ordered using skip = page * pageSize and take = pageSize, with the same sort and filters',
    ),
})
  .refine((value) => value.pageSize !== undefined || !value.locateAssetId, 'Asset lookup requires pageSize')
  .refine((value) => !value.sort || !!value.locateAssetId, 'Sorted lookup requires locateAssetId')
  .meta({ id: 'TimeBucketDto' });
const TimeBucketAssetSchema = TimeBucketQueryBaseSchema.extend({
  take: z.coerce
    .number()
    .int()
    .min(1)
    .max(TIMELINE_CALENDAR_MAX_TAKE)
    .optional()
    .describe('Maximum assets in a calendar page; omit for the legacy complete bucket'),
  after: z
    .uuid()
    .optional()
    .describe('Read after this calendar-page asset ID; requires take and cannot be combined with before'),
  before: z
    .uuid()
    .optional()
    .describe('Read before this calendar-page asset ID; requires take and cannot be combined with after'),
  firstAssetId: z
    .uuid()
    .optional()
    .describe(
      'Expected first asset from the page summary; requires take = summary.count and the same filters. A boundary or page-length mismatch returns 409; interior replacements with unchanged boundaries and length are not detected',
    ),
  lastAssetId: z
    .uuid()
    .optional()
    .describe(
      'Expected last asset from the page summary; requires take = summary.count and the same filters. A boundary or page-length mismatch returns 409; interior replacements with unchanged boundaries and length are not detected',
    ),
  membershipAlbumId: z
    .uuid()
    .optional()
    .describe('Include membership in this readable album for each page asset; requires take'),
  timeBucket: z
    .string()
    .refine(
      (value) =>
        /^[+-]?\d{4,6}-\d{2}-\d{2}(?:T.*)?$/.test(value) &&
        DateTime.fromISO(
          value.replace(/^([+-]?)(\d{5,6})-/, (_match, sign, year) => `${sign || '+'}${year.padStart(6, '0')}-`),
        ).isValid,
      'Invalid time bucket format',
    )
    .describe('Time bucket identifier in YYYY-MM-DDT00:00:00.000Z format')
    .meta({ example: '2024-01-01T00:00:00.000Z' }),
})
  .refine((value) => !(value.after && value.before), 'Use either after or before, not both')
  .refine(
    (value) =>
      value.take !== undefined ||
      (!value.after && !value.before && !value.firstAssetId && !value.lastAssetId && !value.membershipAlbumId),
    'Calendar page options require take',
  )
  .meta({ id: 'TimeBucketAssetDto' });

/** FL-30 (S-15): one page of the timeline in a flat order the time buckets cannot give. */
export const TIMELINE_ORDERED_MAX_TAKE = 1000;
const TimelineOrderedSchema = TimeBucketQueryBaseSchema.extend({
  sort: z
    .enum(['filename', 'rating', 'quality'])
    .describe(
      'filename: by original file name (locale-aware), then newest capture; rating: highest star rating first (unrated counts as 0), then newest capture; quality: highest Best Photos score first (assets without a score of yours last), then newest capture. Use quality with bestPhotos=true',
    )
    .meta({ id: 'TimelineOrderedSort' }),
  after: z.string().max(8192).optional().describe('Continue after the previous ordered page cursor; overrides skip'),
  before: z.string().max(8192).optional().describe('Read the page before this ordered cursor; overrides skip'),
  skip: z.coerce.number().int().min(0).default(0).describe('Items to skip when no cursor is supplied'),
  take: z.coerce
    .number()
    .int()
    .min(1)
    .max(TIMELINE_ORDERED_MAX_TAKE)
    .default(500)
    .describe(`Items to return (at most ${TIMELINE_ORDERED_MAX_TAKE})`),
}).meta({ id: 'TimelineOrderedDto' });

const stackTupleSchema = z.array(z.string()).length(2).nullable();

const TimeBucketAssetResponseSchema = z
  .object({
    id: z.array(z.string()).describe('Array of asset IDs in the time bucket'),
    inAlbum: z.array(z.boolean()).optional().describe('Membership in the requested readable album, aligned with id'),
    startCursor: z
      .string()
      .nullable()
      .optional()
      .describe('First page cursor; a calendar asset ID or an ordered cursor'),
    endCursor: z.string().nullable().optional().describe('Last page cursor; a calendar asset ID or an ordered cursor'),
    ownerId: z.array(z.string()).describe('Array of owner IDs for each asset'),
    ratio: z
      .array(z.number().meta({ format: 'double' }))
      .describe('Array of aspect ratios (width/height) for each asset'),
    isFavorite: z.array(z.boolean()).describe('Array indicating whether each asset is favorited'),
    visibility: z
      .array(AssetVisibilitySchema)
      .describe('Array of visibility statuses for each asset (e.g., ARCHIVE, TIMELINE, HIDDEN, LOCKED)'),
    isTrashed: z.array(z.boolean()).describe('Array indicating whether each asset is in the trash'),
    isOffline: z
      .array(z.boolean())
      .optional()
      .describe('Array indicating whether each asset is offline (its file is missing from an external library)'),
    isImage: z.array(z.boolean()).describe('Array indicating whether each asset is an image (false for videos)'),
    thumbhash: z
      .array(z.string().nullable())
      .describe('Array of BlurHash strings for generating asset previews (base64 encoded)'),
    createdAt: z
      .array(z.string())
      .describe('Array of UTC timestamps when each asset was originally uploaded to Frameleaf'),
    fileCreatedAt: z.array(z.string()).describe('Array of file creation timestamps in UTC'),
    localOffsetHours: z
      .array(z.number().meta({ format: 'double' }))
      .describe(
        "Array of UTC offset hours at the time each photo was taken. Positive values are east of UTC, negative values are west of UTC. Values may be fractional (e.g., 5.5 for +05:30, -9.75 for -09:45). Applying this offset to 'fileCreatedAt' will give you the time the photo was taken from the photographer's perspective.",
      ),
    duration: z
      .array(z.int32().min(0).nullable())
      .describe('Array of video/gif durations in milliseconds (null for static images)'),
    stack: z
      .array(stackTupleSchema)
      .optional()
      .describe('Array of stack information as [stackId, assetCount] tuples (null for non-stacked assets)'),
    projectionType: z
      .array(z.string().nullable())
      .describe('Array of projection types for 360° content (e.g., "EQUIRECTANGULAR", "CUBEFACE", "CYLINDRICAL")'),
    livePhotoVideoId: z
      .array(z.string().nullable())
      .describe('Array of live photo video asset IDs (null for non-live photos)'),
    lockReason: z
      .array(AssetLockReasonSchema.nullable())
      .optional()
      .describe(
        'Why each asset is locked, or null when it is not. Returned with visibility LOCKED and for the timeline of an elevated owner, which reveals their marked and detected items',
      ),
    rating: z
      .array(z.int32().min(-1).max(5).nullable())
      .optional()
      .describe(
        'Array of star ratings from EXIF (-1 rejected, 0 unrated, 1-5 stars; null when unknown). Omitted for shared links that hide EXIF',
      ),
    originalFileName: z
      .array(z.string())
      .optional()
      .describe('Array of original file names. Omitted for shared links that hide EXIF'),
    width: z
      .array(z.int32().nullable())
      .optional()
      .describe('Array of widths in pixels (null when unknown). Omitted for shared links that hide EXIF'),
    height: z
      .array(z.int32().nullable())
      .optional()
      .describe('Array of heights in pixels (null when unknown). Omitted for shared links that hide EXIF'),
    fileSizeInByte: z
      .array(z.int().nullable())
      .optional()
      .describe('Array of file sizes in bytes (null when unknown). Omitted for shared links that hide EXIF'),
    city: z.array(z.string().nullable()).optional().describe('Array of city names extracted from EXIF GPS data'),
    country: z.array(z.string().nullable()).optional().describe('Array of country names extracted from EXIF GPS data'),
    latitude: z
      .array(z.number().meta({ format: 'double' }).nullable())
      .optional()
      .describe('Array of latitude coordinates extracted from EXIF GPS data'),
    longitude: z
      .array(z.number().meta({ format: 'double' }).nullable())
      .optional()
      .describe('Array of longitude coordinates extracted from EXIF GPS data'),
  })
  .meta({ id: 'TimeBucketAssetResponseDto' });

const TimeBucketsResponseSchema = z
  .object({
    timeBucket: z
      .string()
      .describe(
        'Start of the calendar period in YYYY-MM-DD format; sorted asset lookups return the synthetic value 1970-01-01',
      )
      .meta({ example: '2024-01-01' }),
    count: z
      .int()
      .describe(
        'Number of assets in this calendar page when pageSize is supplied, or in the whole bucket otherwise. Sorted asset lookups return the located page’s asset count',
      )
      .meta({ example: 42 }),
    page: z
      .int()
      .min(0)
      .optional()
      .describe(
        'Zero-based page within this calendar month; for sorted asset lookups, the page in the flat sorted timeline, retrieved through GET /timeline/ordered with skip = page * pageSize and take = pageSize, with the same sort and filters',
      ),
    after: z.uuid().nullable().optional().describe('Opaque anchor immediately before this page'),
    firstAssetId: z.uuid().optional().describe('First asset in the page snapshot'),
    lastAssetId: z.uuid().optional().describe('Last asset in the page snapshot'),
    days: z
      .array(z.object({ day: z.int().min(1).max(31), count: z.int().min(1) }))
      .optional()
      .describe('Whole-day counts for the calendar days represented in this page'),
  })
  .meta({ id: 'TimeBucketsResponseDto' });

/** FL-33: the curated Years and Months timeline (`timeline-highlights.mjs` in the design reference) */
const TimelineHighlightsSchema = TimeBucketQueryBaseSchema.extend({
  grouping: z
    .enum(['year', 'month'])
    .default('month')
    .describe('One card per year or per month')
    .meta({ id: 'TimelineHighlightGrouping' }),
  highlightCount: z.coerce
    .number()
    .int()
    .min(0)
    .max(TIMELINE_HIGHLIGHT_MAX)
    .optional()
    .describe(
      `Highlights besides the key photo for each month card (default ${TIMELINE_HIGHLIGHT_DEFAULT}). Year cards carry none`,
    ),
}).meta({ id: 'TimelineHighlightsDto' });

const TimelineHighlightResponseSchema = z
  .object({
    timeBucket: z
      .string()
      .describe('First day of the year or month in YYYY-MM-DD format, as in GET /timeline/buckets')
      .meta({ example: '2024-01-01' }),
    count: z.int().min(0).describe('Number of assets in this year or month, the same as the time buckets report'),
    keyAssetId: z
      .string()
      .nullable()
      .describe('Key photo: highest Best Photos score, then highest star rating, then most recent capture'),
    highlightAssetIds: z
      .array(z.string())
      .describe('The next best assets in capture order (month cards only), never including the key photo'),
    places: z
      .array(z.string())
      .describe(
        'Up to three most frequent places (city, else state, else country), busiest first. Empty when the viewer may not see locations',
      ),
  })
  .meta({ id: 'TimelineHighlightResponseDto' });

export class TimeBucketDto extends createZodDto(TimeBucketSchema) {}
export class TimeBucketAssetDto extends createZodDto(TimeBucketAssetSchema) {}
export class TimelineOrderedDto extends createZodDto(TimelineOrderedSchema) {}
export class TimeBucketAssetResponseDto extends createZodDto(TimeBucketAssetResponseSchema) {}
export class TimeBucketsResponseDto extends createZodDto(TimeBucketsResponseSchema) {}
export class TimelineHighlightsDto extends createZodDto(TimelineHighlightsSchema) {}
export class TimelineHighlightResponseDto extends createZodDto(TimelineHighlightResponseSchema) {}

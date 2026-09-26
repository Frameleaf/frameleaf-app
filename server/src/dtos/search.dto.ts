import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { Place } from 'src/database.js';
import { HistoryBuilder } from 'src/decorators.js';
import { AlbumResponseSchema } from 'src/dtos/album.dto.js';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';
import {
  AssetOrder,
  AssetOrderSchema,
  AssetTypeSchema,
  AssetVisibilitySchema,
  ImageEnrichmentFilterSchema,
  SearchOrderField,
  SearchOrderFieldSchema,
} from 'src/enum.js';
import { isoDatetimeToDate, nonEmptyPartial, stringToBool } from 'src/validation.js';

const ADDED_V3_2 = new HistoryBuilder().added('v3.2.0').getExtensions();

// fields deprecated in favor of the structured filter tree
const DEPRECATED_FLAT_FIELD = {
  ...new HistoryBuilder().added('v1').stable('v2').deprecated('v3.2.0').getExtensions(),
  deprecated: true,
};

/**
 * FL-58: the flat `petIds` twin of `personIds`. It arrives after the structured filter, so it is born
 * deprecated in favour of `filter.petIds`; being marked deprecated is also what makes
 * `withShapeExclusivity` reject it next to `filter`, exactly as it rejects `personIds`.
 */
const FLAT_PET_IDS_FIELD = {
  ...new HistoryBuilder().added('v3.2.0').deprecated('v3.2.0').getExtensions(),
  deprecated: true,
};

const BaseSearchSchema = z.object({
  imageEnrichment: ImageEnrichmentFilterSchema.optional(),
  suppressedOnly: z.boolean().optional().describe('Return only suppressed content. Requires an elevated session.'),
  libraryId: z.uuidv4().nullish().describe('Library ID to filter by').meta(DEPRECATED_FLAT_FIELD),
  type: AssetTypeSchema.optional().meta(DEPRECATED_FLAT_FIELD),
  isEncoded: z.boolean().optional().describe('Filter by encoded status').meta(DEPRECATED_FLAT_FIELD),
  isFavorite: z.boolean().optional().describe('Filter by favorite status').meta(DEPRECATED_FLAT_FIELD),
  isMotion: z.boolean().optional().describe('Filter by motion photo status').meta(DEPRECATED_FLAT_FIELD),
  isOffline: z.boolean().optional().describe('Filter by offline status').meta(DEPRECATED_FLAT_FIELD),
  visibility: AssetVisibilitySchema.optional().meta(DEPRECATED_FLAT_FIELD),
  createdBefore: isoDatetimeToDate.optional().describe('Filter by creation date (before)').meta(DEPRECATED_FLAT_FIELD),
  createdAfter: isoDatetimeToDate.optional().describe('Filter by creation date (after)').meta(DEPRECATED_FLAT_FIELD),
  updatedBefore: isoDatetimeToDate.optional().describe('Filter by update date (before)').meta(DEPRECATED_FLAT_FIELD),
  updatedAfter: isoDatetimeToDate.optional().describe('Filter by update date (after)').meta(DEPRECATED_FLAT_FIELD),
  trashedBefore: isoDatetimeToDate.optional().describe('Filter by trash date (before)').meta(DEPRECATED_FLAT_FIELD),
  trashedAfter: isoDatetimeToDate.optional().describe('Filter by trash date (after)').meta(DEPRECATED_FLAT_FIELD),
  takenBefore: isoDatetimeToDate.optional().describe('Filter by taken date (before)').meta(DEPRECATED_FLAT_FIELD),
  takenAfter: isoDatetimeToDate.optional().describe('Filter by taken date (after)').meta(DEPRECATED_FLAT_FIELD),
  city: z.string().nullable().optional().describe('Filter by city name').meta(DEPRECATED_FLAT_FIELD),
  state: z.string().nullable().optional().describe('Filter by state/province name').meta(DEPRECATED_FLAT_FIELD),
  country: z.string().nullable().optional().describe('Filter by country name').meta(DEPRECATED_FLAT_FIELD),
  make: z.string().nullable().optional().describe('Filter by camera make').meta(DEPRECATED_FLAT_FIELD),
  model: z.string().nullable().optional().describe('Filter by camera model').meta(DEPRECATED_FLAT_FIELD),
  lensModel: z.string().nullable().optional().describe('Filter by lens model').meta(DEPRECATED_FLAT_FIELD),
  isNotInAlbum: z.boolean().optional().describe('Filter assets not in any album').meta(DEPRECATED_FLAT_FIELD),
  personIds: z.array(z.uuidv4()).optional().describe('Filter by person IDs').meta(DEPRECATED_FLAT_FIELD),
  petIds: z
    .array(z.uuidv4())
    .optional()
    .describe("Filter by the caller's own pet IDs (confirmed pet observations only)")
    .meta(FLAT_PET_IDS_FIELD),
  tagIds: z.array(z.uuidv4()).nullish().describe('Filter by tag IDs').meta(DEPRECATED_FLAT_FIELD),
  albumIds: z.array(z.uuidv4()).optional().describe('Filter by album IDs').meta(DEPRECATED_FLAT_FIELD),
  rating: z
    .int()
    .min(1)
    .max(5)
    .nullish()
    .describe('Filter by rating [1-5], or null for unrated')
    .meta({
      ...new HistoryBuilder()
        .added('v1')
        .stable('v2')
        .updated('v2.6.0', 'Using -1 as a rating is deprecated and will be removed in the next major version.')
        .updated('v3', 'Using -1 as a rating is no longer valid.')
        .deprecated('v3.2.0')
        .getExtensions(),
      deprecated: true,
    }),
  ocr: z.string().optional().describe('Filter by OCR text content').meta(DEPRECATED_FLAT_FIELD),
});

const BaseSearchWithResultsSchema = BaseSearchSchema.extend({
  withDeleted: z.boolean().optional().describe('Include deleted assets').meta(DEPRECATED_FLAT_FIELD),
  withExif: z.boolean().optional().describe('Include EXIF data in response'),
  size: z.int().min(1).max(1000).optional().describe('Number of results to return'),
});

const LargeAssetSearchSchema = BaseSearchWithResultsSchema.extend({
  minFileSize: z.coerce.number().int().min(0).optional().describe('Minimum file size in bytes'),
  size: z.coerce.number().int().min(1).max(1000).optional().describe('Number of results to return'),
}).meta({ id: 'LargeAssetSearchDto' });

const SearchPlacesSchema = z
  .object({
    name: z.string().describe('Place name to search for'),
  })
  .meta({ id: 'SearchPlacesDto' });

const SearchPeopleSchema = z
  .object({
    name: z.string().describe('Person name to search for'),
    withHidden: stringToBool.optional().describe('Include hidden people'),
  })
  .meta({ id: 'SearchPeopleDto' });

const PlacesResponseSchema = z
  .object({
    name: z.string().describe('Place name'),
    latitude: z.number().meta({ format: 'double' }).describe('Latitude coordinate'),
    longitude: z.number().meta({ format: 'double' }).describe('Longitude coordinate'),
    admin1name: z.string().optional().describe('Administrative level 1 name (state/province)'),
    admin2name: z.string().optional().describe('Administrative level 2 name (county/district)'),
  })
  .meta({ id: 'PlacesResponseDto' });

const SearchCityCountResponseSchema = z
  .object({
    city: z.string().describe('City name, grouped as in GET /search/cities (which lists only cities with a photo)'),
    count: z.int().min(1).describe('Number of timeline photos and videos in this city'),
  })
  .meta({ id: 'SearchCityCountResponseDto' });

export enum SearchSuggestionType {
  COUNTRY = 'country',
  STATE = 'state',
  CITY = 'city',
  CAMERA_MAKE = 'camera-make',
  CAMERA_MODEL = 'camera-model',
  CAMERA_LENS_MODEL = 'camera-lens-model',
}

const SearchSuggestionTypeSchema = z
  .enum(SearchSuggestionType)
  .describe('Suggestion type')
  .meta({ id: 'SearchSuggestionType' });

const SearchSuggestionRequestSchema = z
  .object({
    type: SearchSuggestionTypeSchema,
    country: z.string().optional().describe('Filter by country'),
    state: z.string().optional().describe('Filter by state/province'),
    make: z.string().optional().describe('Filter by camera make'),
    model: z.string().optional().describe('Filter by camera model'),
    lensModel: z.string().optional().describe('Filter by lens model'),
    includeNull: stringToBool
      .optional()
      .describe('Include null values in suggestions')
      .meta(new HistoryBuilder().added('v1.111.0').stable('v2').getExtensions()),
  })
  .meta({ id: 'SearchSuggestionRequestDto' });

const IdFilterSchema = nonEmptyPartial({
  eq: z.uuidv4(),
  ne: z.uuidv4(),
}).meta({ id: 'IdFilter' });

const IdFilterNullableSchema = nonEmptyPartial({
  eq: z.uuidv4().nullable(),
  ne: z.uuidv4().nullable(),
}).meta({ id: 'IdFilterNullable' });

const IdsFilterSchema = nonEmptyPartial({
  any: z.array(z.uuidv4()).min(1),
  all: z.array(z.uuidv4()).min(1),
  none: z.array(z.uuidv4()).min(1),
}).meta({ id: 'IdsFilter' });

const stringListShape = {
  in: z.array(z.string()).min(1),
  notIn: z.array(z.string()).min(1),
};

const StringFilterSchema = nonEmptyPartial({
  eq: z.string(),
  ne: z.string(),
  ...stringListShape,
}).meta({ id: 'StringFilter' });

const stringNullableShape = {
  eq: z.string().nullable(),
  ne: z.string().nullable(),
  ...stringListShape,
};

const StringFilterNullableSchema = nonEmptyPartial(stringNullableShape).meta({ id: 'StringFilterNullable' });

const StringPatternFilterSchema = nonEmptyPartial({
  ...stringNullableShape,
  like: z.string().min(1),
  notLike: z.string().min(1),
  startsWith: z.string().min(1),
  endsWith: z.string().min(1),
}).meta({ id: 'StringPatternFilter' });

const numberRangeShape = {
  lt: z.number().meta({ format: 'double' }),
  lte: z.number().meta({ format: 'double' }),
  gt: z.number().meta({ format: 'double' }),
  gte: z.number().meta({ format: 'double' }),
  in: z.array(z.number().meta({ format: 'double' })).min(1),
  notIn: z.array(z.number().meta({ format: 'double' })).min(1),
};

const NumberFilterSchema = nonEmptyPartial({
  eq: z.number().meta({ format: 'double' }),
  ne: z.number().meta({ format: 'double' }),
  ...numberRangeShape,
}).meta({ id: 'NumberFilter' });

const NumberFilterNullableSchema = nonEmptyPartial({
  eq: z.number().meta({ format: 'double' }).nullable(),
  ne: z.number().meta({ format: 'double' }).nullable(),
  ...numberRangeShape,
}).meta({ id: 'NumberFilterNullable' });

const dateRangeShape = {
  gt: isoDatetimeToDate,
  gte: isoDatetimeToDate,
  lt: isoDatetimeToDate,
  lte: isoDatetimeToDate,
};

const DateFilterSchema = nonEmptyPartial({
  eq: isoDatetimeToDate,
  ne: isoDatetimeToDate,
  ...dateRangeShape,
}).meta({ id: 'DateFilter' });

const DateFilterNullableSchema = nonEmptyPartial({
  eq: isoDatetimeToDate.nullable(),
  ne: isoDatetimeToDate.nullable(),
  ...dateRangeShape,
}).meta({ id: 'DateFilterNullable' });

const BoolFilterSchema = z.object({ eq: z.boolean() }).meta({ id: 'BoolFilter' });

const enumFilterSchema = <T extends z.core.util.EnumLike>(values: z.ZodEnum<T>, id: string) =>
  nonEmptyPartial({
    eq: values,
    ne: values,
    in: z.array(values).min(1),
    notIn: z.array(values).min(1),
  }).meta({ id });

const EnumFilterAssetTypeSchema = enumFilterSchema(AssetTypeSchema, 'EnumFilterAssetType');
const EnumFilterAssetVisibilitySchema = enumFilterSchema(AssetVisibilitySchema, 'EnumFilterAssetVisibility');

const StringSimilarityFilterSchema = z
  .object({
    matches: z.string().min(1),
  })
  .meta({ id: 'StringSimilarityFilter' });

export const DEFAULT_SEARCH_ORDER = {
  field: SearchOrderField.FileCreatedAt,
  direction: AssetOrder.Desc,
};

export const SearchOrderSchema = z
  .object({
    field: SearchOrderFieldSchema.default(DEFAULT_SEARCH_ORDER.field),
    direction: AssetOrderSchema.default(DEFAULT_SEARCH_ORDER.direction),
  })
  .meta({ id: 'SearchOrder' });

const searchFilterBranchShape = {
  id: IdFilterSchema,
  libraryId: IdFilterNullableSchema,
  type: EnumFilterAssetTypeSchema,
  visibility: EnumFilterAssetVisibilitySchema,
  isFavorite: BoolFilterSchema,
  isMotion: BoolFilterSchema,
  isOffline: BoolFilterSchema,
  isEncoded: BoolFilterSchema,
  hasAlbums: BoolFilterSchema,
  hasPeople: BoolFilterSchema,
  hasTags: BoolFilterSchema,
  city: StringFilterNullableSchema,
  state: StringFilterNullableSchema,
  country: StringFilterNullableSchema,
  // FL-49: cameras and lenses also match "contains" (like/notLike), as the search palette's camera: and lens: do
  make: StringPatternFilterSchema,
  model: StringPatternFilterSchema,
  lensModel: StringPatternFilterSchema,
  description: StringPatternFilterSchema,
  originalFileName: StringPatternFilterSchema,
  originalPath: StringPatternFilterSchema,
  ocr: StringSimilarityFilterSchema,
  rating: NumberFilterNullableSchema,
  fileSizeInBytes: NumberFilterSchema,
  takenAt: DateFilterSchema,
  // FL-49: the local capture date and time (the wall clock where the photo was taken, written as UTC), the
  // date the timeline and the search histogram bucket by; year:, month:, after: and before: narrow on it
  localDateTime: DateFilterSchema,
  createdAt: DateFilterSchema,
  updatedAt: DateFilterSchema,
  trashedAt: DateFilterNullableSchema,
  personIds: IdsFilterSchema,
  // FL-58: matches the caller's own confirmed pet observations; another account's pet id matches nothing
  petIds: IdsFilterSchema,
  tagIds: IdsFilterSchema,
  albumIds: IdsFilterSchema,
  checksum: StringFilterSchema,
  encodedVideoPath: StringFilterSchema,
};

const SearchFilterBranchSchema = z
  .strictObject(searchFilterBranchShape)
  .partial()
  .refine((branch) => Object.values(branch).some((value) => value !== undefined), {
    message: 'At least one filter condition is required',
  })
  .meta({ id: 'SearchFilterBranch' });

export const SearchFilterSchema = z
  .strictObject(searchFilterBranchShape)
  .partial()
  .extend({
    or: z.array(SearchFilterBranchSchema).min(1).optional(),
  })
  .meta({ id: 'SearchFilter' });

export type IdFilter = z.infer<typeof IdFilterSchema>;
export type IdFilterNullable = z.infer<typeof IdFilterNullableSchema>;
export type IdsFilter = z.infer<typeof IdsFilterSchema>;
export type StringFilter = z.infer<typeof StringFilterSchema>;
export type StringFilterNullable = z.infer<typeof StringFilterNullableSchema>;
export type StringPatternFilter = z.infer<typeof StringPatternFilterSchema>;
export type NumberFilter = z.infer<typeof NumberFilterSchema>;
export type NumberFilterNullable = z.infer<typeof NumberFilterNullableSchema>;
export type DateFilter = z.infer<typeof DateFilterSchema>;
export type DateFilterNullable = z.infer<typeof DateFilterNullableSchema>;
export type SearchOrder = z.infer<typeof SearchOrderSchema>;
export type SearchFilter = z.infer<typeof SearchFilterSchema>;
export type SearchFilterBranch = z.infer<typeof SearchFilterBranchSchema>;

const NEW_SHAPE_FIELDS = ['filter', 'orderBy', 'cursor'] as const;

export const isNewShapeRequest = (dto: Partial<Record<(typeof NEW_SHAPE_FIELDS)[number], unknown>>): boolean =>
  NEW_SHAPE_FIELDS.some((field) => dto[field] !== undefined);

/** Whether every asset the branch can match is provably inside an (access-checked) album */
export const isAlbumConfined = (branch: SearchFilterBranch): boolean =>
  branch.albumIds?.any !== undefined || branch.albumIds?.all !== undefined;

/** Whether every result of the whole filter is album-confined */
export const isFullyAlbumConfined = (filter: SearchFilter): boolean =>
  isAlbumConfined(filter) || (!!filter.or?.length && filter.or.every((branch) => isAlbumConfined(branch)));

/**
 * The structured shape and the deprecated flat search fields are mutually exclusive
 * TODO(v4): remove together with the deprecated flat fields.
 */
const withShapeExclusivity = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) => {
  const deprecatedFields = Object.keys(schema.shape).filter(
    (field) => (schema.shape[field] as z.ZodType).meta()?.deprecated,
  );

  return schema.superRefine((dto, ctx) => {
    const values = dto as Record<string, unknown>;
    const newShapeFields = NEW_SHAPE_FIELDS.filter((field) => values[field] !== undefined);
    if (newShapeFields.length === 0) {
      return;
    }

    for (const field of deprecatedFields) {
      if (values[field] === undefined) {
        continue;
      }

      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `Deprecated field ${field} cannot be combined with ${newShapeFields.join('/')}`,
      });
    }
  });
};

const filterField = SearchFilterSchema.optional().meta(ADDED_V3_2);
const cursorField = z.string().min(1).optional().describe('Cursor for the next page of results').meta(ADDED_V3_2);

const RandomSearchBaseSchema = BaseSearchWithResultsSchema.extend({
  withStacked: z.boolean().optional().describe('Include stacked assets'),
  withPeople: z.boolean().optional().describe('Include people data in response'),
  filter: filterField,
});

const RandomSearchSchema = withShapeExclusivity(RandomSearchBaseSchema).meta({ id: 'RandomSearchDto' });

const MetadataSearchSchema = withShapeExclusivity(
  RandomSearchBaseSchema.extend({
    id: z.uuidv4().optional().describe('Filter by asset ID').meta(DEPRECATED_FLAT_FIELD),
    description: z.string().trim().optional().describe('Filter by description text').meta(DEPRECATED_FLAT_FIELD),
    checksum: z.string().optional().describe('Filter by file checksum').meta(DEPRECATED_FLAT_FIELD),
    originalFileName: z.string().trim().optional().describe('Filter by original file name').meta(DEPRECATED_FLAT_FIELD),
    originalPath: z.string().optional().describe('Filter by original file path').meta(DEPRECATED_FLAT_FIELD),
    previewPath: z.string().optional().describe('Filter by preview file path').meta(DEPRECATED_FLAT_FIELD),
    thumbnailPath: z.string().optional().describe('Filter by thumbnail file path').meta(DEPRECATED_FLAT_FIELD),
    encodedVideoPath: z.string().optional().describe('Filter by encoded video file path').meta(DEPRECATED_FLAT_FIELD),
    order: AssetOrderSchema.optional().describe('Sort order').meta(DEPRECATED_FLAT_FIELD),
    page: z.int().min(1).optional().describe('Page number').meta(DEPRECATED_FLAT_FIELD),
    orderBy: SearchOrderSchema.optional().meta(ADDED_V3_2),
    cursor: cursorField,
  }),
).meta({ id: 'MetadataSearchDto' });

const StatisticsSearchBaseSchema = BaseSearchSchema.extend({
  description: z.string().trim().optional().describe('Filter by description text').meta(DEPRECATED_FLAT_FIELD),
  filter: filterField,
});

const StatisticsSearchSchema = withShapeExclusivity(StatisticsSearchBaseSchema).meta({ id: 'StatisticsSearchDto' });

const SmartSearchSchema = withShapeExclusivity(
  BaseSearchWithResultsSchema.extend({
    size: z.int().min(1).max(1000).optional().describe('Number of results to return'),
    query: z.string().trim().optional().describe('Natural language search query'),
    queryAssetId: z.uuidv4().optional().describe('Asset ID to use as search reference'),
    language: z.string().optional().describe('Search language code'),
    page: z.int().min(1).optional().describe('Page number').meta(DEPRECATED_FLAT_FIELD),
    filter: filterField,
  }),
).meta({ id: 'SmartSearchDto' });

export class RandomSearchDto extends createZodDto(RandomSearchSchema) {}
export class LargeAssetSearchDto extends createZodDto(LargeAssetSearchSchema) {}
export class MetadataSearchDto extends createZodDto(MetadataSearchSchema) {}
export class StatisticsSearchDto extends createZodDto(StatisticsSearchSchema) {}
export class SmartSearchDto extends createZodDto(SmartSearchSchema) {}
export class SearchPlacesDto extends createZodDto(SearchPlacesSchema) {}
export class SearchPeopleDto extends createZodDto(SearchPeopleSchema) {}
export class PlacesResponseDto extends createZodDto(PlacesResponseSchema) {}
export class SearchCityCountResponseDto extends createZodDto(SearchCityCountResponseSchema) {}
export class SearchSuggestionRequestDto extends createZodDto(SearchSuggestionRequestSchema) {}

export function mapPlaces(place: Place): PlacesResponseDto {
  return {
    name: place.name,
    latitude: place.latitude,
    longitude: place.longitude,
    admin1name: place.admin1Name ?? undefined,
    admin2name: place.admin2Name ?? undefined,
  };
}

const SearchFacetCountResponseSchema = z
  .object({
    count: z.int().min(0).describe('Number of assets with this facet value'),
    value: z.string().describe('Facet value'),
    label: z
      .string()
      .nullable()
      .optional()
      .describe("Display name when the value is an id (a person or a tag); the viewer's own name for it")
      .meta(ADDED_V3_2),
    coverAssetId: z
      .string()
      .nullable()
      .optional()
      .describe('The newest matching asset with this value (by capture time), when `facetCovers` was asked for')
      .meta(ADDED_V3_2),
  })
  .meta({ id: 'SearchFacetCountResponseDto' });

const SearchFacetResponseSchema = z
  .object({
    fieldName: z.string().describe('Facet field name'),
    counts: z.array(SearchFacetCountResponseSchema),
  })
  .meta({ id: 'SearchFacetResponseDto' });

const SearchAlbumResponseSchema = z
  .object({
    total: z.int().min(0).describe('Total number of matching albums'),
    count: z.int().min(0).describe('Number of albums in this page'),
    items: z.array(AlbumResponseSchema),
    facets: z.array(SearchFacetResponseSchema),
  })
  .meta({ id: 'SearchAlbumResponseDto' });

const SearchAssetResponseSchema = z
  .object({
    total: z
      .int()
      .min(0)
      .describe('Total number of matching assets')
      .meta(new HistoryBuilder().deprecated('v3.0.0').getExtensions()),
    count: z.int().min(0).describe('Number of assets in this page'),
    items: z.array(AssetResponseSchema),
    facets: z.array(SearchFacetResponseSchema),
    nextPage: z.string().nullable().describe('Next page token').meta(DEPRECATED_FLAT_FIELD),
    nextCursor: z.string().nullable().describe('Cursor for the next page of results').meta(ADDED_V3_2),
  })
  .meta({ id: 'SearchAssetResponseDto' });

const SearchResponseSchema = z
  .object({
    albums: SearchAlbumResponseSchema,
    assets: SearchAssetResponseSchema,
  })
  .meta({ id: 'SearchResponseDto' });

export class SearchResponseDto extends createZodDto(SearchResponseSchema) {}

const SearchStatisticsResponseSchema = z
  .object({
    total: z.int().describe('Total number of matching assets'),
  })
  .meta({ id: 'SearchStatisticsResponseDto' });

export class SearchStatisticsResponseDto extends createZodDto(SearchStatisticsResponseSchema) {}

/** FL-49: facet fields the search palette refines by (`search-palette.mjs` in the design reference) */
export enum SearchFacetField {
  People = 'people',
  Type = 'type',
  City = 'city',
  Country = 'country',
  Make = 'make',
  Model = 'model',
  LensModel = 'lensModel',
  Rating = 'rating',
  IsFavorite = 'isFavorite',
  Tags = 'tags',
}

export const SearchFacetFieldSchema = z.enum(SearchFacetField).meta({ id: 'SearchFacetField' });

export const SEARCH_FACET_DEFAULT_LIMIT = 10;
export const SEARCH_FACET_MAX_LIMIT = 100;
/** smart search ranks every eligible asset; its scope count stops here and says so */
export const SMART_SEARCH_COUNT_CAP = 1000;

const facetRequestShape = {
  facets: z
    .array(SearchFacetFieldSchema)
    .min(1)
    .max(Object.values(SearchFacetField).length)
    .optional()
    .describe('Facets to count, each once (repeats are ignored); every facet when omitted'),
  facetLimit: z
    .int()
    .min(1)
    .max(SEARCH_FACET_MAX_LIMIT)
    .optional()
    .describe(`Most frequent values per facet (default ${SEARCH_FACET_DEFAULT_LIMIT})`),
  facetCovers: z
    .boolean()
    .optional()
    .describe('Also return, per value, the newest matching asset (by capture time) as its cover')
    .meta(ADDED_V3_2),
};

const SearchFacetsSchema = withShapeExclusivity(StatisticsSearchBaseSchema.extend(facetRequestShape)).meta({
  id: 'SearchFacetsDto',
});

const SearchFacetsResponseSchema = z
  .object({
    total: z.int().min(0).describe('Number of assets the search body matches, as POST /search/statistics reports'),
    facets: z
      .array(SearchFacetResponseSchema)
      .describe(
        'Per facet, the most frequent values, busiest first. type, rating and isFavorite always add up to total; people, places, cameras, lenses and tags count assets that have a value',
      ),
  })
  .meta({ id: 'SearchFacetsResponseDto' });

export enum SearchHistogramGranularity {
  Day = 'day',
  Month = 'month',
  Year = 'year',
}

const SearchHistogramGranularitySchema = z.enum(SearchHistogramGranularity).meta({ id: 'SearchHistogramGranularity' });

const SearchHistogramSchema = withShapeExclusivity(
  StatisticsSearchBaseSchema.extend({
    granularity: SearchHistogramGranularitySchema.default(SearchHistogramGranularity.Month).describe('Bucket size'),
  }),
).meta({ id: 'SearchHistogramDto' });

const SearchHistogramBucketSchema = z
  .object({
    date: z.string().meta({ format: 'date' }).describe('First local capture date of the bucket (YYYY-MM-DD)'),
    count: z.int().min(1),
  })
  .meta({ id: 'SearchHistogramBucketDto' });

const SearchHistogramResponseSchema = z
  .object({
    granularity: SearchHistogramGranularitySchema,
    total: z.int().min(0).describe('Sum of every bucket; equals POST /search/statistics for the same body'),
    buckets: z.array(SearchHistogramBucketSchema).describe('Non-empty buckets by local capture date, oldest first'),
  })
  .meta({ id: 'SearchHistogramResponseDto' });

const SmartSearchStatisticsResponseSchema = z
  .object({
    total: z
      .int()
      .min(0)
      .max(SMART_SEARCH_COUNT_CAP)
      .describe(`Assets smart search would rank for this body, counted up to ${SMART_SEARCH_COUNT_CAP}`),
    capped: z.boolean().describe(`More than ${SMART_SEARCH_COUNT_CAP} assets match; total is the cap`),
  })
  .meta({ id: 'SmartSearchStatisticsResponseDto' });

export class SearchFacetsDto extends createZodDto(SearchFacetsSchema) {}
export class SearchFacetsResponseDto extends createZodDto(SearchFacetsResponseSchema) {}
export class SearchHistogramDto extends createZodDto(SearchHistogramSchema) {}
export class SearchHistogramResponseDto extends createZodDto(SearchHistogramResponseSchema) {}
export class SmartSearchStatisticsResponseDto extends createZodDto(SmartSearchStatisticsResponseSchema) {}

const SearchExploreItemSchema = z
  .object({
    value: z.string().describe('Explore value'),
    data: AssetResponseSchema,
  })
  .meta({ id: 'SearchExploreItem' });

const SearchExploreResponseSchema = z
  .object({
    fieldName: z.string().describe('Explore field name'),
    items: z.array(SearchExploreItemSchema),
  })
  .meta({ id: 'SearchExploreResponseDto' });

export class SearchExploreResponseDto extends createZodDto(SearchExploreResponseSchema) {}

const AskSearchSchema = z
  .object({
    query: z.string().trim().min(1).describe('Natural language Ask Search query'),
    page: z.int().min(1).optional().describe('Page number'),
    size: z.int().min(1).max(1000).optional().describe('Number of results to return'),
    language: z.string().optional().describe('Search language code'),
  })
  .meta({ id: 'AskSearchDto' });

const AskSearchPlanSchema = z
  .object({
    mode: z.enum(['smart', 'metadata']).describe('Search mode used to answer the query').meta({ id: 'SearchAskMode' }),
    normalizedQuery: z.string().describe('Normalized query text'),
    filters: z.object(MetadataSearchSchema.shape).partial().describe('Structured filters applied to the search'),
  })
  .meta({ id: 'AskSearchPlanDto' });

export class AskSearchDto extends createZodDto(AskSearchSchema) {}
const AskSearchResponseSchema = z
  .object({
    query: z.string().describe('Original Ask Search query'),
    explanation: z.string().describe('Short explanation of how the query was interpreted'),
    warnings: z.array(z.string()).describe('Unsupported or ambiguous parts of the query'),
    plan: AskSearchPlanSchema,
    results: SearchResponseSchema,
  })
  .meta({ id: 'AskSearchResponseDto' });

export class AskSearchResponseDto extends createZodDto(AskSearchResponseSchema) {}

import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetTypeSchema } from 'src/enum.js';
import { isoDatetimeToDate, latitudeSchema, longitudeSchema, stringToBool } from 'src/validation.js';

const MapReverseGeocodeSchema = z
  .object({
    lat: z.coerce.number().meta({ format: 'double' }).pipe(latitudeSchema).describe('Latitude (-90 to 90)'),
    lon: z.coerce.number().meta({ format: 'double' }).pipe(longitudeSchema).describe('Longitude (-180 to 180)'),
  })
  .meta({ id: 'MapReverseGeocodeDto' });

const MapReverseGeocodeResponseSchema = z
  .object({
    city: z.string().nullable().describe('City name'),
    state: z.string().nullable().describe('State/Province name'),
    country: z.string().nullable().describe('Country name'),
  })
  .meta({ id: 'MapReverseGeocodeResponseDto' });

const MapMarkerSchema = z
  .object({
    isArchived: stringToBool.optional().describe('Filter by archived status'),
    isFavorite: stringToBool.optional().describe('Filter by favorite status'),
    fileCreatedAfter: isoDatetimeToDate.optional().describe('Filter assets created after this date'),
    fileCreatedBefore: isoDatetimeToDate.optional().describe('Filter assets created before this date'),
    withSharedAlbums: stringToBool.optional().describe('Include shared album assets'),
  })
  .meta({ id: 'MapMarkerDto' });

const areaEdge = (edge: string, schema: typeof latitudeSchema) =>
  z.coerce.number().meta({ format: 'double' }).pipe(schema).optional().describe(edge);

/**
 * FL-1214: an area of the map. A west edge east of the east edge crosses the antimeridian. All four
 * edges are needed; with any one missing the whole world is meant.
 */
const MapAreaSchema = z.object({
  west: areaEdge('West edge of the area (longitude)', longitudeSchema),
  south: areaEdge('South edge of the area (latitude)', latitudeSchema),
  east: areaEdge('East edge of the area (longitude)', longitudeSchema),
  north: areaEdge('North edge of the area (latitude)', latitudeSchema),
});

/**
 * `GET /map/markers` with the optional area and paging the Map screen's "In view" list asks for
 * (FL-1214). Without them it answers exactly as before: every located item, newest first.
 */
const MapMarkerListSchema = MapMarkerSchema.extend({
  ...MapAreaSchema.shape,
  skip: z.coerce.number().int().min(0).optional().describe('Skip this many markers (with take)'),
  take: z.coerce.number().int().min(1).max(1000).optional().describe('At most this many markers, newest first'),
}).meta({ id: 'MapMarkerListDto' });

/** Asked without an area, the answer covers the whole library and can be `complete` (FL-1214). */
const MapClusterSchema = MapMarkerSchema.extend({
  ...MapAreaSchema.shape,
  zoom: z.coerce
    .number()
    .int()
    .min(0)
    .max(24)
    .describe('The map zoom level the items are grouped for; without an area, at most 4'),
}).meta({ id: 'MapClusterDto' });

/**
 * The map settings sheet's filters for one album's markers (FL-51, prototype `MapView.jsx` in album
 * scope). Each only narrows what the album already shows its viewer: no filter reaches an asset outside
 * the album, and the album's hidden and Locked rules still apply. Omitting a filter keeps the album's
 * own behaviour, so an old client that sends none gets the same markers as before. Unlike the library
 * map, where `withPartners` adds other people's items, here `withPartners=false` keeps only the viewer's
 * own album items, as the prototype's `filterMapAssets` treats every item someone else owns as a partner
 * item. `withSharedAlbums` is accepted for the shared settings sheet but narrows nothing here: the
 * prototype's switch only hides the viewer's own items that reach them solely through a shared space.
 */
const AlbumMapMarkerSchema = z
  .object({
    isArchived: stringToBool.optional().describe('Include archived items (the album default); false leaves them out'),
    isFavorite: stringToBool
      .optional()
      .describe("Filter by the viewer's own favorites; other members' favorites are never matched"),
    fileCreatedAfter: isoDatetimeToDate.optional().describe('Filter assets created after this date'),
    fileCreatedBefore: isoDatetimeToDate.optional().describe('Filter assets created before this date'),
    withPartners: stringToBool
      .optional()
      .describe("Include the album's items owned by anyone else (the album default); false keeps only your own"),
    withSharedAlbums: stringToBool
      .optional()
      .describe('Accepted for the shared map settings; has no effect on an album map'),
  })
  .meta({ id: 'AlbumMapMarkerDto' });

const MapMarkerResponseSchema = z
  .object({
    id: z.uuidv4().describe('Asset ID'),
    lat: z.number().meta({ format: 'double' }).describe('Latitude'),
    lon: z.number().meta({ format: 'double' }).describe('Longitude'),
    city: z.string().nullable().describe('City name'),
    state: z.string().nullable().describe('State/Province name'),
    country: z.string().nullable().describe('Country name'),
    originalFileName: z.string().optional().describe('Original file name'),
    fileCreatedAt: z
      .string()
      .meta({ format: 'date-time' })
      .optional()
      .describe('UTC timestamp when the asset was captured'),
    localDateTime: z
      .string()
      .meta({ format: 'date-time' })
      .optional()
      .describe('Capture date and time in the local time zone where it was taken, encoded as UTC'),
    type: AssetTypeSchema.optional(),
  })
  .meta({ id: 'MapMarkerResponseDto' });

/** Several located items close together at this zoom, drawn as one bubble (FL-1214). */
const MapClusterResponseSchema = z
  .object({
    id: z.uuidv4().describe("One of the items, for the bubble's preview"),
    lat: z.number().meta({ format: 'double' }).describe("Latitude of the items' centre"),
    lon: z.number().meta({ format: 'double' }).describe("Longitude of the items' centre"),
    count: z.int().min(2).describe('How many items'),
    videos: z.int().min(0).describe('How many of them are videos'),
    city: z.string().nullable().describe('City of the preview item'),
    state: z.string().nullable().describe('State/Province of the preview item'),
    country: z.string().nullable().describe('Country of the preview item'),
  })
  .meta({ id: 'MapClusterResponseDto' });

const MapBoundsSchema = z
  .object({
    west: z.number().meta({ format: 'double' }),
    south: z.number().meta({ format: 'double' }),
    east: z.number().meta({ format: 'double' }),
    north: z.number().meta({ format: 'double' }),
  })
  .meta({ id: 'MapBoundsDto' });

/**
 * The located items for one view of the map (FL-1214), so a large library is never sent whole. Items
 * close together at the requested zoom come as clusters; the rest come as markers. A library small
 * enough to send whole comes as markers only, with `complete` set, and need not be asked again as the
 * map moves.
 */
const MapClusterListResponseSchema = z
  .object({
    complete: z.boolean().describe('True when markers hold every located item under the filters, wherever the map is'),
    total: z.int().min(0).describe('Located items in the area asked for (the whole world without one)'),
    bounds: MapBoundsSchema.nullable().describe('The area those items cover; null when there are none'),
    clusters: z.array(MapClusterResponseSchema).describe('Groups of items in the area'),
    markers: z.array(MapMarkerResponseSchema).describe('Items in the area that are not in a group'),
  })
  .meta({ id: 'MapClusterListResponseDto' });

/**
 * The map settings sheet's counts (FL-51, prototype `MapView.jsx` settings): what each switch would
 * add under the sheet's other filters, and how many of the viewer's own items have no location.
 * Every count follows the same owner, partner, hidden and Locked rules as the markers.
 */
const MapStatisticsResponseSchema = z
  .object({
    archived: z.int().min(0).describe("The viewer's own located archived items"),
    partner: z
      .int()
      .min(0)
      .describe("Always 0: partners' items arrive as the viewer's own copies (kept for older clients)"),
    unlocated: z.int().min(0).describe("The viewer's own timeline items without a location"),
  })
  .meta({ id: 'MapStatisticsResponseDto' });

export class MapStatisticsResponseDto extends createZodDto(MapStatisticsResponseSchema) {}
export class MapReverseGeocodeDto extends createZodDto(MapReverseGeocodeSchema) {}
export class MapReverseGeocodeResponseDto extends createZodDto(MapReverseGeocodeResponseSchema) {}
export class MapMarkerDto extends createZodDto(MapMarkerSchema) {}
export class MapMarkerListDto extends createZodDto(MapMarkerListSchema) {}
export class MapClusterDto extends createZodDto(MapClusterSchema) {}
export class MapClusterListResponseDto extends createZodDto(MapClusterListResponseSchema) {}
export class AlbumMapMarkerDto extends createZodDto(AlbumMapMarkerSchema) {}
export class MapMarkerResponseDto extends createZodDto(MapMarkerResponseSchema) {}

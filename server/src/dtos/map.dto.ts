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
    withPartners: stringToBool.optional().describe('Include partner assets'),
    withSharedAlbums: stringToBool.optional().describe('Include shared album assets'),
  })
  .meta({ id: 'MapMarkerDto' });

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

/**
 * The map settings sheet's counts (FL-51, prototype `MapView.jsx` settings): what each switch would
 * add under the sheet's other filters, and how many of the viewer's own items have no location.
 * Every count follows the same owner, partner, hidden and Locked rules as the markers.
 */
const MapStatisticsResponseSchema = z
  .object({
    archived: z.int().min(0).describe("The viewer's own located archived items"),
    partner: z.int().min(0).describe('Located timeline items of partners who share their locations with the viewer'),
    unlocated: z.int().min(0).describe("The viewer's own timeline items without a location"),
  })
  .meta({ id: 'MapStatisticsResponseDto' });

export class MapStatisticsResponseDto extends createZodDto(MapStatisticsResponseSchema) {}
export class MapReverseGeocodeDto extends createZodDto(MapReverseGeocodeSchema) {}
export class MapReverseGeocodeResponseDto extends createZodDto(MapReverseGeocodeResponseSchema) {}
export class MapMarkerDto extends createZodDto(MapMarkerSchema) {}
export class AlbumMapMarkerDto extends createZodDto(AlbumMapMarkerSchema) {}
export class MapMarkerResponseDto extends createZodDto(MapMarkerResponseSchema) {}

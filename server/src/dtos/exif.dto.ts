import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { MaybeDehydrated } from 'src/types.js';
import { Exif } from 'src/database.js';
import { asDateTimeString, isDateEstimated } from 'src/utils/date.js';
import { isMediaKind } from 'src/utils/media-kinds.js';

/**
 * FL-987: a place's names in the viewer's language. A new field beside `city`, `state` and `country`, which
 * keep their English values, so a client that does not know it shows what it always did.
 */
export const PlaceNamesLocalizedSchema = z
  .object({
    city: z.string().nullable().describe('City name in `lang`, or the English `city` where it has no translation'),
    state: z
      .string()
      .nullable()
      .describe('State/province name in `lang`, or the English `state` where it has no translation'),
    country: z
      .string()
      .nullable()
      .describe('Country name in `lang`, or the English `country` where it has no translation'),
    lang: z
      .string()
      .describe('Language of the translated names: fr, es, de, it, pt, nl, pl, sv, da or nb (Norwegian Bokmål)'),
  })
  .describe('Place names in the viewer’s language')
  .meta({ id: 'PlaceNamesLocalizedDto' });

const placeNamesLocalized = PlaceNamesLocalizedSchema.nullish()
  .default(null)
  .describe(
    'City, state and country in the language of the signed-in account, when it is not English and at least one of the three has a translation. Null otherwise: show `city`, `state` and `country`',
  );

export const ExifResponseSchema = z
  .object({
    bitsPerSample: z.int().nullish().default(null).describe('Bits per sample'),
    colorspace: z.string().nullish().default(null).describe('Recorded color space'),
    profileDescription: z.string().nullish().default(null).describe('Color profile description'),
    make: z.string().nullish().default(null).describe('Camera make'),
    model: z.string().nullish().default(null).describe('Camera model'),
    exifImageWidth: z.int().min(0).nullish().default(null).describe('Image width in pixels'),
    exifImageHeight: z.int().min(0).nullish().default(null).describe('Image height in pixels'),
    fileSizeInByte: z.int().min(0).nullish().default(null).describe('File size in bytes'),
    orientation: z.string().nullish().default(null).describe('Image orientation'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    dateTimeOriginal: z.string().meta({ format: 'date-time' }).nullish().default(null).describe('Original date/time'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    modifyDate: z.string().meta({ format: 'date-time' }).nullish().default(null).describe('Modification date/time'),
    timeZone: z.string().nullish().default(null).describe('Time zone'),
    lensModel: z.string().nullish().default(null).describe('Lens model'),
    fNumber: z.number().meta({ format: 'double' }).nullish().default(null).describe('F-number (aperture)'),
    focalLength: z.number().meta({ format: 'double' }).nullish().default(null).describe('Focal length in mm'),
    iso: z.int().nullish().default(null).describe('ISO sensitivity'),
    exposureTime: z.string().nullish().default(null).describe('Exposure time'),
    latitude: z.number().meta({ format: 'double' }).nullish().default(null).describe('GPS latitude'),
    longitude: z.number().meta({ format: 'double' }).nullish().default(null).describe('GPS longitude'),
    gpsAccuracyM: z
      .number()
      .meta({ format: 'double' })
      .nonnegative()
      .nullable()
      .optional()
      .describe('Reported horizontal GPS accuracy in metres'),
    city: z.string().nullish().default(null).describe('City name'),
    state: z.string().nullish().default(null).describe('State/province name'),
    country: z.string().nullish().default(null).describe('Country name'),
    placeNamesLocalized,
    description: z.string().nullish().default(null).describe('Image description'),
    title: z.string().nullable().optional().describe('Image title'),
    artist: z.string().nullable().optional().describe('Artist credit'),
    copyright: z.string().nullable().optional().describe('Copyright notice'),
    projectionType: z.string().nullish().default(null).describe('Projection type'),
    rating: z.int().min(1).max(5).nullish().default(null).describe('Rating'),
    isRejected: z.boolean().nullish().default(null).describe('Whether the stored rating is rejected'),
    fps: z.number().meta({ format: 'double' }).nullish().default(null).describe('Video frame rate (frames per second)'),
    mediaKinds: z
      .array(z.string())
      .optional()
      .describe(
        'Kinds of capture the file records: slow-motion, time-lapse, panorama, spherical, burst, portrait, selfie, screenshot, screen-recording. More may be added; ignore values you do not know. Absent until the metadata scan reads them',
      ),
    dateEstimated: z
      .boolean()
      .optional()
      .describe('The capture date was estimated from the photos around it. Absent when it was not'),
  })
  .describe('EXIF response')
  .meta({ id: 'ExifResponseDto' });

class ExifResponseDto extends createZodDto(ExifResponseSchema) {}

export function mapExif(entity: MaybeDehydrated<Exif>): ExifResponseDto {
  const fileSizeInByte = entity.fileSizeInByte ?? null;
  return {
    bitsPerSample: entity.bitsPerSample ?? null,
    colorspace: entity.colorspace ?? null,
    profileDescription: entity.profileDescription ?? null,
    make: entity.make,
    model: entity.model,
    exifImageWidth: entity.exifImageWidth,
    exifImageHeight: entity.exifImageHeight,
    fileSizeInByte: fileSizeInByte === null ? null : Number(fileSizeInByte),
    orientation: entity.orientation,
    dateTimeOriginal: asDateTimeString(entity.dateTimeOriginal),
    modifyDate: asDateTimeString(entity.modifyDate),
    timeZone: entity.timeZone,
    lensModel: entity.lensModel,
    fNumber: entity.fNumber,
    focalLength: entity.focalLength,
    iso: entity.iso,
    exposureTime: entity.exposureTime,
    latitude: entity.latitude,
    longitude: entity.longitude,
    gpsAccuracyM: entity.gpsAccuracyM ?? undefined,
    city: entity.city,
    state: entity.state,
    country: entity.country,
    // FL-987: filled by the service for the viewer's language (`BaseService.localizeAssetPlaces`)
    placeNamesLocalized: null,
    description: entity.description,
    title: entity.title ?? undefined,
    artist: entity.artist ?? undefined,
    copyright: entity.copyright ?? undefined,
    projectionType: entity.projectionType,
    rating: entity.rating === -1 || entity.rating === 0 ? null : entity.rating,
    isRejected: entity.rating === -1,
    fps: entity.fps ?? null,
    ...(entity.mediaKinds && { mediaKinds: entity.mediaKinds.filter((kind) => isMediaKind(kind)) }),
    ...(isDateEstimated(entity) && { dateEstimated: true }),
  };
}

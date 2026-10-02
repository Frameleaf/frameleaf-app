import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { MaybeDehydrated } from 'src/types.js';
import { Exif } from 'src/database.js';
import { asDateTimeString } from 'src/utils/date.js';

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
    city: z.string().nullish().default(null).describe('City name'),
    state: z.string().nullish().default(null).describe('State/province name'),
    country: z.string().nullish().default(null).describe('Country name'),
    description: z.string().nullish().default(null).describe('Image description'),
    projectionType: z.string().nullish().default(null).describe('Projection type'),
    rating: z.int().min(1).max(5).nullish().default(null).describe('Rating'),
    isRejected: z.boolean().nullish().default(null).describe('Whether the stored rating is rejected'),
    fps: z.number().meta({ format: 'double' }).nullish().default(null).describe('Video frame rate (frames per second)'),
  })
  .describe('EXIF response')
  .meta({ id: 'ExifResponseDto' });

class ExifResponseDto extends createZodDto(ExifResponseSchema) {}

export function mapExif(entity: MaybeDehydrated<Exif>): ExifResponseDto {
  return {
    bitsPerSample: entity.bitsPerSample ?? null,
    colorspace: entity.colorspace ?? null,
    profileDescription: entity.profileDescription ?? null,
    make: entity.make,
    model: entity.model,
    exifImageWidth: entity.exifImageWidth,
    exifImageHeight: entity.exifImageHeight,
    fileSizeInByte: entity.fileSizeInByte ? Number.parseInt(entity.fileSizeInByte.toString()) : null,
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
    city: entity.city,
    state: entity.state,
    country: entity.country,
    description: entity.description,
    projectionType: entity.projectionType,
    rating: entity.rating === -1 ? null : entity.rating,
    isRejected: entity.rating === -1,
    fps: entity.fps ?? null,
  };
}

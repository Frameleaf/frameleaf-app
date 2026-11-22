import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { LOCATION_HISTORY_MAX_BYTES } from 'src/repositories/location-history.repository.js';

/** FL-925: a person's own location history files. Nothing here is ever returned to anyone else. */

export class LocationHistoryUploadCreateDto extends createZodDto(
  z
    .object({
      size: z.int().min(1).max(LOCATION_HISTORY_MAX_BYTES).describe('The file’s size in bytes'),
    })
    .meta({ id: 'LocationHistoryUploadCreateDto' }),
) {}

export class LocationHistoryUploadResponseDto extends createZodDto(
  z
    .object({
      id: z.uuid().describe('Upload ID'),
      receivedBytes: z.int().min(0).describe('Bytes stored so far; the next part starts here'),
    })
    .meta({ id: 'LocationHistoryUploadResponseDto' }),
) {}

export class LocationHistoryUploadParamsDto extends createZodDto(z.object({ id: z.uuid() })) {}

export class LocationHistoryChunkQueryDto extends createZodDto(
  z.object({
    offset: z.coerce.number().int().min(0).max(LOCATION_HISTORY_MAX_BYTES).describe('Byte offset of this part'),
  }),
) {}

export class LocationHistorySourceCreateDto extends createZodDto(
  z
    .object({
      uploadId: z.uuid().describe('The finished upload to read'),
      fileName: z.string().trim().min(1).max(255).describe('The file’s name, to show in the list'),
    })
    .meta({ id: 'LocationHistorySourceCreateDto' }),
) {}

const LocationHistorySourceResponseSchema = z
  .object({
    id: z.uuidv7().describe('Source ID'),
    fileName: z.string().describe('The file’s name'),
    kind: z
      .string()
      .nullable()
      .describe(
        'What the file is, once known: google-timeline, google-records, gpx, owntracks, geojson or a later kind',
      ),
    createdAt: z.string().describe('When the file was added (ISO 8601)'),
    importedAt: z.string().nullable().describe('When the file was read to its end; null while it is being read'),
    pointCount: z.int().min(0).describe('Places stored from this file so far'),
    firstAt: z.string().nullable().describe('The earliest moment in the file'),
    lastAt: z.string().nullable().describe('The latest moment in the file'),
    error: z.string().nullable().describe('Why the file could not be read, when it could not'),
  })
  .meta({ id: 'LocationHistorySourceResponseDto' });

export class LocationHistorySourceResponseDto extends createZodDto(LocationHistorySourceResponseSchema) {}

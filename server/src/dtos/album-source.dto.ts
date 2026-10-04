import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * FL-331 (NAPI-015): album source links. A phone album (iOS Photos) or folder (Android) maps to one of its
 * owner's server albums so the native apps sync phone albums without duplicates.
 */

export const MAX_ALBUM_SOURCES = 500;

export enum AlbumSourceKind {
  IosPhotos = 'ios-photos',
  AndroidFolder = 'android-folder',
}

export const AlbumSourceKindSchema = z
  .enum(AlbumSourceKind)
  .describe('Where the source lives: an iOS Photos album or an Android folder')
  .meta({ id: 'AlbumSourceKind' });

export enum AlbumSourceOutcome {
  Existing = 'existing',
  Merged = 'merged',
  Created = 'created',
}

const SourceIdSchema = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    'The source on the phone: the iOS album PHCloudIdentifier when available, else its localIdentifier; on Android "<bucketId>:<relativePath>"',
  );
const DeviceKeySchema = z
  .string()
  .min(1)
  .max(256)
  .nullable()
  .describe('Set only when sourceId is device-local (an iOS localIdentifier, an Android bucket); null otherwise');
const SourceNameSchema = z.string().trim().min(1).max(255).describe('The name of the album or folder on the phone');

const AlbumSourceSchema = z
  .object({
    kind: AlbumSourceKindSchema,
    sourceId: SourceIdSchema,
    deviceKey: DeviceKeySchema.optional(),
    name: SourceNameSchema,
  })
  .meta({ id: 'AlbumSourceDto' });

const AlbumSourceResolveSchema = z
  .object({
    sources: z
      .array(AlbumSourceSchema)
      .min(1)
      .max(MAX_ALBUM_SOURCES)
      .describe('The phone albums or folders to resolve'),
  })
  .meta({ id: 'AlbumSourceResolveDto' });

export const AlbumSourceLinkResponseSchema = z
  .object({
    id: z.uuidv4().describe('Link ID'),
    albumId: z.uuidv4().describe('The server album the source is linked to'),
    albumName: z.string().describe('The server album name'),
    kind: AlbumSourceKindSchema,
    sourceId: z.string().describe('The source on the phone'),
    deviceKey: z.string().nullable().describe('The device the source id belongs to, when it is device-local'),
    lastSourceName: z.string().describe('The phone name the server album last followed (the rename guard)'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the link was made'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('When the link last changed'),
  })
  .meta({ id: 'AlbumSourceLinkResponseDto' });

const AlbumSourceResolvedSchema = AlbumSourceLinkResponseSchema.extend({
  outcome: z
    .enum(AlbumSourceOutcome)
    .describe(
      'existing: the source was already linked; merged: linked to an existing album with the same name; created: a new album',
    )
    .meta({ id: 'AlbumSourceOutcome' }),
}).meta({ id: 'AlbumSourceResolvedDto' });

const AlbumSourceResolveResponseSchema = z
  .object({
    links: z.array(AlbumSourceResolvedSchema).describe('One link per requested source, in request order'),
  })
  .meta({ id: 'AlbumSourceResolveResponseDto' });

const AlbumSourceUpdateSchema = z
  .object({
    name: SourceNameSchema.describe('The new name of the album or folder on the phone'),
    sourceId: SourceIdSchema.optional().describe(
      'Re-key the link to a new source id with the same kind and device (an Android folder rename changes its bucket)',
    ),
  })
  .meta({ id: 'AlbumSourceUpdateDto' });

const AlbumSourceUpdateResponseSchema = AlbumSourceLinkResponseSchema.extend({
  renamed: z
    .boolean()
    .describe('Whether the server album was renamed (only while its name still equalled lastSourceName)'),
}).meta({ id: 'AlbumSourceUpdateResponseDto' });

export class AlbumSourceResolveDto extends createZodDto(AlbumSourceResolveSchema) {}
export class AlbumSourceResolveResponseDto extends createZodDto(AlbumSourceResolveResponseSchema) {}
export class AlbumSourceLinkResponseDto extends createZodDto(AlbumSourceLinkResponseSchema) {}
export class AlbumSourceUpdateDto extends createZodDto(AlbumSourceUpdateSchema) {}
export class AlbumSourceUpdateResponseDto extends createZodDto(AlbumSourceUpdateResponseSchema) {}

export type AlbumSourceInput = z.infer<typeof AlbumSourceSchema>;

export type AlbumSourceLink = {
  id: string;
  userId: string;
  albumId: string;
  albumName: string;
  sourceKind: AlbumSourceKind;
  sourceId: string;
  deviceKey: string | null;
  lastSourceName: string;
  createdAt: Date;
  updatedAt: Date;
};

export const mapAlbumSourceLink = (link: AlbumSourceLink): AlbumSourceLinkResponseDto => ({
  id: link.id,
  albumId: link.albumId,
  albumName: link.albumName,
  kind: link.sourceKind,
  sourceId: link.sourceId,
  deviceKey: link.deviceKey,
  lastSourceName: link.lastSourceName,
  createdAt: new Date(link.createdAt).toISOString(),
  updatedAt: new Date(link.updatedAt).toISOString(),
});

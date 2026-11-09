import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AlbumChangeRunStatusSchema } from 'src/dtos/album-merge.dto.js';
import { AlbumLostDateSuggestionSchema } from 'src/dtos/album-suggestion.dto.js';

/** FL-1300: Magic Albums cleanup. The server scans, the browser plans, and the server checks what comes back. */

const CleanupAlbumFactSchema = z
  .object({
    id: z.uuidv4().describe('Album ID'),
    name: z.string().describe('Album name'),
    count: z.int().min(0).describe('Photos this session may see'),
    createdAt: z.string().describe('When the album was created'),
    locked: z.boolean().describe('The album is locked'),
    shared: z.boolean().describe('The album is shared with people, by a public link or through a shared space'),
    gps: z
      .object({
        city: z.string().describe('The city most located photos were taken in'),
        share: z.number().min(0).max(1).meta({ format: 'double' }).describe('Its share of the located photos'),
        lat: z.number().meta({ format: 'double' }).describe('Latitude of the centre of those photos'),
        lon: z.number().meta({ format: 'double' }).describe('Longitude of the centre of those photos'),
      })
      .nullable()
      .describe('Where the photos were taken, when they say so'),
    span: z
      .object({
        from: z.int().describe('First day, as days since 1970-01-01'),
        to: z.int().describe('Last day, as days since 1970-01-01'),
        middle: z.int().describe('The middle photo, as days since 1970-01-01'),
      })
      .nullable()
      .describe('When the photos were taken, leaving out estimated dates'),
    coverAssetId: z.uuidv4().nullable().describe('A cover this session may see'),
  })
  .meta({ id: 'AlbumCleanupAlbumFactDto' });

const CleanupCollectionFactSchema = z
  .object({
    id: z.uuidv4().describe('Collection ID'),
    name: z.string().describe('Collection name'),
    parentId: z.uuidv4().nullable().describe('The collection it sits in'),
    createdAt: z.string().describe('When it was created; the older of two with one name is reused'),
  })
  .meta({ id: 'AlbumCleanupCollectionFactDto' });

const CleanupSameNameSchema = z
  .object({
    key: z.string().describe('The name after trimming, collapsing spaces and ignoring case'),
    albumIds: z.array(z.uuidv4()).describe('Every album with this name'),
    winnerId: z.uuidv4().describe('The album that would keep its name and icon, from true counts'),
    union: z.int().min(0).describe('Photos this session may see after merging, each counted once'),
  })
  .meta({ id: 'AlbumCleanupSameNameDto' });

const CleanupPairSchema = z
  .object({
    firstId: z.uuidv4().describe('One album'),
    secondId: z.uuidv4().describe('The other album'),
    winnerId: z.uuidv4().describe('The album that would keep its name and icon, from true counts'),
    share: z
      .number()
      .min(0)
      .max(1)
      .meta({ format: 'double' })
      .describe('How much of the smaller album is in both; 0 for the same trip'),
    union: z.int().min(0).describe('Photos this session may see after merging, each counted once'),
  })
  .meta({ id: 'AlbumCleanupPairDto' });

const CleanupHomeAreaSchema = z
  .object({
    city: z.string().nullable().describe('The most common city in the area'),
    lat: z.number().meta({ format: 'double' }).describe('Latitude of its centre'),
    lon: z.number().meta({ format: 'double' }).describe('Longitude of its centre'),
    photoCount: z.int().min(0).describe('Photos taken there'),
  })
  .meta({ id: 'AlbumCleanupHomeAreaDto' });

const CleanupLostDatesSchema = z
  .object({
    albumId: z.uuidv4().describe('The album'),
    from: z.string().describe('First local day of the album (YYYY-MM-DD)'),
    to: z.string().describe('Last local day of the album (YYYY-MM-DD)'),
    suggestions: z.array(AlbumLostDateSuggestionSchema).describe('Your own photos that lost their date'),
  })
  .meta({ id: 'AlbumCleanupLostDatesDto' });

const AlbumCleanupFactsSchema = z
  .object({
    albums: z.array(CleanupAlbumFactSchema).describe('Your top-level albums'),
    collections: z.array(CleanupCollectionFactSchema).describe('Your existing collections, to reuse as structure'),
    sameName: z.array(CleanupSameNameSchema).describe('Albums sharing a name'),
    samePhotos: z.array(CleanupPairSchema).describe('Albums holding nearly the same photos under different names'),
    sameTrip: z.array(CleanupPairSchema).describe('Albums from the same dates and place with no photos in common'),
    homeAreas: z.array(CleanupHomeAreaSchema).describe('The largest photo clusters, densest first'),
    lostDates: z.array(CleanupLostDatesSchema).describe('Albums with photos that lost their date'),
    healSkipped: z.int().min(0).describe('Albums skipped because their photos span too long'),
  })
  .meta({ id: 'AlbumCleanupFactsDto' });

const AlbumCleanupSnapshotResponseSchema = z
  .object({
    ready: z.boolean().describe('The first scan has finished'),
    computedAt: z.string().nullable().describe('When the scan ran'),
    suggestionCount: z.int().min(0).describe('How many albums the review has something to offer'),
    facts: AlbumCleanupFactsSchema.nullable().describe('What the scan found, for this session'),
  })
  .meta({ id: 'AlbumCleanupSnapshotResponseDto' });

const AlbumCleanupApplyProgressSchema = z
  .object({
    runId: z.uuidv7().describe('The cleanup, for undoing it'),
    status: AlbumChangeRunStatusSchema,
    done: z.int().min(0).describe('Operations finished'),
    total: z.int().min(0).describe('Operations in all'),
  })
  .meta({ id: 'AlbumCleanupApplyProgressDto' });

const AlbumCleanupStatusResponseSchema = z
  .object({
    ready: z.boolean().describe('The first scan has finished'),
    computedAt: z.string().nullable().describe('When the scan ran'),
    suggestionCount: z.int().min(0).describe('How many albums the review has something to offer'),
    apply: AlbumCleanupApplyProgressSchema.nullable().describe('The newest cleanup you have not undone'),
  })
  .meta({ id: 'AlbumCleanupStatusResponseDto' });

export const AlbumCleanupOperationTypeSchema = z
  .enum(['createCollection', 'move', 'rename', 'merge', 'combine', 'heal', 'remove'])
  .describe('What the operation does')
  .meta({ id: 'AlbumCleanupOperationType' });

const AlbumCleanupOperationSchema = z
  .object({
    type: AlbumCleanupOperationTypeSchema,
    tempId: z.string().min(1).max(2048).optional().describe('createCollection: how later operations refer to it'),
    albumId: z.uuidv4().optional().describe('move, rename, heal, remove: the album'),
    albumIds: z.array(z.uuidv4()).min(2).optional().describe('merge, combine: the albums'),
    name: z.string().trim().min(1).max(255).optional().describe('createCollection, rename, combine: the name'),
    parentId: z
      .uuidv4()
      .nullable()
      .optional()
      .describe('createCollection, move: an existing collection, or the top level'),
    parentTempId: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe('createCollection, move: a collection this run creates'),
    allowShared: z.boolean().optional().describe('merge: the person chose to merge albums that are shared'),
    assetIds: z.array(z.uuidv4()).optional().describe('heal: the photos approved'),
  })
  .meta({ id: 'AlbumCleanupOperationDto' });

const AlbumCleanupApplySchema = z
  .object({ operations: z.array(AlbumCleanupOperationSchema).min(1).max(50_000).describe('What to change') })
  .meta({ id: 'AlbumCleanupApplyDto' });

const AlbumCleanupApplyResponseSchema = z
  .object({ runId: z.uuidv7().describe('The cleanup, to follow its progress and undo it') })
  .meta({ id: 'AlbumCleanupApplyResponseDto' });

export class AlbumCleanupSnapshotResponseDto extends createZodDto(AlbumCleanupSnapshotResponseSchema) {}
export class AlbumCleanupStatusResponseDto extends createZodDto(AlbumCleanupStatusResponseSchema) {}
export class AlbumCleanupApplyDto extends createZodDto(AlbumCleanupApplySchema) {}
export class AlbumCleanupApplyResponseDto extends createZodDto(AlbumCleanupApplyResponseSchema) {}
export type AlbumCleanupFacts = z.infer<typeof AlbumCleanupFactsSchema>;
export type AlbumCleanupOperation = z.infer<typeof AlbumCleanupOperationSchema>;
export type AlbumCleanupApplyProgress = z.infer<typeof AlbumCleanupApplyProgressSchema>;

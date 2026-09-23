import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * Google Photos import contracts (FL-65, `IMP-001`).
 *
 * Server paths never appear in a response: sources are named by the file the owner chose or the
 * directory's own name, and files by their path inside the export. Items that would go into Locked
 * are left out of every listing for a session that has not unlocked Locked, and only counted.
 */

export const TakeoutStateSchema = z
  .enum([
    'sources',
    'queued',
    'scanning',
    'review',
    'importing',
    'paused',
    'cancelling',
    'cancelled',
    'failed',
    'completed',
  ])
  .describe('Where the import is: staging sources, a scan or import job at work, awaiting review, or done')
  .meta({ id: 'TakeoutState' });

export const TakeoutPhaseSchema = z
  .enum(['sources', 'scanning', 'review', 'importing', 'completed'])
  .describe('The step the import has reached')
  .meta({ id: 'TakeoutPhase' });

export const TakeoutItemStateSchema = z
  .enum(['ready', 'review', 'importing', 'imported', 'matched', 'skipped', 'failed'])
  .describe('What happened to one photo or video')
  .meta({ id: 'TakeoutItemState' });

export const TakeoutPairStateSchema = z
  .enum(['suggested', 'approved', 'skipped', 'linked', 'failed'])
  .describe('A possible Live Photo pair and the owner’s decision')
  .meta({ id: 'TakeoutPairState' });

export const TakeoutWarningSchema = z
  .enum(['ambiguous_sidecar', 'no_sidecar', 'invalid_sidecar', 'trashed', 'locked'])
  .describe('Why an item needs attention')
  .meta({ id: 'TakeoutWarning' });

export const TakeoutActionSchema = z
  .enum(['scan', 'import'])
  .describe('The step a job carries out')
  .meta({ id: 'TakeoutAction' });

export const TakeoutControlActionSchema = z
  .enum(['pause', 'resume', 'cancel'])
  .describe('What to do with the running job')
  .meta({ id: 'TakeoutControlAction' });

export const TakeoutSourceKindSchema = z
  .enum(['zip', 'directory'])
  .describe('An uploaded archive or a server directory')
  .meta({ id: 'TakeoutSourceKind' });

export const TakeoutItemKindSchema = z
  .enum(['image', 'video'])
  .describe('Photo or video')
  .meta({ id: 'TakeoutItemKind' });

const TakeoutMetadataSchema = z
  .object({
    title: z.string().describe('File name Google Photos recorded'),
    description: z.string().optional().describe('Description'),
    takenAt: z.string().optional().describe('When the photo was taken (ISO 8601)'),
    createdAt: z.string().optional().describe('When Google Photos received the photo (ISO 8601)'),
    latitude: z.number().meta({ format: 'double' }).optional().describe('Latitude'),
    longitude: z.number().meta({ format: 'double' }).optional().describe('Longitude'),
    favorite: z.boolean().optional().describe('Favorite in Google Photos'),
    archived: z.boolean().optional().describe('Archived in Google Photos'),
    locked: z.boolean().optional().describe('In the Google Photos Locked Folder; imported into Locked'),
    trashed: z.boolean().optional().describe('In the Google Photos trash; not imported'),
  })
  .meta({ id: 'TakeoutMetadataDto' });

export const TakeoutOptionsSchema = z
  .object({
    descriptions: z.boolean().default(true).describe('Bring over descriptions'),
    dates: z.boolean().default(true).describe('Bring over the dates photos were taken'),
    locations: z.boolean().default(true).describe('Bring over locations'),
    favorites: z.boolean().default(true).describe('Bring over favorites'),
    archive: z.boolean().default(true).describe('Bring over archived photos as archived'),
    albums: z
      .boolean()
      .default(true)
      .describe('Recreate album memberships, including for photos already in the library'),
    sidecarReview: z
      .boolean()
      .default(true)
      .describe('Hold items whose metadata sidecars disagree for a decision; off imports them without a sidecar'),
    updateMatchedMetadata: z
      .boolean()
      .default(false)
      .describe('Fill metadata missing from photos already in the library; values already there are never replaced'),
    selectedAlbums: z
      .array(z.string().max(4096))
      .max(20_000)
      .optional()
      .describe('Album folders to recreate; omitted means every folder that is not a year folder'),
  })
  .meta({ id: 'TakeoutOptionsDto' });

export class TakeoutOptionsDto extends createZodDto(TakeoutOptionsSchema) {}

/** The choices as the import holds them; every switch is present. */
const TakeoutOptionsResponseSchema = z
  .object({
    descriptions: z.boolean(),
    dates: z.boolean(),
    locations: z.boolean(),
    favorites: z.boolean(),
    archive: z.boolean(),
    albums: z.boolean(),
    sidecarReview: z.boolean(),
    updateMatchedMetadata: z.boolean(),
    selectedAlbums: z.array(z.string()).optional(),
  })
  .meta({ id: 'TakeoutOptionsResponseDto' });

export class TakeoutCreateDto extends createZodDto(
  z
    .object({
      name: z.string().trim().min(1).max(200).describe('A name for this import'),
      rootId: z
        .string()
        .max(32)
        .optional()
        .describe('Administrators only: the permitted import root to read a server directory from'),
      directory: z
        .string()
        .max(4096)
        .optional()
        .describe('Administrators only: the directory inside the root, relative to it; empty for the root itself'),
    })
    .meta({ id: 'TakeoutCreateDto' }),
) {}

export class TakeoutArchiveCreateDto extends createZodDto(
  z
    .object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .refine((name) => name.toLowerCase().endsWith('.zip'), 'Select a ZIP archive')
        .describe('The archive’s file name'),
      size: z
        .int()
        .min(22)
        .max(1024 ** 4)
        .describe('The archive’s size in bytes'),
    })
    .meta({ id: 'TakeoutArchiveCreateDto' }),
) {}

export class TakeoutParamsDto extends createZodDto(z.object({ id: z.uuid() })) {}
export class TakeoutArchiveParamsDto extends createZodDto(z.object({ id: z.uuid(), archiveId: z.uuid() })) {}
export class TakeoutItemParamsDto extends createZodDto(z.object({ id: z.uuid(), itemId: z.uuid() })) {}

export class TakeoutChunkQueryDto extends createZodDto(
  z.object({
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(1024 ** 4)
      .describe('Byte offset of this chunk'),
  }),
) {}

export class TakeoutVerifyChunkDto extends createZodDto(
  z
    .object({
      offset: z.int().min(0).describe('Byte offset of the range'),
      size: z
        .int()
        .min(1)
        .max(8 * 1024 * 1024)
        .describe('Length of the range'),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .describe('SHA-256 of the range, hex'),
    })
    .meta({ id: 'TakeoutVerifyChunkDto' }),
) {}

export class TakeoutItemQueryDto extends createZodDto(
  z.object({
    offset: z.coerce.number().int().min(0).default(0).describe('Items to skip'),
    limit: z.coerce.number().int().min(1).max(200).default(100).describe('Items to return'),
    state: TakeoutItemStateSchema.optional(),
  }),
) {}

export class TakeoutPairQueryDto extends createZodDto(
  z.object({
    offset: z.coerce.number().int().min(0).default(0).describe('Pairs to skip'),
    limit: z.coerce.number().int().min(1).max(200).default(100).describe('Pairs to return'),
    state: TakeoutPairStateSchema.optional(),
  }),
) {}

export class TakeoutControlDto extends createZodDto(
  z.object({ action: TakeoutControlActionSchema }).meta({ id: 'TakeoutControlDto' }),
) {}

export class TakeoutResolveDto extends createZodDto(
  z
    .object({
      sidecarId: z.uuid().nullable().optional().describe('The sidecar to use; null imports without one'),
      skip: z.boolean().optional().describe('True leaves the item out of the import; false brings it back'),
    })
    .refine((value) => value.sidecarId !== undefined || value.skip !== undefined, 'Choose a sidecar or a skip decision')
    .meta({ id: 'TakeoutResolveDto' }),
) {}

export class TakeoutPairDecisionDto extends createZodDto(
  z
    .object({
      photoItemId: z.uuid().describe('The still photo'),
      videoItemId: z.uuid().describe('The motion video'),
      approve: z.boolean().describe('True links them as one Live Photo; false keeps them separate'),
    })
    .meta({ id: 'TakeoutPairDecisionDto' }),
) {}

export const TakeoutSourceSchema = z
  .object({
    id: z.uuid(),
    name: z.string().describe('The archive’s file name, or the directory’s name'),
    kind: TakeoutSourceKindSchema,
    size: z.int().describe('Declared archive size in bytes; zero for a directory'),
    received: z.int().describe('Bytes staged so far; an upload resumes here'),
    scanned: z.boolean().describe('Every entry has been read'),
    rejected: z.int().describe('Entries refused: unsafe names, links or encryption'),
  })
  .meta({ id: 'TakeoutSourceResponseDto' });
export class TakeoutSourceResponseDto extends createZodDto(TakeoutSourceSchema) {}

const TakeoutAlbumSchema = z
  .object({
    folder: z.string().describe('The export folder'),
    name: z.string().describe('The album name it becomes'),
    count: z.int().describe('Items in the folder'),
    selected: z.boolean().describe('Recreated by the next import'),
    year: z.boolean().describe('One of Google’s automatic year folders'),
  })
  .meta({ id: 'TakeoutAlbumDto' });

const TakeoutCountsSchema = z
  .object({
    files: z.int().describe('Files found in the sources'),
    items: z.int().describe('Photos and videos'),
    ready: z.int(),
    review: z.int(),
    importing: z.int(),
    imported: z.int(),
    matched: z.int(),
    skipped: z.int(),
    failed: z.int(),
    newAssets: z.int().describe('Items still to import that are not in the library yet'),
    matchedOriginals: z.int().describe('Items already in the library, whose album memberships are restored'),
    suggestedPairs: z.int().describe('Possible Live Photo pairs awaiting a decision'),
    unresolvedPairs: z.int().describe('Live Photo pairs that could not be linked'),
    hiddenLocked: z.int().describe('Items going into Locked, not listed until Locked is unlocked'),
    rejected: z.int().describe('Archive entries refused'),
  })
  .meta({ id: 'TakeoutCountsDto' });

export const TakeoutResponseSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    state: TakeoutStateSchema,
    phase: TakeoutPhaseSchema,
    action: TakeoutActionSchema.nullable().describe('What the latest job did or is doing'),
    operationId: z.uuid().nullable().describe('The latest job, as Activity lists it'),
    processed: z.int().describe('Units the latest job has finished'),
    total: z.int().nullable().describe('Units the latest job knows of so far; grows while a scan reads its sources'),
    error: z.string().nullable(),
    errorCode: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    counts: TakeoutCountsSchema,
    sources: z.array(TakeoutSourceSchema),
    options: TakeoutOptionsResponseSchema,
    albums: z.array(TakeoutAlbumSchema),
  })
  .meta({ id: 'TakeoutResponseDto' });
export class TakeoutResponseDto extends createZodDto(TakeoutResponseSchema) {}

const TakeoutCandidateSchema = z
  .object({ id: z.uuid(), path: z.string(), metadata: TakeoutMetadataSchema })
  .meta({ id: 'TakeoutSidecarCandidateDto' });

const TakeoutItemSchema = z
  .object({
    id: z.uuid(),
    path: z.string().describe('Path inside the export'),
    folder: z.string(),
    source: z.string().describe('The archive or directory the file came from'),
    kind: TakeoutItemKindSchema,
    size: z.int(),
    state: TakeoutItemStateSchema,
    assetId: z.uuid().nullable().describe('The library item it became or matched, when this session may open it'),
    metadata: TakeoutMetadataSchema,
    candidates: z.array(TakeoutCandidateSchema),
    sidecarId: z.uuid().nullable(),
    albums: z.array(z.string()),
    warnings: z.array(TakeoutWarningSchema),
    locked: z.boolean(),
    error: z.string().nullable(),
  })
  .meta({ id: 'TakeoutItemResponseDto' });

export class TakeoutItemsResponseDto extends createZodDto(
  z
    .object({ items: z.array(TakeoutItemSchema), total: z.int(), hiddenLocked: z.int() })
    .meta({ id: 'TakeoutItemsResponseDto' }),
) {}

const TakeoutPairSchema = z
  .object({
    photoItemId: z.uuid(),
    videoItemId: z.uuid(),
    photoPath: z.string(),
    videoPath: z.string(),
    state: TakeoutPairStateSchema,
    error: z.string().nullable(),
  })
  .meta({ id: 'TakeoutPairResponseDto' });

export class TakeoutPairsResponseDto extends createZodDto(
  z.object({ pairs: z.array(TakeoutPairSchema), total: z.int() }).meta({ id: 'TakeoutPairsResponseDto' }),
) {}

export class TakeoutRootsResponseDto extends createZodDto(
  z
    .object({
      roots: z.array(
        z
          .object({ id: z.string(), path: z.string().describe('The directory the administrator permitted') })
          .meta({ id: 'TakeoutRootDto' }),
      ),
    })
    .meta({ id: 'TakeoutRootsResponseDto' }),
) {}

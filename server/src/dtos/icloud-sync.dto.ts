import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationStatusSchema } from 'src/enum.js';

/** FL-1724: downloads at once, per connection and (by default) across the server; most servers keep up. */
export const ICLOUD_MAX_CONCURRENCY = 100;

export const ICloudConfigSchema = z
  .object({
    libraries: z.array(z.string().min(1).max(1024)).max(100).default([]),
    albums: z.array(z.string().min(1).max(1024)).max(10_000).default([]),
    includeEdits: z.boolean().default(true),
    /** Kept so saved connections and older clients stay valid. Hidden photos always import, as Locked. */
    includeHidden: z.boolean().default(false),
    recoverExternalAsManaged: z.boolean().default(false),
    intervalHours: z.number().int().min(1).max(8760).default(24),
    /** FL-539: "By itself" (checked in the overnight run) or "Only when I ask" (false). */
    automatic: z.boolean().default(true),
    concurrency: z.number().int().min(1).max(ICLOUD_MAX_CONCURRENCY).default(10),
    stagingBytes: z
      .number()
      .int()
      .min(1024 ** 2)
      .max(Number.MAX_SAFE_INTEGER)
      .default(20 * 1024 ** 3),
  })
  .strict();
export type ICloudConfig = z.infer<typeof ICloudConfigSchema>;

const ConfigFieldsSchema = z
  .object({
    libraries: ICloudConfigSchema.shape.libraries.unwrap(),
    albums: ICloudConfigSchema.shape.albums.unwrap(),
    includeEdits: ICloudConfigSchema.shape.includeEdits.unwrap(),
    includeHidden: ICloudConfigSchema.shape.includeHidden.unwrap(),
    recoverExternalAsManaged: ICloudConfigSchema.shape.recoverExternalAsManaged.unwrap(),
    intervalHours: ICloudConfigSchema.shape.intervalHours.unwrap(),
    automatic: ICloudConfigSchema.shape.automatic.unwrap(),
    concurrency: ICloudConfigSchema.shape.concurrency.unwrap(),
    stagingBytes: ICloudConfigSchema.shape.stagingBytes.unwrap(),
  })
  .strict();

export class ICloudConnectionCreateDto extends createZodDto(
  z
    .object({
      label: z.string().trim().min(1).max(100),
      config: ICloudConfigSchema.default(ICloudConfigSchema.parse({})),
    })
    .strict()
    .meta({ id: 'ICloudConnectionCreateDto' }),
) {}

export class ICloudConnectionUpdateDto extends createZodDto(
  z
    .object({
      label: z.string().trim().min(1).max(100).optional(),
      config: ConfigFieldsSchema.partial().optional(),
    })
    .strict()
    .meta({ id: 'ICloudConnectionUpdateDto' }),
) {}

export class ICloudIdentityReuseAuthorityDto extends createZodDto(
  z
    .object({ enabled: z.boolean(), includeProtected: z.boolean(), requestKey: z.uuid() })
    .strict()
    .refine((value) => value.enabled || !value.includeProtected, { message: 'Disabled consent has no protected scope' })
    .meta({ id: 'ICloudIdentityReuseAuthorityDto' }),
) {}

const IdentityReuseAuthorityStatusSchema = z.object({
  enabled: z.boolean(),
  includeProtected: z.boolean(),
  available: z.boolean(),
  regrantRequired: z.boolean(),
  executionAvailable: z
    .literal(false)
    .describe('Foundation consent does not enable weekly execution or identity reuse'),
});
export class ICloudIdentityReuseAuthorityStatusDto extends createZodDto(IdentityReuseAuthorityStatusSchema) {}

export class ICloudAuthDto extends createZodDto(
  z
    .object({
      action: z.enum(['login', 'two-factor', 'device-approval', 'validate']).meta({ id: 'ICloudAuthAction' }),
      appleId: z.email().max(320).optional(),
      password: z.string().min(1).max(1024).optional(),
      code: z
        .string()
        .regex(/^\d{6}$/)
        .optional(),
    })
    .strict()
    .refine((value) => value.action !== 'login' || !!(value.appleId && value.password), {
      message: 'Apple ID and password required for login',
    })
    .refine((value) => value.action !== 'two-factor' || !!value.code, { message: 'Verification code required' })
    .meta({ id: 'ICloudAuthDto' }),
) {}

export class ICloudControlDto extends createZodDto(
  z
    .object({
      action: z.enum(['run', 'pause', 'resume', 'cancel', 'rescan', 'retry']).meta({ id: 'ICloudControlAction' }),
    })
    .strict()
    .meta({ id: 'ICloudControlDto' }),
) {}

/** A personal library or an iCloud Shared Photo Library (FL-68). */
const ICloudLibraryAreaSchema = z.enum(['private', 'shared']).meta({ id: 'ICloudLibraryArea' });

/**
 * What a reconciliation finding is (FL-68): an item to review, one that failed or is unsupported, one
 * kept in the trash here although iCloud still has it, or one deleted in iCloud that stayed here.
 */
const ICloudReviewKindSchema = z
  .enum(['review', 'failed', 'unsupported', 'kept-trashed', 'source-removed'])
  .meta({ id: 'ICloudReviewKind' });

const ICloudReviewGroupSchema = z
  .enum(['match', 'live-photo', 'stack', 'details', 'edits', 'storage', 'other'])
  .meta({ id: 'ICloudReviewGroup' });
const ICloudReviewDifferenceFieldSchema = z
  .enum(['date-taken', 'favorite', 'live-video', 'edits'])
  .meta({ id: 'ICloudReviewDifferenceField' });
const ICloudReviewEffectSchema = z
  .enum(['use-existing', 'keep-current', 'try-again'])
  .describe('What accepting this photo does')
  .meta({ id: 'ICloudReviewEffect' });

export class ICloudReviewQueryDto extends createZodDto(
  z
    .object({
      group: ICloudReviewGroupSchema.optional(),
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(200).default(48),
    })
    .strict()
    .meta({ id: 'ICloudReviewQueryDto' }),
) {}

export class ICloudReviewPageResponseDto extends createZodDto(
  z
    .object({
      total: z.int().min(0).describe('Photos in view, each counted once'),
      page: z.int().min(1),
      pages: z.int().min(1),
      size: z.int().min(1),
      groups: z.array(z.object({ group: ICloudReviewGroupSchema, count: z.int().min(0) })),
      effects: z.object({ useExisting: z.int().min(0), keepCurrent: z.int().min(0), tryAgain: z.int().min(0) }),
      privateWaiting: z.int().min(0).describe('Locked or hidden photos in review that need an unlocked session'),
      hiddenLocked: z.int().min(0).describe('Photos hidden in iCloud that are Locked here'),
      items: z.array(
        z.object({
          resourceId: z.uuid(),
          group: ICloudReviewGroupSchema,
          effect: ICloudReviewEffectSchema,
          reason: z.string(),
          fileName: z.string().nullable(),
          takenAt: z.string().nullable(),
          previewAssetId: z.uuid().nullable().describe('The library photo to show; null when there is none yet'),
          icloudAssetId: z
            .uuid()
            .nullable()
            .describe('The photo as copied from iCloud; null when it is not in the library yet'),
          relatedAssetIds: z
            .array(z.uuid())
            .describe('Up to 4 library photos it sits with: its stack, or the latest edits kept'),
          differences: z
            .array(
              z.object({
                field: ICloudReviewDifferenceFieldSchema,
                icloud: z
                  .string()
                  .nullable()
                  .describe('Value in iCloud: an ISO date, true/false, a file name or a count'),
                library: z.string().nullable().describe('Value in the library, in the same form'),
              }),
            )
            .describe('Only what differs between the iCloud copy and the library copy'),
          fileSize: z.int().min(0).nullable().describe('Size of the file in iCloud, in bytes'),
          camera: z.string().nullable(),
        }),
      ),
    })
    .meta({ id: 'ICloudReviewPageResponseDto' }),
) {}

export class ICloudReviewAcceptDto extends createZodDto(
  z
    .object({
      resourceIds: z.array(z.uuid()).min(1).max(200).optional().describe('The photos to accept'),
      all: z.literal(true).optional().describe('Accept every photo in view instead of a list'),
      group: ICloudReviewGroupSchema.optional().describe('With all: only this reason'),
      exceptResourceIds: z.array(z.uuid()).max(10_000).optional().describe('With all: photos left for later'),
    })
    .strict()
    .refine((value) => !!value.resourceIds !== !!value.all, { message: 'Send resourceIds or all, not both' })
    .refine((value) => !!value.all || (!value.group && !value.exceptResourceIds), {
      message: 'group and exceptResourceIds go with all',
    })
    .meta({ id: 'ICloudReviewAcceptDto' }),
) {}

export class ICloudReviewAcceptResponseDto extends createZodDto(
  z
    .object({
      accepted: z.int().min(0).describe('Photos settled'),
      requeued: z.int().min(0).describe('Of those, photos going back through a sync'),
    })
    .meta({ id: 'ICloudReviewAcceptResponseDto' }),
) {}

/**
 * The connection's current or most recent run (FL-68): a durable media operation, the same row
 * Activity and the notifications panel show. Only its state; never a path, a file or a credential.
 */
const RunSchema = z
  .object({
    id: z.uuid().describe('Media operation ID of the run'),
    status: MediaOperationStatusSchema,
    progress: z
      .number()
      .meta({ format: 'double' })
      .describe('0 to 100, from resources settled out of those known so far'),
    processedUnits: z.number().int().describe('Resources settled so far'),
    totalUnits: z.number().int().nullable().describe('Resources known so far; null until the inventory is counted'),
    retrying: z.boolean().describe('Back in the queue for its automatic retry after a failure'),
    waiting: z.boolean().describe('Handed back to wait for the provider or a backed-off item'),
    pauseRequested: z.boolean().describe('A pause was asked for and the worker has not reached it yet'),
    errorCode: z.string().nullable().describe('Stable failure code, translated by the client'),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'ICloudSyncRunDto' });

const ConnectionSchema = z
  .object({
    id: z.uuid(),
    label: z.string(),
    state: z.string(),
    authenticated: z.boolean().describe('Whether an encrypted Apple session is stored; the session is never returned'),
    config: ConfigFieldsSchema,
    lastError: z.string().nullable(),
    nextRunAt: z.string().nullable(),
    counts: z.record(z.string(), z.number().int()),
    run: RunSchema.nullable().describe('The current or most recent sync run'),
    identityReuseAuthority: IdentityReuseAuthorityStatusSchema.optional(),
  })
  .meta({ id: 'ICloudConnectionResponseDto' });
export class ICloudConnectionResponseDto extends createZodDto(ConnectionSchema) {}
export class ICloudConnectionsResponseDto extends createZodDto(
  z
    .object({
      enabled: z.boolean(),
      connections: z.array(ConnectionSchema),
    })
    .meta({ id: 'ICloudConnectionsResponseDto' }),
) {}
export class ICloudSyncActivityResponseDto extends createZodDto(
  z
    .object({ running: z.int().min(0).describe('Syncs on this server, for any account, that are running or queued') })
    .meta({ id: 'ICloudSyncActivityResponseDto' }),
) {}
export class ICloudInventoryResponseDto extends createZodDto(
  z
    .object({
      libraries: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          area: ICloudLibraryAreaSchema,
          supported: z.boolean(),
        }),
      ),
      albums: z.array(
        z.object({ id: z.string(), libraryId: z.string(), name: z.string(), parentId: z.string().nullable() }),
      ),
      complete: z.boolean(),
      recent: z
        .array(z.object({ assetId: z.uuid(), resourceId: z.uuid(), outcome: z.string(), fileName: z.string() }))
        .optional(),
      review: z
        .array(
          z.object({
            resourceId: z.uuid(),
            kind: ICloudReviewKindSchema,
            reason: z.string().nullable(),
            fileName: z.string().nullable(),
            role: z.string(),
            assetId: z.uuid().nullable(),
          }),
        )
        .describe('Reconciliation findings; private items only for an unlocked session'),
    })
    .meta({ id: 'ICloudInventoryResponseDto' }),
) {}

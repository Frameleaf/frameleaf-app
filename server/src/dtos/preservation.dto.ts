import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationSchema } from 'src/dtos/media-operation.dto.js';
import { SearchFilterSchema } from 'src/dtos/search.dto.js';
import {
  PRESERVATION_CONFLICT_FIELDS,
  PRESERVATION_MAX_ITEMS,
  PRESERVATION_SUPPORT_CATEGORIES,
  PRESERVATION_SUPPORT_LEVELS,
} from 'src/utils/preservation.js';

/**
 * Preservation packages (FL-74, `IMP-006`).
 *
 * Writing, verifying, reviewing and restoring a package are durable media operations, so these
 * DTOs describe a request to start one and what the package, its items and a restoration look
 * like. No server path ever appears here: a package's files are reached only through its
 * owner-scoped download routes. A session that has not unlocked is never told about a Locked item:
 * it is left out of every list and every count.
 */

const IdentifierSchema = z
  .string()
  .regex(/^[\w.:-]{1,128}$/)
  .describe('Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters');

const NameSchema = z.string().trim().min(1).max(120);

export const PreservationPackageOriginSchema = z
  .enum(['export', 'upload', 'server'])
  .describe(
    '`export`: written by this server; `upload`: a package you uploaded; `server`: a package an administrator named on this server',
  )
  .meta({ id: 'PreservationPackageOrigin' });

export const PreservationPackageStatusSchema = z
  .enum(['building', 'ready', 'incomplete', 'unreadable', 'removed'])
  .describe(
    '`building`: being written or not yet read; `ready`: every selected item is in it; `incomplete`: some items could not be copied; `unreadable`: its manifest or index could not be believed; `removed`: its files were deleted',
  )
  .meta({ id: 'PreservationPackageStatus' });

const PreservationPackageFormatSchema = z
  .enum(['directory', 'zip'])
  .describe('How the package is stored on this server')
  .meta({ id: 'PreservationPackageFormat' });

const PreservationItemStateSchema = z
  .enum(['pending', 'copied', 'failed', 'skipped', 'listed'])
  .describe('`pending`, `copied`, `failed` or `skipped` for an export; `listed` for an item read from a package')
  .meta({ id: 'PreservationItemState' });

const PreservationVerifyStateSchema = z
  .enum(['ok', 'missing', 'changed'])
  .describe('The latest verification of this item')
  .meta({ id: 'PreservationVerifyState' });

const PreservationVerificationStatusSchema = z
  .enum(['verified', 'problems', 'unreadable'])
  .describe(
    '`verified`: every file matches; `problems`: some are missing or changed; `unreadable`: the manifest or index cannot be believed',
  )
  .meta({ id: 'PreservationVerificationStatus' });

const PreservationSupportLevelSchema = z
  .enum(PRESERVATION_SUPPORT_LEVELS)
  .describe(
    '`restored`: comes back as it was; `restored-when-empty`: only where the library has none; `provenance-only`: kept as a record, never applied; `not-included`: not in a package',
  )
  .meta({ id: 'PreservationSupportLevel' });

const PreservationSupportCategorySchema = z
  .enum(PRESERVATION_SUPPORT_CATEGORIES)
  .describe('A kind of information a package may carry')
  .meta({ id: 'PreservationSupportCategory' });

const PreservationSupportSchema = z
  .object({ category: PreservationSupportCategorySchema, level: PreservationSupportLevelSchema })
  .meta({ id: 'PreservationSupportDto' });

const PreservationScopeSchema = z
  .object({
    filter: SearchFilterSchema.optional().describe(
      'Your items matching these conditions; the whole library when empty',
    ),
    assetIds: z
      .array(z.uuidv4())
      .min(1)
      .max(PRESERVATION_MAX_ITEMS)
      .optional()
      .describe('Exactly these items of yours, instead of a filter'),
  })
  .refine((scope) => !(scope.filter && scope.assetIds), 'Choose a filter or items, not both')
  .describe('What to preserve. Only your own items are ever included: never a partner’s or a shared album’s.')
  .meta({ id: 'PreservationScopeDto' });

const PreservationPreviewSchema = z
  .object({
    scope: PreservationScopeSchema.optional(),
    includeLocked: z.boolean().optional().describe('Count Locked items as included; needs an unlocked session'),
  })
  .meta({ id: 'PreservationPreviewDto' });

const PreservationPreviewResponseSchema = z
  .object({
    items: z.int().describe('Items matching, Locked ones not counted'),
    bytes: z.string(),
    lockedItems: z.int().describe('Locked items matching'),
    lockedBytes: z.string(),
    includedItems: z.int().describe('Items the export would include'),
    includedBytes: z.string(),
    maxItems: z.int(),
    withinLimit: z.boolean(),
    lockedAllowed: z.boolean().describe('This session is unlocked, so Locked items may be included'),
    freeBytes: z.string().nullable().describe('Free space where the package would be written'),
    support: z.array(PreservationSupportSchema),
  })
  .meta({ id: 'PreservationPreviewResponseDto' });

const PreservationExportCreateSchema = z
  .object({
    name: NameSchema,
    scope: PreservationScopeSchema.optional(),
    includeLocked: z
      .boolean()
      .optional()
      .describe('Include your Locked items. Needs an unlocked session; they are restored Locked.'),
    includeMetadata: z
      .boolean()
      .optional()
      .describe('Include metadata sidecars, albums, people, tags and edit recipes. Checksums are always included.'),
    requestKey: IdentifierSchema.optional().describe(
      'Idempotency key; a repeated submit answers with the first package',
    ),
  })
  .meta({ id: 'PreservationExportCreateDto' });

const PreservationPackageCountsSchema = z
  .object({
    total: z.int(),
    pending: z.int(),
    copied: z.int(),
    failed: z.int(),
    skipped: z.int(),
    listed: z.int(),
    locked: z.int(),
  })
  .meta({ id: 'PreservationPackageCountsDto' });

const PreservationManifestSummarySchema = z
  .object({
    packageId: z.uuid().describe('The package’s own identity, from its manifest'),
    createdAt: z.string().meta({ format: 'date-time' }),
    producerVersion: z.string(),
    complete: z.boolean().describe('Every selected item was written; a complete package can still be damaged later'),
    exported: z.int(),
    failed: z.int(),
    skipped: z.int(),
    locked: z.int(),
    includeMetadata: z.boolean(),
    includeLocked: z.boolean(),
    scopeDescription: z.string(),
  })
  .meta({ id: 'PreservationManifestSummaryDto' });

const PreservationVerificationSchema = z
  .object({
    status: PreservationVerificationStatusSchema,
    reasonKey: z.string().nullable(),
    checked: z.int(),
    ok: z.int(),
    missing: z.int(),
    changed: z.int(),
    unexpected: z.int().describe('Files in the package its manifest does not account for'),
    documentsChanged: z.array(z.string()).describe('Index documents whose digest no longer matches'),
    finishedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'PreservationVerificationDto' });

const PreservationPackageSchema = z
  .object({
    id: z.uuidv7(),
    name: z.string(),
    origin: PreservationPackageOriginSchema,
    status: PreservationPackageStatusSchema,
    format: PreservationPackageFormatSchema,
    sizeBytes: z.string().nullable(),
    includeLocked: z.boolean(),
    includeMetadata: z.boolean(),
    scopeDescription: z.string().nullable(),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
    expiresAt: z.string().meta({ format: 'date-time' }).nullable().describe('When an uploaded package is discarded'),
    counts: PreservationPackageCountsSchema,
    manifest: PreservationManifestSummarySchema.nullable(),
    verification: PreservationVerificationSchema.nullable(),
    operation: MediaOperationSchema.nullable().describe('The newest job on this package'),
    downloadable: z.boolean(),
    restorable: z.boolean(),
    lockedContent: z.boolean().describe('It holds Locked items: downloading it needs an unlocked session'),
    support: z.array(PreservationSupportSchema),
  })
  .meta({ id: 'PreservationPackageDto' });

const PreservationItemsQuerySchema = z
  .object({
    state: PreservationItemStateSchema.optional(),
    verifyState: PreservationVerifyStateSchema.optional(),
    take: z.coerce.number().int().min(1).max(200).optional(),
    skip: z.coerce.number().int().min(0).optional(),
  })
  .meta({ id: 'PreservationItemsQueryDto' });

const PreservationItemSchema = z
  .object({
    id: z.uuidv7(),
    sourceAssetId: z.uuid().nullable(),
    assetId: z.uuid().nullable(),
    name: z.string().nullable(),
    state: PreservationItemStateSchema,
    verifyState: PreservationVerifyStateSchema.nullable(),
    locked: z.boolean(),
    sizeBytes: z.string().nullable(),
    sha256: z.string().nullable(),
    reasonKey: z.string().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'PreservationItemDto' });

const PreservationItemsResponseSchema = z
  .object({
    items: z.array(PreservationItemSchema),
    total: z.int(),
  })
  .meta({ id: 'PreservationItemsResponseDto' });

const PreservationUploadCreateSchema = z
  .object({
    file: z.file().describe('A `.frameleaf-preservation.zip` package'),
  })
  .meta({ id: 'PreservationUploadCreateDto' });

const PreservationServerPackageCreateSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe('A package directory or ZIP file on this server, outside its media storage'),
    name: NameSchema.optional(),
  })
  .meta({ id: 'PreservationServerPackageCreateDto' });

const PreservationConflictDefaultSchema = z
  .enum(['keep', 'replace'])
  .describe('`keep` the library’s value, or `replace` it with the package’s')
  .meta({ id: 'PreservationDecision' });

const PreservationConflictFieldSchema = z
  .enum(PRESERVATION_CONFLICT_FIELDS)
  .describe('A field the package and the library can disagree about')
  .meta({ id: 'PreservationConflictField' });

const PreservationRestoreCreateSchema = z
  .object({
    packageId: z.uuidv7(),
    name: NameSchema.optional(),
    restoreEditRecipes: z.boolean().optional().describe('Restore edit recipes; edited versions are rendered again'),
    conflictDefault: PreservationConflictDefaultSchema.optional().describe(
      'What to do where the package and the library disagree and you have not chosen; `keep` when omitted',
    ),
    requestKey: IdentifierSchema.optional(),
  })
  .meta({ id: 'PreservationRestoreCreateDto' });

const PreservationRestoreStatusSchema = z
  .enum(['reviewing', 'ready', 'restoring', 'completed', 'unreadable'])
  .describe(
    '`reviewing`: the package is being checked; `ready`: review the findings, then restore; `restoring`; `completed`; `unreadable`: the package cannot be believed',
  )
  .meta({ id: 'PreservationRestoreStatus' });

const PreservationRestoreCountsSchema = z
  .object({
    total: z.int(),
    pending: z.int(),
    ready: z.int(),
    failed: z.int(),
    restored: z.int(),
    matched: z.int(),
    skipped: z.int(),
    new: z.int().describe('Originals the library does not hold'),
    existing: z.int().describe('Originals the library already holds; they are matched, never copied again'),
    trashed: z.int().describe('Originals the library holds in the trash; restore them from the trash first'),
    locked: z.int(),
    conflicts: z.int(),
    findings: z.int(),
  })
  .meta({ id: 'PreservationRestoreCountsDto' });

const PreservationRestoreSchema = z
  .object({
    id: z.uuidv7(),
    name: z.string(),
    packageId: z.uuidv7().nullable(),
    status: PreservationRestoreStatusSchema,
    restoreEditRecipes: z.boolean(),
    conflictDefault: PreservationConflictDefaultSchema,
    reasonKey: z.string().nullable(),
    albums: z.int().describe('Albums and collections in the package'),
    people: z.int().describe('Named people in the package'),
    counts: PreservationRestoreCountsSchema,
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
    operation: MediaOperationSchema.nullable().describe('The newest job on this restoration'),
    support: z.array(PreservationSupportSchema),
  })
  .meta({ id: 'PreservationRestoreDto' });

const PreservationRestoreItemsQuerySchema = z
  .object({
    filter: z.enum(['conflicts', 'failed', 'findings']).optional().meta({ id: 'PreservationRestoreItemFilter' }),
    take: z.coerce.number().int().min(1).max(200).optional(),
    skip: z.coerce.number().int().min(0).optional(),
  })
  .meta({ id: 'PreservationRestoreItemsQueryDto' });

const PreservationConflictSchema = z
  .object({
    field: PreservationConflictFieldSchema,
    archived: z.string().nullable().describe('The package’s value'),
    current: z.string().nullable().describe('The library’s value'),
    decision: PreservationConflictDefaultSchema.nullable().describe(
      'Your choice; the restoration default applies when null',
    ),
  })
  .meta({ id: 'PreservationConflictDto' });

const PreservationRestoreItemStateSchema = z
  .enum(['pending', 'ready', 'failed', 'creating', 'restored', 'matched', 'skipped'])
  .meta({ id: 'PreservationRestoreItemState' });

const PreservationRestoreItemSchema = z
  .object({
    id: z.uuidv7(),
    sourceAssetId: z.uuid().nullable(),
    assetId: z.uuid().nullable(),
    name: z.string().nullable(),
    state: PreservationRestoreItemStateSchema,
    match: z.enum(['new', 'existing', 'trashed']).meta({ id: 'PreservationRestoreMatch' }).nullable(),
    locked: z.boolean().describe('Locked in the package or in your library; listed only to an unlocked session'),
    applied: z.boolean(),
    conflicts: z.array(PreservationConflictSchema),
    findings: z.array(z.string()).describe('Translation keys for what the restore left for you to look at'),
    reasonKey: z.string().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'PreservationRestoreItemDto' });

const PreservationRestoreItemsResponseSchema = z
  .object({
    items: z.array(PreservationRestoreItemSchema),
    total: z.int(),
  })
  .meta({ id: 'PreservationRestoreItemsResponseDto' });

const PreservationDecisionsUpdateSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.uuidv7(),
            decisions: z.partialRecord(PreservationConflictFieldSchema, PreservationConflictDefaultSchema),
          })
          .meta({ id: 'PreservationItemDecisionsDto' }),
      )
      .max(500)
      .optional(),
    conflictDefault: PreservationConflictDefaultSchema.optional(),
    restoreEditRecipes: z.boolean().optional(),
  })
  .meta({ id: 'PreservationDecisionsUpdateDto' });

export class PreservationPreviewDto extends createZodDto(PreservationPreviewSchema) {}
export class PreservationPreviewResponseDto extends createZodDto(PreservationPreviewResponseSchema) {}
export class PreservationExportCreateDto extends createZodDto(PreservationExportCreateSchema) {}
export class PreservationPackageDto extends createZodDto(PreservationPackageSchema) {}
export class PreservationItemsQueryDto extends createZodDto(PreservationItemsQuerySchema) {}
export class PreservationItemDto extends createZodDto(PreservationItemSchema) {}
export class PreservationItemsResponseDto extends createZodDto(PreservationItemsResponseSchema) {}
export class PreservationUploadCreateDto extends createZodDto(PreservationUploadCreateSchema) {}
export class PreservationServerPackageCreateDto extends createZodDto(PreservationServerPackageCreateSchema) {}
export class PreservationRestoreCreateDto extends createZodDto(PreservationRestoreCreateSchema) {}
export class PreservationRestoreDto extends createZodDto(PreservationRestoreSchema) {}
export class PreservationRestoreItemsQueryDto extends createZodDto(PreservationRestoreItemsQuerySchema) {}
export class PreservationRestoreItemDto extends createZodDto(PreservationRestoreItemSchema) {}
export class PreservationRestoreItemsResponseDto extends createZodDto(PreservationRestoreItemsResponseSchema) {}
export class PreservationDecisionsUpdateDto extends createZodDto(PreservationDecisionsUpdateSchema) {}

export type PreservationSupport = z.infer<typeof PreservationSupportSchema>;
export type PreservationPackageCounts = z.infer<typeof PreservationPackageCountsSchema>;
export type PreservationRestoreCounts = z.infer<typeof PreservationRestoreCountsSchema>;

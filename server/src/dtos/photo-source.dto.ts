import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const folderKind = z.enum(['folder']).meta({ id: 'PhotoSourceKind' });
const applePhotosKind = z.enum(['apple-photos']).meta({ id: 'ApplePhotosSourceKind' });
const sourceKind = z.union([folderKind, applePhotosKind]);
const copyMode = z.enum(['copy']).meta({ id: 'PhotoSourceCopyMode' });
const runState = z.enum(['open', 'paused', 'cancelled', 'complete']).meta({ id: 'PhotoSourceRunState' });
const itemState = z.enum(['planned', 'verified']).meta({ id: 'PhotoSourceItemState' });
const storage = z.enum(['managed']).meta({ id: 'PhotoSourceStorage' });
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value));
/** FL-1030: the photo catalog (Lightroom Classic, Capture One, Apple Photos) a source reads, as the desktop names it. */
const catalogSchema = z
  .object({
    app: plainText(64).describe('The catalog app, as the desktop names it, for example "lightroom-classic"'),
    catalogId: plainText(256).describe("The desktop's stable identifier for the catalog"),
    name: plainText(256).describe("The catalog's name, shown to the person"),
  })
  .strict()
  .meta({ id: 'PhotoSourceCatalog' });
export const photoSourceCreateSchema = z
  .object({
    id: z.uuid(),
    deviceId: z.uuid(),
    kind: sourceKind,
    mode: copyMode,
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine((value) => !/\p{Cc}/u.test(value)),
    scopeFingerprint: fingerprint,
    catalog: catalogSchema.optional().describe('The photo catalog this source reads, when it reads one'),
  })
  .strict();
export type PhotoSourceCreateInput = z.infer<typeof photoSourceCreateSchema>;
export class PhotoSourceCreateDto extends createZodDto(photoSourceCreateSchema.extend({ kind: folderKind })) {}
export class ApplePhotosSourceCreateDto extends createZodDto(
  photoSourceCreateSchema.extend({ kind: applePhotosKind }),
) {}
export class PhotoSourceRunDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(2 ** 41),
      maxItems: z.number().int().min(1).max(100_000),
    })
    .strict(),
) {}
export class PhotoSourceItemDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      resourceKey: fingerprint,
      version: fingerprint,
      sha256: fingerprint,
      bytes: z
        .number()
        .int()
        .min(1)
        .max(2 ** 31),
    })
    .strict(),
) {}
export class PhotoSourceVerifyDto extends createZodDto(z.object({ uploadResourceId: z.uuid() }).strict()) {}
export class PhotoSourceRunStateDto extends createZodDto(
  z.object({ state: runState, inventoryComplete: z.boolean() }).strict(),
) {}
export const photoSourceViewSchema = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  kind: sourceKind,
  mode: copyMode,
  name: z.string(),
  scopeFingerprint: fingerprint,
  catalog: catalogSchema.optional().describe('The photo catalog this source reads, when it reads one'),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
const runView = z.object({
  id: z.uuid(),
  sourceId: z.uuid(),
  maxBytes: z.number().int(),
  maxItems: z.number().int(),
  state: runState,
  inventoryComplete: z.boolean(),
  createdAt: z.iso.datetime(),
});
const itemView = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  resourceKey: fingerprint,
  version: fingerprint,
  sha256: fingerprint,
  bytes: z.number().int(),
  state: itemState,
  verifiedAt: z.iso.datetime().nullable(),
});
export type PhotoSourceCreateResult = z.infer<typeof photoSourceViewSchema>;
export class PhotoSourceResponseDto extends createZodDto(photoSourceViewSchema.extend({ kind: folderKind })) {}
export class ApplePhotosSourceResponseDto extends createZodDto(
  photoSourceViewSchema.extend({ kind: applePhotosKind }),
) {}
export class PhotoSourceRunResponseDto extends createZodDto(runView) {}
export class PhotoSourceItemResponseDto extends createZodDto(itemView) {}
export class PhotoSourceSnapshotDto extends createZodDto(
  z.object({
    run: runView,
    items: z.array(itemView.omit({ runId: true, sha256: true })),
    nextCursor: z.uuid().nullable(),
  }),
) {}
export class PhotoSourceReceiptDto extends createZodDto(
  z.object({
    sourceId: z.uuid(),
    runId: z.uuid(),
    itemId: z.uuid(),
    uploadResourceId: z.uuid(),
    assetId: z.uuid(),
    ownerId: z.uuid(),
    serverId: z.string(),
    sha256: fingerprint,
    bytes: z.number().int(),
    verifiedAt: z.iso.datetime(),
    storage,
  }),
) {}
export class PhotoSourceRunParamsDto extends createZodDto(z.object({ id: z.uuid(), runId: z.uuid() })) {}
export class PhotoSourceItemParamsDto extends createZodDto(
  z.object({ id: z.uuid(), runId: z.uuid(), itemId: z.uuid() }),
) {}
export class PhotoSourceCursorDto extends createZodDto(z.object({ after: z.uuid().optional() })) {}

/** FL-1030: what a catalog says about one copied item. Every field is optional; an absent field changes nothing. */
const catalogItemSchema = z
  .object({
    itemId: z.uuid().describe('The source item (as planned for a copy run) the catalog entry describes'),
    rating: z.int().min(0).max(5).optional().describe('Star rating, 0 (unrated) to 5'),
    flag: z
      .enum(['pick', 'reject'])
      .nullable()
      .optional()
      .describe('Pick or reject flag; null when the item has neither')
      .meta({ id: 'PhotoSourceCatalogFlag' }),
    colorLabel: plainText(64).optional().describe('Colour label name, for example "Red"'),
    keywords: z
      .array(plainText(1024))
      .max(500)
      .optional()
      .describe('Keywords; a hierarchy is separated by "|", for example "Places|France|Paris"'),
    title: z.string().trim().max(2000).optional().describe('Title'),
    caption: z.string().trim().max(10_000).optional().describe('Caption'),
    collections: z
      .array(
        z
          .object({
            path: z
              .array(plainText(255))
              .max(16)
              .describe('The collection sets the collection sits in, outermost first'),
            name: plainText(255).describe('The collection name'),
          })
          .strict(),
      )
      .max(200)
      .optional()
      .describe('Collections (albums) the item is in'),
  })
  .strict();
export class PhotoSourceCatalogMetadataDto extends createZodDto(
  z
    .object({
      items: z
        .array(catalogItemSchema)
        .min(1)
        .max(500)
        .refine((items) => new Set(items.map(({ itemId }) => itemId.toLowerCase())).size === items.length, {
          error: 'Each item may appear once',
        })
        .describe('Up to 500 catalog entries'),
    })
    .strict()
    .meta({ id: 'PhotoSourceCatalogMetadataDto' }),
) {}
export type PhotoSourceCatalogItem = z.infer<typeof catalogItemSchema>;
const catalogItemStatus = z
  .enum(['applied', 'unchanged', 'keptEdits', 'notReady', 'notFound'])
  .meta({ id: 'PhotoSourceCatalogItemStatus' });
export type PhotoSourceCatalogItemStatus = z.infer<typeof catalogItemStatus>;
const catalogField = z.enum(['rating', 'description', 'tags', 'albums']).meta({ id: 'PhotoSourceCatalogField' });
export type PhotoSourceCatalogField = z.infer<typeof catalogField>;
export class PhotoSourceCatalogMetadataResponseDto extends createZodDto(
  z
    .object({
      summary: z
        .object({
          applied: z.int().describe('Items where at least one field was written'),
          unchanged: z.int().describe('Items already as the catalog says'),
          keptEdits: z
            .int()
            .describe('Items left as they are because the person changed a field in Frameleaf since the last read-in'),
          notReady: z.int().describe('Items whose copy is not verified yet; send them again after verification'),
          notFound: z.int().describe('Items unknown to this source, or whose photo is gone or not available to change'),
        })
        .meta({ id: 'PhotoSourceCatalogSummary' }),
      items: z.array(
        z
          .object({
            itemId: z.uuid(),
            status: catalogItemStatus,
            applied: z.array(catalogField).describe('Fields written for this item'),
            keptEdits: z.array(catalogField).describe("Fields left alone because the person's own change wins"),
          })
          .meta({ id: 'PhotoSourceCatalogItemResult' }),
      ),
    })
    .meta({ id: 'PhotoSourceCatalogMetadataResponseDto' }),
) {}

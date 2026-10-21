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

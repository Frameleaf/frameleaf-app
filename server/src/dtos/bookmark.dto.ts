import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { LibraryScope, LibraryScopeSchema } from 'src/enum.js';

// Stored references only; validation never fetches a caller-supplied URL.
const referenceUrl = z
  .string()
  .max(8192)
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'Expected an HTTP(S) URL without credentials');

const bookmarkFields = z.object({
  url: referenceUrl,
  title: z.string().max(2000),
  note: z.string().max(20_000).nullable().optional(),
  previewAssetId: z.uuidv4().nullable().optional(),
  libraryScope: LibraryScopeSchema,
  isArchived: z.boolean().optional(),
  isLocked: z.boolean().optional(),
});

export class BookmarkCreateDto extends createZodDto(
  bookmarkFields
    .extend({ libraryScope: LibraryScopeSchema.default(LibraryScope.Design) })
    .meta({ id: 'BookmarkCreateDto' }),
) {}
export class BookmarkUpdateDto extends createZodDto(bookmarkFields.partial().meta({ id: 'BookmarkUpdateDto' })) {}

export const BookmarkResponseSchema = z
  .object({
    id: z.uuidv4(),
    ownerId: z.uuidv4(),
    url: z.string(),
    title: z.string(),
    note: z.string().nullable(),
    previewAssetId: z.uuidv4().nullable(),
    libraryScope: LibraryScopeSchema,
    isArchived: z.boolean(),
    isLocked: z.boolean(),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
    deletedAt: z.string().nullable().meta({ format: 'date-time' }),
    updateId: z.string(),
  })
  .meta({ id: 'BookmarkResponseDto' });
export class BookmarkResponseDto extends createZodDto(BookmarkResponseSchema) {}

export class BookmarkTagsDto extends createZodDto(
  z.object({ ids: z.array(z.uuidv4()).max(500) }).meta({ id: 'BookmarkTagsDto' }),
) {}

export class CaptureSourceDto extends createZodDto(
  z
    .object({
      captureId: z.uuidv4(),
      pageUrl: referenceUrl,
      mediaUrl: referenceUrl.nullable().optional(),
      title: z.string().max(2000),
      capturedAt: z.iso.datetime({ offset: true }),
      note: z.string().max(20_000).nullable().optional(),
      creator: z.string().max(2000).nullable().optional(),
      licenseUrl: referenceUrl.nullable().optional(),
    })
    .meta({ id: 'CaptureSourceDto' }),
) {}

export class AssetSourceResponseDto extends createZodDto(
  CaptureSourceDto.schema
    .extend({
      id: z.uuidv4(),
      assetId: z.uuidv4(),
      createdAt: z.string().meta({ format: 'date-time' }),
    })
    .meta({ id: 'AssetSourceResponseDto' }),
) {}

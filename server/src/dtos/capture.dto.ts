import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AlbumResponseSchema } from 'src/dtos/album.dto.js';
import { BookmarkCreateDto, CaptureSourceDto } from 'src/dtos/bookmark.dto.js';
import { LibraryItemSchema } from 'src/dtos/library-item.dto.js';
import { TagResponseSchema } from 'src/dtos/tag.dto.js';
import { LibraryScope } from 'src/enum.js';

export class CaptureCommitDto extends createZodDto(
  z
    .object({
      captureId: z.uuidv4(),
      uploadResourceId: z.uuidv4().optional(),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe('Required for file captures; the complete uploaded file SHA-256'),
      bookmark: BookmarkCreateDto.schema.pick({ url: true, title: true }).strict().optional(),
      albumId: z.uuidv4(),
      tagIds: z.array(z.uuidv4()).max(500).default([]),
      source: CaptureSourceDto.schema.omit({ captureId: true, note: true }).strict(),
      note: z.string().max(20_000).optional(),
    })
    .strict()
    .refine(
      ({ captureId, uploadResourceId, bookmark, sha256 }) =>
        uploadResourceId ? !bookmark && uploadResourceId === captureId && !!sha256 : !!bookmark && sha256 === undefined,
      'One bookmark, or the capture upload UUID and SHA-256, is required',
    )
    .meta({ id: 'CaptureCommitDto' }),
) {}

export class CaptureResponseDto extends createZodDto(
  z
    .object({
      captureId: z.uuidv4(),
      item: LibraryItemSchema,
      status: z.enum(['created', 'duplicate']).meta({ id: 'CaptureStatus' }),
    })
    .meta({ id: 'CaptureResponseDto' }),
) {}

export class CaptureCancelResponseDto extends createZodDto(
  z
    .object({
      captureId: z.uuidv4(),
      status: z.enum(['cancelled', 'already-published']).meta({ id: 'CaptureCancelStatus' }),
      receipt: CaptureResponseDto.schema.optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.status === 'cancelled' ? value.receipt === undefined : value.receipt?.captureId === value.captureId,
      'Cancellation must contain either no published item or its matching receipt',
    )
    .meta({ id: 'CaptureCancelResponseDto' }),
) {}

export class CaptureCapabilitiesDto extends createZodDto(
  z
    .object({
      version: z.literal(1).meta({ id: 'CaptureProtocolVersion' }),
      serverId: z.string(),
      userId: z.uuidv4(),
      userName: z.string().optional().describe('Account name, shown as "Signed in as" in the browser extension'),
      maxFileBytes: z.int().min(0),
      captureSupported: z.literal(true),
      cancellationSupported: z.literal(true).optional(),
    })
    .meta({ id: 'CaptureCapabilitiesDto' }),
) {}

export class CaptureAlbumCreateDto extends createZodDto(
  z
    .object({
      name: z.string().trim().min(1).max(255),
      parentId: z.uuidv4().optional(),
      libraryScope: z.literal(LibraryScope.Design).meta({ id: 'CaptureAlbumScope' }),
    })
    .strict()
    .meta({ id: 'CaptureAlbumCreateDto' }),
) {}

export class CaptureCatalogDto extends createZodDto(
  z
    .object({
      albums: z.array(
        AlbumResponseSchema.pick({ id: true, albumName: true, parentId: true, icon: true, color: true }).meta({
          id: 'CaptureAlbumChoice',
        }),
      ),
      tags: z.array(TagResponseSchema),
    })
    .meta({ id: 'CaptureCatalogDto' }),
) {}

export class CaptureUploadStateDto extends createZodDto(
  z
    .object({
      id: z.uuidv4(),
      offset: z.int().min(0),
      ready: z.boolean(),
      expiresAt: z.string().meta({ format: 'date-time' }),
    })
    .meta({ id: 'CaptureUploadStateDto' }),
) {}

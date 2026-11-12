import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** FL-813: at most this many items per page of the skip list, and per "Allow again" request. */
export const UPLOAD_SKIP_PAGE_MAX = 500;

const UploadSkipListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(UPLOAD_SKIP_PAGE_MAX).default(50).describe('Items per page'),
    offset: z.coerce.number().int().min(0).default(0).describe('Items to pass over, latest deletion first'),
  })
  .meta({ id: 'UploadSkipListDto' });

const UploadSkipItemSchema = z
  .object({
    checksum: z
      .string()
      .describe('The deleted file, as the hex digest of its bytes (SHA-256; SHA-1 for items stored before it)'),
    deletedAt: z.string().meta({ format: 'date-time' }).describe('When it was last permanently deleted'),
    wasLocked: z.boolean().describe('Whether it was Locked when it was deleted'),
  })
  .meta({ id: 'UploadSkipItemDto' });

const UploadSkipListResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether deleted items are refused when uploaded again'),
    items: z.array(UploadSkipItemSchema).describe('This page of the list, latest deletion first'),
    total: z.int().min(0).describe('How many items the whole list holds for this session'),
  })
  .meta({ id: 'UploadSkipListResponseDto' });

const UploadSkipAllowSchema = z
  .object({
    checksums: z
      .array(z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/i, 'A hex SHA-256 or SHA-1 digest'))
      .min(1)
      .max(UPLOAD_SKIP_PAGE_MAX)
      .describe('Items from the list to allow again, by checksum'),
  })
  .meta({ id: 'UploadSkipAllowDto' });

const UploadSkipAllowResponseSchema = z
  .object({
    allowed: z.int().min(0).describe('How many of them were on the list and may now be uploaded again'),
  })
  .meta({ id: 'UploadSkipAllowResponseDto' });

export class UploadSkipListDto extends createZodDto(UploadSkipListQuerySchema) {}
export class UploadSkipListResponseDto extends createZodDto(UploadSkipListResponseSchema) {}
export class UploadSkipAllowDto extends createZodDto(UploadSkipAllowSchema) {}
export class UploadSkipAllowResponseDto extends createZodDto(UploadSkipAllowResponseSchema) {}

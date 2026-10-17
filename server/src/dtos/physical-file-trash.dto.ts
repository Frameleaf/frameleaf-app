import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * Library Care file trash (universal storage, spec §3.5): originals nothing references any more wait
 * here until an administrator restores them or deletes them permanently. Nothing is deleted
 * automatically.
 */

const FileTrashListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).describe('Page number, from 1'),
    size: z.coerce.number().int().min(1).max(500).default(100).describe('Entries per page'),
  })
  .meta({ id: 'FileTrashListQueryDto' });

const FileTrashItemResponseSchema = z
  .object({
    id: z.string().describe('File trash entry id'),
    originalFileName: z.string().describe('Name of the file when it was last in a library'),
    sizeInBytes: z.int().nonnegative().describe('Size of the file in bytes'),
    checksum: z.string().describe('Hex-encoded SHA-256 checksum of the file'),
    lastOwnerId: z.string().nullable().describe('Account whose library held the file last, when known'),
    lastOwnerName: z.string().nullable().describe('Name of that account, while it exists'),
    lastAssetId: z.string().nullable().describe('Asset that held the file last, when known'),
    trashedAt: z.string().meta({ format: 'date-time' }).describe('When the file was moved to the file trash'),
  })
  .meta({ id: 'FileTrashItemResponseDto' });

const FileTrashResponseSchema = z
  .object({
    items: z.array(FileTrashItemResponseSchema),
    total: z.int().nonnegative().describe('Entries in the file trash'),
    totalBytes: z.int().nonnegative().describe('Disk space the file trash holds, in bytes'),
  })
  .meta({ id: 'FileTrashResponseDto' });

const FileTrashRestoreResponseSchema = z
  .object({
    assetId: z.string().describe('The new asset the file was restored as, in its last owner’s library'),
  })
  .meta({ id: 'FileTrashRestoreResponseDto' });

export class FileTrashListQueryDto extends createZodDto(FileTrashListQuerySchema) {}
export class FileTrashItemResponseDto extends createZodDto(FileTrashItemResponseSchema) {}
export class FileTrashResponseDto extends createZodDto(FileTrashResponseSchema) {}
export class FileTrashRestoreResponseDto extends createZodDto(FileTrashRestoreResponseSchema) {}

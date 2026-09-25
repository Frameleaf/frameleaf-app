import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * FL-46: one folder's own originals, as the Folders browser lists them (the owner's Timeline items
 * that the session may see). A folder's total and size are these added up over it and every folder
 * under it.
 */
const FolderSummaryResponseSchema = z
  .object({
    path: z.string().describe('Folder path, without a trailing slash'),
    count: z.int().min(0).describe('Originals directly in this folder'),
    size: z.int().min(0).describe('Bytes of the originals directly in this folder'),
  })
  .meta({ id: 'FolderSummaryResponseDto' });

export class FolderSummaryResponseDto extends createZodDto(FolderSummaryResponseSchema) {}

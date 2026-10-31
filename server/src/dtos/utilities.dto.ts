import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** FL-519: what each Utilities tool has waiting, in one cheap call, so the directory can list them first. */
const UtilitiesSummaryResponseSchema = z
  .object({
    duplicateGroups: z.int().min(0).describe('Groups of look-alike photos waiting for a decision'),
    withoutPlace: z.int().min(0).describe('Photos and videos on the timeline with no place'),
    missingFiles: z
      .int()
      .min(0)
      .nullable()
      .describe('Photos whose original file is missing, across the server; null unless an administrator asks'),
    damagedFiles: z
      .int()
      .min(0)
      .nullable()
      .describe('Photos whose original file is damaged, across the server; null unless an administrator asks'),
    unusedFiles: z
      .int()
      .min(0)
      .nullable()
      .describe('Originals no library uses any more (Unused files); null unless the server owner asks'),
    unusedBytes: z
      .int()
      .min(0)
      .nullable()
      .describe('Combined size of those unused originals, in bytes; null unless the server owner asks'),
  })
  .meta({ id: 'UtilitiesSummaryResponseDto' });

export class UtilitiesSummaryResponseDto extends createZodDto(UtilitiesSummaryResponseSchema) {}

import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const PrintBackUpdateSchema = z
  .object({
    backAssetId: z.uuid().nullable().describe('The scan of the back of this print, or null to remove the back'),
  })
  .meta({ id: 'PrintBackUpdateDto' });

export const PrintBackResponseSchema = z
  .object({
    frontAssetId: z.uuid().describe('The photo of the front'),
    backAssetId: z.uuid().nullable().describe("The back's asset. Only its owner is told; null for anyone else"),
    text: z.string().nullable().describe("The back's text with the owner's corrections, or null when there is none"),
    canEdit: z.boolean().describe('Whether this viewer can pair, unpair and correct the text'),
  })
  .meta({ id: 'PrintBackResponseDto' });

export class PrintBackUpdateDto extends createZodDto(PrintBackUpdateSchema) {}
export class PrintBackResponseDto extends createZodDto(PrintBackResponseSchema) {}

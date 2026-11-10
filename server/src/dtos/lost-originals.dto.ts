import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** Photos the server lost that a phone may still hold (FL-1337). */
const LostOriginalsQuerySchema = z
  .object({
    take: z.coerce.number().int().min(1).max(1000).default(500).describe('How many to list (1 to 1000)'),
    skip: z.coerce.number().int().min(0).default(0).describe('How many to skip'),
  })
  .meta({ id: 'LostOriginalsQueryDto' });

const LostOriginalSchema = z
  .object({
    // any UUID: a photo from an import keeps the id it is given (FL-845's processing failures list does the same)
    assetId: z.uuid().describe('The photo or video'),
    checksum: z.string().describe('SHA-1 of the lost file, base64: what the phone matches its own file by'),
    originalFileName: z.string().describe('The name the file had'),
    fileCreatedAt: z.string().meta({ format: 'date-time' }).describe('When the file was created'),
  })
  .meta({ id: 'LostOriginalDto' });

const LostOriginalsResponseSchema = z
  .object({
    items: z.array(LostOriginalSchema).describe("The caller's own lost originals, oldest problem first"),
    hasNextPage: z.boolean().describe('Whether more follow this page'),
  })
  .meta({ id: 'LostOriginalsResponseDto' });

const LostOriginalsCheckedSchema = z
  .object({
    deviceId: z.string().min(1).max(256).describe('The phone or tablet that looked'),
    notHere: z
      .array(z.string().max(64))
      .max(1000)
      .describe('Checksums (base64) of lost originals this device does not have'),
  })
  .meta({ id: 'LostOriginalsCheckedDto' });

export class LostOriginalsQueryDto extends createZodDto(LostOriginalsQuerySchema) {}
export class LostOriginalsResponseDto extends createZodDto(LostOriginalsResponseSchema) {}
export class LostOriginalsCheckedDto extends createZodDto(LostOriginalsCheckedSchema) {}

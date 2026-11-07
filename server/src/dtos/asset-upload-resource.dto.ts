import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetMediaStatusSchema } from 'src/dtos/asset-media-response.dto.js';
import { DirectUploadDescriptionSchema } from 'src/utils/asset-upload-direct.js';

export class AssetUploadDirectDescriptionDto extends createZodDto(
  DirectUploadDescriptionSchema.meta({ id: 'AssetUploadDirectDescriptionDto' }),
) {}

export class AssetUploadResultDto extends createZodDto(
  z
    .object({
      id: z.uuid().describe('Created or duplicate asset ID; nil UUID if current privacy suppresses it'),
      status: AssetMediaStatusSchema,
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe('Verified SHA-256 of the complete uploaded representation'),
    })
    .meta({ id: 'AssetUploadResultDto' }),
) {}

export class LivePhotoUploadCommitDto extends createZodDto(
  z
    .object({ stillResourceId: z.uuid(), videoResourceId: z.uuid() })
    .refine((value) => value.stillResourceId !== value.videoResourceId, 'Distinct resources are required')
    .meta({ id: 'LivePhotoUploadCommitDto' }),
) {}

export class LivePhotoUploadResultDto extends createZodDto(
  z
    .object({ still: AssetUploadResultDto.schema, video: AssetUploadResultDto.schema })
    .meta({ id: 'LivePhotoUploadResultDto' }),
) {}

export class AssetUploadPartsDto extends createZodDto(
  z
    .object({
      offset: z.int().min(0).describe('Contiguous bytes received from the start of the file'),
      size: z.int().min(1).nullable().describe('Declared length of the file, or null if not declared yet'),
      parts: z
        .array(z.object({ offset: z.int().min(0), size: z.int().min(1) }).meta({ id: 'AssetUploadPartDto' }))
        .describe('Received parts in offset order; a resuming client sends only the gaps'),
    })
    .meta({ id: 'AssetUploadPartsDto' }),
) {}

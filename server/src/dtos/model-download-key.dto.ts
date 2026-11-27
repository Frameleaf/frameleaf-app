import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** FL-1825: the optional Hugging Face key for faster model downloads. The key itself is never returned. */
const ModelDownloadKeyStatusSchema = z
  .enum(['none', 'saved', 'refused'])
  .describe('none: no key; saved: Hugging Face accepted the key; refused: Hugging Face stopped accepting it')
  .meta({ id: 'ModelDownloadKeyStatus' });

const ModelDownloadKeyResponseSchema = z
  .object({
    status: ModelDownloadKeyStatusSchema,
    savedAt: z.iso.datetime().nullable().describe('When the key was saved'),
    checkedAt: z.iso.datetime().nullable().describe('When Hugging Face last answered about the key'),
  })
  .meta({ id: 'ModelDownloadKeyResponseDto' });

const ModelDownloadKeyUpdateSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^hf_[A-Za-z0-9]{20,200}$/, 'A Hugging Face key starts with hf_')
      .describe('A Hugging Face access token with Read access'),
  })
  .meta({ id: 'ModelDownloadKeyUpdateDto' });

export class ModelDownloadKeyResponseDto extends createZodDto(ModelDownloadKeyResponseSchema) {}
export class ModelDownloadKeyUpdateDto extends createZodDto(ModelDownloadKeyUpdateSchema) {}

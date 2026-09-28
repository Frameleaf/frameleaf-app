import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ConfigCredentialSchema } from 'src/enum.js';

/**
 * FL-67: write-only server secrets. A credential is replaced by sending a new value and cleared by
 * deleting it; neither the value nor any part of it is ever returned. Responses only say whether a
 * value is stored.
 */

const ConfigCredentialParamSchema = z
  .object({
    name: ConfigCredentialSchema,
  })
  .meta({ id: 'ConfigCredentialParamDto' });

const ConfigCredentialUpdateSchema = z
  .object({
    value: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.trim().length > 0, { message: 'Value must not be blank' })
      .describe('The new secret. Stored as sent and never returned'),
  })
  .meta({ id: 'ConfigCredentialUpdateDto' });

const ConfigCredentialResponseSchema = z
  .object({
    name: ConfigCredentialSchema,
    configured: z.boolean().describe('Whether a value is stored. The value itself is never returned'),
  })
  .meta({ id: 'ConfigCredentialResponseDto' });

export class ConfigCredentialParamDto extends createZodDto(ConfigCredentialParamSchema) {}
export class ConfigCredentialUpdateDto extends createZodDto(ConfigCredentialUpdateSchema) {}
export class ConfigCredentialResponseDto extends createZodDto(ConfigCredentialResponseSchema) {}

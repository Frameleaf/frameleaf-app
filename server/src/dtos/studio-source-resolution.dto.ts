import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const selection = z
  .object({
    animationId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    themeId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
  })
  .strict()
  .meta({ id: 'StudioSourceSelectionDto' });
const parent = z
  .object({
    kind: z.enum(['project-import', 'vector-graphic']),
    id: z.uuid(),
    checksum: digest,
  })
  .strict()
  .meta({ id: 'StudioSourceParentDto' });

export const StudioSourceResolutionRequestSchema = z
  .object({
    revision: z.int().min(1),
    graphDigest: digest.describe('Exact acknowledged saved envelope digest'),
    parent,
    selection,
  })
  .strict()
  .meta({ id: 'StudioSourceResolutionRequestDto' });

export const StudioSourceResolutionSchema = z
  .object({
    projectId: z.uuidv7(),
    revision: z.int().min(1),
    graphDigest: digest,
    manifestDigest: digest.describe(
      'SHA-256 of canonical JSON containing every result field except files.base64 and manifestDigest',
    ),
    parent,
    expiresAt: z.iso.datetime(),
    archive: z.boolean(),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .max(1024)
              .regex(/^(?!\/)(?!.*(?:\\|\/\/|(?:^|\/)\.\.?(?:\/|$)|[\u0000-\u001f\u007f]))[^/]+(?:\/[^/]+)*$/),
            sha256: digest,
            base64: z
              .string()
              .max(24 * 1024 * 1024)
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/),
          })
          .strict()
          .meta({ id: 'StudioSourceFileDto' }),
      )
      .min(1)
      .max(256),
    selection,
  })
  .strict()
  .meta({ id: 'StudioSourceResolutionDto' });

export class StudioSourceResolutionRequestDto extends createZodDto(StudioSourceResolutionRequestSchema) {}
export class StudioSourceResolutionDto extends createZodDto(StudioSourceResolutionSchema) {}

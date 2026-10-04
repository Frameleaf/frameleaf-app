import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export class JobRunSearchDto extends createZodDto(
  z
    .object({
      take: z.coerce.number().int().min(1).max(100).default(25),
      skip: z.coerce.number().int().min(0).default(0),
    })
    .meta({ id: 'JobRunSearchDto' }),
) {}

export class JobRunResponseDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      kind: z.string(),
      createdAt: z.iso.datetime(),
      finishedAt: z.iso.datetime().nullable(),
      enumerationDone: z.boolean(),
      total: z.number().int(),
      completed: z.number().int(),
      failed: z.number().int(),
      active: z.number().int(),
      waiting: z.number().int(),
      state: z.enum(['running', 'blocked', 'unavailable', 'completed', 'failed', 'needs_attention']),
    })
    .meta({ id: 'JobRunResponseDto' }),
) {}

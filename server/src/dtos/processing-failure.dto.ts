import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { processingFailureSteps } from 'src/queue/processing-failure.js';

const item = z.object({ assetId: z.uuid(), step: z.enum(processingFailureSteps) });

const query = z
  .object({
    userId: z.uuid().optional(),
    skip: z.coerce.number().int().nonnegative().default(0),
    take: z.coerce.number().int().min(1).max(200).default(100),
  })
  .meta({ id: 'ProcessingFailureQueryDto' });

const action = z.object({ items: z.array(item).min(1).max(100) }).meta({ id: 'ProcessingFailureActionDto' });

const response = z
  .object({
    assetId: z.uuid(),
    step: z.string(),
    cause: z.string(),
    attempts: z.int().nonnegative(),
    lastFailedAt: z.iso.datetime(),
    quarantinedAt: z.iso.datetime().nullable(),
    ownerId: z.uuid(),
    ownerName: z.string(),
    fileName: z.string(),
  })
  .meta({ id: 'ProcessingFailureResponseDto' });

export class ProcessingFailureQueryDto extends createZodDto(query) {}
export class ProcessingFailureActionDto extends createZodDto(action) {}
export class ProcessingFailureResponseDto extends createZodDto(response) {}

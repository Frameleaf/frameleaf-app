import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const operationId = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/)
  .describe('Frameleaf Manager move operation that holds the pause');

export class LibraryMovePauseDto extends createZodDto(z.object({ operationId }).strict()) {}

export class LibraryMoveResumeDto extends createZodDto(z.object({ operationId }).strict()) {}

export class LibraryMovePauseStatusDto extends createZodDto(
  z
    .object({
      paused: z.boolean().describe('Uploads, changes and background work are paused for a library move'),
      operationId: z.string().nullable().describe('Manager move operation holding the pause'),
      pausedAt: z.string().nullable().describe('When the pause started (ISO 8601)'),
      leaseExpiresAt: z
        .string()
        .nullable()
        .describe('When the pause lifts by itself unless the Manager renews it (ISO 8601)'),
      writesInFlight: z.number().int().nonnegative().describe('Write requests still being answered'),
      activeJobs: z.number().int().nonnegative().describe('Background jobs still running'),
      activeQueues: z.array(z.string()).describe('Queues with jobs still running'),
      drained: z.boolean().describe('Paused, with no write request and no background job in flight'),
    })
    .meta({ id: 'LibraryMovePauseStatusDto' }),
) {}

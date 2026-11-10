import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { privateLogLevels, privateLogWorkers } from 'src/utils/private-log-store.js';

const filter = z.object({
  worker: z.enum(privateLogWorkers).optional(),
  level: z.enum(privateLogLevels).optional(),
  q: z.string().trim().max(100).optional(),
  since: z.iso.datetime().optional(),
});
const cursor = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f-]{36}$/u);
const item = z.object({
  id: z.uuid(),
  worker: z.enum(privateLogWorkers),
  at: z.iso.datetime(),
  level: z.enum(privateLogLevels),
  context: z.string(),
  message: z.string(),
  requestId: z.uuid().optional(),
  route: z.string().optional(),
  jobName: z.string().optional(),
  jobId: z.uuid().optional(),
  assetId: z.uuid().optional(),
});

export class PrivateLogQueryDto extends createZodDto(
  filter.extend({ before: cursor.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
) {}
export class PrivateLogStreamQueryDto extends createZodDto(filter) {}
export class PrivateLogDownloadQueryDto extends createZodDto(
  z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }),
) {}
export class PrivateLogPageDto extends createZodDto(
  z.object({ entries: z.array(item), nextCursor: cursor.nullable() }),
) {}

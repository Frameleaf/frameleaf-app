import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { CONNECT_EVENT_TYPES } from 'src/utils/connect-events.js';

const filter = z.object({ type: z.enum(CONNECT_EVENT_TYPES).optional(), albumId: z.uuid().optional() });
const cursor = z.string().min(1).max(200).optional();
export class ConnectEventQueryDto extends createZodDto(
  filter
    .extend({ cursor, start: z.literal('now').optional(), limit: z.coerce.number().int().min(1).max(100).default(100) })
    .refine((query) => !(query.start && query.cursor), { message: 'Use a cursor or start=now' }),
) {}
export class ConnectEventLatestQueryDto extends createZodDto(filter.extend({ cursor })) {}
export class ConnectEventSampleQueryDto extends createZodDto(filter) {}
const event = z.object({
  event: z.enum(CONNECT_EVENT_TYPES),
  deliveryId: z.uuid(),
  occurredAt: z.string(),
  subject: z.object({ kind: z.literal('asset'), id: z.uuid(), name: z.null() }),
  detail: z.record(z.string(), z.union([z.string(), z.number().meta({ format: 'double' }), z.boolean(), z.null()])),
});
export class ConnectEventPageDto extends createZodDto(
  z.object({ items: z.array(event), nextCursor: z.string().nullable(), hasMore: z.boolean(), bounded: z.boolean() }),
) {}
export class ConnectEventSampleDto extends createZodDto(z.object({ items: z.array(event) })) {}

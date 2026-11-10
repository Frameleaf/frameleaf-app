import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { isoDatetimeToDate } from 'src/validation.js';

/**
 * FL-808 (E16-02): the account activity log. `action` and `source` stay plain strings, so new
 * actions never break the apps' strict decoders.
 */
const pageFields = {
  before: z.uuidv7().optional().describe('Only events older than this event, for paging'),
  take: z.coerce.number().int().min(1).max(200).optional().describe('Page size, 50 by default'),
};

const AccountActivitySearchSchema = z.object(pageFields);

const AccountActivityAdminSearchSchema = z.object({
  ...pageFields,
  userId: z.uuidv4().optional().describe('Only this account'),
  action: z.string().min(1).max(64).optional().describe('Only this action'),
  from: isoDatetimeToDate.optional().describe('Only events at or after this time'),
  to: isoDatetimeToDate.optional().describe('Only events before this time'),
});

const AccountEventResponseSchema = z
  .object({
    id: z.uuidv7().describe('Event ID'),
    source: z.string().describe('`account` for what the account did, `admin` for what an administrator did to it'),
    userId: z.uuidv4().describe('The account the event is about'),
    action: z
      .string()
      .describe(
        'What happened, for example `signed-in`, `sign-in-failed`, `signed-out`, `session-revoked`, `password-changed`, `pin-changed`, `api-key-created`, `shared-link-created`, `partner-added` or `item-shared`; admin events use the administrator history actions. New values may appear.',
      ),
    subject: z.string().describe('A name: a device, an API key, a partner, an album or the account'),
    detail: z.string().nullable().describe('What the action carries, such as how someone signed in; null otherwise'),
    ipPrefix: z.string().nullable().describe('The client address cut to its /24 or /48; null when unknown'),
    deviceType: z.string().nullable().describe('The client, as the session list names it'),
    deviceOS: z.string().nullable().describe("The client's operating system"),
    via: z.string().nullable().describe('`home`, `direct` or `relay`; null when not known'),
    actorId: z.uuidv4().nullable().describe('For admin events, the administrator; null otherwise'),
    actorName: z.string().nullable().describe("For admin events, the administrator's name; null otherwise"),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When it happened'),
  })
  .meta({ id: 'AccountEventResponseDto' });

const AccountActivityResponseSchema = z
  .object({
    events: z.array(AccountEventResponseSchema).describe('Newest first'),
    hasMore: z.boolean().describe('True when older events exist beyond this page'),
  })
  .meta({ id: 'AccountActivityResponseDto' });

export class AccountActivitySearchDto extends createZodDto(AccountActivitySearchSchema) {}
export class AccountActivityAdminSearchDto extends createZodDto(AccountActivityAdminSearchSchema) {}
export class AccountEventResponseDto extends createZodDto(AccountEventResponseSchema) {}
export class AccountActivityResponseDto extends createZodDto(AccountActivityResponseSchema) {}

import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { UserResponseSchema } from 'src/dtos/user.dto.js';
import { PartnerDirection } from 'src/repositories/partner.repository.js';
import { PARTNER_SCOPE_MAX_ITEMS } from 'src/utils/partner-scope.js';

const PartnerDirectionSchema = z.enum(PartnerDirection).describe('Partner direction').meta({ id: 'PartnerDirection' });

// FL-774: "Everything" (the default) or "Only what I choose"
const PartnerScopeModeSchema = z
  .enum(['everything', 'chosen'])
  .describe('What the partner receives: everything, or only what the owner chose')
  .meta({ id: 'PartnerScopeMode' });

const ids = (what: string) => z.array(z.uuidv4()).max(PARTNER_SCOPE_MAX_ITEMS).optional().describe(what);

const PartnerScopeUpdateSchema = z
  .object({
    mode: PartnerScopeModeSchema,
    sinceDate: z.iso
      .date()
      .nullable()
      .optional()
      .describe('Only items taken on or after this day (YYYY-MM-DD); with mode chosen'),
    albumIds: ids('Albums the owner owns whose items are shared; with mode chosen'),
    personIds: ids("The owner's people whose photos are shared; with mode chosen"),
    folders: z
      .array(z.string().min(1).max(4096))
      .max(PARTNER_SCOPE_MAX_ITEMS)
      .optional()
      .describe('Folders (and the folders inside them) whose items are shared; with mode chosen'),
  })
  .describe('What a partner receives')
  .meta({ id: 'PartnerScopeUpdateDto' });

const PartnerScopeLabelSchema = z.object({ id: z.uuidv4(), name: z.string() }).meta({ id: 'PartnerScopeLabelDto' });

const PartnerScopeSchema = z
  .object({
    mode: PartnerScopeModeSchema,
    sinceDate: z.iso.date().nullable().describe('Only items taken on or after this day'),
    albums: z.array(PartnerScopeLabelSchema).describe('Albums whose items are shared'),
    people: z.array(PartnerScopeLabelSchema).describe('People whose photos are shared'),
    folders: z.array(z.string()).describe('Folders whose items are shared'),
  })
  .describe('What a partner receives')
  .meta({ id: 'PartnerScopeDto' });

const PartnerScopeResponseSchema = PartnerScopeSchema.extend({
  count: z.int().min(0).describe('How many items this sends now'),
})
  .describe('What a partner receives, and how many items that is')
  .meta({ id: 'PartnerScopeResponseDto' });

const PartnerScopeEstimateSchema = z
  .object({ count: z.int().min(0).describe('How many items this would send now') })
  .meta({ id: 'PartnerScopeEstimateResponseDto' });

const PartnerCreateSchema = z
  .object({
    sharedWithId: z.uuidv4().describe('User ID to share with'),
    // FL-774
    scope: PartnerScopeUpdateSchema.optional().describe('What the partner receives; everything when left out'),
  })
  .meta({ id: 'PartnerCreateDto' });

// FL-326: partners receive their own copies and locations are always shared, so a partnership has no
// settings left (`inTimeline` and `shareLocation` are gone). The update body is kept, empty, for older
// clients.
const PartnerUpdateSchema = z.object({}).meta({ id: 'PartnerUpdateDto' });

const PartnerSearchSchema = z
  .object({
    direction: PartnerDirectionSchema,
  })
  .meta({ id: 'PartnerSearchDto' });

// FL-326 (spec §5.2): the first copy of the library shared this way, for the partner card's progress
const PartnerBackfillSchema = z
  .object({
    state: z.enum(['pending', 'running', 'done', 'stopped']).describe('Where the first copy stands'),
    total: z.int().min(0).describe('Items to copy'),
    done: z.int().min(0).describe('Items copied so far'),
  })
  .meta({ id: 'PartnerBackfillDto' });

const PartnerResponseSchema = UserResponseSchema.extend({
  // FL-326
  backfill: PartnerBackfillSchema.nullable()
    .optional()
    .describe('Copy progress of the library shared this way; null when it was never copied'),
  // FL-774
  scope: PartnerScopeSchema.optional().describe('What the library shared this way sends'),
})
  .describe('Partner response')
  .meta({ id: 'PartnerResponseDto' });

export class PartnerCreateDto extends createZodDto(PartnerCreateSchema) {}
export class PartnerUpdateDto extends createZodDto(PartnerUpdateSchema) {}
export class PartnerSearchDto extends createZodDto(PartnerSearchSchema) {}
export class PartnerResponseDto extends createZodDto(PartnerResponseSchema) {}
export class PartnerScopeUpdateDto extends createZodDto(PartnerScopeUpdateSchema) {}
export class PartnerScopeDto extends createZodDto(PartnerScopeSchema) {}
export class PartnerScopeResponseDto extends createZodDto(PartnerScopeResponseSchema) {}
export class PartnerScopeEstimateResponseDto extends createZodDto(PartnerScopeEstimateSchema) {}

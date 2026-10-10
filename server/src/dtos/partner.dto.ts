import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { UserResponseSchema } from 'src/dtos/user.dto.js';
import { PartnerDirection } from 'src/repositories/partner.repository.js';

const PartnerDirectionSchema = z.enum(PartnerDirection).describe('Partner direction').meta({ id: 'PartnerDirection' });

const PartnerCreateSchema = z
  .object({
    sharedWithId: z.uuidv4().describe('User ID to share with'),
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
  backfill: PartnerBackfillSchema.nullable()
    .optional()
    .describe('FL-326: copy progress of the library shared this way; null when it was never copied'),
})
  .describe('Partner response')
  .meta({ id: 'PartnerResponseDto' });

export class PartnerCreateDto extends createZodDto(PartnerCreateSchema) {}
export class PartnerUpdateDto extends createZodDto(PartnerUpdateSchema) {}
export class PartnerSearchDto extends createZodDto(PartnerSearchSchema) {}
export class PartnerResponseDto extends createZodDto(PartnerResponseSchema) {}

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

// Exactly one field per request: `inTimeline` is the recipient's preference on the partner who shares
// with them (`:id` shares with me); `shareLocation` is the sharing user's setting on the partner they
// share with (I share with `:id`). The service rejects requests that set both or neither.
const PartnerUpdateSchema = z
  .object({
    inTimeline: z.boolean().optional().describe('Show partner assets in timeline'),
    shareLocation: z
      .boolean()
      .optional()
      .describe('Share asset locations with this partner; only the sharing user can change it'),
  })
  .meta({ id: 'PartnerUpdateDto' });

const PartnerSearchSchema = z
  .object({
    direction: PartnerDirectionSchema,
  })
  .meta({ id: 'PartnerSearchDto' });

const PartnerResponseSchema = UserResponseSchema.extend({
  inTimeline: z.boolean().optional().describe('Show in timeline'),
  shareLocation: z.boolean().optional().describe('Sharer allows this partner to see asset locations'),
})
  .describe('Partner response')
  .meta({ id: 'PartnerResponseDto' });

export class PartnerCreateDto extends createZodDto(PartnerCreateSchema) {}
export class PartnerUpdateDto extends createZodDto(PartnerUpdateSchema) {}
export class PartnerSearchDto extends createZodDto(PartnerSearchSchema) {}
export class PartnerResponseDto extends createZodDto(PartnerResponseSchema) {}

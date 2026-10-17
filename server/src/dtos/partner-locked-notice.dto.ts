import { createZodDto } from 'nestjs-zod';
import z from 'zod';

// FL-326: the one-time notice for an account that received Locked items from a partner but has no PIN.
const PartnerLockedNoticeResponseSchema = z
  .object({
    show: z
      .boolean()
      .describe(
        'Whether to show the notice: Locked items arrived from a partner, no PIN is set, and it was not dismissed',
      ),
    flaggedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When the first Locked item arrived for an account without a PIN'),
  })
  .meta({ id: 'PartnerLockedNoticeResponseDto' });

export class PartnerLockedNoticeResponseDto extends createZodDto(PartnerLockedNoticeResponseSchema) {}

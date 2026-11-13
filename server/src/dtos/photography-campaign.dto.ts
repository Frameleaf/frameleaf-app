import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const campaignAudience = z.object({
  source: z.enum(['all', 'clients', 'leads', 'shoot']),
  workflowId: z.uuidv4().optional(),
});
export class PhotographyCampaignSaveDto extends createZodDto(
  z.object({
    name: z.string().trim().min(1).max(120),
    templateKey: z.enum(['print-sale', 'review-request', 'mini-session']),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n]/.test(value)),
    body: z.string().trim().min(1).max(10_000),
    audience: campaignAudience,
  }),
) {}
export class PhotographyCampaignScheduleDto extends createZodDto(
  z.object({
    scheduledFor: z.iso.datetime().optional(),
    expectedRevision: z.uuidv4(),
  }),
) {}
export class PhotographyCampaignDto extends createZodDto(
  PhotographyCampaignSaveDto.schema.extend({
    id: z.uuidv4(),
    revision: z.uuidv4(),
    status: z.enum(['draft', 'scheduled', 'completed', 'cancelled']),
    scheduledFor: z.iso.datetime().nullable(),
    sentCount: z.int().nonnegative(),
    failedCount: z.int().nonnegative(),
    pendingCount: z.int().nonnegative(),
    uncertainCount: z.int().nonnegative(),
    unsubscribedCount: z.int().nonnegative(),
  }),
) {}
export class PhotographyCampaignListDto extends createZodDto(
  z.object({
    items: z.array(PhotographyCampaignDto.schema),
    clients: z.int().nonnegative(),
    leads: z.int().nonnegative(),
    mailReady: z.boolean(),
    sender: z.string(),
  }),
) {}
export class PhotographyCampaignPreviewDto extends createZodDto(
  z.object({
    html: z.string(),
    text: z.string(),
    sender: z.string(),
    recipients: z.int().nonnegative(),
  }),
) {}

export class PhotographyCampaignDeliveriesDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        email: z.string(),
        name: z.string(),
        status: z.enum(['pending', 'sent', 'failed', 'uncertain', 'unsubscribed']),
      }),
    ),
  }),
) {}

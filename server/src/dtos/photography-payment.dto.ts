import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const PAYMENT_LINK_CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP'] as const;

const PaymentLinkSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  amount: z.int(),
  currency: z.string(),
  reusable: z.boolean(),
  active: z.boolean(),
  /** Successful payments, and their total in the smallest currency unit. */
  payments: z.int(),
  collected: z.int(),
  createdAt: z.string(),
});
export class PhotographyPaymentLinkDto extends createZodDto(PaymentLinkSchema) {}
export class PhotographyPaymentLinkListDto extends createZodDto(
  z.object({
    links: z.array(PaymentLinkSchema),
    /** The studio's payment account can take payments now; creating a link needs it. */
    ready: z.boolean(),
  }),
) {}
export class PhotographyPaymentLinkCreateDto extends createZodDto(
  z.strictObject({
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).default(''),
    /** Smallest currency unit (cents). */
    amount: z.int().min(50).max(99_999_999),
    currency: z.enum(PAYMENT_LINK_CURRENCIES).meta({ id: 'PhotographyPaymentLinkCurrency' }),
    reusable: z.boolean(),
  }),
) {}
export class PhotographyPaymentLinkUpdateDto extends createZodDto(
  z.strictObject({
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(300).optional(),
    active: z.boolean().optional(),
  }),
) {}
export class PhotographyPaymentListDto extends createZodDto(
  z.object({
    payments: z.array(
      z.object({
        id: z.uuid(),
        linkId: z.uuid().nullable(),
        title: z.string().nullable(),
        amount: z.int(),
        currency: z.string(),
        payerEmail: z.string(),
        status: z.enum(['paid', 'failed', 'expired', 'refunded']).meta({ id: 'PhotographyPaymentListStatus' }),
        createdAt: z.string(),
      }),
    ),
  }),
) {}

/** The public pay page: only what the payer needs. Never the studio's account or other payments. */
export class PhotographyPublicPaymentLinkDto extends createZodDto(
  z.object({
    title: z.string(),
    description: z.string(),
    amount: z.int(),
    currency: z.string(),
    brand: z.object({
      name: z.string(),
      email: z.string(),
      color: z.string(),
      logoInitials: z.string(),
    }),
  }),
) {}
export class PhotographyPayCheckoutDto extends createZodDto(z.strictObject({ email: z.email().max(254) })) {}
export class PhotographyPayCheckoutResponseDto extends createZodDto(
  z.object({ url: z.string(), paymentId: z.uuid() }),
) {}
export class PhotographyPayStatusDto extends createZodDto(
  z.object({
    status: z.enum(['pending', 'paid', 'failed', 'expired', 'refunded']).meta({ id: 'PhotographyPaymentStatus' }),
    amount: z.int(),
    currency: z.string(),
  }),
) {}

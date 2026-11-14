import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { PAYMENT_LINK_CURRENCIES } from 'src/dtos/photography-payment.dto.js';

const minor = z.int().min(0).max(99_999_999);
const LineSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.int().min(1).max(10_000),
  /** Smallest currency unit (cents). */
  unitPrice: minor,
});
export class PhotographyInvoiceSaveDto extends createZodDto(
  z.strictObject({
    clientName: z.string().trim().min(1).max(200),
    clientEmail: z.email().max(254),
    lines: z.array(LineSchema).min(1).max(100),
    /** Hundredths of a percent: 500 is 5%. */
    taxBasisPoints: z.int().min(0).max(10_000),
    currency: z.enum(PAYMENT_LINK_CURRENCIES).meta({ id: 'PhotographyInvoiceCurrency' }),
    /** Smallest currency unit; 0 means no deposit. */
    deposit: minor,
    depositDue: z.iso.date().nullable(),
    balanceDue: z.iso.date(),
    reminders: z.boolean(),
  }),
) {}
const InvoiceStatus = z.enum(['draft', 'sent', 'part', 'paid', 'void']).meta({ id: 'PhotographyInvoiceStatus' });
const ScheduleSchema = z.array(z.object({ dueOn: z.iso.date(), amount: z.int() }));
const InvoiceSchema = z.object({
  id: z.uuidv4(),
  number: z.int(),
  label: z.string(),
  clientName: z.string(),
  clientEmail: z.string(),
  lines: z.array(LineSchema),
  taxBasisPoints: z.int(),
  currency: z.string(),
  subtotal: z.int(),
  tax: z.int(),
  total: z.int(),
  schedule: ScheduleSchema,
  reminders: z.boolean(),
  status: InvoiceStatus,
  paid: z.int(),
  overdue: z.boolean(),
  sentAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export class PhotographyInvoiceDto extends createZodDto(InvoiceSchema) {}
export class PhotographyInvoiceListDto extends createZodDto(
  z.object({ items: z.array(InvoiceSchema), mailReady: z.boolean(), paymentsReady: z.boolean() }),
) {}
export class PhotographyInvoicePaidDto extends createZodDto(
  z.strictObject({ amount: z.int().min(1).max(99_999_999) }),
) {}
export class PhotographyPublicInvoiceDto extends createZodDto(
  z.object({
    studio: z.object({ name: z.string(), email: z.string(), color: z.string() }),
    label: z.string(),
    clientName: z.string(),
    lines: z.array(LineSchema),
    taxBasisPoints: z.int(),
    currency: z.string(),
    subtotal: z.int(),
    tax: z.int(),
    total: z.int(),
    schedule: ScheduleSchema,
    paid: z.int(),
    status: InvoiceStatus,
    /** What the client can pay now, and by when; null once nothing is due. */
    next: z.object({ amount: z.int(), dueOn: z.iso.date() }).nullable(),
    payOnline: z.boolean(),
  }),
) {}
export class PhotographyInvoiceCheckoutDto extends createZodDto(z.object({ url: z.string(), paymentId: z.uuid() })) {}
export class PhotographyInvoicePaymentStatusDto extends createZodDto(
  z.object({
    status: z
      .enum(['pending', 'paid', 'failed', 'expired', 'refunded'])
      .meta({ id: 'PhotographyInvoicePaymentStatus' }),
  }),
) {}

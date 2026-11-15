import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { PaymentCurrencySchema } from 'src/dtos/photography-payment.dto.js';

const Cents = z.int().min(0).max(99_999_999);
const AddOnSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(80),
  price: Cents,
  maxQuantity: z.int().min(1).max(20),
});
const BookingTypeFields = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).default(''),
  durationMinutes: z
    .int()
    .min(5)
    .max(24 * 60),
  /** Smallest currency unit (cents). */
  price: Cents,
  deposit: Cents.default(0),
  currency: PaymentCurrencySchema,
  active: z.boolean().default(true),
  addOns: z.array(AddOnSchema).max(20).default([]),
  order: z.int().min(0).max(1000).default(0),
});
const BookingTypeSaveSchema = BookingTypeFields.refine(
  (t) => t.deposit <= t.price,
  'The deposit can’t be more than the price',
).refine((t) => new Set(t.addOns.map((a) => a.id)).size === t.addOns.length, 'Add-on ids must be unique');
export class PhotographyBookingTypeSaveDto extends createZodDto(BookingTypeSaveSchema) {}

const BookingTypeSchema = BookingTypeFields.extend({ id: z.uuid(), createdAt: z.string() }).strip();
export class PhotographyBookingTypeDto extends createZodDto(BookingTypeSchema) {}
export class PhotographyBookingTypeListDto extends createZodDto(z.object({ types: z.array(BookingTypeSchema) })) {}

export const BookingStatusSchema = z
  .enum(['requested', 'confirmed', 'declined', 'cancelled'])
  .meta({ id: 'PhotographyBookingStatus' });
const BookingSchema = z.object({
  id: z.uuid(),
  bookingTypeId: z.uuid().nullable(),
  typeName: z.string(),
  clientName: z.string(),
  clientEmail: z.string(),
  message: z.string(),
  preferredDates: z.array(z.string()),
  addOns: z.array(z.object({ id: z.string(), name: z.string(), price: z.int(), quantity: z.int() })),
  total: z.int(),
  deposit: z.int(),
  currency: z.string(),
  /** `none` when no deposit was asked; otherwise the deposit payment's status. */
  depositStatus: z.enum(['none', 'unpaid', 'pending', 'paid', 'failed', 'expired', 'refunded']).meta({
    id: 'PhotographyBookingDepositStatus',
  }),
  status: BookingStatusSchema,
  requestedAt: z.string(),
});
export class PhotographyBookingListDto extends createZodDto(
  z.object({
    bookings: z.array(BookingSchema),
    /** FL-1606: whether this server can email clients, so the studio is offered the confirm/decline email. */
    mailReady: z.boolean(),
  }),
) {}
export class PhotographyBookingDto extends createZodDto(
  BookingSchema.extend({
    /** FL-1606: whether the client was emailed about this change. */
    clientEmailed: z.boolean(),
  }),
) {}
export class PhotographyBookingStatusDto extends createZodDto(
  z.strictObject({
    status: BookingStatusSchema,
    /** FL-1606: email the client when the booking is confirmed or declined (when email is set up). */
    notifyClient: z.boolean().default(false),
  }),
) {}

/** The public booking form: what the client chose. Prices come from the server, never from here. */
export class PhotographyBookingRequestDto extends createZodDto(
  z.strictObject({
    bookingTypeId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    email: z.email().max(254),
    preferredDates: z.array(z.iso.date()).max(3).default([]),
    addOns: z
      .array(z.strictObject({ id: z.string().max(40), quantity: z.int().min(1).max(20) }))
      .max(20)
      .default([]),
    message: z.string().trim().max(2000).default(''),
    /** Left empty by people; filled by form-filling bots, whose requests are dropped without saying so. */
    website: z.string().max(500).optional(),
  }),
) {}
export class PhotographyBookingRequestResponseDto extends createZodDto(
  z.object({ total: z.int(), deposit: z.int(), currency: z.string(), checkoutUrl: z.string().nullable() }),
) {}
export class PhotographyPublicBookingTypeListDto extends createZodDto(
  z.object({
    types: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        description: z.string(),
        durationMinutes: z.int(),
        price: z.int(),
        deposit: z.int(),
        currency: z.string(),
        addOns: z.array(AddOnSchema),
      }),
    ),
  }),
) {}

import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const HttpUrl = z.url({ protocol: /^https?$/ }).max(2000);

/**
 * FL-1037: a studio's payment account (Stripe, connected through Frameleaf Cloud). `unavailable`: this
 * server isn't linked to Frameleaf Cloud, or has no Server licence. `legacy`: the server still takes
 * this studio's payments with the old server-wide Stripe keys.
 */
export const ClientsPaymentAccountSchema = z.object({
  status: z.enum(['none', 'pending', 'active', 'disconnected', 'unavailable']),
  chargesEnabled: z.boolean(),
  requirementsDue: z.array(z.string()),
  country: z.string().nullable(),
  defaultCurrency: z.string().nullable(),
  legacy: z.boolean(),
});
export type ClientsPaymentAccount = z.infer<typeof ClientsPaymentAccountSchema>;
export class ClientsPaymentAccountDto extends createZodDto(ClientsPaymentAccountSchema) {}
export class ClientsPaymentConnectDto extends createZodDto(z.strictObject({ returnUrl: HttpUrl })) {}
export class ClientsPaymentConnectResponseDto extends createZodDto(z.object({ url: z.string() })) {}

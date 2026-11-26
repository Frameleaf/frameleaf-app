/**
 * FL-1037: the server-wide Stripe settings from before studios connected their own accounts. Read as
 * `FRAMELEAF_CLIENTS_<name>`, falling back to the deprecated `PHOTOGRAPHY_<name>` for one release.
 */
type LegacyName =
  | 'STRIPE_STUDIO_OWNER_ID'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_WEBHOOK_SECRET'
  | 'CHECKOUT_SUCCESS_URL'
  | 'CHECKOUT_CANCEL_URL';

export const legacyStripeEnv = (name: LegacyName): string | undefined =>
  process.env[`FRAMELEAF_CLIENTS_${name}`] || process.env[`PHOTOGRAPHY_${name}`] || undefined;

export const legacyStripeEnvInUse = () =>
  Object.keys(process.env).some((key) => /^PHOTOGRAPHY_(STRIPE|CHECKOUT)_/.test(key) && !!process.env[key]);

/**
 * Whether a browser-supplied address is this server's, so Stripe may send a payer back to it after they pay: the
 * public address when one is set, otherwise the host this request came in on.
 */
export const isOwnAddress = (
  candidate: string | undefined,
  publicUrl: string | null,
  hostname: string,
): candidate is string => {
  if (!candidate || !URL.canParse(candidate)) return false;
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  if (!publicUrl) return url.hostname === hostname;
  return URL.canParse(publicUrl) && url.origin === new URL(publicUrl).origin;
};

/** The base for a checkout's return pages: the request's Origin when it is this server's, else the public address. */
export const checkoutOrigin = (origin: string | undefined, publicUrl: string | null, hostname: string) =>
  isOwnAddress(origin, publicUrl, hostname) && /^https?:\/\/[^/\s]+$/.test(origin) ? origin : publicUrl;

/**
 * Whether a `payment.refunded` event gave back the whole payment. Cloud relays Stripe's `charge.refunded`, which also
 * fires for a partial refund, with the running total refunded as `amount`. An event without an amount counts as full.
 */
export const refundsWholePayment = (refunded: number | null, paid: number) => refunded === null || refunded >= paid;

/** The one studio the legacy settings take payments for, when they are complete. */
export const legacyStripeOwner = () => {
  const ownerId = legacyStripeEnv('STRIPE_STUDIO_OWNER_ID');
  const complete =
    /^sk_(test|live)_/.test(legacyStripeEnv('STRIPE_SECRET_KEY') ?? '') &&
    !!legacyStripeEnv('STRIPE_WEBHOOK_SECRET') &&
    /^https:\/\//.test(legacyStripeEnv('CHECKOUT_SUCCESS_URL') ?? '') &&
    /^https:\/\//.test(legacyStripeEnv('CHECKOUT_CANCEL_URL') ?? '');
  return complete && ownerId ? ownerId : null;
};

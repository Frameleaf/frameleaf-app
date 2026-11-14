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

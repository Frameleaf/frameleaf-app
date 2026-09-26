/**
 * Frameleaf Cloud account, plan and licence helpers (FL-155, FL-156, FL-157, FL-171, FL-172).
 * Pure functions only: the Svelte sections call the server for every real state.
 *
 * Prices are bundled snapshots in USD (owner decision on FL-146, 2026-09-25): every amount is shown
 * in US dollars in every country and never converted. The store address comes from the server's
 * deployment configuration (`GET license/products`), never from here.
 */
import { CloudLinkRefusal } from '@immich/sdk';

// ------------------------------------------------------------------ prices

/** Formats an amount as US dollars, whatever the viewer's language (owner decision, FL-146). */
export const formatUsd = (amount: number, digits?: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits ?? (Number.isSafeInteger(amount) ? 0 : 2),
    maximumFractionDigits: digits ?? 2,
  }).format(amount);

/**
 * FL-156: why plan prices are lower for this viewer, or null. An activated server key (the
 * server's supporter entitlement) or the viewer's own individual supporter key counts; the server
 * reason wins when both apply. AI credit is never discounted, whatever this says.
 */
export type LicensedDiscount = 'server' | 'personal' | null;
export const licensedDiscount = (input: { serverLicensed: boolean; personalKey: boolean }): LicensedDiscount =>
  input.serverLicensed ? 'server' : input.personalKey ? 'personal' : null;

/**
 * A plan price after the licensed-server discount. `share` is the `licensedDiscount` from
 * `GET license/products` (what Frameleaf Cloud last published) for a viewer who gets the discount,
 * else 0. Plans only: never AI credit or extra backup blocks.
 */
export const cloudPlanPrice = (price: number, share: number) =>
  share > 0 ? Math.round(price * (1 - share) * 100) / 100 : price;

/** A discount share as the percentage shown in copy, for example "20%" for 0.2. */
export const discountPercent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * Cloud backup pricing, matching the prices Frameleaf Cloud records (owner decision, 2026-09-25):
 * every plan includes 1 TB, and more storage is sold in 1 TB blocks at this rate per TB a month. Kept
 * in this one constant so a price change is a one-line edit.
 */
export const CLOUD_BACKUP_PRICING = Object.freeze({ includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 });

/** The monthly charge for backup beyond what a plan includes: whole blocks over the included TB. */
export const cloudBackupMonthlyUsd = (storedTb: number) => {
  const { includedTb, blockTb, usdPerTbMonth } = CLOUD_BACKUP_PRICING;
  // a sum like 2.0000000000000004 TB is 2 TB: floating-point noise never starts another block
  const blocks = Math.max(0, Math.ceil(Math.max(0, storedTb - includedTb) / blockTb - 1e-9));
  return Math.round(blocks * blockTb * usdPerTbMonth * 100) / 100;
};

// ------------------------------------------------------------------ licence keys (FL-171)

/** Key symbols: no I, O, 0 or 1 (frameleaf-cloud `docs/entitlements-stripe-licensing.md`). */
export const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type ProductKeyKind = 'server' | 'individual';

export type ProductKeyCheck =
  | { valid: true; key: string; kind: ProductKeyKind; last4: string }
  | { valid: false; key: string; reason: 'empty' | 'format' | 'symbols' | 'kind' | 'check' | 'upstream' };

/**
 * The mod-32 check symbol over the 11 symbols after `FL-`. The kind symbol (S or I) is weighted by
 * its character code, since `I` is not in the alphabet; the others by alphabet index and position.
 * The same rule as the cloud's `license-key.mjs`.
 */
export const keyCheckSymbol = (body: string) => {
  let sum = body.codePointAt(0) ?? 0;
  for (let index = 1; index < body.length; index++) {
    sum += (KEY_ALPHABET.indexOf(body[index]) + 1) * (index + 1);
  }
  return KEY_ALPHABET[sum % 32];
};

/** Uppercases, strips separators and re-hyphenates into FL-XXXX-XXXX-XXXX (system-data.mjs:684-690). */
export const normalizeProductKey = (input: string) => {
  const compact = input
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, '')
    .slice(0, 14);
  return [compact.slice(0, 2), compact.slice(2, 6), compact.slice(6, 10), compact.slice(10, 14)]
    .filter(Boolean)
    .join('-');
};

/**
 * Checks a key before it is sent anywhere (port of system-data.mjs:691-705 with the check symbol).
 * Keys from the previous product-key scheme (IMCL-, IMSV-) are refused by name.
 */
export const validateProductKey = (input: string): ProductKeyCheck => {
  const raw = input.trim().toUpperCase();
  if (/^IM(CL|SV)-/.test(raw)) {
    return { valid: false, key: raw, reason: 'upstream' };
  }
  const key = normalizeProductKey(input);
  if (!key) {
    return { valid: false, key, reason: 'empty' };
  }
  if (!/^FL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) {
    return { valid: false, key, reason: 'format' };
  }
  const symbols = key.slice(3).replaceAll('-', '');
  if (symbols[0] !== 'S' && symbols[0] !== 'I') {
    return { valid: false, key, reason: 'kind' };
  }
  if ([...symbols.slice(1)].some((symbol) => !KEY_ALPHABET.includes(symbol))) {
    return { valid: false, key, reason: 'symbols' };
  }
  if (keyCheckSymbol(symbols.slice(0, 11)) !== symbols[11]) {
    return { valid: false, key, reason: 'check' };
  }
  return { valid: true, key, kind: symbols[0] === 'S' ? 'server' : 'individual', last4: symbols.slice(8) };
};

/** The translation key for why a licence key was refused. */
export const productKeyMessageKey = (reason: Exclude<ProductKeyCheck, { valid: true }>['reason']) =>
  `frameleaf_license_key_error_${reason}` as const;

// ------------------------------------------------------------------ device link (FL-155)

/** Seconds left before a device code expires, never negative. */
export const secondsUntil = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) {
    return 0;
  }
  const left = Math.ceil((Date.parse(iso) - now) / 1000);
  return Number.isFinite(left) ? Math.max(0, left) : 0;
};

/** `m:ss`, as the link code's countdown shows it. */
export const formatCountdown = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.max(0, seconds) % 60).padStart(2, '0')}`;

/** The verification page without its scheme, as the prototype prints it. */
export const displayHost = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
};

/** A short, readable key fingerprint: `SHA256:` and the first and last characters. */
export const shortFingerprint = (kid: string | null | undefined) =>
  kid ? `SHA256:${kid.slice(0, 4)}…${kid.slice(-4)}` : '';

/**
 * FL-177: the title and help for a link Frameleaf Cloud refused for a reason an administrator can act
 * on (402 `instance-limit`, 403 for a removed server or a suspended account, 409 `instance-id-taken`
 * and 409 `jwk_already_bound`).
 */
export const linkRefusalKeys = (refusal: CloudLinkRefusal) => {
  switch (refusal) {
    case CloudLinkRefusal.InstanceLimit: {
      return {
        title: 'frameleaf_cloud_link_refusal_instance_limit_title',
        body: 'frameleaf_cloud_link_refusal_instance_limit_body',
      } as const;
    }
    case CloudLinkRefusal.ServerRefused: {
      return {
        title: 'frameleaf_cloud_link_refusal_server_refused_title',
        body: 'frameleaf_cloud_link_refusal_server_refused_body',
      } as const;
    }
    case CloudLinkRefusal.InstanceIdTaken: {
      return {
        title: 'frameleaf_cloud_link_refusal_instance_id_taken_title',
        body: 'frameleaf_cloud_link_refusal_instance_id_taken_body',
      } as const;
    }
    case CloudLinkRefusal.KeyAlreadyLinked: {
      return {
        title: 'frameleaf_cloud_link_refusal_key_already_linked_title',
        body: 'frameleaf_cloud_link_refusal_key_already_linked_body',
      } as const;
    }
  }
};

// ------------------------------------------------------------------ store (FL-172)

/**
 * The store page for one product, from the store address the server was deployed with. `null`
 * when no store is configured: the card then says purchasing is not available yet.
 */
export const storeProductUrl = (storeUrl: string | null | undefined, productId: string) => {
  if (!storeUrl) {
    return null;
  }
  try {
    const url = new URL(storeUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    url.searchParams.set('product', productId);
    return url.href;
  } catch {
    return null;
  }
};

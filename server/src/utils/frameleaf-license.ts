import { createPublicKey, verify } from 'node:crypto';
import z from 'zod';
import type {
  FrameleafLicense,
  FrameleafLicenseClaims,
  FrameleafLicenseStore,
  FrameleafPricing,
  FrameleafPricingState,
} from 'src/types.js';

/**
 * Frameleaf licence certificates (FL-156, CLD-003; instance contract "License certificate";
 * frameleaf-cloud `docs/entitlements-stripe-licensing.md`). Pure functions only: verification
 * against pinned keys, the none/active/grace/expired/invalid state, the entitlement flags, and the
 * `FL-KXXX-XXXX-XXXX` key check.
 *
 * Only cloud-connected features read these flags. A self-hosted feature is never gated on a
 * licence, and local photos are never locked by one.
 */

/** A pinned licence-signing key: an Ed25519 public key (`x`, base64url) and its `kid`. */
export type LicenseSigningKey = { kid: string; x: string; status: 'active' | 'spare' };

export type LicenseState = 'none' | 'active' | 'grace' | 'expired' | 'invalid';

export type LicenseEntitlements = {
  frameleafCloud: boolean;
  remoteAccess: boolean;
  cloudMl: boolean;
  cloudBackup: boolean;
  supporter: boolean;
};

/** Tolerance for clocks that are slightly apart when checking `nbf`. */
export const LICENSE_CLOCK_SKEW_SECONDS = 60;
/** Grace days when a certificate names none. */
export const DEFAULT_GRACE_DAYS = 7;
/** Refresh a day after issue when the certificate gives no hint, as the contract's `upd.after`. */
export const DEFAULT_REFRESH_AFTER_SECONDS = 86_400;
/** At most this much random delay is added to a scheduled refresh. */
export const REFRESH_JITTER_SECONDS = 3600;

export const LICENSE_TYPE = 'license+jwt';
export const LICENSE_AUDIENCE = 'frameleaf-server';

const claimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  iid: z.string().min(1),
  cnf: z.object({ jkt: z.string().optional() }).optional(),
  lic: z.object({ id: z.string().optional(), last4: z.string().optional(), kind: z.string().optional() }).optional(),
  ent: z.array(z.string()).default([]),
  lim: z.record(z.string(), z.number()).optional(),
  lic_exp: z.number().nullable().default(null),
  upd: z.object({ after: z.number().optional(), url: z.string().optional() }).optional(),
  grace_days: z.number().int().min(0).max(60).optional(),
  iat: z.number(),
  nbf: z.number().optional(),
  exp: z.number(),
  jti: z.string().optional(),
});

export type LicenseRefusal =
  | 'malformed'
  | 'algorithm'
  | 'type'
  | 'unknown-kid'
  | 'signature'
  | 'audience'
  | 'instance'
  | 'account'
  | 'key-binding'
  | 'not-yet-valid'
  | 'expired';

export type VerifiedCertificate = { ok: true; kid: string; claims: FrameleafLicenseClaims };
export type RefusedCertificate = { ok: false; reason: LicenseRefusal };

const decodeJson = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * Verify a certificate with the pinned keys only. Refused: another algorithm or type, an unknown
 * `kid`, a bad signature or a tampered payload, another audience, another instance (`iid`), another
 * account (`sub`, when this server knows its account), another key binding (`cnf.jkt`), a future
 * `nbf`, and an `exp` in the past (a new certificate must be current; a stored one ages into grace).
 *
 * Binding: the instance id (`iid`) is what binds a certificate to this server and is always
 * required. `cnf.jkt` (the identity key thumbprint) is optional: it is checked only when both the
 * certificate carries it and this server has a key, because an offline certificate may be issued
 * before the server has linked, and a key rotation must not invalidate a licence.
 */
export const verifyLicenseCertificate = (
  jws: string,
  context: {
    keys: readonly LicenseSigningKey[];
    instanceId: string;
    accountId?: string | null;
    jkt?: string | null;
    now?: number;
    allowExpired?: boolean;
  },
): VerifiedCertificate | RefusedCertificate => {
  const parts = jws.trim().split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[\w-]*$/.test(part))) {
    return { ok: false, reason: 'malformed' };
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  let header: { alg?: unknown; typ?: unknown; kid?: unknown };
  let payload: unknown;
  try {
    header = decodeJson(headerPart) as typeof header;
    payload = decodeJson(payloadPart);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'EdDSA') {
    return { ok: false, reason: 'algorithm' };
  }
  if (header.typ !== LICENSE_TYPE) {
    return { ok: false, reason: 'type' };
  }
  const key = context.keys.find(({ kid }) => kid === header.kid);
  if (!key) {
    return { ok: false, reason: 'unknown-kid' };
  }
  let valid: boolean;
  try {
    valid = verify(
      null,
      Buffer.from(`${headerPart}.${payloadPart}`),
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' }),
      Buffer.from(signaturePart, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'signature' };
  }
  const parsed = claimsSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed' };
  }
  const claims = parsed.data;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(LICENSE_AUDIENCE)) {
    return { ok: false, reason: 'audience' };
  }
  if (claims.iid !== context.instanceId) {
    return { ok: false, reason: 'instance' };
  }
  if (context.accountId && claims.sub !== context.accountId) {
    return { ok: false, reason: 'account' };
  }
  if (claims.cnf?.jkt && context.jkt && claims.cnf.jkt !== context.jkt) {
    return { ok: false, reason: 'key-binding' };
  }
  const now = Math.floor((context.now ?? Date.now()) / 1000);
  if (claims.nbf !== undefined && claims.nbf > now + LICENSE_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'not-yet-valid' };
  }
  if (!context.allowExpired && claims.exp <= now) {
    return { ok: false, reason: 'expired' };
  }
  return {
    ok: true,
    kid: key.kid,
    claims: {
      ...claims,
      aud: LICENSE_AUDIENCE,
      ent: [...claims.ent],
      lic_exp: claims.lic_exp,
    } as FrameleafLicenseClaims,
  };
};

/**
 * When a stored certificate stops counting: the earlier of its `exp` (it must be refreshed by then)
 * and `lic_exp` (the entitlement period end; null for a lifetime key).
 */
export const certificateEnd = (claims: FrameleafLicenseClaims): number =>
  claims.lic_exp === null ? claims.exp : Math.min(claims.exp, claims.lic_exp);

export type LicenseStatus = {
  state: LicenseState;
  expiresAt: Date | null;
  graceUntil: Date | null;
};

/**
 * The state of one stored certificate: active until it ends, then in grace for `grace_days` while
 * refresh keeps failing, then expired. A lifetime supporter key never expires on its own.
 */
export const licenseStatus = (license: FrameleafLicense | null | undefined, now = Date.now()): LicenseStatus => {
  if (!license) {
    return { state: 'none', expiresAt: null, graceUntil: null };
  }
  const end = certificateEnd(license.claims) * 1000;
  const graceUntil = end + (license.claims.grace_days ?? DEFAULT_GRACE_DAYS) * 86_400_000;
  const lifetime = license.claims.lic_exp === null && isSupporterOnly(license.claims);
  if (lifetime) {
    return { state: 'active', expiresAt: null, graceUntil: null };
  }
  if (now < end) {
    return { state: 'active', expiresAt: new Date(end), graceUntil: null };
  }
  if (now < graceUntil) {
    return { state: 'grace', expiresAt: new Date(end), graceUntil: new Date(graceUntil) };
  }
  return { state: 'expired', expiresAt: new Date(end), graceUntil: new Date(graceUntil) };
};

const SUPPORTER = new Set(['SUPPORTER_SERVER', 'SUPPORTER_INDIVIDUAL']);
const isSupporterOnly = (claims: FrameleafLicenseClaims) =>
  claims.ent.length > 0 && claims.ent.every((entitlement) => SUPPORTER.has(entitlement));

/**
 * Entitlement flags for the web and native clients. Cloud-connected flags need an active or grace
 * certificate; past grace they are false and nothing local changes. The supporter badge follows a
 * supporter entitlement on any certificate that is active, in grace, or lifetime.
 */
export const entitlementFlags = (licenses: Array<FrameleafLicense | null | undefined>, now = Date.now()) => {
  const flags: LicenseEntitlements = {
    frameleafCloud: false,
    remoteAccess: false,
    cloudMl: false,
    cloudBackup: false,
    supporter: false,
  };
  for (const license of licenses) {
    if (!license) {
      continue;
    }
    const { state } = licenseStatus(license, now);
    if (state !== 'active' && state !== 'grace') {
      continue;
    }
    const ent = new Set(license.claims.ent);
    flags.frameleafCloud ||= ent.has('CLOUD');
    flags.remoteAccess ||= ent.has('REMOTE_ACCESS');
    flags.cloudMl ||= ent.has('CLOUD_ML');
    flags.cloudBackup ||= ent.has('CLOUD_BACKUP');
    flags.supporter ||= ent.has('SUPPORTER_SERVER') || ent.has('SUPPORTER_INDIVIDUAL');
  }
  return flags;
};

/** A licensed server: its supporter key or plan certificate is active or in grace (About, FL-156). */
export const isLicensed = (store: FrameleafLicenseStore | null | undefined, now = Date.now()) =>
  [store?.key, store?.plan].some((license) => {
    const { state } = licenseStatus(license, now);
    return state === 'active' || state === 'grace';
  });

/** Which licence a certificate is: a supporter key's (`lic` present) or the account's plan. */
export const certificateKind = (claims: FrameleafLicenseClaims): FrameleafLicense['kind'] => {
  if (!claims.lic) {
    return 'plan';
  }
  return claims.lic.kind === 'individual' || claims.ent.includes('SUPPORTER_INDIVIDUAL') ? 'individual' : 'server';
};

/** When to ask for a fresh certificate: `upd.after` seconds after issue, plus jitter. */
export const nextRefreshAt = (claims: FrameleafLicenseClaims, random = Math.random): Date =>
  new Date(
    (claims.iat +
      (claims.upd?.after ?? DEFAULT_REFRESH_AFTER_SECONDS) +
      Math.floor(random() * REFRESH_JITTER_SECONDS)) *
      1000,
  );

// ------------------------------------------------------------------ keys

/** Key symbols: no I, O, 0 or 1. The kind symbol (S or I) sits outside this alphabet. */
export const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** The kind symbol's value in the check: `S` is its alphabet index (16); `I` has the fixed value 8. */
const KEY_KIND_VALUES: Record<string, number> = { S: 16, I: 8 };

const KEY_CHECK_MODULUS = 32;

/** Symbols to values for the check: the kind first (S 16, I 8), then alphabet indexes. */
const keySymbolValues = (symbols: string): number[] => {
  const kind = KEY_KIND_VALUES[symbols[0]];
  if (kind === undefined) {
    throw new Error('a licence key starts with S or I');
  }
  return [kind, ...[...symbols.slice(1)].map((symbol) => KEY_ALPHABET.indexOf(symbol))];
};

/**
 * Luhn mod 32 sum: walking from the rightmost value leftwards, every second value is doubled,
 * starting with the rightmost when `doubleRightmost` (generation) or with the one left of it
 * (validation, where the rightmost is the check). A doubled value v counts as
 * `Math.floor(2v / 32) + (2v % 32)`.
 */
const luhnSum = (values: readonly number[], doubleRightmost: boolean): number => {
  let sum = 0;
  let double = doubleRightmost;
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index];
    sum += double ? Math.floor((2 * value) / KEY_CHECK_MODULUS) + ((2 * value) % KEY_CHECK_MODULUS) : value;
    double = !double;
  }
  return sum;
};

/**
 * The check-symbol algorithm, Luhn mod 32 (as-built decision #40; frameleaf-cloud
 * `packages/contracts/src/licence/key-format.ts`, `licenseKeyCheckSymbol`): over the 11 values of
 * the kind and the ten body symbols, check = (32 − (sum mod 32)) mod 32, mapped back to the
 * alphabet. It catches every single-symbol substitution and most adjacent transpositions.
 */
export const keyCheckSymbol = (body: string) => {
  const sum = luhnSum(keySymbolValues(body), true);
  return KEY_ALPHABET[(KEY_CHECK_MODULUS - (sum % KEY_CHECK_MODULUS)) % KEY_CHECK_MODULUS];
};

export type LicenseKeyCheck =
  | { valid: true; key: string; kind: 'server' | 'individual'; last4: string }
  | { valid: false; reason: 'format' | 'kind' | 'symbols' | 'check' | 'upstream' };

/** `FL-KXXX-XXXX-XXXX` with K = S (server) or I (individual) and a mod-32 check symbol. */
export const checkLicenseKey = (input: string): LicenseKeyCheck => {
  const key = input.trim().toUpperCase();
  // upstream product keys are detected on the symbols alone, whatever separators surround them
  const compact = key.replaceAll(/[^A-Z0-9]/g, '');
  if (compact.startsWith('IMCL') || compact.startsWith('IMSV')) {
    return { valid: false, reason: 'upstream' };
  }
  if (!/^FL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) {
    return { valid: false, reason: 'format' };
  }
  const symbols = key.slice(3).replaceAll('-', '');
  if (symbols[0] !== 'S' && symbols[0] !== 'I') {
    return { valid: false, reason: 'kind' };
  }
  if ([...symbols.slice(1)].some((symbol) => !KEY_ALPHABET.includes(symbol))) {
    return { valid: false, reason: 'symbols' };
  }
  if (keyCheckSymbol(symbols.slice(0, 11)) !== symbols[11]) {
    return { valid: false, reason: 'check' };
  }
  return { valid: true, key, kind: symbols[0] === 'S' ? 'server' : 'individual', last4: symbols.slice(8) };
};

/** Plain-language reason a key was refused, for the error the client shows. */
export const licenseKeyProblem = (reason: Exclude<LicenseKeyCheck, { valid: true }>['reason']) => {
  switch (reason) {
    case 'upstream': {
      return 'This is not a Frameleaf licence key. Frameleaf keys start with FL-.';
    }
    case 'format': {
      return 'Keys look like FL-SXXX-XXXX-XXXX.';
    }
    case 'kind': {
      return 'This key does not belong to a Frameleaf product.';
    }
    case 'symbols': {
      return 'Keys never contain I, O, 0 or 1 after the first group.';
    }
    case 'check': {
      return 'That key has a typo; check the last group.';
    }
  }
};

/** Plain-language reason a certificate was refused. */
export const certificateProblem = (reason: LicenseRefusal) => {
  switch (reason) {
    case 'instance': {
      return 'This licence belongs to a different server. Download the file for this server’s instance ID.';
    }
    case 'account': {
      return 'This licence belongs to a different Frameleaf account.';
    }
    case 'expired': {
      return 'This licence file has expired. Download a new one.';
    }
    case 'not-yet-valid': {
      return 'This licence is not valid yet. Check the server’s clock.';
    }
    default: {
      return 'This is not a valid Frameleaf licence.';
    }
  }
};

// ------------------------------------------------------------------ published pricing

/** The pricing bundled with this release, used until Frameleaf Cloud publishes a valid one. */
export const BUNDLED_PRICING: Readonly<FrameleafPricing> = Object.freeze({
  pricesVersion: '2026-09-25.1',
  licensedDiscountPercent: 20,
  effectiveFrom: '2026-09-25T00:00:00Z',
});

const publishedPricingSchema = z.object({
  pricesVersion: z
    .string()
    .max(32)
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$/),
  licensedDiscountPercent: z.number().int().min(0).max(50),
  effectiveFrom: z.iso.datetime(),
});

const versionParts = (version: string) => {
  const [date, revision] = version.split('.', 2);
  return { date, revision: Number(revision) };
};

/** Orders two pricings: by `effectiveFrom`, then by `pricesVersion` (date, then revision). */
export const comparePricing = (a: FrameleafPricing, b: FrameleafPricing) => {
  const byTime = Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom);
  if (byTime !== 0) {
    return Math.sign(byTime);
  }
  const [x, y] = [versionParts(a.pricesVersion), versionParts(b.pricesVersion)];
  return x.date === y.date ? Math.sign(x.revision - y.revision) : x.date < y.date ? -1 : 1;
};

/** The stored state with a pending pricing whose `effectiveFrom` has passed made current. */
export const settlePricing = (
  stored: FrameleafPricingState | null | undefined,
  now = Date.now(),
): FrameleafPricingState => {
  const current = stored?.current ?? null;
  const pending = stored?.pending;
  if (pending && Date.parse(pending.effectiveFrom) <= now) {
    return { current: pending };
  }
  return pending ? { current, pending } : { current };
};

/**
 * The pricing state to keep after a heartbeat. This is the one place that reads the `pricing`
 * object Frameleaf Cloud publishes:
 *
 * - One that is missing or fails validation changes nothing.
 * - One older than the pricing in force (the last good one, else the bundle) is ignored.
 * - One already in force is authoritative: it becomes (or stays) current and clears any pending
 *   pricing, so the cloud withdraws a pending change by publishing the current one again.
 * - One still to come waits as `pending`, replacing a pending one only when it is newer.
 */
export const acceptPublishedPricing = (
  raw: unknown,
  stored: FrameleafPricingState | null | undefined,
  now = Date.now(),
): FrameleafPricingState => {
  const state = settlePricing(stored, now);
  const parsed = publishedPricingSchema.safeParse(raw);
  if (!parsed.success) {
    return state;
  }
  const published = parsed.data;
  const inForce = state.current ?? BUNDLED_PRICING;
  const order = comparePricing(published, inForce);
  if (order < 0) {
    return state;
  }
  if (Date.parse(published.effectiveFrom) <= now) {
    // the same version republished keeps the stored copy (null while the bundle is in force)
    return { current: order === 0 ? state.current : published };
  }
  if (order === 0 || (state.pending && comparePricing(published, state.pending) <= 0)) {
    return state;
  }
  return { current: state.current, pending: published };
};

/** The pricing in force at `now`: the last good published value that has taken effect, else the bundle. */
export const effectivePricing = (
  stored: FrameleafPricingState | null | undefined,
  now = Date.now(),
): FrameleafPricing => settlePricing(stored, now).current ?? BUNDLED_PRICING;

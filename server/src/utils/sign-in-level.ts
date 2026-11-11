/**
 * Unified sign-in (spec 2026-11-11, docs/superpowers/specs): how a session was made, and the level that follows.
 * Rules are written against the level, never against a list of methods. The same vectors as Frameleaf Cloud's
 * implementation are in `sign-in-level.spec.ts`.
 */

/** Method names on the wire (`amr`), in the order used. */
export const SIGN_IN_METHODS = ['passkey', 'pwd', 'totp', 'recovery_code', 'email_code', 'magic_link'] as const;
export type SignInMethodName = (typeof SIGN_IN_METHODS)[number];

export const ACR_VERIFIED = 'urn:frameleaf:acr:verified';
export const ACR_BASIC = 'urn:frameleaf:acr:basic';

export type SignInLevel = 'verified' | 'basic';
export type SignInSource = 'local' | 'frameleaf';

const isMethod = (value: unknown): value is SignInMethodName =>
  typeof value === 'string' && (SIGN_IN_METHODS as readonly string[]).includes(value);

/** The methods a token names: known names only, in order, once each. Anything else is ignored (unknown is Basic). */
export const parseAmr = (amr: unknown): SignInMethodName[] =>
  Array.isArray(amr) ? [...new Set(amr.filter((value) => isMethod(value)))] : [];

/** A token's `acr`; a missing or unknown value is Basic. */
export const levelFromAcr = (acr: unknown): SignInLevel => (acr === ACR_VERIFIED ? 'verified' : 'basic');

export const acrFromLevel = (level: SignInLevel) => (level === 'verified' ? ACR_VERIFIED : ACR_BASIC);

/**
 * Verified: a passkey, or two different factors among password, emailed code (a magic link is the same
 * factor) and authenticator code (a recovery code counts as the authenticator). Everything else, including
 * no recorded methods and a lone `totp`, is Basic here (a lone `totp` is never a valid session).
 */
export const levelFromMethods = (methods: readonly string[]): SignInLevel => {
  const known = new Set(methods.filter((method) => isMethod(method)));
  if (known.has('passkey')) {
    return 'verified';
  }
  const factors = new Set<string>();
  if (known.has('pwd')) factors.add('password');
  if (known.has('email_code') || known.has('magic_link')) factors.add('mailbox');
  if (known.has('totp') || known.has('recovery_code')) factors.add('authenticator');
  return factors.size >= 2 ? 'verified' : 'basic';
};

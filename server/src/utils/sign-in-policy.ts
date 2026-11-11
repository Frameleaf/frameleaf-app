/**
 * Unified sign-in (spec 2026-11-11, "Server behaviour" 2): the one rule the server applies to a session,
 * written against the level the session reached and never against a list of methods. Pure; the callers
 * (`requireRemoteSignIn`, `requirePasswordLogin`, administrator routes, step-up) read the inputs.
 */
import type { SignInLevel, SignInSource } from 'src/utils/sign-in-level.js';

/** The owner's "Require a passkey or two-step" setting. */
export const SIGN_IN_REQUIREMENTS = ['administrators-away', 'everyone-away', 'everyone'] as const;
export type SignInRequirement = (typeof SIGN_IN_REQUIREMENTS)[number];
export const DEFAULT_SIGN_IN_REQUIREMENT: SignInRequirement = 'administrators-away';

export type PolicyRecord = { level: SignInLevel; methods: readonly string[]; source: SignInSource; legacy: boolean };

export type PolicyInput = {
  /** The request arrived through the relay or a direct remote address. */
  away: boolean;
  isAdmin: boolean;
  /** The route is an administrator route. */
  adminRoute: boolean;
  /** How the session was made; none for a session older than the record. */
  record?: PolicyRecord;
  requirement: SignInRequirement;
  /** "Apply to older apps too": legacy sessions follow the rule too. */
  applyToOlderApps: boolean;
  allowPasswordOverRelay: boolean;
  /** The person has a local authenticator switched on. */
  hasAuthenticator: boolean;
  /**
   * A Frameleaf sign-in's live tag still exists (unlinking removes it and keeps the session). Without it the
   * session is neither a Frameleaf sign-in nor a password one. Default: tagged.
   */
  frameleafTagged?: boolean;
};

export type PolicyDecision =
  | { ok: true }
  /** Away from home without a Frameleaf or passkey sign-in (403 `frameleaf_sign_in_required`). */
  | { ok: false; code: 'frameleaf_sign_in_required' }
  /** More is needed: Cloud's step-up, or the local authenticator (403 `verification_required`). */
  | { ok: false; code: 'verification_required' }
  /** `everyone` at home for a password-only person: set up the authenticator first. */
  | { ok: false; code: 'two_factor_setup_required' };

const usedAuthenticator = (methods: readonly string[]) => methods.includes('totp') || methods.includes('recovery_code');

export const evaluateSession = (input: PolicyInput): PolicyDecision => {
  const { record, away } = input;
  const legacy = !record || (record.legacy && !input.applyToOlderApps);
  const local = !record || record.source === 'local';
  // a passkey counts only when it is this server's own; a Cloud passkey counts as the Frameleaf sign-in it was
  const passkey = local && !!record?.methods.includes('passkey');
  const untagged = record?.source === 'frameleaf' && input.frameleafTagged === false;
  const frameleaf = record?.source === 'frameleaf' && !untagged;

  if (away) {
    // a password away from home is accepted only when the owner allowed it, and then only with the authenticator
    const password = local && input.allowPasswordOverRelay && (legacy || usedAuthenticator(record?.methods ?? []));
    if (!frameleaf && !passkey && !password) {
      return { ok: false, code: 'frameleaf_sign_in_required' };
    }
  }
  if (legacy) {
    return { ok: true };
  }
  const verified = record!.level === 'verified';
  if (verified) {
    return { ok: true };
  }

  // Basic from here
  if (frameleaf && input.hasAuthenticator) {
    // a person's local authenticator is never skipped silently, at home or away
    return { ok: false, code: 'verification_required' };
  }
  if (!frameleaf && !passkey && !away && input.requirement === 'everyone' && !input.hasAuthenticator) {
    // a local password with no second step, where everyone must have one: set it up first (a person who has
    // one already is asked for it instead, below)
    return { ok: false, code: 'two_factor_setup_required' };
  }
  const everyone = input.requirement === 'everyone' || (away && input.requirement === 'everyone-away');
  if (everyone || (away && input.isAdmin && input.adminRoute)) {
    return { ok: false, code: 'verification_required' };
  }
  return { ok: true };
};

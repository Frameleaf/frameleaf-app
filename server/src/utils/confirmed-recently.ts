/**
 * Unified sign-in (spec 2026-11-11): "confirmed recently", the one freshness rule for sensitive actions
 * (two-step changes, adding a passkey, reading server logs away from home, restoring a backup, removing a
 * person). Within 600 seconds the person proved themselves with a Frameleaf sign-in (its `auth_time`) or a
 * local passkey, or they type their password (and authenticator code, when they have one) for the action.
 * It adds no level requirement beyond what the away/administrator rule already demands. The 30-day
 * trusted-browser cookie never counts, so a local password sign-in is never recent by itself.
 */
export const CONFIRMED_RECENTLY_SECONDS = 600;
export const CONFIRMATION_REQUIRED = 'confirmation_required';

export const signInIsRecent = (
  signIn:
    { methods: readonly string[]; source: 'local' | 'frameleaf'; authTime?: Date | string | null } | null | undefined,
  now = Date.now(),
): boolean => {
  if (!signIn?.authTime || (signIn.source !== 'frameleaf' && !signIn.methods.includes('passkey'))) {
    return false;
  }
  const at = new Date(signIn.authTime).getTime();
  return at <= now && now - at <= CONFIRMED_RECENTLY_SECONDS * 1000;
};

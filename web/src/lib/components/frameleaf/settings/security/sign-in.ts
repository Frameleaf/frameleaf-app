/**
 * Who can sign in and Your sign-in & privacy (FL-367) in plain words: the rules of the two landing
 * pages, kept apart from the drawing so they can be tested on their own.
 */
import type { SessionResponseDto } from '@frameleaf/sdk';

/** The ways in that are on, as one key of `frameleaf_security_methods_*`. */
export const signInMethodsState = ({
  password,
  provider,
  frameleaf,
}: {
  password: boolean;
  provider: boolean;
  frameleaf: boolean;
}) => {
  const on = [password && 'password', provider && 'provider', frameleaf && 'frameleaf'].filter(Boolean);
  return (on.length === 0 ? 'none' : on.join('_')) as
    | 'none'
    | 'password'
    | 'provider'
    | 'frameleaf'
    | 'password_provider'
    | 'password_frameleaf'
    | 'provider_frameleaf'
    | 'password_provider_frameleaf';
};

const DAY_MS = 86_400_000;
/** A device not used for this long is "not used for a while" (30 days, as the prototype). */
export const IDLE_DEVICE_DAYS = 30;

/** Signed-in devices, other than this one, not used for a while. */
export const idleDevices = (sessions: readonly SessionResponseDto[], now = Date.now()) =>
  sessions.filter((session) => !session.current && now - Date.parse(session.updatedAt) > IDLE_DEVICE_DAYS * DAY_MS);

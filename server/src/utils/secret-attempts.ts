import { UnauthorizedException } from '@nestjs/common';

/*
 * SECURITY (security.md M5): exponential backoff for secret checks, per account.
 * The PIN is only 6 digits (~10^6 keyspace), so without throttling an attacker
 * with a stolen session token can brute-force the full space in minutes.
 * Track failed attempts per user in-process. State resets on process restart,
 * which is conservative — fewer false lockouts at the cost of bypass via
 * process kill (only available to admins).
 *
 * FL-721: the Locked encryption secrets (PIN, passphrase, recovery key) share this one counter and
 * queue with PIN unlock (spec §10), so trying them in turn never buys extra guesses.
 */
const FAILURE_THRESHOLDS = [
  { attempts: 5, lockoutMs: 60 * 1000 }, // 5 failures -> 1 minute
  { attempts: 10, lockoutMs: 60 * 60 * 1000 }, // 10 failures -> 1 hour
  { attempts: 15, lockoutMs: 24 * 60 * 60 * 1000 }, // 15 failures -> 24 hours
];
const FAILURE_RESET_MS = 30 * 60 * 1000; // failures expire after 30 min of inactivity

type AttemptState = { failureCount: number; lastFailureAt: number; lockedUntil: number };
const attemptsByUser = new Map<string, AttemptState>();
// Keep backoff admission serial while bcrypt or scrypt runs outside the event loop.
const checksByUser = new Map<string, Promise<void>>();

const lookupLockoutMs = (failureCount: number): number => {
  let lockout = 0;
  for (const tier of FAILURE_THRESHOLDS) {
    if (failureCount >= tier.attempts) {
      lockout = tier.lockoutMs;
    }
  }
  return lockout;
};

const assertNotLockedOut = (userId: string, what: string) => {
  const state = attemptsByUser.get(userId);
  const now = Date.now();
  if (state && state.lockedUntil > now) {
    const retryAfterSec = Math.ceil((state.lockedUntil - now) / 1000);
    throw new UnauthorizedException(`Too many failed ${what} attempts. Try again in ${retryAfterSec} seconds.`);
  }
};

/** A secret check inside `checkSecret`: a throw counts as a failed attempt, a return resets the count. */
export type VerifySecret = <T>(check: () => Promise<T>) => Promise<T>;

/**
 * Runs `run` after every earlier secret check of this account has finished, refusing while the
 * account is locked out. `run` loads what it needs, then calls `verify` around the check itself:
 * the lockout is checked again first (a pending read must observe failures from other requests),
 * and its outcome is counted. `what` names the secret in the lockout message.
 */
export async function checkSecret<T>(
  userId: string,
  run: (verify: VerifySecret) => Promise<T>,
  what = 'PIN',
): Promise<T> {
  const previous = checksByUser.get(userId);
  const { promise, resolve } = Promise.withResolvers<void>();
  checksByUser.set(userId, promise);
  await previous;
  try {
    assertNotLockedOut(userId, what);
    const verify: VerifySecret = async (check) => {
      assertNotLockedOut(userId, what);
      const now = Date.now();
      const state = attemptsByUser.get(userId);
      let result;
      try {
        result = await check();
      } catch (error) {
        // Record failure and apply backoff. Failures expire after a quiet window.
        const prev =
          state && now - state.lastFailureAt < FAILURE_RESET_MS
            ? state
            : { failureCount: 0, lastFailureAt: 0, lockedUntil: 0 };
        const failureCount = prev.failureCount + 1;
        const lockoutMs = lookupLockoutMs(failureCount);
        attemptsByUser.set(userId, {
          failureCount,
          lastFailureAt: now,
          lockedUntil: lockoutMs > 0 ? now + lockoutMs : 0,
        });
        throw error;
      }
      // Successful credential check resets the per-user counter.
      attemptsByUser.delete(userId);
      return result;
    };
    return await run(verify);
  } finally {
    resolve();
    if (checksByUser.get(userId) === promise) {
      checksByUser.delete(userId);
    }
  }
}

import { startFrameleafSignIn } from '@immich/sdk';
import { recordOAuthRequest } from '$lib/frameleaf/auth-session-preference';

/**
 * Sign in with Frameleaf (FL-158) in the browser: the provider returns to the same callbacks as the
 * administrator's own provider (`/auth/login` to sign in, `/link` to link an account), so the start
 * of each Frameleaf request is recorded under its `state`, for 15 minutes, and the tab that receives
 * the callback takes it back once to know the callback is Frameleaf's and what it was for.
 */
export type FrameleafPurpose = 'sign-in' | 'link';

const PREFIX = 'frameleaf.auth.frameleafRequest.';
const TTL_MS = 15 * 60 * 1000;

type FrameleafRequest = { purpose: FrameleafPurpose; expiresAt: number };

const store = () => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

const stateOf = (url: string) => {
  try {
    return new URL(url, 'http://localhost').searchParams.get('state');
  } catch {
    return null;
  }
};

/** Record a Frameleaf request by the `state` of its authorize address. */
export const recordFrameleafRequest = (authorizeUrl: string, purpose: FrameleafPurpose, now = Date.now()) => {
  const state = stateOf(authorizeUrl);
  if (!state) {
    return false;
  }
  try {
    store()?.setItem(PREFIX + state, JSON.stringify({ purpose, expiresAt: now + TTL_MS } satisfies FrameleafRequest));
    return true;
  } catch {
    return false;
  }
};

/** What a callback was for, when it answers a Frameleaf request made from this browser; taken once. */
export const takeFrameleafCallback = (callbackUrl: string, now = Date.now()): FrameleafPurpose | null => {
  const state = stateOf(callbackUrl);
  const storage = store();
  if (!state || !storage) {
    return null;
  }
  try {
    const key = PREFIX + state;
    const raw = storage.getItem(key);
    storage.removeItem(key);
    const record = raw ? (JSON.parse(raw) as Partial<FrameleafRequest>) : null;
    if (!record || typeof record.expiresAt !== 'number' || record.expiresAt <= now) {
      return null;
    }
    return record.purpose === 'sign-in' || record.purpose === 'link' ? record.purpose : null;
  } catch {
    return null;
  }
};

/**
 * Leave for Frameleaf: `sign-in` returns to the login page this was started from, `link` to `/link`.
 * Throws when the server refuses (not linked, or the address is not registered).
 */
export const startFrameleaf = async (purpose: FrameleafPurpose, location: Location) => {
  const redirectUri = purpose === 'link' ? `${location.origin}/link` : location.href.split('?', 1)[0];
  const { url } = await startFrameleafSignIn({ oAuthConfigDto: { redirectUri } });
  if (!recordFrameleafRequest(url, purpose)) {
    throw new Error('storage');
  }
  if (purpose === 'sign-in') {
    // "Keep me signed in" and where to continue, as for the administrator's own provider (FL-80)
    recordOAuthRequest(url);
  }
  globalThis.location.assign(url);
};

import { createFrameleafHandoff, startFrameleafSignIn } from '@frameleaf/sdk';
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

type FrameleafRequest = { purpose: FrameleafPurpose; expiresAt: number; returnTo?: string; nonce?: string };

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
export const recordFrameleafRequest = (
  authorizeUrl: string,
  purpose: FrameleafPurpose,
  now = Date.now(),
  bounce?: { returnTo: string; nonce: string },
) => {
  const state = stateOf(authorizeUrl);
  if (!state) {
    return false;
  }
  try {
    store()?.setItem(
      PREFIX + state,
      JSON.stringify({ purpose, expiresAt: now + TTL_MS, ...bounce } satisfies FrameleafRequest),
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * What a callback was for, and the home address to return to (FL-167) when it answers a Frameleaf
 * request made from this browser; taken once.
 */
export const takeFrameleafCallbackRequest = (
  callbackUrl: string,
  now = Date.now(),
): { purpose: FrameleafPurpose; bounce: { returnTo: string; nonce: string } | null } | null => {
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
    if (record.purpose !== 'sign-in' && record.purpose !== 'link') {
      return null;
    }
    const bounce =
      typeof record.returnTo === 'string' && typeof record.nonce === 'string'
        ? { returnTo: record.returnTo, nonce: record.nonce }
        : null;
    return { purpose: record.purpose, bounce };
  } catch {
    return null;
  }
};

/** What a callback was for, when it answers a Frameleaf request made from this browser; taken once. */
export const takeFrameleafCallback = (callbackUrl: string, now = Date.now()): FrameleafPurpose | null =>
  takeFrameleafCallbackRequest(callbackUrl, now)?.purpose ?? null;

/**
 * Leave for Frameleaf: `sign-in` returns to the login page this was started from, `link` to `/link`.
 * Throws when the server refuses (not linked, or the address is not registered).
 */
export const startFrameleaf = async (
  purpose: FrameleafPurpose,
  location: Location,
  bounce?: { returnTo: string; nonce: string },
) => {
  const redirectUri = purpose === 'link' ? `${location.origin}/link` : location.href.split('?', 1)[0];
  const { url } = await startFrameleafSignIn({ oAuthConfigDto: { redirectUri } });
  if (!recordFrameleafRequest(url, purpose, Date.now(), bounce)) {
    throw new Error('storage');
  }
  if (purpose === 'sign-in') {
    // "Keep me signed in" and where to continue, as for the administrator's own provider (FL-80)
    recordOAuthRequest(url);
  }
  globalThis.location.assign(url);
};

/**
 * FL-167: the LAN→relay sign-in bounce. A home address is not a registered sign-in address, so Sign
 * in with Frameleaf leaves for the public address (the relay name, or the verified custom domain) with
 * the home address to come back to. There, after signing in, the server hands the session back with a
 * single-use code, and only to a home address it published itself.
 */
export const RETURN_PARAM = 'frameleafReturn';
export const NONCE_PARAM = 'frameleafNonce';
export const REMEMBER_PARAM = 'frameleafRemember';
export const HANDOFF_FRAGMENT = 'frameleafHandoff';
const NONCE_KEY = 'frameleaf.auth.handoffNonce';
const NONCE = /^[\w-]{16,64}$/;

const session = () => {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
};

/**
 * The public address's login page, starting Sign in with Frameleaf and returning to this home address.
 * A nonce kept in this tab goes along and must come back with the code, so a code someone else made
 * for their own account can never sign this browser in (login CSRF).
 */
export const bounceUrl = (signInOrigin: string, location: Location, rememberMe: boolean) => {
  const nonce = crypto.randomUUID();
  session()?.setItem(NONCE_KEY, nonce);
  const url = new URL('/auth/login', signInOrigin);
  url.searchParams.set(RETURN_PARAM, location.origin);
  url.searchParams.set(NONCE_PARAM, nonce);
  url.searchParams.set(REMEMBER_PARAM, rememberMe ? '1' : '0');
  return url.href;
};

/** The home address a bounce asked to return to (an https origin) and its nonce, or null. */
export const bounceReturn = (location: Location): { returnTo: string; nonce: string } | null => {
  const params = new URLSearchParams(location.search ?? '');
  const value = params.get(RETURN_PARAM);
  const nonce = params.get(NONCE_PARAM);
  if (!value || !nonce || !NONCE.test(nonce)) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin !== location.origin ? { returnTo: url.origin, nonce } : null;
  } catch {
    return null;
  }
};

/**
 * A handoff code in this page's fragment, taken once (the fragment is cleared), and only when it
 * carries the nonce this tab sent off with its own bounce.
 */
export const takeHandoffCode = (location: Location): string | null => {
  const params = new URLSearchParams((location.hash ?? '').replace(/^#/, ''));
  const code = params.get(HANDOFF_FRAGMENT);
  if (!code) {
    return null;
  }
  history.replaceState(history.state, '', location.pathname + location.search);
  const expected = session()?.getItem(NONCE_KEY);
  session()?.removeItem(NONCE_KEY);
  return expected && params.get(NONCE_PARAM) === expected ? code : null;
};

/** Back to the home address with a code for this session; the server checks the address. */
export const handBack = async (bounce: { returnTo: string; nonce: string }) => {
  const { url } = await createFrameleafHandoff({ frameleafHandoffCreateDto: { returnTo: bounce.returnTo } });
  if (!url) {
    throw new Error('handoff');
  }
  location.assign(`${url}&${NONCE_PARAM}=${encodeURIComponent(bounce.nonce)}`);
};

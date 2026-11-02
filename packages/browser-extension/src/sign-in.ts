import { normalizeServerAddress } from './api';
import type { SignInProblem } from './settings';

/**
 * FL-655: Save to Frameleaf signs in with your own Frameleaf account. The browser's sign-in window
 * (`chrome.identity.launchWebAuthFlow`) opens the server's own sign-in and then its one-time
 * "Allow Save to Frameleaf" page; the server sends back a single-use code, which is exchanged here,
 * with the secret only this extension holds, for an access that can only save and list collections
 * and tags. The password never reaches the extension.
 */

/** A sign-in window lasts 10 minutes; after that the sign-in starts over. */
export const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;

export class SignInFailure extends Error {
  constructor(readonly problem: SignInProblem) {
    super(problem);
  }
}

export type BrowserClient = 'chrome' | 'edge';

/** A random base64url string of `bytes` bytes. */
export function randomText(bytes: number) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(values);
}
function base64Url(values: Uint8Array) {
  let text = '';
  for (const value of values) text += String.fromCodePoint(value);
  return btoa(text)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export async function codeChallenge(verifier: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

/** The address of the server's Allow page, opened in the sign-in window. */
export function allowPageUrl(
  origin: string,
  request: {
    redirectUri: string;
    codeChallenge: string;
    state: string;
    client: BrowserClient;
    installationId: string;
  },
) {
  const url = new URL(
    `${normalizeServerAddress(origin, true)}/auth/allow-extension`,
  );
  url.search = new URLSearchParams({
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
    state: request.state,
    client: request.client,
    installation: request.installationId,
  }).toString();
  return url.href;
}

/**
 * Whether the sign-in window was closed by the person (Chrome's message for it), rather than
 * failing to open or load at all.
 */
export const windowClosed = (error: unknown) =>
  /did not approve|cancel|closed/i.test(
    error instanceof Error ? error.message : String(error),
  );

/** Reads the code from where the sign-in window ended, checking it is ours and for this sign-in. */
export function readReturn(
  returned: string | undefined,
  redirectUri: string,
  state: string,
): string {
  let url: URL;
  try {
    url = new URL(returned ?? '');
  } catch {
    throw new SignInFailure('cancelled');
  }
  const expected = new URL(redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname)
    throw new SignInFailure('failed');
  if (url.searchParams.get('state') !== state)
    throw new SignInFailure('failed');
  if (url.searchParams.get('error')) throw new SignInFailure('cancelled');
  const code = url.searchParams.get('code');
  if (!code || code.length > 200) throw new SignInFailure('failed');
  return code;
}

type Transport = typeof fetch;
const publicFetch = (
  transport: Transport,
  url: string,
  init: RequestInit = {},
) =>
  transport(url, {
    ...init,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });

/**
 * Checks the address before the sign-in window opens: it must answer as Frameleaf, and be new
 * enough to sign in from the browser. Otherwise the problem says what to change.
 */
export async function checkServer(origin: string, transport: Transport) {
  const base = normalizeServerAddress(origin, true) + '/api';
  let ping: Response;
  try {
    ping = await publicFetch(transport, `${base}/server/ping`);
  } catch {
    throw new SignInFailure('unreachable');
  }
  let pong: unknown;
  try {
    pong = ping.ok ? await ping.json() : undefined;
  } catch {
    pong = undefined;
  }
  if (
    !pong ||
    typeof pong !== 'object' ||
    (pong as { res?: unknown }).res !== 'pong'
  )
    throw new SignInFailure('address');
  let info: Response;
  try {
    info = await publicFetch(transport, `${base}/browser-extension/sign-in`);
  } catch {
    throw new SignInFailure('unreachable');
  }
  let supported = false;
  try {
    supported =
      info.ok && ((await info.json()) as { version?: unknown }).version === 1;
  } catch {
    supported = false;
  }
  if (!supported) throw new SignInFailure('old-server');
}

export type ExchangedAccess = {
  secret: string;
  apiKeyId: string;
  userId: string;
  serverId: string;
};

/** Exchanges the code and the secret verifier for this browser's access. */
export async function exchangeCode(
  origin: string,
  body: { code: string; codeVerifier: string; redirectUri: string },
  transport: Transport,
): Promise<ExchangedAccess> {
  const url =
    normalizeServerAddress(origin, true) +
    '/api/browser-extension/sign-in/exchange';
  let response: Response;
  try {
    response = await publicFetch(transport, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SignInFailure('unreachable');
  }
  let value: Partial<ExchangedAccess & { code: string }>;
  try {
    value = (await response.json()) as typeof value;
  } catch {
    throw new SignInFailure('failed');
  }
  if (!response.ok)
    throw new SignInFailure(value?.code === 'expired' ? 'expired' : 'failed');
  if (
    typeof value.secret !== 'string' ||
    !value.secret ||
    value.secret.length > 4096 ||
    typeof value.apiKeyId !== 'string' ||
    typeof value.userId !== 'string' ||
    typeof value.serverId !== 'string'
  )
    throw new SignInFailure('failed');
  return {
    secret: value.secret,
    apiKeyId: value.apiKeyId,
    userId: value.userId,
    serverId: value.serverId,
  };
}

/** Sign out: the access removes itself on the server, so it leaves API keys too. */
export async function removeAccess(
  origin: string,
  token: string,
  transport: Transport,
) {
  const url =
    normalizeServerAddress(origin, true) + '/api/browser-extension/sign-in';
  const response = await publicFetch(transport, url, {
    method: 'DELETE',
    headers: { 'x-api-key': token },
  });
  await response.body?.cancel();
  // Already removed in Frameleaf counts as signed out.
  return response.ok || response.status === 401 || response.status === 403;
}

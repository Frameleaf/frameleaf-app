import { createHash, timingSafeEqual } from 'node:crypto';
import type { BrowserExtensionClient } from 'src/schema/tables/browser-extension-sign-in.table.js';

/**
 * FL-655: Save to Frameleaf signs in through the browser's own sign-in window
 * (`chrome.identity.launchWebAuthFlow`), which only hands a result back to the extension at
 * `https://<extension id>.chromiumapp.org/`. That is the only kind of return address accepted.
 */
const EXTENSION_ID = /^[a-p]{32}$/;

/** How long an allowed sign-in code may be exchanged. */
export const SIGN_IN_CODE_TTL_SECONDS = 5 * 60;

/** The extension's access as listed in API keys. */
export const accessName = (client: BrowserExtensionClient) =>
  `Save to Frameleaf · ${client === 'edge' ? 'Edge' : 'Chrome'}`;

/**
 * The extension's return address when it is one the browser's sign-in window owns, else null:
 * `https://<32 lowercase a–p>.chromiumapp.org/` or a path under it, with no port, user, query or
 * fragment. The returned value is the address as typed, which must later match exactly.
 */
export const checkRedirectUri = (value: string): { redirectUri: string; origin: string } | null => {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const [id, ...rest] = url.hostname.split('.');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    value.includes('?') ||
    value.includes('#') ||
    rest.join('.') !== 'chromiumapp.org' ||
    !EXTENSION_ID.test(id) ||
    !url.pathname.startsWith('/') ||
    /%2[ef]|%5c/i.test(url.pathname) ||
    url.pathname.split('/').some((part) => part === '.' || part === '..') ||
    // the typed address must already be in its canonical form, so it can be compared exactly
    url.href !== value
  ) {
    return null;
  }
  return { redirectUri: url.href, origin: url.origin };
};

/** A base64url S256 code challenge: SHA-256 is 32 bytes, so 43 characters without padding. */
export const isCodeChallenge = (value: string) => typeof value === 'string' && /^[\w-]{43}$/.test(value);

/** A code verifier as RFC 7636 allows: 43 to 128 unreserved characters. */
export const isCodeVerifier = (value: string) => typeof value === 'string' && /^[\w.~-]{43,128}$/.test(value);

/** Whether the verifier hashes (S256) to the challenge, compared in constant time. */
export const verifierMatches = (verifier: string, challenge: string) => {
  if (!isCodeVerifier(verifier) || !isCodeChallenge(challenge)) {
    return false;
  }
  const expected = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

/** The address the sign-in window returns to, with the result in its query. */
export const returnAddress = (redirectUri: string, values: Record<string, string>) => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    url.searchParams.set(key, value);
  }
  return url.href;
};

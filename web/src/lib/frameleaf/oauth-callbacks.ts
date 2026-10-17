/**
 * The OAuth redirect URI the Frameleaf app signs in with (FL-131), for the Authentication settings to
 * show what an identity provider must allow.
 *
 * Mirrors the server (`frameleafRedirectUri` in `server/src/services/auth.service.ts`): without the
 * mobile redirect override the app uses its custom-scheme callback. With the override, an address
 * that is this server's `…/oauth/frameleaf-mobile-redirect` is used as is, and an older
 * `…/oauth/mobile-redirect` maps to that sibling. For any other address the server refuses app
 * sign-in with setup guidance, so the page says so (undefined) before anyone tries.
 */

export const FRAMELEAF_APP_CALLBACK = 'frameleaf-auth:///oauth-callback';

const FRAMELEAF_MOBILE_REDIRECT_PATH = '/oauth/frameleaf-mobile-redirect';
const LEGACY_MOBILE_REDIRECT_PATH = /\/oauth\/mobile-redirect\/?$/;

export function appCallback(overrideEnabled: boolean, mobileRedirectUri: string): string | undefined {
  // Like the server (`resolveRedirectUri`), an override with no address is not applied.
  if (!overrideEnabled || !mobileRedirectUri) {
    return FRAMELEAF_APP_CALLBACK;
  }

  let url: URL | undefined;
  try {
    url = new URL(mobileRedirectUri);
  } catch {
    return undefined;
  }
  if (url.pathname.replace(/\/$/, '').endsWith(FRAMELEAF_MOBILE_REDIRECT_PATH)) {
    // already the forwarder
  } else if (LEGACY_MOBILE_REDIRECT_PATH.test(url.pathname)) {
    url.pathname = url.pathname.replace(LEGACY_MOBILE_REDIRECT_PATH, FRAMELEAF_MOBILE_REDIRECT_PATH);
  } else {
    return undefined;
  }
  url.search = '';
  url.hash = '';
  return url.href;
}

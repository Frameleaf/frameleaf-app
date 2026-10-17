/**
 * The OAuth redirect URIs each app signs in with (FL-131), for the Authentication settings to show
 * what an identity provider must allow.
 *
 * Mirrors the server (`frameleafRedirectUri` in `server/src/services/auth.service.ts`): without the
 * mobile redirect override, each app uses its own custom-scheme callback. With the override, the
 * Immich app uses the configured address and the Frameleaf app uses its sibling
 * `…/oauth/frameleaf-mobile-redirect`. Only an override ending in `/oauth/mobile-redirect` has a
 * sibling; for any other address the server refuses Frameleaf sign-in with setup guidance, so the
 * page says so before anyone tries.
 */

export const IMMICH_APP_CALLBACK = 'app.immich:///oauth-callback';
export const FRAMELEAF_APP_CALLBACK = 'frameleaf-auth:///oauth-callback';

const LEGACY_MOBILE_REDIRECT_PATH = /\/oauth\/mobile-redirect\/?$/;

export type AppCallbacks = {
  /** What the Immich app is sent back to. */
  immich: string;
  /** What the Frameleaf app is sent back to, or undefined when the server would refuse it. */
  frameleaf?: string;
};

export function appCallbacks(overrideEnabled: boolean, mobileRedirectUri: string): AppCallbacks {
  // Like the server (`resolveRedirectUri`), an override with no address is not applied.
  if (!overrideEnabled || !mobileRedirectUri) {
    return { immich: IMMICH_APP_CALLBACK, frameleaf: FRAMELEAF_APP_CALLBACK };
  }

  let url: URL | undefined;
  try {
    url = new URL(mobileRedirectUri);
  } catch {
    url = undefined;
  }
  if (!url || !LEGACY_MOBILE_REDIRECT_PATH.test(url.pathname)) {
    return { immich: mobileRedirectUri };
  }

  url.pathname = url.pathname.replace(LEGACY_MOBILE_REDIRECT_PATH, '/oauth/frameleaf-mobile-redirect');
  url.search = '';
  url.hash = '';
  return { immich: mobileRedirectUri, frameleaf: url.href };
}

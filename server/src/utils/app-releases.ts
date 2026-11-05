/**
 * Where Frameleaf's phone apps are published (FL-82, FL-1195). Frameleaf distributes its apps through
 * the App Store and Google Play only (owner decision 2026-11-04, FL-1200): the direct APK download,
 * left over from the upstream Flutter app, is gone.
 *
 * - `FRAMELEAF_IOS_APP_URL`: the https App Store or TestFlight page; defaults to the App Store listing.
 * - `FRAMELEAF_ANDROID_STORE_URL`: the https store listing of the Android app; defaults to Google Play.
 *
 * A value that is set but wrong fails at startup, so a typo is noticed instead of silently hiding a link.
 */
export type AppReleaseConfig = {
  iosUrl: string;
  androidStoreUrl: string;
};

/** The listings frameleaf.app links (2026-11-04). */
export const APP_STORE_URL = 'https://apps.apple.com/us/app/frameleaf/id6821111014';
export const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=app.frameleaf.android';

type AppReleaseEnv = {
  FRAMELEAF_IOS_APP_URL?: string;
  FRAMELEAF_ANDROID_STORE_URL?: string;
};

export const httpsUrl = (name: string, value: string) => {
  let url: URL;
  try {
    url = new URL(value.replace('{version}', '0.0.0'));
  } catch {
    throw new Error(`${name}: "${value}" is not a URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${name}: must be an https address`);
  }
  if (url.username || url.password) {
    throw new Error(`${name}: must not contain credentials`);
  }
  return value.replace(/\/+$/, '');
};

export const parseAppReleases = (env: AppReleaseEnv): AppReleaseConfig => {
  const iosUrl = env.FRAMELEAF_IOS_APP_URL?.trim();
  const androidStoreUrl = env.FRAMELEAF_ANDROID_STORE_URL?.trim();
  return {
    iosUrl: iosUrl ? httpsUrl('FRAMELEAF_IOS_APP_URL', iosUrl) : APP_STORE_URL,
    androidStoreUrl: androidStoreUrl ? httpsUrl('FRAMELEAF_ANDROID_STORE_URL', androidStoreUrl) : GOOGLE_PLAY_URL,
  };
};

/**
 * Where this installation's help lives (FL-135): the operator's documentation, support, issue and
 * source addresses. `FRAMELEAF_DOCS_URL`, `FRAMELEAF_SUPPORT_URL`, `FRAMELEAF_BUG_FEATURE_URL` and
 * `FRAMELEAF_SOURCE_URL` must be https and fail at startup otherwise. The inherited
 * `IMMICH_THIRD_PARTY_*` names still work, but only an https value is used; anything else is left
 * out, so the link is hidden rather than pointing somewhere unchecked. Nothing falls back to the
 * upstream project's sites.
 */
export type HelpLinkConfig = {
  documentationUrl?: string;
  supportUrl?: string;
  bugFeatureUrl?: string;
  sourceUrl?: string;
};

type HelpLinkEnv = {
  FRAMELEAF_DOCS_URL?: string;
  FRAMELEAF_SUPPORT_URL?: string;
  FRAMELEAF_BUG_FEATURE_URL?: string;
  FRAMELEAF_SOURCE_URL?: string;
  IMMICH_THIRD_PARTY_DOCUMENTATION_URL?: string;
  IMMICH_THIRD_PARTY_SUPPORT_URL?: string;
  IMMICH_THIRD_PARTY_BUG_FEATURE_URL?: string;
  IMMICH_THIRD_PARTY_SOURCE_URL?: string;
};

const legacyHttpsUrl = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return;
  }
  try {
    return httpsUrl('legacy', trimmed);
  } catch {
    return;
  }
};

export const parseHelpLinks = (env: HelpLinkEnv): HelpLinkConfig => {
  const pick = (name: keyof HelpLinkEnv, legacy: keyof HelpLinkEnv) => {
    const value = env[name]?.trim();
    return value ? httpsUrl(name, value) : legacyHttpsUrl(env[legacy]);
  };
  return {
    documentationUrl: pick('FRAMELEAF_DOCS_URL', 'IMMICH_THIRD_PARTY_DOCUMENTATION_URL'),
    supportUrl: pick('FRAMELEAF_SUPPORT_URL', 'IMMICH_THIRD_PARTY_SUPPORT_URL'),
    bugFeatureUrl: pick('FRAMELEAF_BUG_FEATURE_URL', 'IMMICH_THIRD_PARTY_BUG_FEATURE_URL'),
    sourceUrl: pick('FRAMELEAF_SOURCE_URL', 'IMMICH_THIRD_PARTY_SOURCE_URL'),
  };
};

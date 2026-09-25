/**
 * Where this installation's own apps are published (FL-82).
 *
 * The operator names the signed release destinations in the deployment environment; nothing here is
 * a user setting and nothing falls back to another product's store listing or releases. When a
 * destination is not configured the web app says that no signed release is available.
 *
 * - `FRAMELEAF_ANDROID_RELEASE_URL`: an https folder holding `app-arm64-v8a-release.apk`,
 *   `app-armeabi-v7a-release.apk`, `app-x86_64-release.apk` and `app-release.apk` (universal). A
 *   `{version}` token is replaced with the server version.
 * - `FRAMELEAF_ANDROID_APP_ID`: the package id those APKs are signed as.
 * - `FRAMELEAF_ANDROID_SIGNING_SHA256`: the SHA-256 fingerprint of their signing certificate, shown
 *   to people so they can check what they install. Android releases are unavailable without it.
 * - `FRAMELEAF_IOS_APP_URL`: the https App Store or TestFlight page of the iOS app.
 * - `FRAMELEAF_ANDROID_STORE_URL` (FL-135): the https store listing of the Android app (Google Play,
 *   F-Droid or another store), offered next to the signed APKs when it is set.
 *
 * A value that is set but wrong fails at startup, so a typo is noticed instead of silently hiding
 * the downloads.
 */
export type AppReleaseConfig = {
  android?: { releaseUrl: string; appId: string; signingSha256: string };
  iosUrl?: string;
  androidStoreUrl?: string;
};

export const APK_FILES = {
  arm64v8a: 'app-arm64-v8a-release.apk',
  armeabiv7a: 'app-armeabi-v7a-release.apk',
  universal: 'app-release.apk',
  x86_64: 'app-x86_64-release.apk',
} as const;

type AppReleaseEnv = {
  FRAMELEAF_ANDROID_RELEASE_URL?: string;
  FRAMELEAF_ANDROID_APP_ID?: string;
  FRAMELEAF_ANDROID_SIGNING_SHA256?: string;
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

/** `AA:BB:…` uppercase, from a fingerprint written with or without separators. */
export const normalizeFingerprint = (value: string) => {
  const hex = value.replaceAll(/[\s:]/g, '').toUpperCase();
  if (!/^[\dA-F]{64}$/.test(hex)) {
    throw new Error('FRAMELEAF_ANDROID_SIGNING_SHA256: expected a SHA-256 certificate fingerprint (64 hex digits)');
  }
  return hex.match(/../g)!.join(':');
};

export const parseAppReleases = (env: AppReleaseEnv): AppReleaseConfig => {
  const config: AppReleaseConfig = {};
  const releaseUrl = env.FRAMELEAF_ANDROID_RELEASE_URL?.trim();
  const appId = env.FRAMELEAF_ANDROID_APP_ID?.trim();
  const fingerprint = env.FRAMELEAF_ANDROID_SIGNING_SHA256?.trim();
  if (releaseUrl || appId || fingerprint) {
    const missing = [
      !releaseUrl && 'FRAMELEAF_ANDROID_RELEASE_URL',
      !appId && 'FRAMELEAF_ANDROID_APP_ID',
      !fingerprint && 'FRAMELEAF_ANDROID_SIGNING_SHA256',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Android releases need ${missing.join(', ')} as well`);
    }
    if (!/^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/.test(appId!)) {
      throw new Error(`FRAMELEAF_ANDROID_APP_ID: "${appId}" is not an Android package id`);
    }
    const validatedReleaseUrl = httpsUrl('FRAMELEAF_ANDROID_RELEASE_URL', releaseUrl!);
    const releaseLocation = new URL(releaseUrl!.replace('{version}', '__frameleaf_version__'));
    if (!releaseLocation.pathname.includes('__frameleaf_version__') || releaseLocation.search || releaseLocation.hash) {
      throw new Error('FRAMELEAF_ANDROID_RELEASE_URL: include {version} in the path with no query or fragment');
    }
    config.android = {
      releaseUrl: validatedReleaseUrl,
      appId: appId!,
      signingSha256: normalizeFingerprint(fingerprint!),
    };
  }
  const iosUrl = env.FRAMELEAF_IOS_APP_URL?.trim();
  if (iosUrl) {
    config.iosUrl = httpsUrl('FRAMELEAF_IOS_APP_URL', iosUrl);
  }
  const androidStoreUrl = env.FRAMELEAF_ANDROID_STORE_URL?.trim();
  if (androidStoreUrl) {
    config.androidStoreUrl = httpsUrl('FRAMELEAF_ANDROID_STORE_URL', androidStoreUrl);
  }
  return config;
};

/** The download link of each Android build of this server version. */
export const apkLinks = (releaseUrl: string, version: string) => {
  const base = releaseUrl.split('{version}').join(version);
  return Object.fromEntries(Object.entries(APK_FILES).map(([key, file]) => [key, `${base}/${file}`])) as Record<
    keyof typeof APK_FILES,
    string
  >;
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

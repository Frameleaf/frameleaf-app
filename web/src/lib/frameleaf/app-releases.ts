import type { ServerAppReleasesResponseDto } from '@immich/sdk';

/**
 * Mobile applications and Obtainium setup (FL-82), ported from the design template's
 * `ApplicationSetup` in `UtilitiesManager.jsx`.
 *
 * Every download comes from the signed release destinations the operator configured for this server
 * (`GET /server/app-releases`). With none configured the page says so and offers nothing: it never
 * sends installation to another product's store listing or releases. The Obtainium configuration is
 * generated here, validated, and opened directly in the Obtainium app — not through a web redirect.
 */

export const ANDROID_ARCHITECTURES = ['Automatic', 'arm64-v8a', 'armeabi-v7a', 'x86_64', 'Universal'] as const;
export type AndroidArchitecture = (typeof ANDROID_ARCHITECTURES)[number];
export type AppPlatform = 'Android' | 'iOS';

/** The APK file suffix a build is published under (`app-<suffix>.apk`). */
const APK_SUFFIX: Record<Exclude<AndroidArchitecture, 'Automatic'>, string> = {
  'arm64-v8a': 'arm64-v8a-release',
  'armeabi-v7a': 'armeabi-v7a-release',
  x86_64: 'x86_64-release',
  Universal: 'release',
};

const LINK_KEY: Record<
  Exclude<AndroidArchitecture, 'Automatic'>,
  'arm64v8a' | 'armeabiv7a' | 'x86_64' | 'universal'
> = {
  'arm64-v8a': 'arm64v8a',
  'armeabi-v7a': 'armeabiv7a',
  x86_64: 'x86_64',
  Universal: 'universal',
};

export type AppDownload = { available: true; href: string; fingerprint?: string } | { available: false };

/** What the download button offers for a platform and architecture. Automatic uses the universal build. */
export function appDownload(
  releases: ServerAppReleasesResponseDto | null,
  platform: AppPlatform,
  architecture: AndroidArchitecture,
): AppDownload {
  if (!releases) {
    return { available: false };
  }
  if (platform === 'iOS') {
    return releases.ios.available && releases.ios.url
      ? { available: true, href: releases.ios.url }
      : { available: false };
  }
  const { android } = releases;
  if (!android.available || !android.links) {
    return { available: false };
  }
  const key = LINK_KEY[architecture === 'Automatic' ? 'Universal' : architecture];
  return { available: true, href: android.links[key], fingerprint: android.signingCertificateSha256 };
}

export type ObtainiumInput = {
  /** This server's address, as the phone reaches it. */
  serverUrl: string;
  /** A download-only access key (the `server.apkLinks` permission). */
  apiKey: string;
  architecture: AndroidArchitecture;
  /** The package id of the signed release. */
  appId: string;
};

export type ObtainiumConfig = { app: Record<string, unknown>; link: string };

/** Why a generated Obtainium configuration would not work, or an empty list. */
export function obtainiumProblems(input: ObtainiumInput): string[] {
  const problems: string[] = [];
  let url: URL | undefined;
  try {
    url = new URL(input.serverUrl);
  } catch {
    problems.push('Enter this server’s address, starting with https:// or http://.');
  }
  if (url) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      problems.push('The server address must start with https:// or http://.');
    }
    if (url.username || url.password || url.search || url.hash) {
      problems.push('The server address must not contain a user name, password, query or fragment.');
    }
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.apiKey)) {
    problems.push('Create download-only access, or paste a valid access key.');
  }
  if (!ANDROID_ARCHITECTURES.includes(input.architecture)) {
    problems.push('Choose a device architecture.');
  }
  if (!/^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/.test(input.appId)) {
    problems.push('No signed Android release is available for this installation yet.');
  }
  return problems;
}

/**
 * The Obtainium app entry for this server's signed releases. It checks `/api/server/apk-links` with a
 * download-only key and picks the APK for the chosen architecture; a new version is recognised by a
 * changed download link.
 */
export function obtainiumConfig(input: ObtainiumInput): ObtainiumConfig {
  const problems = obtainiumProblems(input);
  if (problems.length > 0) {
    throw new Error(problems[0]);
  }
  const base = new URL(input.serverUrl);
  const path = base.pathname.replace(/\/+$/, '');
  const automatic = input.architecture === 'Automatic';
  const suffix = APK_SUFFIX[input.architecture === 'Automatic' ? 'Universal' : input.architecture];
  const settings = {
    intermediateLink: [],
    customLinkFilterRegex: '',
    filterByLinkText: false,
    skipSort: false,
    reverseSort: false,
    sortByLastLinkSegment: false,
    versionExtractWholePage: false,
    requestHeader: [{ requestHeader: `x-api-key: ${input.apiKey}` }],
    defaultPseudoVersioningMethod: 'APKLinkHash',
    trackOnly: false,
    versionExtractionRegEx: '',
    matchGroupToUse: '',
    versionDetection: false,
    useVersionCodeAsOSVersion: false,
    // Automatic lets Obtainium pick the build for the phone among every architecture
    apkFilterRegEx: automatic ? String.raw`\.apk$` : 'app-' + suffix + String.raw`\.apk$`,
    invertAPKFilter: false,
    autoApkFilterByArch: automatic,
    appName: 'Frameleaf',
    appAuthor: 'Frameleaf',
    shizukuPretendToBeGooglePlay: false,
    allowInsecure: false,
    exemptFromBackgroundUpdates: false,
    skipUpdateNotifications: false,
    about: '',
    refreshBeforeDownload: false,
  };
  const app = {
    id: input.appId,
    url: `${base.origin}${path}/api/server/apk-links`,
    author: 'Frameleaf',
    name: 'Frameleaf',
    preferredApkIndex: 0,
    additionalSettings: JSON.stringify(settings),
    overrideSource: null,
  };
  return { app, link: `obtainium://app/${encodeURIComponent(JSON.stringify(app))}` };
}

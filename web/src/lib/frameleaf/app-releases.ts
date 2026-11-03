import type { ServerAppReleasesResponseDto } from '@frameleaf/sdk';

/**
 * Mobile applications (FL-82), ported from the design template's `ApplicationSetup` in
 * `UtilitiesManager.jsx`.
 *
 * Every download comes from the signed release destinations the operator configured for this server
 * (`GET /server/app-releases`). With none configured the page says so and offers nothing: it never
 * sends installation to another product's store listing or releases.
 */

export const ANDROID_ARCHITECTURES = ['Automatic', 'arm64-v8a', 'armeabi-v7a', 'x86_64', 'Universal'] as const;
export type AndroidArchitecture = (typeof ANDROID_ARCHITECTURES)[number];
export type AppPlatform = 'Android' | 'iOS';

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

import type { ServerAppReleasesResponseDto } from '@frameleaf/sdk';
import { appDownload } from '$lib/frameleaf/app-releases';

const unavailable: ServerAppReleasesResponseDto = { android: { available: false }, ios: { available: false } };
const configured: ServerAppReleasesResponseDto = {
  android: {
    available: true,
    appId: 'app.frameleaf.android',
    signingCertificateSha256: 'AB:CD',
    links: {
      arm64v8a: 'https://releases.example.test/3.2.0/app-arm64-v8a-release.apk',
      armeabiv7a: 'https://releases.example.test/3.2.0/app-armeabi-v7a-release.apk',
      universal: 'https://releases.example.test/3.2.0/app-release.apk',
      x86_64: 'https://releases.example.test/3.2.0/app-x86_64-release.apk',
    },
  },
  ios: { available: true, url: 'https://apps.apple.com/app/id000' },
};

describe('appDownload', () => {
  it('offers nothing when no signed release is configured or the server did not answer', () => {
    expect(appDownload(null, 'Android', 'Automatic')).toEqual({ available: false });
    expect(appDownload(unavailable, 'Android', 'arm64-v8a')).toEqual({ available: false });
    expect(appDownload(unavailable, 'iOS', 'Automatic')).toEqual({ available: false });
  });

  it('offers the configured signed build for the chosen architecture', () => {
    expect(appDownload(configured, 'Android', 'Automatic')).toEqual({
      available: true,
      href: configured.android.links!.universal,
      fingerprint: 'AB:CD',
    });
    expect(appDownload(configured, 'Android', 'x86_64')).toMatchObject({ href: configured.android.links!.x86_64 });
    expect(appDownload(configured, 'iOS', 'Automatic')).toEqual({
      available: true,
      href: 'https://apps.apple.com/app/id000',
    });
  });
});

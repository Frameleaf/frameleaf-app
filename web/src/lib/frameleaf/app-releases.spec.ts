import type { ServerAppReleasesResponseDto } from '@immich/sdk';
import { appDownload, obtainiumConfig, obtainiumProblems } from '$lib/frameleaf/app-releases';

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

describe('obtainiumConfig', () => {
  const input = {
    serverUrl: 'https://photos.example.test',
    apiKey: 'AbCdEfGhIjKlMnOpQrStUv0123456789',
    architecture: 'arm64-v8a' as const,
    appId: 'app.frameleaf.android',
  };

  it('opens this server’s signed releases directly in Obtainium with download-only access', () => {
    const { app, link } = obtainiumConfig(input);
    expect(link.startsWith('obtainium://app/')).toBe(true);
    expect(JSON.parse(decodeURIComponent(link.slice('obtainium://app/'.length)))).toEqual(app);
    expect(app).toMatchObject({
      id: 'app.frameleaf.android',
      url: 'https://photos.example.test/api/server/apk-links',
      name: 'Frameleaf',
      author: 'Frameleaf',
    });
    const settings = JSON.parse(app.additionalSettings as string);
    expect(settings.requestHeader).toEqual([{ requestHeader: `x-api-key: ${input.apiKey}` }]);
    expect(new RegExp(settings.apkFilterRegEx).test('app-arm64-v8a-release.apk')).toBe(true);
    expect(new RegExp(settings.apkFilterRegEx).test('app-x86_64-release.apk')).toBe(false);
    expect(JSON.stringify(app).toLowerCase()).not.toContain('immich');
  });

  it('keeps a server path and lets Obtainium choose the architecture automatically', () => {
    const { app } = obtainiumConfig({ ...input, serverUrl: 'https://example.test/photos/', architecture: 'Automatic' });
    expect(app.url).toBe('https://example.test/photos/api/server/apk-links');
    expect(JSON.parse(app.additionalSettings as string)).toMatchObject({ autoApkFilterByArch: true });
  });

  it('refuses a configuration that would not work', () => {
    expect(obtainiumProblems({ ...input, apiKey: 'short' })).toHaveLength(1);
    expect(obtainiumProblems({ ...input, apiKey: `${input.apiKey}\nx-other: 1` })).toHaveLength(1);
    expect(obtainiumProblems({ ...input, serverUrl: 'ftp://example.test' })).toHaveLength(1);
    expect(obtainiumProblems({ ...input, serverUrl: 'https://user:pw@example.test' })).toHaveLength(1);
    expect(obtainiumProblems({ ...input, appId: '' })).toEqual([
      'No signed Android release is available for this installation yet.',
    ]);
    expect(() => obtainiumConfig({ ...input, appId: '' })).toThrow();
  });
});

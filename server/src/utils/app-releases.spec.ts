import { apkLinks, normalizeFingerprint, parseAppReleases } from 'src/utils/app-releases.js';

const fingerprint = 'ab'.repeat(32);

describe('parseAppReleases', () => {
  it('is empty when nothing is configured, so downloads are shown as unavailable', () => {
    expect(parseAppReleases({})).toEqual({});
  });

  it('reads a complete Android destination and an iOS page', () => {
    expect(
      parseAppReleases({
        FRAMELEAF_ANDROID_RELEASE_URL: 'https://releases.example.test/android/{version}/',
        FRAMELEAF_ANDROID_APP_ID: 'app.frameleaf.android',
        FRAMELEAF_ANDROID_SIGNING_SHA256: fingerprint,
        FRAMELEAF_IOS_APP_URL: 'https://apps.apple.com/app/id000',
      }),
    ).toEqual({
      android: {
        releaseUrl: 'https://releases.example.test/android/{version}',
        appId: 'app.frameleaf.android',
        signingSha256: normalizeFingerprint(fingerprint),
      },
      iosUrl: 'https://apps.apple.com/app/id000',
    });
  });

  it('refuses a partial Android destination', () => {
    expect(() => parseAppReleases({ FRAMELEAF_ANDROID_RELEASE_URL: 'https://releases.example.test' })).toThrow(
      /FRAMELEAF_ANDROID_APP_ID, FRAMELEAF_ANDROID_SIGNING_SHA256/,
    );
  });

  it.each([
    // eslint-disable-next-line unicorn/prefer-https -- an http destination is what is being refused
    ['http://releases.example.test', /https/],
    ['https://user:pass@releases.example.test', /credentials/],
    ['not a url', /not a URL/],
  ])('refuses the release URL %s', (url, error) => {
    expect(() =>
      parseAppReleases({
        FRAMELEAF_ANDROID_RELEASE_URL: url,
        FRAMELEAF_ANDROID_APP_ID: 'app.frameleaf.android',
        FRAMELEAF_ANDROID_SIGNING_SHA256: fingerprint,
      }),
    ).toThrow(error);
  });

  it('refuses a fingerprint that is not SHA-256 and a package id that is not one', () => {
    const base = { FRAMELEAF_ANDROID_RELEASE_URL: 'https://releases.example.test' };
    expect(() =>
      parseAppReleases({ ...base, FRAMELEAF_ANDROID_APP_ID: 'app.frameleaf', FRAMELEAF_ANDROID_SIGNING_SHA256: 'abc' }),
    ).toThrow(/64 hex/);
    expect(() =>
      parseAppReleases({
        ...base,
        FRAMELEAF_ANDROID_APP_ID: 'frameleaf',
        FRAMELEAF_ANDROID_SIGNING_SHA256: fingerprint,
      }),
    ).toThrow(/package id/);
  });
});

describe('apkLinks', () => {
  it('names each build of this server version at the configured destination', () => {
    expect(apkLinks('https://releases.example.test/{version}', '3.2.0')).toEqual({
      arm64v8a: 'https://releases.example.test/3.2.0/app-arm64-v8a-release.apk',
      armeabiv7a: 'https://releases.example.test/3.2.0/app-armeabi-v7a-release.apk',
      universal: 'https://releases.example.test/3.2.0/app-release.apk',
      x86_64: 'https://releases.example.test/3.2.0/app-x86_64-release.apk',
    });
  });
});

describe('normalizeFingerprint', () => {
  it('accepts separators and case', () => {
    expect(normalizeFingerprint(`${'Ab:'.repeat(31)}ab`)).toBe(`${'AB:'.repeat(31)}AB`);
  });
});

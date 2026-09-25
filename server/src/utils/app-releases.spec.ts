import { apkLinks, normalizeFingerprint, parseAppReleases, parseHelpLinks } from 'src/utils/app-releases.js';

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

  it('requires a versioned Android destination', () => {
    expect(() =>
      parseAppReleases({
        FRAMELEAF_ANDROID_RELEASE_URL: 'https://releases.example.test/android',
        FRAMELEAF_ANDROID_APP_ID: 'app.frameleaf.android',
        FRAMELEAF_ANDROID_SIGNING_SHA256: fingerprint,
      }),
    ).toThrow(/\{version\}/);
  });

  it.each([
    // eslint-disable-next-line unicorn/prefer-https -- an http destination is what is being refused
    ['http://releases.example.test/{version}', /https/],
    ['https://user:pass@releases.example.test/{version}', /credentials/],
    ['not a url/{version}', /not a URL/],
    ['https://releases.example.test/android?version={version}', /path/],
    ['https://releases.example.test/{version}?channel=beta', /query or fragment/],
    ['https://releases.example.test/{version}#release', /query or fragment/],
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
    const base = { FRAMELEAF_ANDROID_RELEASE_URL: 'https://releases.example.test/{version}' };
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

describe('Android store listing (FL-135)', () => {
  it('reads an https store page and refuses anything else', () => {
    expect(parseAppReleases({ FRAMELEAF_ANDROID_STORE_URL: 'https://f-droid.example/app/' })).toEqual({
      androidStoreUrl: 'https://f-droid.example/app',
    });
    // eslint-disable-next-line unicorn/prefer-https -- an insecure address must be refused
    expect(() => parseAppReleases({ FRAMELEAF_ANDROID_STORE_URL: 'http://play.example/app' })).toThrow(
      'FRAMELEAF_ANDROID_STORE_URL: must be an https address',
    );
  });
});

describe('parseHelpLinks (FL-135)', () => {
  it('hides every help link that is not configured, never falling back upstream', () => {
    expect(parseHelpLinks({})).toEqual({
      documentationUrl: undefined,
      supportUrl: undefined,
      bugFeatureUrl: undefined,
      sourceUrl: undefined,
    });
  });

  it('prefers the Frameleaf names and requires https for them', () => {
    expect(
      parseHelpLinks({
        FRAMELEAF_DOCS_URL: 'https://docs.frameleaf.example/',
        IMMICH_THIRD_PARTY_DOCUMENTATION_URL: 'https://old.example/docs',
        FRAMELEAF_SUPPORT_URL: 'https://help.frameleaf.example',
      }),
    ).toMatchObject({
      documentationUrl: 'https://docs.frameleaf.example',
      supportUrl: 'https://help.frameleaf.example',
    });
    // eslint-disable-next-line unicorn/prefer-https -- an insecure address must be refused
    expect(() => parseHelpLinks({ FRAMELEAF_DOCS_URL: 'http://docs.example' })).toThrow(
      'FRAMELEAF_DOCS_URL: must be an https address',
    );
    expect(() => parseHelpLinks({ FRAMELEAF_SUPPORT_URL: 'https://user:secret@help.example' })).toThrow(
      'FRAMELEAF_SUPPORT_URL: must not contain credentials',
    );
  });

  it('keeps an inherited https link and leaves out one that is not https', () => {
    expect(
      parseHelpLinks({
        IMMICH_THIRD_PARTY_SUPPORT_URL: 'https://support.example',
        // eslint-disable-next-line unicorn/prefer-https -- an insecure address must be refused
        IMMICH_THIRD_PARTY_DOCUMENTATION_URL: 'http://docs.example',
      }),
    ).toMatchObject({ supportUrl: 'https://support.example', documentationUrl: undefined });
  });
});

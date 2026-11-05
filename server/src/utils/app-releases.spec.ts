import { APP_STORE_URL, GOOGLE_PLAY_URL, parseAppReleases, parseHelpLinks } from 'src/utils/app-releases.js';

describe('parseAppReleases (FL-1195)', () => {
  it('links the App Store and Google Play listings by default', () => {
    expect(parseAppReleases({})).toEqual({ iosUrl: APP_STORE_URL, androidStoreUrl: GOOGLE_PLAY_URL });
  });

  it('takes the listings the operator names', () => {
    expect(
      parseAppReleases({
        FRAMELEAF_IOS_APP_URL: 'https://testflight.apple.com/join/abc',
        FRAMELEAF_ANDROID_STORE_URL: 'https://f-droid.example/app/',
      }),
    ).toEqual({ iosUrl: 'https://testflight.apple.com/join/abc', androidStoreUrl: 'https://f-droid.example/app' });
  });

  it('refuses a listing that is not an https page', () => {
    // an insecure address must be refused
    expect(() => parseAppReleases({ FRAMELEAF_ANDROID_STORE_URL: 'http://play.example/app' })).toThrow(
      'FRAMELEAF_ANDROID_STORE_URL: must be an https address',
    );
    expect(() => parseAppReleases({ FRAMELEAF_IOS_APP_URL: 'not a url' })).toThrow('is not a URL');
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
    // an insecure address must be refused
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
        // an insecure address must be refused
        IMMICH_THIRD_PARTY_DOCUMENTATION_URL: 'http://docs.example',
      }),
    ).toMatchObject({ supportUrl: 'https://support.example', documentationUrl: undefined });
  });
});

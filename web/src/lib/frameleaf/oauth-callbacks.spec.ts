import { appCallback, FRAMELEAF_APP_CALLBACK } from '$lib/frameleaf/oauth-callbacks';

describe('appCallback (FL-131)', () => {
  it('uses the app scheme without an applied override', () => {
    expect(appCallback(false, 'https://photos.example.com/api/oauth/frameleaf-mobile-redirect')).toBe(
      FRAMELEAF_APP_CALLBACK,
    );
    expect(appCallback(true, '')).toBe(FRAMELEAF_APP_CALLBACK);
  });

  it('uses a Frameleaf forwarder override as is', () => {
    expect(appCallback(true, 'https://photos.example.com/api/oauth/frameleaf-mobile-redirect?x=1#y')).toBe(
      'https://photos.example.com/api/oauth/frameleaf-mobile-redirect',
    );
  });

  it('maps an older mobile-redirect override to its Frameleaf sibling', () => {
    expect(appCallback(true, 'https://photos.example.com/api/oauth/mobile-redirect/?x=1#y')).toBe(
      'https://photos.example.com/api/oauth/frameleaf-mobile-redirect',
    );
  });

  it('refuses any other override, like the server', () => {
    expect(appCallback(true, 'https://auth.example.com/callback')).toBeUndefined();
    expect(appCallback(true, ' '.repeat(3))).toBeUndefined();
  });
});

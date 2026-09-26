import { appCallbacks, FRAMELEAF_APP_CALLBACK, IMMICH_APP_CALLBACK } from '$lib/frameleaf/oauth-callbacks';

describe('appCallbacks (FL-131)', () => {
  it('keeps each app on its own custom-scheme callback without the override', () => {
    expect(appCallbacks(false, 'https://photos.example.com/api/oauth/mobile-redirect')).toEqual({
      immich: IMMICH_APP_CALLBACK,
      frameleaf: FRAMELEAF_APP_CALLBACK,
    });
  });

  it('treats an override with an empty address like no override, as the server does', () => {
    const plain = { immich: IMMICH_APP_CALLBACK, frameleaf: FRAMELEAF_APP_CALLBACK };
    expect(appCallbacks(true, '')).toEqual(plain);
    // a blank-but-not-empty address is applied by the server, which then refuses Frameleaf sign-in
    expect(appCallbacks(true, ' '.repeat(3))).toEqual({ immich: ' '.repeat(3) });
  });

  it('derives the Frameleaf sibling of the configured mobile redirect', () => {
    expect(appCallbacks(true, 'https://photos.example.com/api/oauth/mobile-redirect/?x=1#y')).toEqual({
      immich: 'https://photos.example.com/api/oauth/mobile-redirect/?x=1#y',
      frameleaf: 'https://photos.example.com/api/oauth/frameleaf-mobile-redirect',
    });
  });

  it('has no Frameleaf callback for an override that is not a mobile-redirect address', () => {
    expect(appCallbacks(true, 'https://auth.example.com/callback')).toEqual({
      immich: 'https://auth.example.com/callback',
    });
    expect(appCallbacks(true, 'not a url')).toEqual({ immich: 'not a url' });
  });
});

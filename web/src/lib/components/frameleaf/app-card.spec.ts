import type { ServerAppReleasesResponseDto } from '@frameleaf/sdk';
import {
  APP_CARD_SNOOZE_MS,
  APP_CARD_STORAGE_KEY,
  appCardOffer,
  appCardPlatform,
  isNormalArrival,
  isPhoneScreen,
  isSnoozed,
  phonePlatform,
  snooze,
  type AppCardContext,
} from '$lib/components/frameleaf/app-card';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const IPAD =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

const phone: AppCardContext = {
  userAgent: IPHONE,
  coarsePointer: true,
  screenWidth: 390,
  screenHeight: 844,
  standalone: false,
  arrivedNormally: true,
  onLibrary: true,
  otherSurface: false,
  snoozed: false,
  shownThisLoad: false,
};

const releases = (overrides: Partial<ServerAppReleasesResponseDto> = {}): ServerAppReleasesResponseDto => ({
  android: { available: false },
  ios: { available: false },
  ...overrides,
});

describe('app card rules', () => {
  it('opens for an iPhone or an Android phone on the library', () => {
    expect(appCardPlatform(phone)).toBe('ios');
    expect(appCardPlatform({ ...phone, userAgent: ANDROID, screenWidth: 412, screenHeight: 915 })).toBe('android');
  });

  it('stays closed on tablets, unfolded foldables, desktops and other devices', () => {
    // iPad mini in portrait reports a desktop user agent and a 744px screen
    expect(appCardPlatform({ ...phone, userAgent: IPAD, screenWidth: 744, screenHeight: 1133 })).toBeNull();
    expect(appCardPlatform({ ...phone, userAgent: ANDROID, screenWidth: 800, screenHeight: 1280 })).toBeNull();
    expect(appCardPlatform({ ...phone, userAgent: ANDROID, screenWidth: 673, screenHeight: 841 })).toBeNull();
    expect(appCardPlatform({ ...phone, coarsePointer: false, screenWidth: 1440, screenHeight: 900 })).toBeNull();
    expect(
      appCardPlatform({ ...phone, userAgent: 'Mozilla/5.0 (Mobile; rv:48.0) Gecko/48.0 Firefox/48.0' }),
    ).toBeNull();
  });

  it('measures the screen, so a phone held sideways is still a phone', () => {
    expect(isPhoneScreen({ coarsePointer: true, width: 844, height: 390 })).toBe(true);
    expect(isPhoneScreen({ coarsePointer: false, width: 390, height: 844 })).toBe(false);
  });

  it.each([
    ['away from the library', { onLibrary: false }],
    ['after a deep link', { arrivedNormally: false }],
    ['in the home-screen web app', { standalone: true }],
    ['behind another dialog or the viewer', { otherSurface: true }],
    ['within 30 days of being closed', { snoozed: true }],
    ['a second time in one page load', { shownThisLoad: true }],
  ])('stays closed %s', (_name, change) => {
    expect(appCardPlatform({ ...phone, ...change })).toBeNull();
  });

  it('counts a visit that began on the root, the library or sign-in as arriving normally', () => {
    expect(isNormalArrival(new URL('https://home.example/'))).toBe(true);
    expect(isNormalArrival(new URL('https://home.example/photos'))).toBe(true);
    expect(isNormalArrival(new URL('https://home.example/photos/'))).toBe(true);
    expect(isNormalArrival(new URL('https://home.example/auth/login'))).toBe(true);
  });

  it('treats any other first page, or a query, as a deep link', () => {
    expect(isNormalArrival(new URL('https://home.example/albums/1f6d1c2e-1111-4111-8111-111111111111'))).toBe(false);
    expect(isNormalArrival(new URL('https://home.example/photos/1f6d1c2e-1111-4111-8111-111111111111'))).toBe(false);
    expect(isNormalArrival(new URL('https://home.example/photos?at=abc'))).toBe(false);
    expect(isNormalArrival(new URL('https://home.example/auth/login?continue=%2Falbums%2Fx'))).toBe(false);
    expect(isNormalArrival(new URL('https://home.example/s/family'))).toBe(false);
  });

  it('reads the platform from the user agent', () => {
    expect(phonePlatform(IPHONE)).toBe('ios');
    expect(phonePlatform(ANDROID)).toBe('android');
    expect(phonePlatform(IPAD)).toBeNull();
  });
});

describe('app card offer', () => {
  it('offers nothing when the server names no release (the default)', () => {
    expect(appCardOffer(releases(), 'ios')).toBeNull();
    expect(appCardOffer(releases(), 'android')).toBeNull();
    expect(appCardOffer(null, 'ios')).toBeNull();
  });

  it('offers the App Store page on iPhone', () => {
    const value = releases({ ios: { available: true, url: 'https://apps.apple.com/us/app/frameleaf/id6821111014' } });
    expect(appCardOffer(value, 'ios')).toEqual({
      platform: 'ios',
      kind: 'store',
      href: 'https://apps.apple.com/us/app/frameleaf/id6821111014',
    });
  });

  it('prefers the Android store page, and otherwise offers this server’s own download page', () => {
    const store = 'https://play.google.com/store/apps/details?id=app.frameleaf.android';
    expect(appCardOffer(releases({ android: { available: true, storeUrl: store } }), 'android')).toEqual({
      platform: 'android',
      kind: 'store',
      href: store,
    });
    expect(appCardOffer(releases({ android: { available: true, appId: 'app.frameleaf.android' } }), 'android')).toEqual(
      {
        platform: 'android',
        kind: 'downloads',
      },
    );
  });

  it('ignores a store address that is not https', () => {
    expect(
      // eslint-disable-next-line unicorn/prefer-https -- the plain-http address is the case under test
      appCardOffer(releases({ ios: { available: true, url: 'http://apps.apple.com/app/id1' } }), 'ios'),
    ).toBeNull();
    expect(
      appCardOffer(releases({ android: { available: false, storeUrl: 'javascript:alert(1)' } }), 'android'),
    ).toBeNull();
  });
});

describe('app card snooze', () => {
  const now = Date.UTC(2026, 9, 16, 12);
  const storage = (value: string | null) => ({ getItem: vi.fn(() => value), setItem: vi.fn() });

  it('keeps the sheet away for 30 days after it was closed', () => {
    expect(isSnoozed(storage(String(now - 1000)), now)).toBe(true);
    expect(isSnoozed(storage(String(now - APP_CARD_SNOOZE_MS + 1000)), now)).toBe(true);
    expect(isSnoozed(storage(String(now - APP_CARD_SNOOZE_MS)), now)).toBe(false);
    expect(isSnoozed(storage(null), now)).toBe(false);
    expect(isSnoozed(storage('not a date'), now)).toBe(false);
  });

  it('writes the close time, and survives storage that throws', () => {
    const store = storage(null);
    snooze(store, now);
    expect(store.setItem).toHaveBeenCalledWith(APP_CARD_STORAGE_KEY, String(now));

    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(isSnoozed(broken, now)).toBe(false);
    expect(() => snooze(broken, now)).not.toThrow();
  });
});

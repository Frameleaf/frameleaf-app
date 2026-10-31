import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { APP_CARD_STORAGE_KEY, resetShownThisLoad } from '$lib/components/frameleaf/app-card';
import en from '../../../../../i18n/en.json';
import AppCard from './AppCard.svelte';

const state = vi.hoisted(() => ({
  url: new URL('https://home.example/photos'),
  routeId: '/(user)/photos/[[assetId=id]]' as string | null,
  params: {} as Record<string, string>,
  linked: false,
  goto: vi.fn(),
}));

vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
    get route() {
      return { id: state.routeId };
    },
    get params() {
      return state.params;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => state.goto(...args) }));
vi.mock('$lib/stores/media-query-manager.svelte', () => ({
  mediaQueryManager: { pointerCoarse: true, reducedMotion: true, maxMd: true },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: {
    get value() {
      return { frameleafCloud: state.linked };
    },
  },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'user-1', isAdmin: false } },
}));
vi.mock('$lib/managers/asset-viewer-manager.svelte', () => ({ assetViewerManager: { isViewing: false } }));

const t = en.frameleaf_app_card;
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const APP_STORE = 'https://apps.apple.com/us/app/frameleaf/id6821111014';
const PLAY = 'https://play.google.com/store/apps/details?id=app.frameleaf.android';

const device = (userAgent: string, width = 390, height = 844) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  Object.defineProperties(globalThis.screen, {
    width: { configurable: true, get: () => width },
    height: { configurable: true, get: () => height },
  });
};

/** Mount the sheet and let its delay and the releases request run. */
const mount = async () => {
  const result = render(AppCard);
  await vi.advanceTimersByTimeAsync(1300);
  await tick();
  return result;
};

beforeEach(() => {
  addMessages('dev', en);
  vi.useFakeTimers();
  resetShownThisLoad();
  localStorage.clear();
  state.url = new URL('https://home.example/photos');
  state.routeId = '/(user)/photos/[[assetId=id]]';
  state.params = {};
  state.linked = false;
  state.goto.mockReset();
  sdkMock.getAppReleases.mockReset();
  sdkMock.getAppReleases.mockResolvedValue({
    android: { available: true, appId: 'app.frameleaf.android', storeUrl: PLAY },
    ios: { available: true, url: APP_STORE },
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AppCard', () => {
  it('offers the App Store on an iPhone, with the benefits and no app link', async () => {
    device(IPHONE);
    await mount();

    expect(screen.getByRole('dialog', { name: t.title_ios })).toBeInTheDocument();
    for (const text of [t.lede, t.backup_title, t.offline_title, t.fast_title, t.network_note]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: t.app_store_badge })).toHaveAttribute('href', APP_STORE);
    expect(document.querySelector('a[href^="frameleaf:"], a[href^="intent:"]')).toBeNull();
    expect(screen.queryByText(/open the app/i)).toBeNull();
  });

  it('offers Google Play on an Android phone', async () => {
    device(ANDROID, 412, 915);
    await mount();

    expect(screen.getByRole('dialog', { name: t.title_android })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t.google_play_badge })).toHaveAttribute('href', PLAY);
  });

  it("offers this server's Downloads page when Android has only the server's own download", async () => {
    device(ANDROID, 412, 915);
    sdkMock.getAppReleases.mockResolvedValue({
      android: { available: true, appId: 'app.frameleaf.android' },
      ios: { available: false },
    } as never);
    await mount();

    await fireEvent.click(screen.getByRole('button', { name: t.get_the_app }));
    expect(state.goto).toHaveBeenCalledWith(expect.stringContaining('section=downloads'));
    expect(localStorage.getItem(APP_CARD_STORAGE_KEY)).not.toBeNull();
  });

  it('stays closed when the server names no release (the default) or on a tablet', async () => {
    device(IPHONE);
    sdkMock.getAppReleases.mockResolvedValue({ android: { available: false }, ios: { available: false } } as never);
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();

    resetShownThisLoad();
    device(IPHONE, 744, 1133);
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays closed away from the library and with a photo open', async () => {
    device(IPHONE);
    state.routeId = '/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]';
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();

    state.routeId = '/(user)/photos/[[assetId=id]]';
    state.params = { assetId: 'a1' };
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('waits behind another dialog and opens once it closes', async () => {
    device(IPHONE);
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('aria-modal', 'true');
    document.body.append(other);
    await mount();
    expect(screen.queryByRole('dialog', { name: t.title_ios })).toBeNull();

    other.remove();
    await vi.advanceTimersByTimeAsync(1600);
    await tick();
    expect(screen.getByRole('dialog', { name: t.title_ios })).toBeInTheDocument();
  });

  it('shows the address to type into the app unless the server is linked to Frameleaf Cloud', async () => {
    device(IPHONE);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount();

    expect(screen.getByText(t.address_label)).toBeInTheDocument();
    expect(screen.getByText('https://home.example')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: t.copy }));
    expect(writeText).toHaveBeenCalledWith('https://home.example');
    expect(await screen.findByRole('button', { name: t.copied })).toBeInTheDocument();
  });

  it('hides the address row for a server linked to Frameleaf Cloud', async () => {
    device(IPHONE);
    state.linked = true;
    await mount();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(t.address_label)).toBeNull();
  });

  it.each([
    ['Continue in the browser', () => fireEvent.click(screen.getByRole('button', { name: t.continue_in_browser }))],
    [
      'the store button',
      () => {
        const link = screen.getByRole('link', { name: t.app_store_badge });
        // the test browser would really open the store page
        link.addEventListener('click', (event) => event.preventDefault());
        return fireEvent.click(link);
      },
    ],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
  ])('closes with %s and stays away for 30 days', async (_name, action) => {
    device(IPHONE);
    vi.setSystemTime(Date.UTC(2026, 9, 16, 12));
    await mount();
    const closedAt = Date.now();

    await action();
    await vi.advanceTimersByTimeAsync(500);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem(APP_CARD_STORAGE_KEY)).toBe(String(closedAt));

    // a later visit within 30 days doesn't bring it back
    resetShownThisLoad();
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens only once per page load', async () => {
    device(IPHONE);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await mount();
    await fireEvent.click(screen.getByRole('button', { name: t.continue_in_browser }));
    await vi.advanceTimersByTimeAsync(500);

    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

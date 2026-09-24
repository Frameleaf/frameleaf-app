import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import SessionPrivacyGuard from './SessionPrivacyGuard.svelte';

type Status = 'pending' | 'ready' | 'error';

const guard = vi.hoisted(() => ({
  setStatus: undefined as ((status: Status) => void) | undefined,
  destination: undefined as (() => string) | undefined,
  revalidatePreloaded: undefined as (() => Promise<unknown>) | undefined,
  refresh: vi.fn(),
  revalidate: vi.fn(),
  dispose: vi.fn(),
}));

const state = vi.hoisted(() => ({
  page: {
    params: {} as Record<string, string | undefined>,
    route: { id: '/(user)/albums' as string | null },
    url: new URL('http://localhost/albums?filter=mine'),
  },
}));

vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/state', () => state);

const sdk = vi.hoisted(() => ({ getAssetInfo: vi.fn() }));
vi.mock('@immich/sdk', () => ({
  getAssetInfo: sdk.getAssetInfo,
  isHttpError: (error: unknown) => !!(error as { isHttp?: boolean })?.isHttp,
}));
vi.mock('$lib/managers/AssetCacheManager.svelte', () => ({
  assetCacheManager: { invalidate: vi.fn(), revoke: vi.fn() },
}));
vi.mock('$lib/utils/session-privacy-guard', () => ({
  watchSessionPrivacy: (
    _isAuthenticated: () => boolean,
    onInitialStatus: (status: Status) => void,
    revalidatePreloaded: () => Promise<unknown>,
    destination: () => string,
  ) => {
    guard.setStatus = onInitialStatus;
    guard.destination = destination;
    guard.revalidatePreloaded = revalidatePreloaded;
    return { refresh: guard.refresh, revalidate: guard.revalidate, dispose: guard.dispose };
  },
}));

const children = createRawSnippet(() => ({ render: () => '<p>Protected library</p>' }));

// FL-34: the root gate shows nothing of the app until the session's elevated access is verified
describe('SessionPrivacyGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('draws no app content while the first check runs', () => {
    render(SessionPrivacyGuard, { children });

    expect(screen.queryByText('Protected library')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('releases the app once the session is verified', () => {
    render(SessionPrivacyGuard, { children });

    flushSync(() => guard.setStatus?.('ready'));

    expect(screen.getByText('Protected library')).toBeInTheDocument();
  });

  it('keeps the app held and offers a retry when the check cannot complete', async () => {
    render(SessionPrivacyGuard, { children });

    flushSync(() => guard.setStatus?.('error'));
    expect(screen.queryByText('Protected library')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'retry' }));

    expect(guard.refresh).toHaveBeenCalledOnce();
  });

  it('reloads an ordinary route where it is after a revocation', () => {
    render(SessionPrivacyGuard, { children });

    expect(guard.destination?.()).toBe('/albums?filter=mine');
  });

  it.each([
    ['an open viewer', { assetId: 'asset-1' }, '/(user)/albums', '/albums/a/photos/asset-1'],
    ['the Locked view', {}, '/(user)/locked/[[photos=photos]]/[[assetId=id]]', '/locked'],
    ['the legacy sensitive view', {}, '/(user)/suppressed', '/suppressed'],
  ])('sends %s to Photos after a revocation', (_name, params, routeId, path) => {
    render(SessionPrivacyGuard, { children });
    state.page.params = params;
    state.page.route.id = routeId;
    state.page.url = new URL(`http://localhost${path}`);

    expect(guard.destination?.()).toBe('/photos');
  });

  // Review P2-1: a cold load of an asset the locked session may not see leaves instead of a dead retry
  it.each([400, 403, 404])(
    'leaves a preloaded viewer the server refuses with %i for the view without it',
    async (code) => {
      render(SessionPrivacyGuard, { children });
      state.page.params = { assetId: 'asset-1' };
      state.page.route.id = '/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]';
      state.page.url = new URL('http://localhost/albums/a/photos/asset-1?at=1');
      sdk.getAssetInfo.mockRejectedValue({ isHttp: true, status: code });
      const replace = vi.spyOn(location, 'replace').mockImplementation(() => {});

      await expect(guard.revalidatePreloaded?.()).resolves.toBe('replaced');

      expect(replace).toHaveBeenCalledWith('/albums/a/photos?at=1');
      replace.mockRestore();
    },
  );

  it('keeps the retry for a network failure while checking a preloaded viewer', async () => {
    render(SessionPrivacyGuard, { children });
    state.page.params = { assetId: 'asset-1' };
    state.page.url = new URL('http://localhost/photos/asset-1');
    sdk.getAssetInfo.mockRejectedValue(new TypeError('Failed to fetch'));
    const replace = vi.spyOn(location, 'replace').mockImplementation(() => {});

    await expect(guard.revalidatePreloaded?.()).rejects.toThrow('Failed to fetch');

    expect(replace).not.toHaveBeenCalled();
    expect(assetCacheManager.revoke).toHaveBeenCalled();
    replace.mockRestore();
  });

  it('stops watching when the root is destroyed', () => {
    const { unmount } = render(SessionPrivacyGuard, { children });

    unmount();

    expect(guard.dispose).toHaveBeenCalledOnce();
  });
});

import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
import SessionPrivacyGuard from './SessionPrivacyGuard.svelte';

type Status = 'pending' | 'ready' | 'error';

const guard = vi.hoisted(() => ({
  setStatus: undefined as ((status: Status) => void) | undefined,
  destination: undefined as (() => string) | undefined,
  refresh: vi.fn(),
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
vi.mock('$lib/utils/session-privacy-guard', () => ({
  watchSessionPrivacy: (
    _isAuthenticated: () => boolean,
    onInitialStatus: (status: Status) => void,
    _revalidate: () => Promise<void>,
    destination: () => string,
  ) => {
    guard.setStatus = onInitialStatus;
    guard.destination = destination;
    return { refresh: guard.refresh, dispose: guard.dispose };
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

  it('stops watching when the root is destroyed', () => {
    const { unmount } = render(SessionPrivacyGuard, { children });

    unmount();

    expect(guard.dispose).toHaveBeenCalledOnce();
  });
});

import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { handBack, startFrameleaf } from '$lib/frameleaf/frameleaf-sign-in';
import { oauth } from '$lib/utils';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';

vi.mock('$lib/utils/handle-error', async (original) => ({ ...(await original<object>()), handleError: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

it.each(['oauth', 'frameleaf', 'handoff'] as const)(
  'does not redirect or record a retired %s request',
  async (kind) => {
    const pending = deferredPromise<{ url: string }>();
    const assign = vi.fn();
    const original = location;
    vi.stubGlobal('location', { ...original, assign });
    let current = true;
    const isCurrent = () => current;
    let done: Promise<unknown>;
    if (kind === 'oauth') {
      sdkMock.startOAuth.mockReturnValue(pending.promise);
      done = oauth.authorize(original, isCurrent);
    } else if (kind === 'frameleaf') {
      sdkMock.startFrameleafSignIn.mockReturnValue(pending.promise);
      done = startFrameleaf('sign-in', original, undefined, isCurrent);
    } else {
      sdkMock.createFrameleafHandoff.mockReturnValue(
        pending.promise as ReturnType<typeof sdkMock.createFrameleafHandoff>,
      );
      done = handBack({ returnTo: 'https://home.test', nonce: 'nonce' }, isCurrent);
    }
    current = false;
    pending.resolve({ url: 'https://provider.test/auth?state=retired' });
    await done;
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  },
);

it.each([false, true])('reports OAuth start failure only while current (%s)', async (current) => {
  const pending = deferredPromise<{ url: string }>();
  sdkMock.startOAuth.mockReturnValue(pending.promise);
  let active = true;
  const done = oauth.authorize(location, () => active);
  active = current;
  pending.reject(new Error('Offline'));
  await expect(done).resolves.toBe(false);
  expect(handleError).toHaveBeenCalledTimes(current ? 1 : 0);
});

it.each(['oauth', 'frameleaf', 'handoff'] as const)('still redirects a current %s request', async (kind) => {
  const assign = vi.fn();
  const original = location;
  vi.stubGlobal('location', { ...original, assign });
  const url = 'https://provider.test/auth?state=current';
  if (kind === 'oauth') {
    sdkMock.startOAuth.mockResolvedValue({ url });
    await expect(oauth.authorize(original, () => true)).resolves.toBe(true);
  } else if (kind === 'frameleaf') {
    sdkMock.startFrameleafSignIn.mockResolvedValue({ url });
    await startFrameleaf('sign-in', original, undefined, () => true);
  } else {
    sdkMock.createFrameleafHandoff.mockResolvedValue({ url, code: 'code', expiresAt: new Date().toISOString() });
    await handBack({ returnTo: 'https://home.test', nonce: 'nonce' }, () => true);
  }
  expect(assign).toHaveBeenCalledWith(kind === 'handoff' ? url + '&frameleafNonce=nonce' : url);
});

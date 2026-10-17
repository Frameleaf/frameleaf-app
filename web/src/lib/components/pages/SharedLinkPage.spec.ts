import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { invalidateAll } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getSharedLink, setSharedLink } from '$lib/utils';
import { handleError, setUnauthorizedHandler } from '$lib/utils/handle-error';
import { navigate } from '$lib/utils/navigation';
import { deferredPromise } from '@test-data/deferred';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';
import SharedLinkPage from './SharedLinkPage.svelte';

const route = vi.hoisted(() => ({
  error: null,
  data: { sharedLink: undefined as unknown },
  params: {},
  route: { id: null },
  state: {},
  url: new URL('http://localhost/share/first'),
}));
vi.mock('$app/state', () => ({ page: route }));
vi.mock('$app/navigation', async (original) => ({
  ...(await original<typeof import('$app/navigation')>()),
  invalidateAll: vi.fn(),
}));
vi.mock('$lib/components/album-page/AlbumViewer.svelte', async () => ({
  default: (await import('@test-data/components/SharedViewerFixture.svelte')).default,
}));
vi.mock('$lib/components/share-page/IndividualSharedViewer.svelte', async () => ({
  default: (await import('@test-data/components/SharedViewerFixture.svelte')).default,
}));
vi.mock('$lib/utils/navigation', async (original) => ({
  ...(await original<typeof import('$lib/utils/navigation')>()),
  navigate: vi.fn(),
}));
vi.mock('$lib/utils/handle-error', async (original) => {
  const actual = await original<typeof import('$lib/utils/handle-error')>();
  return { ...actual, handleError: vi.fn(), setUnauthorizedHandler: vi.fn(actual.setUnauthorizedHandler) };
});

const protectedData = (key: string) => ({ key, passwordRequired: true, meta: { title: key } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.resetAllMocks();
  route.data.sharedLink = undefined;
  authManager.reset();
  setSharedLink(undefined);
});

it('follows new route data and clears the old password', async () => {
  const view = render(SharedLinkPage, { data: protectedData('first') });
  await fireEvent.input(screen.getByLabelText('password'), { target: { value: 'secret' } });
  const sharedLink = sharedLinkFactory.build();
  await view.rerender({ data: { ...protectedData('second'), passwordRequired: false, sharedLink } });
  expect(await screen.findByTestId('shared-link-id')).toHaveTextContent(sharedLink.id);
  await view.rerender({ data: protectedData('third') });
  expect(screen.getByLabelText('password')).toHaveValue('');
  expect(screen.queryByTestId('shared-link-id')).not.toBeInTheDocument();
});

it.each(['current', 'replace', 'return', 'close', 'session'])(
  'publishes password login only to its owning route: %s',
  async (change) => {
    const original = protectedData('first');
    const pending = deferredPromise<ReturnType<typeof sharedLinkFactory.build>>();
    sdkMock.sharedLinkLogin.mockReturnValueOnce(pending.promise);
    const view = render(SharedLinkPage, { data: original });
    await fireEvent.input(screen.getByLabelText('password'), { target: { value: 'secret' } });
    await fireEvent.submit(screen.getByRole('button', { name: 'continue' }).closest('form')!);
    await waitFor(() =>
      expect(sdkMock.sharedLinkLogin).toHaveBeenCalledWith({
        key: 'first',
        slug: undefined,
        sharedLinkLoginDto: { password: 'secret' },
      }),
    );
    if (change === 'replace' || change === 'return') {
      await view.rerender({ data: protectedData('second') });
    }
    switch (change) {
      case 'return': {
        await view.rerender({ data: original });
        break;
      }
      case 'close': {
        view.unmount();
        break;
      }
      case 'session': {
        authManager.reset();
        break;
      }
      // No default
    }
    const sharedLink = sharedLinkFactory.build();
    pending.resolve(sharedLink);
    await settle();
    expect(getSharedLink()).toEqual(change === 'current' ? sharedLink : undefined);
    expect(navigate).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
  },
);

it('ignores a password failure after navigating to another link', async () => {
  const pending = deferredPromise<ReturnType<typeof sharedLinkFactory.build>>();
  sdkMock.sharedLinkLogin.mockReturnValueOnce(pending.promise);
  const view = render(SharedLinkPage, { data: protectedData('first') });
  await fireEvent.submit(screen.getByRole('button', { name: 'continue' }).closest('form')!);
  await waitFor(() => expect(sdkMock.sharedLinkLogin).toHaveBeenCalled());
  await view.rerender({ data: protectedData('second') });
  pending.reject(new Error('offline'));
  await settle();
  expect(handleError).not.toHaveBeenCalled();
});

it.each(['same', 'replace', 'close'])('keeps unauthorized readback with its route: %s', async (change) => {
  const pending = deferredPromise<void>();
  vi.mocked(invalidateAll).mockReturnValueOnce(pending.promise);
  const view = render(SharedLinkPage, { data: protectedData('first') });
  const handler = vi.mocked(setUnauthorizedHandler).mock.calls.findLast(([callback]) => callback)?.[0];
  expect(handler).toBeDefined();
  const showError = vi.fn();
  handler!(showError);
  await waitFor(() => expect(invalidateAll).toHaveBeenCalled());
  const key = change === 'replace' ? 'second' : 'first';
  const sharedLink = sharedLinkFactory.build({ key });
  route.data.sharedLink = sharedLink;
  if (change === 'close') {
    view.unmount();
  } else {
    await view.rerender({ data: { ...protectedData(key), sharedLink, passwordRequired: false } });
  }
  pending.resolve();
  await settle();
  expect(showError).toHaveBeenCalledTimes(change === 'same' ? 1 : 0);
});

it('keeps the latest password submission when responses arrive out of order', async () => {
  const first = deferredPromise<ReturnType<typeof sharedLinkFactory.build>>();
  const second = deferredPromise<ReturnType<typeof sharedLinkFactory.build>>();
  sdkMock.sharedLinkLogin.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render(SharedLinkPage, { data: protectedData('first') });
  const form = screen.getByRole('button', { name: 'continue' }).closest('form')!;
  await fireEvent.submit(form);
  await waitFor(() => expect(sdkMock.sharedLinkLogin).toHaveBeenCalledTimes(1));
  await fireEvent.submit(form);
  await waitFor(() => expect(sdkMock.sharedLinkLogin).toHaveBeenCalledTimes(2));
  const sharedLink = sharedLinkFactory.build();
  second.resolve(sharedLink);
  await settle();
  first.resolve(sharedLinkFactory.build());
  await settle();
  expect(getSharedLink()).toEqual(sharedLink);
  expect(navigate).toHaveBeenCalledTimes(1);
});

it('reports the original unauthorized action when link readback fails', async () => {
  vi.mocked(invalidateAll).mockRejectedValueOnce(new Error('Readback unavailable'));
  render(SharedLinkPage, { data: protectedData('first') });
  const handler = vi.mocked(setUnauthorizedHandler).mock.calls.findLast(([callback]) => callback)?.[0];
  const showError = vi.fn();
  handler!(showError);
  await waitFor(() => expect(showError).toHaveBeenCalledOnce());
});

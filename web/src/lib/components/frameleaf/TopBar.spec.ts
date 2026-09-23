import { modalManager } from '@immich/ui';
import { render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
  sessionAccess,
  setSessionLockPending,
  trackSessionLockRefresh,
  trackSessionUnlock,
} from '$lib/frameleaf/session-access.svelte';
import { requestSessionLock } from '$lib/frameleaf/session-lock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import AssetDeleteConfirmModal from '$lib/modals/AssetDeleteConfirmModal.svelte';
import CreateFaceModal from '$lib/modals/CreateFaceModal.svelte';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';
import TopBarTestHarness from './TopBarTestHarness.svelte';

const app = vi.hoisted(() => ({
  goto: vi.fn().mockResolvedValue(undefined),
  invalidateAll: vi.fn().mockResolvedValue(undefined),
  page: { url: new URL('http://localhost/photos'), route: { id: '/(user)/photos' }, params: {} },
}));

vi.mock('$app/navigation', () => ({ goto: app.goto, invalidateAll: app.invalidateAll }));
vi.mock('$app/state', () => ({ page: app.page }));
vi.mock('$lib/frameleaf/running-jobs-session.svelte', () => ({
  runningJobsSession: { activeCount: 0, watch: () => () => {}, setPanelOpen: vi.fn() },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: { search: false } } }));
vi.mock('$lib/stores/notification-manager.svelte', () => ({
  notificationManager: { notifications: [], refresh: vi.fn().mockResolvedValue(undefined) },
}));

const authStatus = (isElevated: boolean) => ({ isElevated, password: true, pinCode: true });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  setSessionLockPending(false);
  sessionAccess.isElevated = false;
  authManager.setUser(userAdminFactory.build());
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  app.invalidateAll.mockResolvedValue(undefined);
  app.goto.mockResolvedValue(undefined);
});

afterEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  setSessionLockPending(false);
  authManager.reset();
});

describe('TopBar session privacy', () => {
  it('ignores a stale elevated auth-status response after the root locks without TopBar', async () => {
    const auth = deferred<ReturnType<typeof authStatus>>();
    sdkMock.getAuthStatus.mockReturnValue(auth.promise as never);
    sdkMock.lockAuthSession.mockResolvedValue(undefined as never);
    const view = render(TopBarTestHarness);
    await waitFor(() => expect(sdkMock.getAuthStatus).toHaveBeenCalledOnce());

    await requestSessionLock();
    auth.resolve(authStatus(true));
    await Promise.resolve();
    expect(sessionAccess.lockPending).toBe(false);
    expect(sessionAccess.isElevated).toBe(false);
    view.unmount();
  });

  it('hides immediately while auth status and lock are pending, then ignores the stale elevated response', async () => {
    const auth = deferred<ReturnType<typeof authStatus>>();
    const lock = deferred<void>();
    const sanitized = deferred<void>();
    const refreshed = deferred<void>();
    const stopRefresh = eventManager.on({
      SessionAccessChanged: ({ isElevated }) => {
        if (!isElevated) {
          void trackSessionLockRefresh(refreshed.promise);
        }
      },
    });
    sdkMock.getAuthStatus.mockReturnValue(auth.promise as never);
    sdkMock.lockAuthSession.mockReturnValue(lock.promise as never);
    app.invalidateAll.mockReturnValue(sanitized.promise);
    const view = render(TopBarTestHarness);
    await waitFor(() => expect(sdkMock.getAuthStatus).toHaveBeenCalledOnce());

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sessionAccess.lockPending).toBe(true);
    expect(sessionStorage.getItem('frameleaf:session-lock-pending')).toBe('true');
    await waitFor(() => expect(sdkMock.lockAuthSession).toHaveBeenCalledOnce());
    auth.resolve(authStatus(true));
    await Promise.resolve();
    expect(sessionAccess.isElevated).toBe(false);

    lock.resolve();
    await waitFor(() => expect(app.invalidateAll).toHaveBeenCalledOnce());
    expect(sessionAccess.lockPending).toBe(true);
    sanitized.resolve();
    await Promise.resolve();
    expect(sessionAccess.lockPending).toBe(true);
    refreshed.resolve();
    await waitFor(() => expect(sessionAccess.lockPending).toBe(false));
    expect(sessionAccess.isElevated).toBe(false);
    stopRefresh();
    view.unmount();
  });

  it('keeps the shield on failure and retries without another auth-status read', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(authStatus(true) as never);
    const lock = deferred<void>();
    sdkMock.lockAuthSession.mockReturnValueOnce(lock.promise as never).mockResolvedValueOnce(undefined as never);
    const view = render(TopBarTestHarness);
    await screen.findByRole('button', { name: en.frameleaf_locked_hide_content });
    const deletion = modalManager.open(AssetDeleteConfirmModal, {
      size: 1,
      suppressible: false,
      assetName: 'draft-private.jpg',
    });
    await waitFor(() => expect(document.body).toHaveTextContent('draft-private.jpg'));

    void sessionAccess.retryLock?.();
    expect(sessionAccess.lockPending).toBe(true);
    lock.reject(new Error('offline'));
    await waitFor(() => expect(sdkMock.lockAuthSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(sessionAccess.retryLock).toBeDefined());
    expect(sessionAccess.lockPending).toBe(true);
    expect(document.body).toHaveTextContent('draft-private.jpg');

    await sessionAccess.retryLock?.();
    await waitFor(() => expect(sessionAccess.lockPending).toBe(false));
    expect(document.body).not.toHaveTextContent('draft-private.jpg');
    expect(await deletion.onClose).toBeUndefined();
    expect(sdkMock.lockAuthSession).toHaveBeenCalledTimes(2);
    expect(sdkMock.getAuthStatus).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('retries a persisted pending lock on mount before reading elevated status', async () => {
    setSessionLockPending(true);
    sdkMock.lockAuthSession.mockResolvedValue(undefined as never);
    const view = render(TopBarTestHarness);

    await waitFor(() => expect(sdkMock.lockAuthSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(sessionAccess.lockPending).toBe(false));
    expect(sdkMock.getAuthStatus).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('frameleaf:session-lock-pending')).toBeNull();
    view.unmount();
  });

  it('waits for an abandoned PIN unlock to settle before requesting a lock', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(authStatus(true) as never);
    sdkMock.lockAuthSession.mockResolvedValue(undefined as never);
    const view = render(TopBarTestHarness);
    await screen.findByRole('button', { name: en.frameleaf_locked_hide_content });
    const unlock = deferred<void>();
    void trackSessionUnlock(unlock.promise);
    setSessionLockPending(true);

    const locking = sessionAccess.retryLock?.();
    await Promise.resolve();
    expect(sdkMock.lockAuthSession).not.toHaveBeenCalled();
    expect(sessionAccess.lockPending).toBe(true);
    unlock.resolve();
    await locking;
    expect(sdkMock.lockAuthSession).toHaveBeenCalledOnce();
    expect(sessionAccess.lockPending).toBe(false);
    view.unmount();
  });

  it('unmounts body-mounted private dialogs before exposing the refreshed app', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(authStatus(true) as never);
    sdkMock.lockAuthSession.mockResolvedValue(undefined as never);
    const refreshed = deferred<void>();
    app.invalidateAll.mockReturnValue(refreshed.promise);
    const view = render(TopBarTestHarness);
    await screen.findByRole('button', { name: en.frameleaf_locked_hide_content });
    const deletion = modalManager.open(AssetDeleteConfirmModal, {
      size: 1,
      suppressible: false,
      assetName: 'locked-private.jpg',
    });
    await waitFor(() => expect(document.body).toHaveTextContent('locked-private.jpg'));

    void sessionAccess.retryLock?.();
    await waitFor(() => expect(app.invalidateAll).toHaveBeenCalledOnce());
    expect(sessionAccess.lockPending).toBe(true);
    expect(document.body).not.toHaveTextContent('locked-private.jpg');
    const late = modalManager.open(CreateFaceModal, {
      assetId: 'late-private-asset',
      imageWidth: 100,
      imageHeight: 100,
      x: 1,
      y: 1,
      width: 10,
      height: 10,
      previewUrl: 'data:image/png;base64,cHJpdmF0ZQ==',
    });
    await late.onClose;
    expect(document.querySelector('img[src^="data:image/png"]')).not.toBeInTheDocument();
    expect(sessionAccess.lockPending).toBe(true);
    refreshed.resolve();
    await waitFor(() => expect(sessionAccess.lockPending).toBe(false));
    expect(await deletion.onClose).toBeUndefined();
    view.unmount();
  });

  it('clears a cached face preview mounted by the shared modal manager', async () => {
    sdkMock.getAuthStatus.mockResolvedValue(authStatus(true) as never);
    sdkMock.lockAuthSession.mockResolvedValue(undefined as never);
    const view = render(TopBarTestHarness);
    await screen.findByRole('button', { name: en.frameleaf_locked_hide_content });
    const face = modalManager.open(CreateFaceModal, {
      assetId: 'private-asset',
      imageWidth: 100,
      imageHeight: 100,
      x: 1,
      y: 1,
      width: 10,
      height: 10,
      previewUrl: 'data:image/png;base64,cHJpdmF0ZQ==',
    });
    await waitFor(() => expect(document.querySelector('img[src^="data:image/png"]')).toBeInTheDocument());

    void sessionAccess.retryLock?.();
    await waitFor(() => expect(sessionAccess.lockPending).toBe(false));
    expect(document.querySelector('img[src^="data:image/png"]')).not.toBeInTheDocument();
    expect(await face.onClose).toBeUndefined();
    view.unmount();
  });
});

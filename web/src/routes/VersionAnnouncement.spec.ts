import { ReleaseType, type ReleaseEventV1 } from '@frameleaf/sdk';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { deferredPromise } from '@test-data/deferred';
import VersionAnnouncement from './VersionAnnouncement.svelte';

const mocks = vi.hoisted(() => ({
  handlers: {} as { ReleaseEvent?: (release: ReleaseEventV1) => Promise<void> },
  authenticated: true,
  current: true,
  user: { isAdmin: true },
  open: vi.fn(),
}));
vi.mock('$lib/managers/event-manager.svelte', () => ({
  eventManager: {
    on: (handlers: typeof mocks.handlers) => {
      mocks.handlers = handlers;
      return () => {
        mocks.handlers = {};
      };
    },
  },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    get authenticated() {
      return mocks.authenticated;
    },
    user: mocks.user,
    captureSession: () => () => mocks.current,
  },
}));
vi.mock('$lib/modals/VersionAnnouncementModal.svelte', () => ({ default: {} }));
vi.mock('@frameleaf/ui', () => ({ modalManager: { open: mocks.open } }));
vi.mock('$lib/utils', () => ({
  semverToName: ({ major, minor, patch }: { major: number; minor: number; patch: number }) =>
    `v${major}.${minor}.${patch}`,
}));

const release = (minor: number): ReleaseEventV1 => ({
  isAvailable: true,
  type: ReleaseType.Minor,
  checkedAt: '',
  serverVersion: { major: 2, minor: 0, patch: 0, prerelease: null },
  releaseVersion: { major: 2, minor, patch: 0, prerelease: null },
});
beforeEach(() => {
  mocks.open.mockReset().mockImplementation(() => ({
    close: vi.fn().mockResolvedValue(undefined),
    onClose: new Promise<void>(() => {}),
  }));
  mocks.authenticated = true;
  mocks.current = true;
  mocks.user.isAdmin = true;
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

it('opens only the latest event when announcements overlap', async () => {
  render(VersionAnnouncement);
  await tick();
  const listener = mocks.handlers.ReleaseEvent!;
  await Promise.all([listener(release(1)), listener(release(2))]);
  expect(mocks.open).toHaveBeenCalledTimes(1);
  expect(mocks.open).toHaveBeenLastCalledWith(expect.anything(), { serverVersion: 'v2.0.0', releaseVersion: 'v2.2.0' });
});

it.each(['unmount', 'session'])('discards pending replacement after %s retires its owner', async (retire) => {
  const closing = deferredPromise<void>();
  mocks.open.mockReturnValue({ close: () => closing.promise, onClose: new Promise<void>(() => {}) });
  const view = render(VersionAnnouncement);
  await tick();
  const listener = mocks.handlers.ReleaseEvent!;
  await listener(release(1));
  const pending = listener(release(2));
  if (retire === 'unmount') {
    view.unmount();
  } else {
    mocks.current = false;
  }
  closing.resolve();
  await pending;
  expect(mocks.open).toHaveBeenCalledTimes(1);
});

it('leaves acknowledged, patch and unauthenticated events alone', async () => {
  render(VersionAnnouncement);
  await tick();
  const listener = mocks.handlers.ReleaseEvent!;
  localStorage.setItem('appVersion', 'v2.1.0');
  await listener(release(1));
  await listener({ ...release(2), type: ReleaseType.Patch });
  mocks.authenticated = false;
  await listener(release(3));
  expect(mocks.open).not.toHaveBeenCalled();
});

it('acknowledges only the current announcement even if an older close settles later', async () => {
  const first = deferredPromise<void>();
  const second = deferredPromise<void>();
  mocks.open
    .mockReturnValueOnce({ close: vi.fn().mockResolvedValue(undefined), onClose: first.promise })
    .mockReturnValueOnce({ close: vi.fn().mockResolvedValue(undefined), onClose: second.promise });
  render(VersionAnnouncement);
  await tick();
  await mocks.handlers.ReleaseEvent!(release(1));
  await mocks.handlers.ReleaseEvent!(release(2));
  second.resolve();
  await tick();
  expect(localStorage.getItem('appVersion')).toBe('v2.2.0');
  first.resolve();
  await tick();
  expect(localStorage.getItem('appVersion')).toBe('v2.2.0');
});

it('owns a rejected modal-close notification', async () => {
  const closed = deferredPromise<void>();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.open.mockReturnValue({ close: vi.fn().mockResolvedValue(undefined), onClose: closed.promise });
  render(VersionAnnouncement);
  await tick();
  await mocks.handlers.ReleaseEvent!(release(1));
  const error = new Error('close failed');
  closed.reject(error);
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Error [VersionAnnouncementBox]:', error));
});

import { createSession, type SessionCreateResponseDto } from '@frameleaf/sdk';
import { deferredPromise } from '@test-data/deferred';

const mocks = vi.hoisted(() => ({
  generation: 0,
  destination: { isConnected: true, loadMedia: vi.fn(), initialize: vi.fn() },
}));
vi.mock('@frameleaf/sdk', () => ({ createSession: vi.fn() }));
vi.mock('$lib/managers/event-manager.svelte', () => ({ eventManager: { on: vi.fn() } }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    captureSession: () => {
      const generation = mocks.generation;
      return () => generation === mocks.generation;
    },
  },
}));
vi.mock('$lib/utils/cast/gcast-destination.svelte', () => ({
  GCastDestination: class {
    constructor() {
      return mocks.destination;
    }
  },
}));

let manager: typeof import('./cast-manager.svelte').castManager;
const token = (value: string): SessionCreateResponseDto => ({
  token: value,
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  id: 'cast-session',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  current: false,
  deviceType: 'Cast',
  deviceOS: 'test',
  appVersion: null,
  isPendingSyncReset: false,
});
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.generation = 0;
  mocks.destination.isConnected = true;
  manager = (await import('./cast-manager.svelte')).castManager;
});

it('shares one pending token request across concurrent selections', async () => {
  const pending = deferredPromise<SessionCreateResponseDto>();
  vi.mocked(createSession).mockReturnValue(pending.promise);
  const first = manager.loadMedia('first');
  const second = manager.loadMedia('second');
  pending.resolve(token('shared'));
  await Promise.all([first, second]);
  expect(createSession).toHaveBeenCalledOnce();
  expect(mocks.destination.loadMedia).toHaveBeenCalledWith('first', 'shared', false);
  expect(mocks.destination.loadMedia).toHaveBeenCalledWith('second', 'shared', false);
});

it('reuses an unexpired token only within its originating account session', async () => {
  vi.mocked(createSession).mockResolvedValueOnce(token('old')).mockResolvedValueOnce(token('new'));
  await manager.loadMedia('first');
  await manager.loadMedia('second');
  expect(createSession).toHaveBeenCalledOnce();
  mocks.generation++;
  await manager.loadMedia('third');
  expect(createSession).toHaveBeenCalledTimes(2);
  expect(mocks.destination.loadMedia).toHaveBeenLastCalledWith('third', 'new', false);
});

it('does not let an old account response overwrite or clear the new pending token', async () => {
  const old = deferredPromise<SessionCreateResponseDto>();
  const current = deferredPromise<SessionCreateResponseDto>();
  vi.mocked(createSession).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const oldLoad = manager.loadMedia('old-selection');
  mocks.generation++;
  const currentLoad = manager.loadMedia('current-selection');
  old.resolve(token('old'));
  await oldLoad;
  expect(mocks.destination.loadMedia).not.toHaveBeenCalled();
  const anotherLoad = manager.loadMedia('another-selection');
  expect(createSession).toHaveBeenCalledTimes(2);
  current.resolve(token('current'));
  await Promise.all([currentLoad, anotherLoad]);
  await manager.loadMedia('last-selection');
  expect(createSession).toHaveBeenCalledTimes(2);
  expect(mocks.destination.loadMedia).toHaveBeenLastCalledWith('last-selection', 'current', false);
});

it('abandons token delivery when the connected destination disappears', async () => {
  const pending = deferredPromise<SessionCreateResponseDto>();
  vi.mocked(createSession).mockReturnValueOnce(pending.promise);
  const load = manager.loadMedia('selection');
  manager['castDestinations'] = [];
  pending.resolve(token('key'));
  await expect(load).resolves.toBeUndefined();
  expect(mocks.destination.loadMedia).not.toHaveBeenCalled();
});

it('propagates token failures and allows a subsequent request to retry', async () => {
  const failure = new Error('offline');
  vi.mocked(createSession).mockRejectedValueOnce(failure).mockResolvedValueOnce(token('retry'));
  await expect(manager.loadMedia('first')).rejects.toBe(failure);
  await manager.loadMedia('second', true);
  expect(mocks.destination.loadMedia).toHaveBeenCalledExactlyOnceWith('second', 'retry', true);
});

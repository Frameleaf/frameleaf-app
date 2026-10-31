import {
  getMemoryShowLess,
  MemoryShowLessKind,
  memoriesStatistics,
  searchMemories,
  type MemoryResponseDto,
} from '@frameleaf/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferredPromise } from '@test-data/deferred';

const session = vi.hoisted(() => ({ generation: 0 }));
const state = vi.hoisted(() => ({
  auth: {
    authenticated: false,
    user: { id: 'me' },
    captureSession: () => {
      const generation = session.generation;
      return () => generation === session.generation;
    },
  },
  events: {} as Record<string, () => unknown>,
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: state.auth }));
vi.mock('$lib/managers/event-manager.svelte', () => ({
  eventManager: { on: (events: Record<string, () => unknown>) => Object.assign(state.events, events) },
}));
vi.mock('$lib/managers/user-preferences-manager.svelte', () => ({
  userPreferencesManager: { memories: { showUpcoming: true, onlyFavorites: false } },
}));
vi.mock('$lib/frameleaf/library-access', () => ({ onLibraryAccessChange: vi.fn() }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  searchMemories: vi.fn(),
  memoriesStatistics: vi.fn(),
  getMemoryShowLess: vi.fn(),
}));

const memory = (id: string, assets = [{ id: `asset-${id}` }]) => ({ id, assets }) as MemoryResponseDto;
let manager: typeof import('./memory-manager.svelte').memoryManager;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-15T12:59:55.250Z');
  state.auth.authenticated = false;
  state.events = {};
  vi.mocked(searchMemories).mockReset().mockResolvedValue([]);
  vi.mocked(memoriesStatistics).mockReset().mockResolvedValue({ total: 0 });
  vi.mocked(getMemoryShowLess).mockReset().mockResolvedValue([]);
  ({ memoryManager: manager } = await import('./memory-manager.svelte'));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('memory page ownership', () => {
  it('publishes an in-flight page before fetching the queued page, counting empty memories toward pagination', async () => {
    const first = deferredPromise<MemoryResponseDto[]>();
    const duplicate = memory('first', [{ id: 'ignored-duplicate' }]);
    vi.mocked(searchMemories)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([duplicate, memory('second')]);
    vi.mocked(memoriesStatistics).mockResolvedValue({ total: 5 });
    const loading = manager.refresh();
    manager.loadNextPage();
    manager.loadNextPage();
    first.resolve([memory('empty', []), memory('first'), duplicate]);
    await loading;
    expect(manager.memories.map(({ id }) => id)).toEqual(['first', 'second']);
    expect(manager.memories[0].assets[0].id).toBe('asset-first');
    expect(vi.mocked(searchMemories).mock.calls.map(([query]) => query.page)).toEqual([1, 2]);
    expect(manager.hasNextPage).toBe(false);
  });

  it('never asks for a page past the end when the memories are opened again', async () => {
    vi.mocked(searchMemories).mockResolvedValueOnce([memory('only')]);
    vi.mocked(memoriesStatistics).mockResolvedValue({ total: 1 });
    await manager.refresh();
    expect(manager.hasNextPage).toBe(false);

    await manager.applyPreferences();
    await manager.refresh();

    expect(vi.mocked(searchMemories).mock.calls.map(([query]) => query.page)).toEqual([1]);
    expect(manager.memories.map(({ id }) => id)).toEqual(['only']);
  });

  it.each([false, true])('discards a response after logout without another request (queued=%s)', async (queued) => {
    const first = deferredPromise<MemoryResponseDto[]>();
    vi.mocked(searchMemories).mockReturnValueOnce(first.promise);
    const loading = manager.refresh();
    if (queued) {
      manager.loadNextPage();
    }
    state.events.AuthLogout();
    first.resolve([memory('private')]);
    await loading;
    expect(manager.memories).toEqual([]);
    expect(searchMemories).toHaveBeenCalledTimes(1);
    expect(memoriesStatistics).not.toHaveBeenCalled();
    expect(manager.loading).toBeUndefined();
  });

  it('starts a session-state reload immediately and ignores statistics from the previous state', async () => {
    const oldStatistics = deferredPromise<{ total: number }>();
    const currentPage = deferredPromise<MemoryResponseDto[]>();
    vi.mocked(searchMemories)
      .mockResolvedValueOnce([memory('old')])
      .mockReturnValueOnce(currentPage.promise)
      .mockResolvedValueOnce([memory('hidden-current')]);
    vi.mocked(getMemoryShowLess).mockResolvedValueOnce([
      { kind: MemoryShowLessKind.Person, createdAt: '', name: '', value: 'current-person' },
    ]);
    vi.mocked(memoriesStatistics).mockReturnValueOnce(oldStatistics.promise).mockResolvedValueOnce({ total: 1 });
    const oldLoading = manager.refresh();
    await vi.waitFor(() => expect(memoriesStatistics).toHaveBeenCalledTimes(1));
    const currentLoading = manager.reloadForSessionAccess();
    const currentPageLoading = manager.loading;
    expect(currentPageLoading).toBeDefined();
    expect(searchMemories).toHaveBeenCalledTimes(3);
    expect(searchMemories).toHaveBeenCalledWith({ isHidden: true, order: 'desc', size: 250 });
    expect(getMemoryShowLess).toHaveBeenCalledOnce();
    oldStatistics.resolve({ total: 999 });
    await oldLoading;
    expect(manager.loading).toBe(currentPageLoading);
    expect(manager.memories).toEqual([]);
    currentPage.resolve([memory('current')]);
    await currentLoading;
    expect(manager.total).toBe(1);
    expect(manager.hidden.map(({ id }) => id)).toEqual(['hidden-current']);
    expect(manager.showLess).toEqual([
      { kind: MemoryShowLessKind.Person, createdAt: '', name: '', value: 'current-person' },
    ]);
    expect(manager.memories.map(({ id }) => id)).toEqual(['current']);
    expect(manager.loading).toBeUndefined();
  });

  it('retries a failed page rather than leaving the loader stuck or skipping it', async () => {
    vi.mocked(searchMemories)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([memory('retry')]);
    vi.mocked(memoriesStatistics).mockResolvedValue({ total: 1 });
    await expect(manager.refresh()).rejects.toThrow('offline');
    expect(manager.loading).toBeUndefined();
    await manager.refresh();
    expect(vi.mocked(searchMemories).mock.calls.map(([query]) => query.page)).toEqual([1, 1]);
    expect(manager.memories.map(({ id }) => id)).toEqual(['retry']);
  });

  it('does not publish a partial page when statistics fail and retries the same page', async () => {
    vi.mocked(searchMemories).mockResolvedValue([memory('retry')]);
    vi.mocked(memoriesStatistics)
      .mockRejectedValueOnce(new Error('statistics unavailable'))
      .mockResolvedValueOnce({ total: 1 });
    await expect(manager.refresh()).rejects.toThrow('statistics unavailable');
    expect(manager.memories).toEqual([]);
    expect(manager.loading).toBeUndefined();
    await manager.refresh();
    expect(vi.mocked(searchMemories).mock.calls.map(([query]) => query.page)).toEqual([1, 1]);
    expect(manager.memories.map(({ id }) => id)).toEqual(['retry']);
  });

  it('keeps the hourly schedule but does not fetch while signed out', async () => {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(searchMemories).not.toHaveBeenCalled();
    state.auth.authenticated = true;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(searchMemories).toHaveBeenCalledTimes(1);
  });
});

describe('direct memory read ownership', () => {
  it.each([
    ['memory', 'logout'],
    ['hidden', 'logout'],
    ['rules', 'logout'],
    ['memory', 'session'],
    ['hidden', 'session'],
    ['rules', 'session'],
  ] as const)('does not republish %s after %s', async (kind, change) => {
    const response = deferredPromise<MemoryResponseDto[]>();
    const rules = deferredPromise<Awaited<ReturnType<typeof getMemoryShowLess>>>();
    vi.mocked(searchMemories).mockReturnValueOnce(response.promise);
    vi.mocked(getMemoryShowLess).mockReturnValueOnce(rules.promise);
    const loading =
      kind === 'memory'
        ? manager.loadMemory('private')
        : kind === 'hidden'
          ? manager.loadHidden()
          : manager.loadShowLess();
    if (change === 'logout') {
      state.events.AuthLogout();
    } else {
      session.generation++;
    }
    response.resolve([memory('private')]);
    rules.resolve([{ kind: MemoryShowLessKind.Person, createdAt: '', name: '', value: 'private-person' }]);
    await loading;
    expect(manager.memories).toEqual([]);
    expect(manager.hidden).toEqual([]);
    expect(manager.showLess).toEqual([]);
  });

  it('clears already loaded hidden memories and show-less rules on logout', () => {
    manager.hidden = [memory('private')];
    manager.showLess = [{ kind: MemoryShowLessKind.Person, createdAt: '', name: '', value: 'private-person' }];
    state.events.AuthLogout();
    expect(manager.hidden).toEqual([]);
    expect(manager.showLess).toEqual([]);
  });
});

it('preserves auxiliary memory settings during an ordinary filter change', () => {
  manager.hidden = [memory('hidden')];
  manager.showLess = [{ kind: MemoryShowLessKind.Person, createdAt: '', name: '', value: 'person' }];
  manager.setFilters({ size: 17 });
  expect(manager.hidden.map(({ id }) => id)).toEqual(['hidden']);
  expect(manager.showLess).toEqual([{ kind: MemoryShowLessKind.Person, createdAt: '', name: '', value: 'person' }]);
});

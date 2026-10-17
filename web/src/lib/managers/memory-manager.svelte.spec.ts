import {
  addMemoryAssets,
  addMemoryShowLess,
  deleteMemory,
  getMemoryShowLess,
  memoriesStatistics,
  MemoryShowLessKind,
  removeMemoryAssets,
  searchMemories,
  updateMemory,
  type MemoryResponseDto,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import { MEMORY_REMOVE_UNDO_TIMEOUT_MS, memoryManager } from './memory-manager.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: vi.fn().mockResolvedValue(undefined) }));
const navigation = vi.hoisted((): { url?: URL; session: number } => ({ session: 0 }));
vi.mock('$app/state', async () => {
  const { SvelteURL } = await import('svelte/reactivity');
  const url = new SvelteURL('http://localhost/memories/memory-1?assetId=asset-1');
  navigation.url = url;
  return {
    page: { params: { id: 'memory-1' }, url },
  };
});
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    authenticated: false,
    user: { id: 'me' },
    captureSession: () => {
      const session = navigation.session;
      return () => session === navigation.session;
    },
  },
}));
vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  removeMemoryAssets: vi.fn().mockResolvedValue([{ id: 'asset-1', success: true }]),
  addMemoryAssets: vi.fn().mockResolvedValue([{ id: 'asset-1', success: true }]),
  deleteMemory: vi.fn().mockResolvedValue(undefined),
  searchMemories: vi.fn().mockResolvedValue([]),
  memoriesStatistics: vi.fn().mockResolvedValue({ total: 0 }),
  updateMemory: vi.fn(),
  addMemoryShowLess: vi.fn().mockResolvedValue(undefined),
  getMemoryShowLess: vi.fn().mockResolvedValue([]),
}));
vi.mock('@frameleaf/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/ui')>()),
  toastManager: { primary: vi.fn() },
}));

const memory = () =>
  ({
    id: 'memory-1',
    assets: [{ id: 'asset-1', originalFileName: 'IMG_0001.jpg', type: 'IMAGE' }],
    isSaved: false,
  }) as unknown as MemoryResponseDto;

it('retains the viewer window between photos and replaces it when memory contents change', () => {
  const current = memory();
  current.assets.push({ ...current.assets[0], id: 'asset-2' });
  memoryManager.memories = [current];
  const first = memoryManager.current!;
  navigation.url!.searchParams.set('assetId', 'asset-2');
  try {
    const second = memoryManager.current!;
    expect(second.asset.id).toBe('asset-2');
    expect(second.viewerAssets).toBe(first.viewerAssets);
    expect(second.previousHref).toContain('asset-1');
    memoryManager.memories[0].assets = [current.assets[1]];
    expect(memoryManager.current!.viewerAssets).not.toBe(second.viewerAssets);
    expect(memoryManager.current!.viewerAssets.map(({ id }) => id)).toEqual(['asset-2']);
  } finally {
    navigation.url!.searchParams.set('assetId', 'asset-1');
  }
});

it('invalidates the viewer window when an adjacent memory gains an asset', () => {
  const previous = {
    ...memory(),
    memoryAt: '2026-10-15T00:00:00Z',
    data: { year: 2020 },
    id: 'previous',
    assets: [{ ...memory().assets[0], id: 'before' }],
  };
  const next = {
    ...memory(),
    memoryAt: '2026-10-15T00:00:00Z',
    data: { year: 2020 },
    id: 'next',
    assets: [{ ...memory().assets[0], id: 'after' }],
  };
  memoryManager.memories = [previous, memory(), next];
  const window = memoryManager.current!.viewerAssets;
  expect(window.map(({ id }) => id)).toEqual(['before', 'asset-1', 'after']);
  memoryManager.memories[2].assets.push({ ...next.assets[0], id: 'added' });
  expect(memoryManager.current!.viewerAssets).not.toBe(window);
  expect(memoryManager.current!.viewerAssets.map(({ id }) => id)).toEqual(['before', 'asset-1', 'after', 'added']);
});

describe('memoryManager.removeCurrentAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryManager.memories = [memory()];
  });

  it('sends the removal to the server at once and drops an emptied memory without deleting it', async () => {
    await memoryManager.removeCurrentAsset();

    expect(removeMemoryAssets).toHaveBeenCalledExactlyOnceWith({ id: 'memory-1', bulkIdsDto: { ids: ['asset-1'] } });
    expect(deleteMemory).not.toHaveBeenCalled();
    expect(memoryManager.memories).toHaveLength(0);
    expect(toastManager.primary).toHaveBeenCalledOnce();
  });

  it('keeps the item and offers no Undo when the server refuses removal', async () => {
    vi.mocked(removeMemoryAssets).mockResolvedValueOnce([{ id: 'asset-1', success: false }]);
    await expect(memoryManager.removeCurrentAsset()).rejects.toThrow('Unable to remove');
    expect(memoryManager.memories[0].assets.map((asset) => asset.id)).toEqual(['asset-1']);
    expect(toastManager.primary).not.toHaveBeenCalled();
  });

  it('does not restore local state when the server refuses Undo', async () => {
    vi.mocked(addMemoryAssets).mockResolvedValueOnce([{ id: 'asset-1', success: false }]);
    await memoryManager.removeCurrentAsset();
    const [[toast]] = vi.mocked(toastManager.primary).mock.calls as unknown as [
      [{ button: (close: () => void) => { onclick: () => void } }],
    ];
    toast.button(() => {}).onclick();
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledOnce());
    expect(memoryManager.memories).toHaveLength(0);
  });

  it('puts the item back through the inverse call when Undo is pressed, and only once', async () => {
    await memoryManager.removeCurrentAsset();
    const [[toast]] = vi.mocked(toastManager.primary).mock.calls as unknown as [
      [{ button: (close: () => void) => { onclick: () => void } }],
    ];
    const button = toast.button(() => {});

    button.onclick();
    button.onclick();
    await vi.waitFor(() => expect(addMemoryAssets).toHaveBeenCalledOnce());

    expect(addMemoryAssets).toHaveBeenCalledWith({ id: 'memory-1', bulkIdsDto: { ids: ['asset-1'] } });
    expect(memoryManager.memories).toHaveLength(1);
    expect(memoryManager.memories[0].assets.map((asset) => asset.id)).toEqual(['asset-1']);
  });
});

describe('memoryManager: a memory emptied by removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    memoryManager.memories = [memory()];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const undoButton = () => {
    const [[toast]] = vi.mocked(toastManager.primary).mock.calls as unknown as [
      [{ button: (close: () => void) => { onclick: () => void } }],
    ];
    return toast.button(() => {});
  };

  it('is deleted on the server once the Undo window closes unused', async () => {
    await memoryManager.removeCurrentAsset();
    expect(deleteMemory).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MEMORY_REMOVE_UNDO_TIMEOUT_MS);

    expect(deleteMemory).toHaveBeenCalledExactlyOnceWith({ id: 'memory-1' });
  });

  it('is not deleted when Undo runs inside the window', async () => {
    await memoryManager.removeCurrentAsset();
    const button = undoButton();

    button.onclick();
    await vi.advanceTimersByTimeAsync(MEMORY_REMOVE_UNDO_TIMEOUT_MS);

    expect(deleteMemory).not.toHaveBeenCalled();
    expect(addMemoryAssets).toHaveBeenCalledOnce();
    expect(memoryManager.memories).toHaveLength(1);
  });

  it('ignores an Undo pressed after the window has deleted the memory', async () => {
    await memoryManager.removeCurrentAsset();
    const button = undoButton();

    await vi.advanceTimersByTimeAsync(MEMORY_REMOVE_UNDO_TIMEOUT_MS);
    button.onclick();
    await vi.advanceTimersByTimeAsync(0);

    expect(deleteMemory).toHaveBeenCalledOnce();
    expect(addMemoryAssets).not.toHaveBeenCalled();
    expect(memoryManager.memories).toHaveLength(0);
  });

  it('never lists an empty memory the server still returns after a reload', async () => {
    const empty = { ...memory(), id: 'memory-empty', assets: [] } as unknown as MemoryResponseDto;
    const kept = { ...memory(), id: 'memory-2' } as unknown as MemoryResponseDto;
    vi.mocked(searchMemories).mockResolvedValueOnce([empty, kept]);
    vi.mocked(memoriesStatistics).mockResolvedValueOnce({ total: 2 });
    memoryManager.memories = [];

    await memoryManager.refresh();

    expect(memoryManager.memories.map(({ id }) => id)).toEqual(['memory-2']);
    expect(memoryManager.hasNextPage).toBe(false);

    vi.mocked(searchMemories).mockResolvedValueOnce([empty]);
    await expect(memoryManager.loadMemory('memory-empty')).resolves.toBeUndefined();
    expect(memoryManager.memories.map(({ id }) => id)).toEqual(['memory-2']);
  });
});

describe('memoryManager curation (FL-62)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const curated = () =>
    ({
      id: 'memory-9',
      title: null,
      isSaved: false,
      memoryAt: '2020-01-01T00:00:00.000Z',
      assets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    }) as unknown as MemoryResponseDto;

  it('saves the owner title and item order and plays the items in that order', async () => {
    memoryManager.memories = [curated()];
    vi.mocked(updateMemory).mockResolvedValueOnce({ ...curated(), title: 'Our summer' });

    await memoryManager.updateCuration('memory-9', { title: 'Our summer', assetOrder: ['c', 'a'] });

    expect(updateMemory).toHaveBeenCalledWith({
      id: 'memory-9',
      memoryUpdateDto: { title: 'Our summer', assetOrder: ['c', 'a'] },
    });
    expect(memoryManager.memories[0].title).toBe('Our summer');
    expect(memoryManager.memories[0].assets.map(({ id }) => id)).toEqual(['c', 'a', 'b']);
  });

  it('asks the server for less of something and reloads the index it filters', async () => {
    memoryManager.memories = [curated()];

    await memoryManager.addShowLess({ kind: MemoryShowLessKind.Date, value: '09-25' });

    expect(addMemoryShowLess).toHaveBeenCalledWith({ memoryShowLessDto: { kind: 'date', value: '09-25' } });
    expect(getMemoryShowLess).toHaveBeenCalled();
    expect(searchMemories).toHaveBeenCalled();
  });
});

describe('memoryManager on a lock or unlock (FL-195 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops what the other session state saw and reads the memories again', async () => {
    const { eventManager } = await import('$lib/managers/event-manager.svelte');
    memoryManager.memories = [memory()];
    const mixed = { ...memory(), id: 'memory-mixed' };
    vi.mocked(searchMemories).mockResolvedValueOnce([mixed]);
    vi.mocked(memoriesStatistics).mockResolvedValueOnce({ total: 1 });

    eventManager.emit('SessionAccessChanged', { isElevated: true });

    await vi.waitFor(() => expect(memoryManager.memories.map(({ id }) => id)).toEqual(['memory-mixed']));
    expect(searchMemories).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));

    vi.mocked(searchMemories).mockResolvedValueOnce([]);
    vi.mocked(memoriesStatistics).mockResolvedValueOnce({ total: 0 });
    eventManager.emit('SessionAccessChanged', { isElevated: false });

    await vi.waitFor(() => expect(memoryManager.memories).toEqual([]));
  });
});

describe('memory mutation session ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    memoryManager.memories = [memory()];
    memoryManager.hidden = [];
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const changeSession = () => {
    navigation.session++;
    memoryManager.memories = [];
    memoryManager.hidden = [];
  };

  it('does not navigate or offer Undo when removal completes in another session', async () => {
    const response = deferredPromise<Awaited<ReturnType<typeof removeMemoryAssets>>>();
    vi.mocked(removeMemoryAssets).mockReturnValueOnce(response.promise);
    const removing = memoryManager.removeCurrentAsset();
    changeSession();
    response.resolve([{ id: 'asset-1', success: true }]);
    await removing;
    expect(toastManager.primary).not.toHaveBeenCalled();
    expect(memoryManager.memories).toEqual([]);
  });

  it.each(['undo', 'finalize'] as const)('does not send a pending %s through another session', async (action) => {
    await memoryManager.removeCurrentAsset();
    const [[toast]] = vi.mocked(toastManager.primary).mock.calls as unknown as [
      [{ button: (close: () => void) => { onclick: () => void } }],
    ];
    changeSession();
    if (action === 'undo') {
      toast.button(() => {}).onclick();
    }
    await vi.advanceTimersByTimeAsync(MEMORY_REMOVE_UNDO_TIMEOUT_MS);
    expect(addMemoryAssets).not.toHaveBeenCalled();
    expect(deleteMemory).not.toHaveBeenCalled();
    expect(memoryManager.memories).toEqual([]);
  });

  it.each(['hide', 'restore'] as const)('does not publish an old %s response into another session', async (action) => {
    const item = memory();
    const response = deferredPromise<MemoryResponseDto>();
    vi.mocked(updateMemory).mockReturnValueOnce(response.promise);
    if (action === 'restore') {
      memoryManager.hidden = [item];
      memoryManager.memories = [];
    }
    const updating = action === 'hide' ? memoryManager.hideMemory(item.id) : memoryManager.restoreMemory(item.id);
    await vi.advanceTimersByTimeAsync(0);
    changeSession();
    response.resolve(item);
    await updating;
    expect(memoryManager.memories).toEqual([]);
    expect(memoryManager.hidden).toEqual([]);
  });
});

it('does not insert an undone memory when its restore response arrives in another session', async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  try {
    memoryManager.memories = [memory()];
    await memoryManager.removeCurrentAsset();
    const [[toast]] = vi.mocked(toastManager.primary).mock.calls as unknown as [
      [{ button: (close: () => void) => { onclick: () => void } }],
    ];
    const response = deferredPromise<Awaited<ReturnType<typeof addMemoryAssets>>>();
    vi.mocked(addMemoryAssets).mockReturnValueOnce(response.promise);
    toast.button(() => {}).onclick();
    navigation.session++;
    memoryManager.memories = [];
    response.resolve([{ id: 'asset-1', success: true }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(memoryManager.memories).toEqual([]);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it('keeps Undo available through an ordinary same-session filter refresh', async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  try {
    memoryManager.memories = [memory()];
    await memoryManager.removeCurrentAsset();
    const [[toast]] = vi.mocked(toastManager.primary).mock.calls as unknown as [
      [{ button: (close: () => void) => { onclick: () => void } }],
    ];
    memoryManager.setFilters({ size: 251 });
    await memoryManager.loading;
    toast.button(() => {}).onclick();
    await vi.advanceTimersByTimeAsync(0);
    expect(addMemoryAssets).toHaveBeenCalledOnce();
    expect(memoryManager.memories[0].assets[0].id).toBe('asset-1');
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

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
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleError } from '$lib/utils/handle-error';
import { MEMORY_REMOVE_UNDO_TIMEOUT_MS, memoryManager } from './memory-manager.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: vi.fn().mockResolvedValue(undefined) }));
vi.mock('$app/state', () => ({
  page: { params: { id: 'memory-1' }, url: new URL('http://localhost/memories/memory-1?assetId=asset-1') },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { authenticated: false, user: { id: 'me' } } }));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  removeMemoryAssets: vi.fn().mockResolvedValue([{ id: 'asset-1', success: true }]),
  addMemoryAssets: vi.fn().mockResolvedValue([{ id: 'asset-1', success: true }]),
  deleteMemory: vi.fn().mockResolvedValue(undefined),
  searchMemories: vi.fn().mockResolvedValue([]),
  memoriesStatistics: vi.fn().mockResolvedValue({ total: 0 }),
  updateMemory: vi.fn(),
  addMemoryShowLess: vi.fn().mockResolvedValue(undefined),
  getMemoryShowLess: vi.fn().mockResolvedValue([]),
}));
vi.mock('@immich/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/ui')>()),
  toastManager: { primary: vi.fn() },
}));

const memory = () =>
  ({
    id: 'memory-1',
    assets: [{ id: 'asset-1', originalFileName: 'IMG_0001.jpg', type: 'IMAGE' }],
    isSaved: false,
  }) as unknown as MemoryResponseDto;

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

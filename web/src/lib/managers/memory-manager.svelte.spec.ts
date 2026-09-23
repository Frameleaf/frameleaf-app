import { addMemoryAssets, deleteMemory, removeMemoryAssets, type MemoryResponseDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryManager } from './memory-manager.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn().mockResolvedValue(undefined) }));
vi.mock('$app/state', () => ({
  page: { params: { id: 'memory-1' }, url: new URL('http://localhost/memories/memory-1?assetId=asset-1') },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { authenticated: false, user: { id: 'me' } } }));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  removeMemoryAssets: vi.fn().mockResolvedValue(undefined),
  addMemoryAssets: vi.fn().mockResolvedValue(undefined),
  deleteMemory: vi.fn().mockResolvedValue(undefined),
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

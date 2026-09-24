import { removeMemoryAssets, type MemoryResponseDto } from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleError } from '$lib/utils/handle-error';
import { memoryManager } from './memory-manager.svelte';

// FL-83 (ported from ef7ad8b832): memory removal trusts the per-item outcome, not the HTTP status

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: vi.fn().mockResolvedValue(undefined) }));
vi.mock('$app/state', async () => {
  const { QueryParameter } = await import('$lib/constants');
  return {
    page: {
      params: { id: 'memory-1' },
      url: new URL(`http://localhost/memories/memory-1?${QueryParameter.ASSET_ID}=asset-1`),
    },
  };
});
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { authenticated: false, user: { id: 'me' } } }));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  removeMemoryAssets: vi.fn(),
}));

const asset = (id: string) => ({ id, ownerId: 'me', fileCreatedAt: '2026-01-01T00:00:00.000Z' });

const memory = () =>
  ({
    id: 'memory-1',
    memoryAt: '2026-01-01T00:00:00.000Z',
    assets: [asset('asset-1'), asset('asset-2')],
  }) as unknown as MemoryResponseDto;

describe('memoryManager.deleteCurrentAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryManager.memories = [memory()];
  });

  it('removes the item once the server reports success for it', async () => {
    vi.mocked(removeMemoryAssets).mockResolvedValueOnce([{ id: 'asset-1', success: true }]);
    await memoryManager.deleteCurrentAsset();
    expect(memoryManager.memories[0].assets.map(({ id }) => id)).toEqual(['asset-2']);
    expect(handleError).not.toHaveBeenCalled();
  });

  it.each([
    ['refuses the item', [{ id: 'asset-1', success: false }]],
    ['omits the item', [{ id: 'asset-2', success: true }]],
  ])('keeps the item and reports an error when the server %s', async (_, results) => {
    vi.mocked(removeMemoryAssets).mockResolvedValueOnce(results);
    await memoryManager.deleteCurrentAsset();
    expect(memoryManager.memories[0].assets.map(({ id }) => id)).toEqual(['asset-1', 'asset-2']);
    expect(handleError).toHaveBeenCalledOnce();
  });
});

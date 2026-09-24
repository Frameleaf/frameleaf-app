import type { MemoryResponseDto } from '@immich/sdk';
import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryManager } from '$lib/managers/memory-manager.svelte';
import MemoriesPanel from './MemoriesPanel.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn().mockResolvedValue(undefined) }));

const memory = (id: string, assets: unknown[]) =>
  ({
    id,
    type: 'on_this_day',
    data: { year: 2020 },
    memoryAt: '2026-09-24T00:00:00.000Z',
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    isSaved: false,
    ownerId: 'me',
    assets,
  }) as unknown as MemoryResponseDto;

describe('MemoriesPanel', () => {
  afterEach(() => {
    memoryManager.memories = [];
  });

  // FL-83: an emptied memory is deleted when its Undo closes, but one the server still returns (a
  // reload inside the window) must not break the index.
  it('renders the index without throwing when a memory has no items', () => {
    memoryManager.memories = [memory('memory-empty', [])];

    expect(() => render(MemoriesPanel)).not.toThrow();
  });
});

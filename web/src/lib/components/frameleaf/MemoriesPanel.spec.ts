import type { MemoryResponseDto } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { memoryManager } from '$lib/managers/memory-manager.svelte';
import en from '../../../../../i18n/en.json';
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
  beforeAll(() => {
    addMessages('dev', en);
  });

  afterEach(() => {
    memoryManager.memories = [];
  });

  // FL-83: an emptied memory is deleted when its Undo closes, but one the server still returns (a
  // reload inside the window) must not break the index.
  it('renders the index without throwing when a memory has no items', () => {
    memoryManager.memories = [memory('memory-empty', [])];

    expect(() => render(MemoriesPanel)).not.toThrow();
  });

  // FL-62: the card's overline and its hover preview come from the shared Memories engine.
  it('labels a card by kind and gives its cover the engine preview motion', () => {
    memoryManager.memories = [
      memory('memory-1', [
        { id: 'asset-1', type: 'IMAGE', visibility: 'timeline', localDateTime: '2020-09-24T10:00:00.000Z' },
      ]),
    ];

    const { container } = render(MemoriesPanel);

    expect(screen.getByText('Memory')).toBeInTheDocument();
    const cover = container.querySelector(':scope .fm-card-main img');
    expect(cover?.getAttribute('style')).toContain('--kb-from');
    expect(cover?.getAttribute('style')).toContain('--kb-duration: 9s');
  });

  it('never uses a Locked item as the cover', () => {
    memoryManager.memories = [
      memory('memory-2', [
        { id: 'locked-1', type: 'IMAGE', visibility: 'locked', localDateTime: '2020-09-24T10:00:00.000Z' },
        { id: 'asset-2', type: 'IMAGE', visibility: 'timeline', localDateTime: '2020-09-24T10:00:00.000Z' },
      ]),
    ];

    const { container } = render(MemoriesPanel);

    const cover = container.querySelector(':scope .fm-card-main img');
    expect(cover?.getAttribute('src')).toContain('asset-2');
    expect(container.getHTML()).not.toContain('locked-1/thumbnail');
  });
});

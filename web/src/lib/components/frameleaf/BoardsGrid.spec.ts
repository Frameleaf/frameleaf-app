import { LibraryAssetItemKind, type LibraryItemDto } from '@frameleaf/sdk';
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import BoardsGrid from '$lib/components/frameleaf/BoardsGrid.svelte';
import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';

const session = { selection: [], select: vi.fn(), setScrollAnchor: vi.fn() } as unknown as LibrarySessionStore;

describe('BoardsGrid', () => {
  it('shows the quiet placeholder for an item whose thumbnail does not load, and its name still (FL-1358)', async () => {
    const [missing, fine] = [
      timelineAssetFactory.build({ originalFileName: 'logo.eps' }),
      timelineAssetFactory.build({ originalFileName: 'photo.jpg' }),
    ];
    const items = [missing, fine].map(
      (asset) => ({ kind: LibraryAssetItemKind.Asset, asset: { id: asset.id } }) as unknown as LibraryItemDto,
    );
    const onOpen = vi.fn();
    const { container } = render(BoardsGrid, {
      items,
      assets: [missing, fine],
      session,
      layout: 'grid',
      tileSize: 180,
      showNames: true,
      onOpen,
    });
    const pictures = container.querySelectorAll<HTMLImageElement>(':scope .bg-open img');
    expect(pictures).toHaveLength(2);
    expect(container.querySelector('[data-broken-asset]')).toBeNull();

    await fireEvent.error(pictures[0]);

    expect(container.querySelectorAll(':scope .bg-open img')).toHaveLength(1);
    expect(container.querySelectorAll('[data-broken-asset]')).toHaveLength(1);
    expect(container.textContent).toContain('logo.eps');

    // opening the item tries its thumbnail again
    await fireEvent.click(container.querySelector(':scope .bg-open')!);
    expect(onOpen).toHaveBeenCalledWith(missing.id);
    expect(container.querySelectorAll(':scope .bg-open img')).toHaveLength(2);
    expect(container.querySelector('[data-broken-asset]')).toBeNull();
  });
});

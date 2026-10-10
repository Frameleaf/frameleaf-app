import { AssetVisibility } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readable } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { DRAG_SELECT_EVENT } from '$lib/components/timeline/drag-select';
import { clearLocksRevealed, markLocksRevealed } from '$lib/components/timeline/lock-reveal';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import AssetTile from './AssetTile.svelte';

vi.mock('$lib/utils', async (original) => ({
  ...(await original<typeof import('$lib/utils')>()),
  getAssetMediaUrl: ({ id, size }: { id: string; size?: string }) => `/api/assets/${id}/thumbnail?size=${size}`,
  getAssetPlaybackUrl: ({ id }: { id: string }) => `/api/assets/${id}/video/playback`,
}));
vi.mock('$lib/utils/thumbnail-util', () => ({ getAltText: readable(() => 'A photo') }));

const asset = (overrides: Partial<TimelineAsset> = {}): TimelineAsset =>
  ({
    id: 'asset-1',
    ownerId: 'owner-1',
    ratio: 1.5,
    thumbhash: null,
    localDateTime: { year: 2026, month: 9, day: 22, hour: 10, minute: 0, second: 0 },
    createdAt: { year: 2026, month: 9, day: 22, hour: 10, minute: 0, second: 0 },
    fileCreatedAt: { year: 2026, month: 9, day: 22, hour: 10, minute: 0, second: 0 },
    visibility: AssetVisibility.Timeline,
    isFavorite: false,
    isTrashed: false,
    isVideo: false,
    isImage: true,
    stack: null,
    duration: null,
    projectionType: null,
    livePhotoVideoId: null,
    city: null,
    country: null,
    people: [],
    ...overrides,
  }) as TimelineAsset;

const touch = { pointerType: 'touch' } as const;

/** Review findings 3, 6 and 7: selection that reads at a glance, press-and-hold, photos that develop. */
describe('AssetTile selection and touch', () => {
  it('marks a selected tile on the tile itself, with a ticked box, and keeps everything on the photo in one layer', () => {
    const { container } = render(AssetTile, {
      asset: asset({ isFavorite: true }),
      width: 200,
      height: 133,
      selected: true,
    });
    const tile = screen.getByTestId('frameleaf-asset-tile');
    expect(tile).toHaveClass('is-selected');
    expect(screen.getByRole('checkbox')).toBeChecked();
    // The photo, its scrim and its badges move together when the tile insets.
    const media = container.querySelector('.fl-tile-media')!;
    expect(media.querySelector('img')).not.toBeNull();
    expect(media.querySelector('.fl-tile-badges')).not.toBeNull();
    // The tick is outside that layer: it stays put while the photo settles.
    expect(media.querySelector('.fl-tile-select')).toBeNull();
  });

  it('starts a selection on a press-and-hold, and the hold does not also open the item', async () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      const onToggleSelect = vi.fn();
      render(AssetTile, { asset: asset(), width: 200, height: 133, onOpen, onToggleSelect });
      const open = screen.getByRole('button', { name: 'A photo' });

      await fireEvent.pointerDown(open, { ...touch, clientX: 20, clientY: 20 });
      expect(screen.getByTestId('frameleaf-asset-tile')).toHaveClass('is-pressing');
      vi.advanceTimersByTime(450);
      await tick();
      expect(onToggleSelect).toHaveBeenCalledOnce();
      expect(onToggleSelect.mock.calls[0][0]).toMatchObject({ id: 'asset-1' });

      await fireEvent.pointerUp(open, touch);
      await fireEvent.click(open);
      expect(onOpen).not.toHaveBeenCalled();

      // The next plain tap is an ordinary tap again.
      await fireEvent.pointerDown(open, { ...touch, clientX: 20, clientY: 20 });
      await fireEvent.pointerUp(open, touch);
      await fireEvent.click(open);
      expect(onOpen).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('extends the selection to the tiles a held finger is dragged across', async () => {
    vi.useFakeTimers();
    try {
      const onToggleSelect = vi.fn();
      render(AssetTile, { asset: asset(), width: 200, height: 133, onToggleSelect });
      render(AssetTile, { asset: asset({ id: 'asset-2' }), width: 200, height: 133, onToggleSelect });
      const [first, second] = screen.getAllByRole('button', { name: 'A photo' });

      await fireEvent.pointerDown(first, { ...touch, clientX: 20, clientY: 20 });
      vi.advanceTimersByTime(450);
      await tick();
      expect(onToggleSelect).toHaveBeenCalledOnce();

      // The finger moves on to the next tile without lifting.
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => second });
      const move = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(move, 'touches', { value: [{ clientX: 260, clientY: 20 }] });
      first.dispatchEvent(move);

      expect(move.defaultPrevented).toBe(true);
      expect(onToggleSelect).toHaveBeenCalledTimes(2);
      expect(onToggleSelect.mock.calls[1][0]).toMatchObject({ id: 'asset-2' });
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint');
      vi.useRealTimers();
    }
  });

  it('does not drop a tile from the selection when a drag passes back over it', () => {
    const onToggleSelect = vi.fn();
    render(AssetTile, { asset: asset(), width: 200, height: 133, selected: true, onToggleSelect });
    screen
      .getByTestId('frameleaf-asset-tile')
      .dispatchEvent(new CustomEvent(DRAG_SELECT_EVENT, { bubbles: true, detail: { assetId: 'asset-1' } }));
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it('sharpens a Locked item into view only when it is drawn just after the PIN', () => {
    clearLocksRevealed();
    const before = render(AssetTile, { asset: asset({ visibility: AssetVisibility.Locked }), width: 200, height: 133 });
    expect(screen.getByTestId('frameleaf-asset-tile')).not.toHaveClass('is-revealing');
    before.unmount();

    markLocksRevealed();
    const locked = render(AssetTile, { asset: asset({ visibility: AssetVisibility.Locked }), width: 200, height: 133 });
    expect(screen.getByTestId('frameleaf-asset-tile')).toHaveClass('is-revealing');
    locked.unmount();

    // An ordinary item drawn in the same moment is left alone.
    render(AssetTile, { asset: asset(), width: 200, height: 133 });
    expect(screen.getByTestId('frameleaf-asset-tile')).not.toHaveClass('is-revealing');
    clearLocksRevealed();
  });

  it('treats a press that travels as a scroll: nothing is selected', async () => {
    vi.useFakeTimers();
    try {
      const onToggleSelect = vi.fn();
      render(AssetTile, { asset: asset(), width: 200, height: 133, onToggleSelect });
      const open = screen.getByRole('button', { name: 'A photo' });

      await fireEvent.pointerDown(open, { ...touch, clientX: 20, clientY: 20 });
      await fireEvent.pointerMove(open, { ...touch, clientX: 22, clientY: 60 });
      vi.advanceTimersByTime(600);
      expect(onToggleSelect).not.toHaveBeenCalled();
      expect(screen.getByTestId('frameleaf-asset-tile')).not.toHaveClass('is-pressing');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not select from a mouse press, and a short touch is just a tap', async () => {
    vi.useFakeTimers();
    try {
      const onToggleSelect = vi.fn();
      render(AssetTile, { asset: asset(), width: 200, height: 133, onToggleSelect });
      const open = screen.getByRole('button', { name: 'A photo' });

      await fireEvent.pointerDown(open, { pointerType: 'mouse', clientX: 20, clientY: 20 });
      vi.advanceTimersByTime(600);
      await fireEvent.pointerDown(open, { ...touch, clientX: 20, clientY: 20 });
      vi.advanceTimersByTime(150);
      await fireEvent.pointerUp(open, touch);
      vi.advanceTimersByTime(600);
      expect(onToggleSelect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps press-and-hold for the Live Photo once a selection is in progress', async () => {
    vi.useFakeTimers();
    try {
      const onToggleSelect = vi.fn();
      const { container } = render(AssetTile, {
        asset: asset({ id: 'still-1', livePhotoVideoId: 'motion-1' }),
        width: 200,
        height: 133,
        selecting: true,
        onToggleSelect,
      });
      await fireEvent.pointerDown(screen.getByRole('button', { name: 'A photo' }), {
        ...touch,
        clientX: 20,
        clientY: 20,
      });
      vi.advanceTimersByTime(450);
      await tick();
      expect(onToggleSelect).not.toHaveBeenCalled();
      expect(container.querySelector('video')?.getAttribute('src')).toBe('/api/assets/motion-1/video/playback');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the photo’s thumbhash until the thumbnail lands, and a quiet placeholder while the image is held back', async () => {
    const { container, rerender } = render(AssetTile, {
      asset: asset({ thumbhash: 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw==' }),
      width: 200,
      height: 133,
      deferImage: true,
    });
    // Scrubbing: no request yet, but the hash already stands in for the photo.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.fl-tile-placeholder')).not.toBeNull();
    expect(container.querySelector('canvas.fl-tile-hash')).not.toBeNull();

    await rerender({ deferImage: false });
    const image = container.querySelector('img')!;
    expect(image).not.toBeNull();
    expect(container.querySelector('canvas.fl-tile-hash')).not.toBeNull();

    // An image that arrives at once (the cache) replaces the hash without a fade.
    await fireEvent.load(image);
    await tick();
    expect(container.querySelector('canvas.fl-tile-hash')).toBeNull();
  });

  it('draws no hash canvas for an item that has none', () => {
    const { container } = render(AssetTile, { asset: asset(), width: 200, height: 133 });
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('hands a right-click to the page instead of the browser menu', async () => {
    const onContextMenu = vi.fn();
    render(AssetTile, { asset: asset(), width: 200, height: 133, quickActions: { onContextMenu } });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    screen.getByRole('button', { name: /A photo/ }).dispatchEvent(event);
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });
});

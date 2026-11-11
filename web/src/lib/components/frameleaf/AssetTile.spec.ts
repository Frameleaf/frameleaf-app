import { AssetVisibility, TimeBucketDateType } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { Settings } from 'luxon';
import { tick } from 'svelte';
import { locale } from 'svelte-i18n';
import { readable } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { DRAG_SELECT_EVENT } from '$lib/components/timeline/drag-select';
import { clearLocksRevealed, markLocksRevealed } from '$lib/components/timeline/lock-reveal';
import { thumbnailFailures } from '$lib/frameleaf/thumbnail-state.svelte';
import type { TimelineDay } from '$lib/managers/timeline-manager/timeline-day.svelte';
import { bucketTimelineAssets } from '$lib/managers/timeline-manager/timeline-month.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';
import AssetTile from './AssetTile.svelte';
import LibraryDayGroup from './LibraryDayGroup.svelte';

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

  it('opens the same menu from Shift+F10, under the photo, where a Mac sends no contextmenu', async () => {
    const onContextMenu = vi.fn();
    render(AssetTile, { asset: asset(), width: 200, height: 133, quickActions: { onContextMenu } });
    await fireEvent.keyDown(screen.getByRole('button', { name: /A photo/ }), { key: 'F10', shiftKey: true });
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onContextMenu.mock.calls[0][0]).toBeInstanceOf(MouseEvent);
  });
});

describe('AssetTile date labels', () => {
  it.each([
    ['2026-01-15', 21, 16, '2026-01-15'],
    ['2026-07-15', 21, 17, '2026-07-15'],
    ['2026-01-15', 2, 21, '2026-01-14'],
  ])('converts added time to the viewer zone (%s at %s UTC)', (date, hour, expectedHour, expectedDate) => {
    const previousZone = Settings.defaultZone;
    Settings.defaultZone = 'America/Toronto';
    void locale.set('en-US');
    try {
      const [year, month, day] = date.split('-').map(Number);
      const response = toResponseDto(timelineAssetFactory.build());
      response.createdAt = [`${date}T${String(hour).padStart(2, '0')}:20:00.000Z`];
      response.fileCreatedAt = ['2019-06-01T12:00:00.000Z'];
      response.localOffsetHours = [-5];
      const [photo] = bucketTimelineAssets(response);
      const tile = { id: photo.id, asset: photo, position: { top: 0, left: 0, width: 200, height: 160 } };
      const { container } = render(LibraryDayGroup, {
        timelineDay: {
          dateType: TimeBucketDateType.Added,
          timelineMonth: { yearMonth: { year, month } },
          day,
          viewerAssets: [tile],
          activeViewerAssets: [tile],
          width: 200,
          height: 160,
        } as unknown as TimelineDay,
        selection: [],
        selecting: false,
        showHeader: false,
        captionHeight: 24,
      });
      const time = container.querySelector('time')!;
      // No day headers under Added, so the caption names the day too (prototype "18 Aug 06:00").
      const [, expectedMonth, expectedDay] = expectedDate.split('-').map(Number);
      const dayLabel = `${expectedMonth === 7 ? 'Jul' : 'Jan'} ${expectedDay}`;
      expect(time.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(`${dayLabel}, ${expectedHour % 12 || 12}:20 PM`);
      expect(time.getAttribute('datetime')).toContain(`${expectedDate}T${expectedHour}:20`);
    } finally {
      Settings.defaultZone = previousZone;
      void locale.set('en');
    }
  });

  it.each(['timeline', 'work'] as const)('preserves the capture clock in %s', (layout) => {
    const previousZone = Settings.defaultZone;
    Settings.defaultZone = 'America/Toronto';
    void locale.set('en-US');
    try {
      const { container } = render(AssetTile, {
        asset: asset({
          localDateTime: { year: 2026, month: 1, day: 15, hour: 21, minute: 20, second: 0, millisecond: 0 },
        }),
        layout,
        width: 200,
        height: 160,
        captionHeight: 24,
      });
      expect(container.querySelector('time')?.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe('9:20 PM');
    } finally {
      Settings.defaultZone = previousZone;
      void locale.set('en');
    }
  });
});

describe('AssetTile list and browse dates', () => {
  it.each([TimeBucketDateType.Added, TimeBucketDateType.Taken])(
    'uses the appropriate date in List (%s)',
    (dateType) => {
      const previousZone = Settings.defaultZone;
      Settings.defaultZone = 'America/Toronto';
      void locale.set('en-US');
      try {
        const at = { year: 2026, month: 1, day: 15, hour: 2, minute: 20, second: 0, millisecond: 0 };
        const { container } = render(AssetTile, {
          asset: asset({ createdAt: at, localDateTime: at }),
          width: 300,
          height: 96,
          layout: 'list',
          dateType,
        });
        expect(container.querySelector('.fl-list-date')?.textContent).toBe(
          dateType === TimeBucketDateType.Added ? 'Jan 14, 2026' : 'Jan 15, 2026',
        );
      } finally {
        Settings.defaultZone = previousZone;
        void locale.set('en');
      }
    },
  );

  it('rings the item the Work panel describes, unless it is selected (FL-1117)', async () => {
    const { container, rerender } = render(AssetTile, {
      asset: asset(),
      width: 200,
      height: 200,
      layout: 'work',
      inPanel: true,
    });
    const tile = container.querySelector('.fl-tile')!;
    expect(tile).toHaveClass('is-in-panel');
    await rerender({ inPanel: false });
    expect(tile).not.toHaveClass('is-in-panel');
  });

  it('keeps Browse free of captions until the View menu gives it one (FL-1398)', async () => {
    const { container, rerender } = render(AssetTile, {
      asset: asset({ originalFileName: 'IMG_0412.jpg' }),
      width: 200,
      height: 200,
      layout: 'browse',
      dateType: TimeBucketDateType.Added,
    });
    expect(container.querySelector('.fl-tile-caption')).toBeNull();

    // "File name" on, "Time taken" off: the name alone
    await rerender({ captionHeight: 24, showFileName: true, showTime: false });
    expect(container.querySelector('.fl-tile-caption')).toHaveTextContent('IMG_0412');
    expect(container.querySelector('time')).toBeNull();

    // "Time taken" alone starts under the photo's edge
    await rerender({ showFileName: false, showTime: true });
    expect(container.querySelector('.fl-tile-caption')).toHaveClass('is-time-only');
    expect(container.querySelector('time')).not.toBeNull();
  });
});

// FL-1409 (M5): a photo that is not ready is calm; one that can't be shown says so and leads to Library care.
describe('AssetTile for a photo with no thumbnail (FL-1409)', () => {
  const fail = async (container: HTMLElement) => {
    vi.spyOn(thumbnailFailures, 'check').mockImplementation(() => {});
    await fireEvent.error(container.querySelector('img')!);
  };

  it('shows the calm placeholder while the photo waits for its thumbnail', async () => {
    const { container } = render(AssetTile, { asset: asset(), width: 200, height: 133 });
    await fail(container);

    expect(container.querySelector('[data-thumbnail-pending]')).toHaveAccessibleName('frameleaf_thumbnail_pending');
    expect(container.querySelector('[data-broken-asset]')).toBeNull();
    expect(screen.queryByRole('link', { name: 'frameleaf_thumbnail_cant_show_care' })).not.toBeInTheDocument();
    expect(thumbnailFailures.check).toHaveBeenCalled();
  });

  it('keeps the can’t-show tile for a photo whose thumbnail failed, and leads to Library care', async () => {
    thumbnailFailures.ids.add('asset-1');
    try {
      const { container } = render(AssetTile, { asset: asset(), width: 200, height: 133 });
      await fail(container);

      expect(container.querySelector('[data-thumbnail-pending]')).toBeNull();
      expect(container.querySelector('[data-broken-asset]')).toHaveAccessibleName('frameleaf_thumbnail_cant_show');
      // The words are on the tile at any size; the link's name says where it leads.
      const care = screen.getByRole('link', { name: 'frameleaf_thumbnail_cant_show_care' });
      expect(care).toHaveTextContent('frameleaf_thumbnail_cant_show');
      expect(care).toHaveAttribute('href', expect.stringContaining('care'));
    } finally {
      thumbnailFailures.ids.delete('asset-1');
    }
  });

  it('keeps the list of such photos fresh while its tile is on screen, and stops when it leaves', async () => {
    const stop = vi.fn();
    const watch = vi.spyOn(thumbnailFailures, 'watch').mockReturnValue(stop);
    thumbnailFailures.ids.add('asset-1');
    try {
      const { container, unmount } = render(AssetTile, { asset: asset(), width: 200, height: 133 });
      expect(watch).not.toHaveBeenCalled();
      await fail(container);
      expect(watch).toHaveBeenCalledTimes(1);

      // The server stops listing it: the tile goes back to getting ready, which asks for the picture again.
      thumbnailFailures.ids.delete('asset-1');
      await tick();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-thumbnail-pending]')).not.toBeNull();
      unmount();
    } finally {
      thumbnailFailures.ids.delete('asset-1');
      watch.mockRestore();
    }
  });

  it('keeps the can’t-show tile for a photo whose file is missing from its library', async () => {
    const { container } = render(AssetTile, { asset: asset({ isOffline: true }), width: 200, height: 133 });
    await fail(container);

    expect(container.querySelector('[data-thumbnail-pending]')).toBeNull();
    expect(container.querySelector('[data-broken-asset]')).toHaveAccessibleName('frameleaf_thumbnail_cant_show');
  });

  it('shows no 0:00 on a video whose length isn’t known yet', () => {
    const { container } = render(AssetTile, {
      asset: asset({ isVideo: true, isImage: false, duration: null }),
      width: 200,
      height: 133,
    });
    expect(container.querySelector('.fl-tile-badges')).not.toHaveTextContent('0:00');

    const known = render(AssetTile, {
      asset: asset({ id: 'asset-2', isVideo: true, isImage: false, duration: 65_000 }),
      width: 200,
      height: 133,
    });
    expect(known.container.querySelector('.fl-tile-badges')).toHaveTextContent('1:05');
  });
});

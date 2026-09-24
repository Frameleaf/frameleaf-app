import { AssetVisibility, MediaOperationItemStatus, MediaOperationStatus } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { durableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';
import { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import AssetGrid from './AssetGrid.svelte';
import AssetTile from './AssetTile.svelte';
import LibraryDayGroup from './LibraryDayGroup.svelte';
import ResultsToolbar from './ResultsToolbar.svelte';
import ShowMore from './ShowMore.svelte';

vi.mock('$lib/utils', () => ({
  getAssetMediaUrl: ({ id, size }: { id: string; size?: string }) => `/api/assets/${id}/thumbnail?size=${size}`,
  getAssetPlaybackUrl: ({ id }: { id: string }) => `/api/assets/${id}/video/playback`,
  getPeopleThumbnailUrl: ({ id }: { id: string }) => `/api/people/${id}/thumbnail`,
}));
vi.mock('$lib/utils/thumbnail-util', () => ({ getAltText: readable(() => 'A photo') }));
vi.mock('$lib/components/assets/thumbnail/ImageThumbnail.svelte', async () => {
  const { default: TestImage } = await import('$lib/../test-data/frameleaf/TestImage.svelte');
  return { default: TestImage };
});

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

const tile = (props: Record<string, unknown> = {}) =>
  render(AssetTile, { asset: asset(), width: 200, height: 133, ...props });

describe('AssetTile', () => {
  it('draws a duration badge for a video', () => {
    tile({ asset: asset({ isVideo: true, isImage: false, duration: 96_000 }) });
    expect(screen.getByTestId('frameleaf-asset-tile').textContent).toContain('1:36');
  });

  it('badges a Live Photo, a panorama, a stack and a locked item', () => {
    tile({
      asset: asset({
        livePhotoVideoId: 'motion-1',
        projectionType: 'EQUIRECTANGULAR',
        stack: { id: 'stack-1', primaryAssetId: 'asset-1', assetCount: 4 } as never,
        visibility: AssetVisibility.Locked,
      }),
    });
    const text = screen.getByTestId('frameleaf-asset-tile').textContent ?? '';
    expect(text).toContain('frameleaf_library_badge_live_photo');
    expect(text).toContain('frameleaf_library_badge_panorama');
    expect(text).toContain('frameleaf_library_badge_locked');
    expect(text).toContain('4');
  });

  it('scrubs the preview transcode on hover and never the original file', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(AssetTile, {
        asset: asset({ id: 'video-1', isVideo: true, isImage: false, duration: 10_000 }),
        width: 200,
        height: 133,
      });
      expect(container.querySelector('video')).toBeNull();
      await fireEvent.pointerEnter(screen.getByRole('button', { name: 'A photo' }), { pointerType: 'mouse' });
      vi.advanceTimersByTime(400);
      await tick();
      const video = container.querySelector('video');
      expect(video?.getAttribute('src')).toBe('/api/assets/video-1/video/playback');
      expect(container.getHTML()).not.toContain('size=original');
    } finally {
      vi.useRealTimers();
    }
  });

  it('plays the motion part of a Live Photo, not the still', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(AssetTile, {
        asset: asset({ id: 'still-1', livePhotoVideoId: 'motion-1' }),
        width: 200,
        height: 133,
      });
      await fireEvent.pointerEnter(screen.getByRole('button', { name: 'A photo' }), { pointerType: 'mouse' });
      vi.advanceTimersByTime(400);
      await tick();
      expect(container.querySelector('video')?.getAttribute('src')).toBe('/api/assets/motion-1/video/playback');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the rating on hover or while selected, and not at rest', async () => {
    const { container, rerender } = render(AssetTile, {
      asset: asset(),
      width: 200,
      height: 133,
      rating: 3,
    });
    expect(container.querySelector('.fl-tile-rating')).toBeNull();
    await fireEvent.pointerEnter(screen.getByRole('button', { name: 'A photo' }), { pointerType: 'mouse' });
    expect(container.querySelector('.fl-tile-rating')).not.toBeNull();
    await fireEvent.pointerLeave(screen.getByRole('button', { name: 'A photo' }));
    expect(container.querySelector('.fl-tile-rating')).toBeNull();
    await rerender({ selected: true });
    expect(container.querySelector('.fl-tile-rating')).not.toBeNull();
  });

  it('shows the asset’s own rating when no override is given', async () => {
    const { container } = render(AssetTile, { asset: asset({ rating: 4 }), width: 200, height: 133, selected: true });
    expect(container.querySelector('.fl-tile-rating')?.getAttribute('aria-label')).toBe(
      'frameleaf_library_rating_stars',
    );
  });

  describe('per layout (September 24)', () => {
    it('never shows a rating or a caption in Browse, even selected or hovered', async () => {
      const { container } = render(AssetTile, {
        asset: asset({ rating: 5, originalFileName: 'IMG_0001.HEIC' }),
        width: 120,
        height: 120,
        layout: 'browse',
        selected: true,
        showFileName: true,
      });
      await fireEvent.pointerEnter(screen.getByRole('button', { name: 'A photo' }), { pointerType: 'mouse' });
      expect(container.querySelector('.fl-tile-rating')).toBeNull();
      expect(container.querySelector('.fl-tile-caption')).toBeNull();
      expect(container.querySelector('[data-layout="browse"]')).not.toBeNull();
    });

    it('always shows ratings and rejects in Work, at rest', () => {
      const { container, unmount } = render(AssetTile, {
        asset: asset({ rating: 2 }),
        width: 200,
        height: 157,
        layout: 'work',
        captionHeight: 24,
      });
      expect(container.querySelector('.fl-tile-rating')).not.toBeNull();
      unmount();
      render(AssetTile, { asset: asset({ rating: -1 }), width: 200, height: 157, layout: 'work', captionHeight: 24 });
      expect(screen.getByLabelText('frameleaf_library_rating_rejected')).toBeTruthy();
    });

    it('captions Work tiles with the capture time and hides the file name until asked', async () => {
      const props = {
        asset: asset({ originalFileName: 'IMG_0042.HEIC' }),
        width: 200,
        height: 157,
        layout: 'work' as const,
        captionHeight: 24,
      };
      const { container, rerender } = render(AssetTile, props);
      const caption = () => container.querySelector('.fl-tile-caption')!;
      expect(caption().querySelector('time')?.textContent).toMatch(/10:00/);
      expect(caption().textContent).not.toContain('IMG_0042');
      // The name still shows on hover (the button's tooltip) while the captions hide it.
      expect(screen.getByRole('button', { name: 'A photo' }).getAttribute('title')).toBe('IMG_0042.HEIC');
      // The photo leaves the caption row free under it.
      expect((screen.getByRole('button', { name: 'A photo' }) as HTMLElement).style.height).toBe('133px');

      await rerender({ ...props, showFileName: true });
      expect(caption().querySelector('span')?.textContent).toBe('IMG_0042');
      expect(screen.getByRole('button', { name: 'A photo' }).getAttribute('title')).toBeNull();
    });
  });

  it('opens on a plain click, selects while a selection is in progress, and selects on shift-click', async () => {
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    const { rerender } = render(AssetTile, { asset: asset(), width: 200, height: 133, onOpen, onToggleSelect });
    const open = screen.getByRole('button', { name: 'A photo' });

    await fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onToggleSelect).not.toHaveBeenCalled();

    await fireEvent.click(open, { shiftKey: true });
    expect(onToggleSelect).toHaveBeenCalledOnce();

    await rerender({ selecting: true });
    await fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onToggleSelect).toHaveBeenCalledTimes(2);
  });

  describe('while a durable bulk job works on the item', () => {
    afterEach(() => durableBulkTracker.reset());

    it('shows a loader in the corner and says so in the tile’s name', () => {
      durableBulkTracker.track('delete', 'job-1', ['asset-1']);

      tile();

      expect(screen.getByTestId('frameleaf-tile-job-pending')).toBeTruthy();
      expect(screen.getByTestId('frameleaf-asset-tile').getAttribute('aria-busy')).toBe('true');
      expect(screen.getByRole('button', { name: 'A photo, frameleaf_bulk_tile_processing' })).toBeTruthy();
    });

    it('swaps the loader for a failure mark when the job could not change the item', async () => {
      durableBulkTracker.track('delete', 'job-1', ['asset-1']);
      const { container } = tile();

      durableBulkTracker.apply('job-1', {
        status: MediaOperationStatus.Completed,
        processedUnits: '1',
        bulkItems: [
          {
            id: 'asset-1',
            status: MediaOperationItemStatus.Failed,
            reasonKey: 'frameleaf_bulk_reason_failed',
            message: null,
          },
        ],
        bulkRetryPending: [],
        bulk: { retried: 1 },
      } as never);
      await tick();

      expect(container.querySelector('[data-testid="frameleaf-tile-job-pending"]')).toBeNull();
      expect(screen.getByTestId('frameleaf-tile-job-failed')).toBeTruthy();
      expect(screen.getByTestId('frameleaf-asset-tile').getAttribute('aria-busy')).toBeNull();
    });

    it('shows nothing for an item no job is working on', () => {
      const { container } = tile();

      expect(container.querySelector('.fl-tile-job')).toBeNull();
    });
  });

  it('selects from the checkbox without opening the item', async () => {
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    render(AssetTile, { asset: asset(), width: 200, height: 133, onOpen, onToggleSelect });
    await fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggleSelect).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('AssetGrid', () => {
  const results = (count: number) => Array.from({ length: count }, (_, index) => asset({ id: `asset-${index}` }));
  const cells = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.fl-grid-cell')];
  const px = (value: string) => Number(value.replace('px', ''));

  // The grid lays out once it has measured its width (`bind:clientWidth`, through a ResizeObserver).
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!;
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')!;
  beforeEach(() => {
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 1000 },
      clientHeight: { configurable: true, get: () => 800 },
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          queueMicrotask(() =>
            this.callback(
              [{ target, contentRect: target.getBoundingClientRect() } as unknown as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            ),
          );
        }
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    Object.defineProperties(HTMLElement.prototype, { clientWidth, clientHeight });
    vi.unstubAllGlobals();
  });

  const renderGrid = (layout: 'browse' | 'work' | 'timeline', count = 12) => {
    const session = new LibrarySessionStore({ userId: 'user-1', pageSize: 10 });
    const view = render(AssetGrid, { assets: results(count), session, layout });
    return { ...view, session };
  };

  it('draws Browse as square cells with 2px gutters and no captions', async () => {
    const { container } = renderGrid('browse');
    await waitFor(() => expect(cells(container).length).toBeGreaterThan(0));
    const [first, second] = cells(container);
    expect(first.style.width).toBe(first.style.height);
    expect(px(second.style.insetInlineStart) - px(first.style.width)).toBe(2);
    expect(container.querySelector('.fl-tile-caption')).toBeNull();
    expect(container.querySelector('[data-layout="browse"]')).not.toBeNull();
  });

  it('mounts only the rows near the viewport, not every result', async () => {
    const { container } = renderGrid('browse', 5000);
    await waitFor(() => expect(cells(container).length).toBeGreaterThan(0));
    // 6 columns of ~165px square cells: 800px is about 5 rows, plus 3 rows of overscan.
    expect(cells(container).length).toBeLessThanOrEqual(6 * 9);
  });

  it('zooms with + and −, but not while a viewer is open or on a public page', async () => {
    const { libraryGridPreferences } = await import('$lib/frameleaf/library-grid-preferences.svelte');
    const { assetViewerManager } = await import('$lib/managers/asset-viewer-manager.svelte');
    libraryGridPreferences.thumbnailSize = 200;
    const { unmount } = renderGrid('browse');
    await fireEvent.keyDown(document.body, { key: '+' });
    expect(libraryGridPreferences.thumbnailSize).toBe(230);

    const viewing = vi.spyOn(assetViewerManager, 'isViewing', 'get').mockReturnValue(true);
    await fireEvent.keyDown(document.body, { key: '+' });
    expect(libraryGridPreferences.thumbnailSize).toBe(230);
    viewing.mockRestore();
    unmount();

    const session = new LibrarySessionStore({ userId: 'user-1', pageSize: 10 });
    const { container } = render(AssetGrid, { assets: results(3), session, layout: 'work', publicView: true });
    await fireEvent.keyDown(document.body, { key: '+' });
    expect(libraryGridPreferences.thumbnailSize).toBe(230);
    // A public page keeps the plain Browse grid.
    expect(container.querySelector('[data-testid="frameleaf-asset-grid"]')).toHaveAttribute('data-layout', 'browse');
    libraryGridPreferences.thumbnailSize = 200;
  });

  it('draws Work as 3:2 cells with a caption row under each', async () => {
    const { container } = renderGrid('work');
    await waitFor(() => expect(cells(container).length).toBeGreaterThan(0));
    const [first] = cells(container);
    const width = px(first.style.width);
    expect(px(first.style.height)).toBe(Math.round(width / 1.5) + 24);
    expect(container.querySelectorAll('.fl-tile-caption')).toHaveLength(12);
  });
});

describe('LibraryDayGroup', () => {
  const day = (ids: string[]) => {
    const viewerAssets = ids.map((id) => ({
      id,
      asset: asset({ id }),
      position: { top: 0, left: 0, width: 100, height: 66 },
    }));
    return {
      day: 22,
      groupTitle: 'Tue, Sep 22',
      start: 0,
      top: 0,
      width: 600,
      height: 66,
      viewerAssets,
      activeViewerAssets: viewerAssets,
      timelineMonth: { yearMonth: { year: 2026, month: 9 } },
    } as never;
  };

  it('selects the whole day from the sticky header and reports a partial selection', async () => {
    const onSelectGroup = vi.fn();
    const { rerender, container } = render(LibraryDayGroup, {
      timelineDay: day(['a', 'b', 'c']),
      selection: [],
      selecting: false,
      onSelectGroup,
    });
    const selectAll = () =>
      screen.getByRole('checkbox', { name: 'frameleaf_library_select_all_in_group' }) as HTMLInputElement;
    const checkbox = selectAll();
    expect(checkbox.checked).toBe(false);
    expect(checkbox.indeterminate).toBe(false);

    await fireEvent.click(checkbox);
    expect(onSelectGroup).toHaveBeenCalledWith(['a', 'b', 'c'], true);

    await rerender({ selection: ['a'], selecting: true });
    expect(selectAll().indeterminate).toBe(true);

    await rerender({ selection: ['a', 'b', 'c'], selecting: true });
    expect(selectAll().checked).toBe(true);
    expect(container.querySelectorAll('[data-testid="frameleaf-asset-tile"]')).toHaveLength(3);
  });

  it('titles the day with the full date, as the prototype does', () => {
    render(LibraryDayGroup, { timelineDay: day(['a']), selection: [], selecting: false });
    // Prototype `explore-timeline.mjs` `timelineGroups`: weekday, month, day and year in full.
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Tuesday, September 22, 2026');
    expect(screen.getByRole('region', { name: 'Tuesday, September 22, 2026' })).toBeTruthy();
    expect(screen.queryByText('Tue, Sep 22')).toBeNull();
  });

  it('hides the day header for Browse', () => {
    render(LibraryDayGroup, { timelineDay: day(['a']), selection: [], selecting: false, showHeader: false });
    expect(screen.queryByRole('checkbox', { name: 'frameleaf_library_select_all_in_group' })).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByRole('region', { name: 'Tuesday, September 22, 2026' })).toBeTruthy();
  });

  it('shows every group checkbox while a selection is in progress', async () => {
    const { container, rerender } = render(LibraryDayGroup, {
      timelineDay: day(['a']),
      selection: [],
      selecting: false,
    });
    const select = () => container.querySelector('.fl-group-select')!;
    expect(select().classList.contains('is-shown')).toBe(false);
    // Nothing in this day is selected, but another day's item is: the checkbox shows regardless.
    await rerender({ selection: ['elsewhere'], selecting: true });
    expect(select().classList.contains('is-shown')).toBe(true);
  });
});

describe('ResultsToolbar', () => {
  let session: LibrarySessionStore;

  beforeEach(() => {
    session = new LibrarySessionStore({ storage: null });
  });

  it('draws no chips and no badge while nothing is filtered', () => {
    render(ResultsToolbar, { session });
    expect(screen.queryByTestId('frameleaf-filter-chips')).toBeNull();
    expect(screen.getByRole('button', { name: /filter/ })).toBeTruthy();
  });

  it('badges the active filter count and draws one removable chip per field', async () => {
    session.setQuery({
      ...emptyDiscoveryQuery(),
      filter: { city: { eq: 'Halifax' }, personIds: { any: ['p1', 'p2'] } },
    });
    render(ResultsToolbar, { session });
    expect(screen.getByTestId('frameleaf-results-toolbar').textContent).toContain('frameleaf_library_filters_active');
    const chips = screen.getByTestId('frameleaf-filter-chips');
    expect(chips.textContent).toContain('city: Halifax');
    expect(chips.textContent).toContain('people (2)');

    await fireEvent.click(screen.getAllByRole('button', { name: 'frameleaf_library_remove_filter' })[0]);
    expect(session.filterCount).toBe(1);
  });

  it('deep-links the filter panel into the chosen section', async () => {
    const onOpenFilterPanel = vi.fn();
    render(ResultsToolbar, { session, onOpenFilterPanel });
    await fireEvent.click(screen.getByRole('button', { name: /filter/ }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'places' }));
    expect(onOpenFilterPanel).toHaveBeenCalledWith('places');
    expect(session.filterSection).toBe('places');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('switches layout without touching anything else in the session', async () => {
    session.select('asset-1');
    session.open('asset-2', 12);
    render(ResultsToolbar, { session });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_library_layout_timeline' }));
    expect(session.layout).toBe('timeline');
    expect(session.selection).toEqual(['asset-1']);
    expect(session.openAssetId).toBe('asset-2');
    expect(session.playbackPosition).toBe(12);
  });
});

describe('ShowMore', () => {
  it('raises the cumulative page and reports the running total', async () => {
    const session = new LibrarySessionStore({ storage: null, pageSize: 10 });
    session.applyTotal(30, session.revision);
    const onShowMore = vi.fn();
    render(ShowMore, { session, onShowMore });

    expect(screen.getByRole('status').textContent).toContain('frameleaf_library_showing_of');
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_library_show_more' }));
    expect(onShowMore).toHaveBeenCalledWith(2);
    expect(session.paging.shown).toBe(20);
  });

  it('drops the button once everything is shown', () => {
    const session = new LibrarySessionStore({ storage: null, pageSize: 10 });
    session.applyTotal(5, session.revision);
    render(ShowMore, { session });
    expect(screen.getByRole('status').textContent).toContain('frameleaf_library_showing_all');
    expect(screen.queryByRole('button', { name: 'frameleaf_library_show_more' })).toBeNull();
  });
});

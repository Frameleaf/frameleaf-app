import { AssetVisibility, type TimeBucketAssetResponseDto } from '@immich/sdk';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LibraryTimeline from '$lib/components/frameleaf/LibraryTimeline.svelte';
import { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import { timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';

vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn(), beforeNavigate: vi.fn(), goto: vi.fn() }));
const routerStarted = vi.hoisted(() => ({ value: false }));
vi.mock('$lib/utils/router-started', () => ({ hasRouterStarted: () => routerStarted.value }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { nsfwHiding: true } },
}));

/**
 * A year group whose older month is not loaded when the checkbox is clicked: the load is held open
 * so the test can act while it is pending.
 */
const inMonth = (month: string, count: number): TimelineAsset[] =>
  timelineAssetFactory.buildList(count).map((asset) => {
    const at = fromISODateTimeUTCToObject(`${month}-10T12:00:00.000Z`);
    return { ...asset, fileCreatedAt: at, localDateTime: at };
  });

describe('LibraryTimeline "all" grouping', () => {
  const march = inMonth('2024-03', 40);
  const february = inMonth('2024-02', 3);
  let releaseFebruary: () => void;
  let manager: TimelineManager;
  let session: LibrarySessionStore;

  beforeEach(async () => {
    vi.resetAllMocks();
    let respond!: (value: TimeBucketAssetResponseDto) => void;
    const pendingFebruary = new Promise<TimeBucketAssetResponseDto>((resolve) => (respond = resolve));
    releaseFebruary = () => respond(toResponseDto(...february));
    sdkMock.getTimeBuckets.mockResolvedValue([
      { timeBucket: '2024-03-01', count: march.length },
      { timeBucket: '2024-02-01', count: february.length },
    ]);
    sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) =>
      timeBucket.startsWith('2024-03') ? Promise.resolve(toResponseDto(...march)) : pendingFebruary,
    );
    manager = new TimelineManager();
    await manager.updateViewport({ width: 1000, height: 200 });
    await tick();
    session = new LibrarySessionStore({ userId: 'user-1', pageSize: 10 });
  });

  // Years and Months are curated cards (September 24); "all" is the group whose checkbox reaches
  // months that are not loaded yet.
  const renderYears = () =>
    render(LibraryTimeline, {
      timelineManager: manager,
      session,
      grouping: 'all',
      onGroupingChange: vi.fn(),
    });

  const yearCheckbox = () =>
    screen.getByRole('checkbox', { name: 'frameleaf_library_select_all_in_group' }) as HTMLInputElement;
  const scroller = (container: HTMLElement) => container.querySelector('.fl-timeline-scroll')!;

  it('starts with the older month of the year not loaded', () => {
    expect(manager.months.map((month) => month.isLoaded)).toEqual([true, false]);
  });

  it('is busy only while the newest group request loads: check, then uncheck mid-load', async () => {
    const { container } = renderYears();
    await tick();
    await fireEvent.click(yearCheckbox());
    await waitFor(() => expect(scroller(container).getAttribute('aria-busy')).toBe('true'));
    expect(screen.getByText('loading')).toBeTruthy();

    // Unchecking supersedes the pending load: not busy any more, although the load still runs.
    await fireEvent.click(yearCheckbox());
    await waitFor(() => expect(scroller(container).getAttribute('aria-busy')).toBe('false'));

    releaseFebruary();
    await waitFor(() => expect(manager.months[1].isLoaded).toBe(true));
    await tick();
    expect(scroller(container).getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByText('loading')).toBeNull();
    // The superseded load selects nothing.
    expect(session.selection).toEqual([]);
    expect(yearCheckbox().checked).toBe(false);
  });

  it('selects the whole year once the pending month loads', async () => {
    renderYears();
    await tick();
    await fireEvent.click(yearCheckbox());
    releaseFebruary();
    await waitFor(() => expect(session.selection).toHaveLength(march.length + february.length));
    expect(yearCheckbox().checked).toBe(true);
  });

  it('puts the checkbox back and says so when the view changes during the load', async () => {
    const { container } = renderYears();
    await tick();
    await fireEvent.click(yearCheckbox());
    expect(yearCheckbox().checked).toBe(true);
    session.patchView({ sort: 'rating' });
    releaseFebruary();
    await waitFor(() =>
      expect(container.ownerDocument.querySelector('[data-testid="frameleaf-grouping-status"]')?.textContent).toBe(
        'frameleaf_library_group_select_failed',
      ),
    );
    expect(session.selection).toEqual([]);
    expect(yearCheckbox().checked).toBe(false);
    expect(scroller(container).getAttribute('aria-busy')).toBe('false');
  });
});

// FL-34 (ported from PR131 8c6bf6bb31): the session privacy gate can mount a routed timeline after
// the router's first navigation, when no `afterNavigate` call will come for it
describe('LibraryTimeline mounted after the first navigation', () => {
  let manager: TimelineManager;
  let session: LibrarySessionStore;

  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getTimeBuckets.mockResolvedValue([]);
    manager = new TimelineManager();
    session = new LibrarySessionStore({ userId: 'user-1', pageSize: 10 });
    session.dispatch({ type: 'anchor', id: 'asset-anchor' });
  });

  afterEach(() => {
    routerStarted.value = false;
  });

  const renderRouted = () =>
    render(LibraryTimeline, {
      timelineManager: manager,
      session,
      grouping: 'days',
      onGroupingChange: vi.fn(),
      enableRouting: true,
    });

  it('places the grid on mount once the router has started', async () => {
    routerStarted.value = true;
    const find = vi.spyOn(manager, 'findTimelineMonthForAsset').mockResolvedValue(undefined);

    renderRouted();

    await waitFor(() => expect(find).toHaveBeenCalledWith({ id: 'asset-anchor' }));
  });

  it('leaves the first placement to the router while it has not started', async () => {
    const find = vi.spyOn(manager, 'findTimelineMonthForAsset').mockResolvedValue(undefined);

    renderRouted();
    await tick();

    expect(find).not.toHaveBeenCalled();
  });
});

// FL-33: the layout control scrolls with the results, so reaching it (a click scrolls it into view)
// can leave the session's anchored asset off screen. The switch must come back to that asset, not
// hold whatever happened to be at the top (the e2e deep link regression).
describe('LibraryTimeline layout switch', () => {
  const march = inMonth('2024-03', 40);
  const february = inMonth('2024-02', 40);
  let manager: TimelineManager;
  let session: LibrarySessionStore;

  beforeEach(async () => {
    vi.resetAllMocks();
    sdkMock.getTimeBuckets.mockResolvedValue([
      { timeBucket: '2024-03-01', count: march.length },
      { timeBucket: '2024-02-01', count: february.length },
    ]);
    sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) =>
      Promise.resolve(toResponseDto(...(timeBucket.startsWith('2024-03') ? march : february))),
    );
    manager = new TimelineManager();
    await manager.updateViewport({ width: 1000, height: 400 });
    await manager.loadTimelineMonth({ year: 2024, month: 2 }, { cancelable: false });
    await tick();
    session = new LibrarySessionStore({ userId: 'user-1', pageSize: 10 });
  });

  const frames = async (count: number) => {
    for (let index = 0; index < count; index++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };

  it('comes back to the session’s anchor when it is off screen, not to the top of the view', async () => {
    const anchor = february.at(-1)!;
    render(LibraryTimeline, { timelineManager: manager, session, grouping: 'days' });
    await tick();
    session.dispatch({ type: 'anchor', id: anchor.id });
    const scrollTo = vi.spyOn(manager, 'scrollTo');
    const anchorTop = () => manager.getTimelineMonthByAssetId(anchor.id)!.findAssetAbsolutePosition(anchor.id)!.top;

    session.setLayout('work');
    await tick();
    await frames(4);

    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    const landed = scrollTo.mock.calls.at(-1)![0];
    // the anchor is in the window the scroll lands on
    expect(landed).toBeGreaterThan(anchorTop() - 400);
    expect(landed).toBeLessThanOrEqual(anchorTop() + 1);
  });
});

// FL-33: Thumbnail size zoom in Browse and Work (template `App.jsx` "#12 grid zoom").
describe('LibraryTimeline grid zoom', () => {
  let manager: TimelineManager;
  let session: LibrarySessionStore;

  beforeEach(async () => {
    vi.resetAllMocks();
    sdkMock.getTimeBuckets.mockResolvedValue([]);
    manager = new TimelineManager();
    await manager.updateViewport({ width: 1000, height: 400 });
    session = new LibrarySessionStore({ userId: 'user-1', pageSize: 10 });
  });

  const renderLayout = (tileLayout: 'browse' | 'work' | 'timeline', thumbnailSize = 200) => {
    const onThumbnailSizeChange = vi.fn();
    render(LibraryTimeline, {
      timelineManager: manager,
      session,
      tileLayout,
      thumbnailSize,
      showDayHeaders: tileLayout === 'timeline',
      onThumbnailSizeChange,
    });
    return onThumbnailSizeChange;
  };
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key, ...init });

  it('steps the Thumbnail size with + and − in Browse and Work', async () => {
    const browse = renderLayout('browse');
    await press('+');
    expect(browse).toHaveBeenLastCalledWith(230);
    await press('-');
    expect(browse).toHaveBeenLastCalledWith(170);
  });

  it('never takes ⌘/Ctrl + or −, which stay with browser zoom', async () => {
    const work = renderLayout('work');
    await press('+', { ctrlKey: true });
    await press('-', { metaKey: true });
    expect(work).not.toHaveBeenCalled();
  });

  it('holds at the size limits', async () => {
    const atMax = renderLayout('browse', 290);
    await press('+');
    expect(atMax).not.toHaveBeenCalled();
  });

  it('leaves + and − alone in the Timeline, and while an item is open', async () => {
    const timeline = renderLayout('timeline');
    await press('+');
    expect(timeline).not.toHaveBeenCalled();
    cleanup();
    const browse = renderLayout('browse');
    session.open('asset-1');
    await press('+');
    expect(browse).not.toHaveBeenCalled();
  });

  it('scales the Timeline row height with the Thumbnail size, keeping the default at the default size', async () => {
    const { rerender } = render(LibraryTimeline, { timelineManager: manager, session, thumbnailSize: 200 });
    await tick();
    const base = manager.rowHeight;
    await rerender({ thumbnailSize: 290 });
    expect(manager.rowHeight).toBe(Math.round(base * (290 / 200)));
    await rerender({ thumbnailSize: 200 });
    expect(manager.rowHeight).toBe(base);
  });

  it('leaves + and − alone while any viewer is open', async () => {
    const { assetViewerManager } = await import('$lib/managers/asset-viewer-manager.svelte');
    const viewing = vi.spyOn(assetViewerManager, 'isViewing', 'get').mockReturnValue(true);
    const browse = renderLayout('browse');
    await press('+');
    expect(browse).not.toHaveBeenCalled();
    viewing.mockRestore();
  });

  it('lays Browse out as a square cell grid', async () => {
    renderLayout('browse');
    await tick();
    expect(manager.cells).toMatchObject({ aspect: 1, gap: 2 });
  });
});

// FL-33 / FL-50: curated Years and Months cards from GET /timeline/highlights.
describe('LibraryTimeline curated Years and Months', () => {
  let manager: TimelineManager;
  let session: LibrarySessionStore;

  beforeEach(async () => {
    vi.resetAllMocks();
    sdkMock.getTimeBuckets.mockResolvedValue([{ timeBucket: '2024-03-01', count: 2 }]);
    sdkMock.getTimeBucket.mockResolvedValue(toResponseDto(...inMonth('2024-03', 2)));
    sdkMock.getTimelineHighlights.mockImplementation(({ grouping }) =>
      Promise.resolve(
        grouping === 'year'
          ? [{ timeBucket: '2024-01-01', count: 2, keyAssetId: 'key', highlightAssetIds: [], places: ['Banff'] }]
          : [
              {
                timeBucket: '2024-03-01',
                count: 2,
                keyAssetId: 'key',
                highlightAssetIds: ['h1'],
                places: ['Banff', 'Jasper'],
              },
            ],
      ),
    );
    manager = new TimelineManager();
    await manager.updateOptions({ visibility: AssetVisibility.Timeline });
    await manager.updateViewport({ width: 1000, height: 400 });
    session = new LibrarySessionStore({ userId: 'user-1', pageSize: 10 });
  });

  const renderGrouping = (grouping: 'years' | 'months' | 'days') => {
    const onGroupingChange = vi.fn();
    const view = render(LibraryTimeline, { timelineManager: manager, session, grouping, onGroupingChange });
    return { ...view, onGroupingChange };
  };

  it('shows a card per year with the same query as the time buckets, and opens Months', async () => {
    const { onGroupingChange } = renderGrouping('years');
    const card = await screen.findByRole('button', { name: 'frameleaf_timeline_card_show_months' });
    expect(sdkMock.getTimelineHighlights).toHaveBeenCalledWith(
      expect.objectContaining({ grouping: 'year', visibility: AssetVisibility.Timeline }),
    );
    expect(card.textContent).toContain('2024');
    expect(screen.queryByTestId('frameleaf-day-group')).toBeNull();
    await fireEvent.click(card);
    expect(onGroupingChange).toHaveBeenCalledWith('months');
  });

  it('adds a highlight strip to month cards and opens Days', async () => {
    const { container, onGroupingChange } = renderGrouping('months');
    const card = await screen.findByRole('button', { name: 'frameleaf_timeline_card_show_days' });
    expect(container.querySelectorAll(':scope .fl-tl-card-strip img')).toHaveLength(1);
    await fireEvent.click(card);
    expect(onGroupingChange).toHaveBeenCalledWith('days');
  });

  it('keeps the tile flow for Days', async () => {
    renderGrouping('days');
    await tick();
    expect(screen.queryByTestId('frameleaf-timeline-cards')).toBeNull();
    expect(sdkMock.getTimelineHighlights).not.toHaveBeenCalled();
  });

  it('keeps the scrubber beside the cards and jumps to a month card, or its year card', async () => {
    const { container } = renderGrouping('months');
    await screen.findByRole('button', { name: 'frameleaf_timeline_card_show_days' });
    const slider = await screen.findByRole('slider');
    const scroller = container.querySelector<HTMLElement>('.fl-tl-cards-scroll')!;
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy as never;
    await fireEvent.keyDown(slider, { key: 'Home' });
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  it('refetches the cards after the library changes, once the changes settle', async () => {
    vi.useFakeTimers();
    try {
      renderGrouping('years');
      await vi.waitFor(() => expect(sdkMock.getTimelineHighlights).toHaveBeenCalledTimes(1));
      const { eventManager } = await import('$lib/managers/event-manager.svelte');
      eventManager.emit('AssetsDelete', ['a']);
      eventManager.emit('AssetsDelete', ['b']);
      await vi.advanceTimersByTimeAsync(1600);
      expect(sdkMock.getTimelineHighlights).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when the cards cannot load', async () => {
    sdkMock.getTimelineHighlights.mockRejectedValue(new Error('offline'));
    renderGrouping('years');
    expect(await screen.findByText('frameleaf_timeline_cards_failed')).toBeTruthy();
  });
});

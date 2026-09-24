import type { TimeBucketAssetResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
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

describe('LibraryTimeline year grouping', () => {
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

  const renderYears = () =>
    render(LibraryTimeline, {
      timelineManager: manager,
      session,
      grouping: 'years',
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

import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { captureLibraryAnchor, restoreLibraryAnchor } from '$lib/frameleaf/library-layout';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import { timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { nsfwHiding: true } },
}));

/** Ported from PR #133's `library-layout.svelte.spec.ts` (FL-33), for the production timeline manager. */
const inMonth = (month: string, count: number): TimelineAsset[] =>
  timelineAssetFactory.buildList(count).map((asset) => {
    const at = fromISODateTimeUTCToObject(`${month}-10T12:00:00.000Z`);
    return { ...asset, ratio: 1.5, fileCreatedAt: at, localDateTime: at };
  });

describe('library layout anchoring', () => {
  const march = inMonth('2024-03', 30);
  const february = inMonth('2024-02', 30);
  let manager: TimelineManager;
  let scrollTop: number;
  let top: (id: string) => number;

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
    scrollTop = 0;
    manager.scrollableElement = {
      get scrollTop() {
        return scrollTop;
      },
      scrollTo({ top }: { top: number }) {
        scrollTop = top;
      },
      scrollBy(_x: number, y: number) {
        scrollTop += y;
      },
    } as unknown as HTMLElement;
    await manager.updateViewport({ width: 900, height: 400 });
    await manager.loadTimelineMonth({ year: 2024, month: 3 }, { cancelable: false });
    await manager.loadTimelineMonth({ year: 2024, month: 2 }, { cancelable: false });
    await tick();
    top = (id: string) => manager.getTimelineMonthByAssetId(id)!.findAssetAbsolutePosition(id)!.top;
  });

  afterEach(() => {
    manager.destroy();
  });

  const scrollToShow = (id: string, offset: number) => {
    manager.scrollTo(top(id) - offset);
    manager.updateSlidingWindow();
  };

  it('keeps the anchored asset at the same height on screen across layout geometry changes', () => {
    const target = february[4];
    scrollToShow(target.id, 60);
    const requests = sdkMock.getTimeBucket.mock.calls.length;

    for (const rowHeight of [100, 235, 160]) {
      const anchor = captureLibraryAnchor(manager, target.id);
      expect(anchor).toEqual({ assetId: target.id, offset: expect.closeTo(60, 0) });

      manager.setLayoutOptions({ rowHeight, headerHeight: rowHeight > 150 ? 48 : 32, gap: 8, fillRowWidth: true });
      // the new geometry alone moves the asset on screen
      expect(Math.abs(top(target.id) - scrollTop - 60)).toBeGreaterThan(1);

      expect(restoreLibraryAnchor(manager, anchor)).toBe(true);
      expect(top(target.id) - scrollTop).toBeCloseTo(60, 0);
    }
    // restoring reads the loaded months only
    expect(sdkMock.getTimeBucket).toHaveBeenCalledTimes(requests);
  });

  it('never swaps the session’s anchor for another asset when the anchor is off screen', () => {
    // the layout control scrolls with the results: reaching it can leave the anchor off screen, and
    // the anchor, not whatever is at the top, must stay the asset the switch comes back to
    scrollToShow(february[0].id, 0);

    expect(captureLibraryAnchor(manager, march[0].id)).toBeUndefined();
  });

  it('anchors the first asset on screen when the session has no anchor', () => {
    scrollToShow(february[0].id, 0);

    const anchor = captureLibraryAnchor(manager);

    expect(anchor?.assetId).toBe(february[0].id);
    expect(anchor?.offset).toBeCloseTo(0, 0);
  });

  it('never fetches or resurrects an asset that left the view', () => {
    const target = february[4];
    scrollToShow(target.id, 20);
    const anchor = captureLibraryAnchor(manager, target.id);
    manager.removeAssets([target.id]);
    const scroll = vi.spyOn(manager, 'scrollTo');

    expect(restoreLibraryAnchor(manager, anchor)).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
  });
});

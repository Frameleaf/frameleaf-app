import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { AssetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import { timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';
import { captureLibraryAnchor, contactSheetPositions, restoreLibraryAnchor } from './library-layout';

it('uses equal contact-sheet cells with a bounded row width', () => {
  const boxes = contactSheetPositions(7, { rowWidth: 800, rowHeight: 160, spacing: 2, heightTolerance: 0.5 });
  expect(boxes).toHaveLength(7);
  expect(boxes[0].width).toBeCloseTo(boxes[6].width);
  expect(boxes[2].left + boxes[2].width).toBeCloseTo(800);
  expect(boxes[3].top).toBeGreaterThan(boxes[0].top);
  expect(boxes.every((box) => box.left + box.width <= 800)).toBe(true);
});

it('preserves actual paged months, selection and an asset-relative anchor across repeated layouts', async () => {
  const assets = [1, 2].map((month) =>
    timelineAssetFactory.build({
      ratio: 1.5,
      fileCreatedAt: fromISODateTimeUTCToObject(`2024-0${month}-01T00:00:00Z`),
      localDateTime: fromISODateTimeUTCToObject(`2024-0${month}-01T00:00:00Z`),
    }),
  );
  sdkMock.getTimeBuckets.mockResolvedValue([
    { count: 1, timeBucket: '2024-02-01' },
    { count: 1, timeBucket: '2024-01-01' },
  ]);
  sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) =>
    Promise.resolve(toResponseDto(assets[timeBucket.startsWith('2024-01') ? 0 : 1])),
  );
  const manager = new TimelineManager();
  const selection = new AssetMultiSelectManager();
  await manager.updateOptions({ albumId: 'album-a' });
  await manager.updateViewport({ width: 900, height: 500 });
  await manager.loadTimelineMonth({ year: 2024, month: 1 }, { cancelable: false });
  await manager.loadTimelineMonth({ year: 2024, month: 2 }, { cancelable: false });
  await tick();
  const months = [...manager.months];
  const requests = sdkMock.getTimeBucket.mock.calls.length;
  const buckets = sdkMock.getTimeBuckets.mock.calls.length;
  selection.selectAsset(assets[0]);
  const scroll = {
    scrollTop: 0,
    scrollTo({ top }: { top: number }) {
      scroll.scrollTop = top;
    },
  } as HTMLElement;
  manager.scrollableElement = scroll;
  for (const layout of ['timeline', 'browse', 'work', 'timeline'] as const) {
    const anchor = captureLibraryAnchor(manager);
    manager.libraryLayout = layout;
    manager.setLayoutOptions({ rowHeight: layout === 'timeline' ? 235 : 130, headerHeight: 48, gap: 8 });
    manager.refreshLayout();
    restoreLibraryAnchor(manager, anchor);
    expect(manager.months).toEqual(months);
    expect(selection.assets.map(({ id }) => id)).toEqual([assets[0].id]);
    for (const month of manager.months) {
      expect(month.timelineDays[0].width).toBe(900);
      if (layout === 'timeline') {
        expect(month.timelineDays[0].viewerAssets[0].position?.width).toBeCloseTo(900);
      }
    }
  }
  expect(sdkMock.getTimeBucket).toHaveBeenCalledTimes(requests);
  expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(buckets);
  const anchor = captureLibraryAnchor(manager);
  manager.removeAssets(assets.map(({ id }) => id));
  const restore = vi.spyOn(manager, 'scrollTo');
  restoreLibraryAnchor(manager, anchor);
  expect(restore).not.toHaveBeenCalled();
  selection.destroy();
  manager.destroy();
});

it('applies every geometry option together', () => {
  const manager = new TimelineManager();
  manager.setLayoutOptions({ headerHeight: 32, rowHeight: 100, gap: 5 });
  expect([manager.headerHeight, manager.rowHeight, manager.gap]).toEqual([32, 100, 5]);
  manager.destroy();
});

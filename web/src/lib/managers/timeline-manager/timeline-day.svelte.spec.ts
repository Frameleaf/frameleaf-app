import { TimeBucketDateType } from '@frameleaf/sdk';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { TimelineDay } from './timeline-day.svelte';
import type { TimelineMonth } from './timeline-month.svelte';
import { ViewerAsset } from './viewer-asset.svelte';

const setup = () => {
  const manager = { visibleWindow: { top: 0, bottom: 500 }, headerHeight: 0 };
  const month = { top: 0, timelineManager: manager } as unknown as TimelineMonth;
  const day = new TimelineDay(month, 0, 1, 'day', TimeBucketDateType.Taken);
  day.viewerAssets = [0, 200, 1800].map((top) => {
    const viewer = new ViewerAsset(timelineAssetFactory.build());
    viewer.position = { top, height: 100, left: 0, width: 100 };
    return viewer;
  });
  return { day, manager };
};

describe('timeline day visibility', () => {
  it('keeps the visible array when scrolling leaves the same tiles active', () => {
    const { day, manager } = setup();
    day.updateAssetBoundaries();
    const active = day.activeViewerAssets;
    expect(active).toEqual(day.viewerAssets.slice(0, 2));
    manager.visibleWindow = { top: 1, bottom: 501 };
    day.updateAssetBoundaries();
    expect(day.activeViewerAssets).toBe(active);
    expect(day.isInOrNearViewport).toBe(true);
  });

  it('replaces the array when a tile changes at the same active index', () => {
    const { day } = setup();
    day.updateAssetBoundaries();
    const active = day.activeViewerAssets;
    const replacement = new ViewerAsset(timelineAssetFactory.build());
    replacement.position = day.viewerAssets[0].position;
    day.viewerAssets[0] = replacement;
    day.updateAssetBoundaries();
    expect(day.activeViewerAssets).not.toBe(active);
    expect(day.activeViewerAssets[0]).toBe(replacement);
  });

  it('updates visible geometry without replacing unchanged tile membership', () => {
    const { day } = setup();
    day.updateAssetBoundaries();
    const active = day.activeViewerAssets;
    day.viewerAssets[0].position = { top: 5, height: 100, left: 0, width: 100 };
    day.updateAssetBoundaries();
    expect(day.activeViewerAssets).toBe(active);
    expect(day.activeViewerAssets[0].position?.top).toBe(5);
  });

  it('replaces membership when the active range expands or an asset is removed', () => {
    const { day, manager } = setup();
    day.updateAssetBoundaries();
    manager.visibleWindow.bottom = 2000;
    day.updateAssetBoundaries();
    expect(day.activeViewerAssets).toEqual(day.viewerAssets);
    day.viewerAssets.splice(1, 1);
    day.updateAssetBoundaries();
    expect(day.activeViewerAssets).toEqual(day.viewerAssets);
  });

  it('reuses the empty active array outside the viewport', () => {
    const { day, manager } = setup();
    manager.visibleWindow = { top: 10_000, bottom: 10_500 };
    day.updateAssetBoundaries();
    const active = day.activeViewerAssets;
    day.updateAssetBoundaries();
    expect(day.activeViewerAssets).toBe(active);
    expect(day.isInOrNearViewport).toBe(false);
  });

  it('clears stale active tiles when layout is absent and then keeps the empty array', () => {
    const { day } = setup();
    day.updateAssetBoundaries();
    day.viewerAssets[0].position = undefined;
    day.updateAssetBoundaries();
    expect(day.activeViewerAssets).toEqual([]);
    const active = day.activeViewerAssets;
    day.updateAssetBoundaries();
    expect(day.activeViewerAssets).toBe(active);
    expect(day.isInOrNearViewport).toBe(false);
  });
});

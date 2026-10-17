import type { TimelineDay } from './timeline-day.svelte';
import { TimelineManager } from './timeline-manager.svelte';
import { TimelineMonth } from './timeline-month.svelte';

const setup = () => {
  const manager = new TimelineManager();
  vi.spyOn(manager, 'loadTimelineMonth').mockResolvedValue(undefined);
  manager.isInitialized = true;
  manager.visibleWindow = { top: 0, bottom: 500 };
  const month = new TimelineMonth(manager, { year: 2026, month: 10 }, 0, true);
  month.isLoaded = true;
  month.height = 500;
  manager.months = [month];
  return { manager, month };
};

afterEach(() => vi.restoreAllMocks());

it('allows the next viewport update after layout throws and preserves the original error', () => {
  const { manager, month } = setup();
  const failure = new Error('synthetic layout failure');
  const update = vi.fn().mockImplementationOnce(() => {
    throw failure;
  });
  month.timelineDays = [{ deferredLayout: false, updateAssetBoundaries: update } as unknown as TimelineDay];
  expect(() => manager.updateViewportProximities()).toThrow(failure);
  manager.updateViewportProximities();
  expect(update).toHaveBeenCalledTimes(2);
});

it('keeps an unchanged viewport intersection and replaces it when its ratios change', () => {
  const { manager, month } = setup();
  manager.updateViewportProximities();
  const intersection = manager.viewportTopMonthIntersection;
  manager.updateViewportProximities();
  expect(manager.viewportTopMonthIntersection).toBe(intersection);
  manager.visibleWindow = { top: 100, bottom: 600 };
  manager.updateViewportProximities();
  expect(manager.viewportTopMonthIntersection).not.toBe(intersection);
  expect(manager.viewportTopMonthIntersection).toMatchObject({
    month,
    viewportTopRatioInMonth: 0.2,
    monthBottomViewportRatio: 0.8,
  });
});

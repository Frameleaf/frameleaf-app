import type { TimelineManager } from '../timeline-manager.svelte';
import type { TimelineMonth } from '../timeline-month.svelte';
import {
  isIntersecting,
  isInOrNearViewport,
  isInViewport,
  updateTimelineMonthViewportProximity,
  ViewportProximity,
} from './intersection-support.svelte';

it.each([
  { region: [900, 1000], expected: true },
  { region: [900, 999], expected: false },
  { region: [1000, 1100], expected: true },
  { region: [1199, 1300], expected: true },
  { region: [1200, 1300], expected: false },
  { region: [900, 1300], expected: true },
  { region: [1100, 1100], expected: true },
  { region: [NaN, NaN], expected: false },
])('retains navigation intersection boundaries for $region', ({ region, expected }) => {
  expect(isIntersecting(region[0], region[1], 1000, 1200)).toBe(expected);
});

it.each([
  { state: ViewportProximity.FarFromViewport, inViewport: false, nearby: false },
  { state: ViewportProximity.NearViewport, inViewport: false, nearby: true },
  { state: ViewportProximity.InViewport, inViewport: true, nearby: true },
])('classifies enum state $state', ({ state, inViewport, nearby }) => {
  expect(isInViewport(state)).toBe(inViewport);
  expect(isInOrNearViewport(state)).toBe(nearby);
});

it.each([
  { top: 0, height: 499, expected: ViewportProximity.FarFromViewport },
  { top: 0, height: 500, expected: ViewportProximity.NearViewport },
  { top: 900, height: 99, expected: ViewportProximity.NearViewport },
  { top: 900, height: 100, expected: ViewportProximity.InViewport },
  { top: 1100, height: 0, expected: ViewportProximity.InViewport },
  { top: 1199, height: 100, expected: ViewportProximity.InViewport },
  { top: 1200, height: 100, expected: ViewportProximity.NearViewport },
  { top: 1699, height: 100, expected: ViewportProximity.NearViewport },
  { top: 1700, height: 100, expected: ViewportProximity.FarFromViewport },
  { top: 900, height: 400, expected: ViewportProximity.InViewport },
])('sets proximity for $top/$height and only releases nearby layout', ({ top, height, expected }) => {
  const clearDeferredLayout = vi.fn();
  const manager = { visibleWindow: { top: 1000, bottom: 1200 }, clearDeferredLayout } as unknown as TimelineManager;
  const month = { top, height, viewportProximity: ViewportProximity.FarFromViewport } as TimelineMonth;
  updateTimelineMonthViewportProximity(manager, month);
  expect(month.viewportProximity).toBe(expected);
  expect(clearDeferredLayout.mock.calls).toEqual(expected === ViewportProximity.FarFromViewport ? [] : [[month]]);
});

it('reads a coherent month and viewport snapshot once before assigning proximity', () => {
  const reads = { top: 0, height: 0, window: 0 };
  const events: string[] = [];
  const manager = {
    get visibleWindow() {
      reads.window++;
      return { top: 1000, bottom: 1200 };
    },
    clearDeferredLayout(month: TimelineMonth) {
      expect(month.viewportProximity).toBe(ViewportProximity.InViewport);
      events.push('clear');
    },
  } as unknown as TimelineManager;
  let state = ViewportProximity.FarFromViewport;
  const month = {
    get top() {
      reads.top++;
      return 1100;
    },
    get height() {
      reads.height++;
      return 100;
    },
    get viewportProximity() {
      return state;
    },
    set viewportProximity(value: ViewportProximity) {
      state = value;
      events.push('assign');
    },
  } as TimelineMonth;
  updateTimelineMonthViewportProximity(manager, month);
  expect(reads).toEqual({ top: 1, height: 1, window: 1 });
  expect(events).toEqual(['assign', 'clear']);
});

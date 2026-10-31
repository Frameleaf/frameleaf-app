import { TUNABLES } from '$lib/utils/tunables';
import type { TimelineManager } from '../timeline-manager.svelte';
import type { TimelineMonth } from '../timeline-month.svelte';

const {
  TIMELINE: { INTERSECTION_EXPAND_TOP, INTERSECTION_EXPAND_BOTTOM },
} = TUNABLES;

export function isIntersecting(regionTop: number, regionBottom: number, otherTop: number, otherBottom: number) {
  return (
    (regionTop >= otherTop && regionTop < otherBottom) ||
    (regionBottom >= otherTop && regionBottom < otherBottom) ||
    (regionTop < otherTop && regionBottom >= otherBottom)
  );
}

export enum ViewportProximity {
  FarFromViewport,
  NearViewport,
  InViewport,
}

export function isInViewport(state: ViewportProximity): boolean {
  return state === ViewportProximity.InViewport;
}

export function isInOrNearViewport(state: ViewportProximity): boolean {
  return state !== ViewportProximity.FarFromViewport;
}

function calculateViewportProximity(regionTop: number, regionBottom: number, windowTop: number, windowBottom: number) {
  if (regionBottom < windowTop - INTERSECTION_EXPAND_TOP || regionTop >= windowBottom + INTERSECTION_EXPAND_BOTTOM) {
    return ViewportProximity.FarFromViewport;
  }

  return regionBottom < windowTop || regionTop >= windowBottom
    ? ViewportProximity.NearViewport
    : ViewportProximity.InViewport;
}

export function updateTimelineMonthViewportProximity(timelineManager: TimelineManager, month: TimelineMonth) {
  const top = month.top;
  const visibleWindow = timelineManager.visibleWindow;
  const proximity = calculateViewportProximity(top, top + month.height, visibleWindow.top, visibleWindow.bottom);

  month.viewportProximity = proximity;
  if (isInOrNearViewport(proximity)) {
    timelineManager.clearDeferredLayout(month);
  }
}

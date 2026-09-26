import { cellGrid } from '$lib/frameleaf/library-grid';
import { getJustifiedLayoutFromAssets } from '$lib/utils/layout-utils';
import { TimelineManager } from '../timeline-manager.svelte';
import type { TimelineMonth } from '../timeline-month.svelte';
import type { UpdateGeometryOptions } from '../types';
import { leaveFlow, requestFlowLayout } from './flow-support.svelte';

export function updateGeometry(timelineManager: TimelineManager, month: TimelineMonth, options: UpdateGeometryOptions) {
  const { invalidateHeight, noDefer = false } = options;
  if (invalidateHeight) {
    month.isHeightActual = false;
  }
  if (!month.isLoaded) {
    const viewportWidth = timelineManager.viewportWidth;
    if (!month.isHeightActual && timelineManager.cells) {
      // A cell grid depends on the count alone, so even a month that is not loaded gets its exact height.
      const grid = cellGrid(month.assetsCount, viewportWidth, timelineManager.cells);
      month.height = month.groupHeaderHeight + grid.height;
      return;
    }
    if (!month.isHeightActual) {
      const unwrappedWidth = (3 / 2) * month.assetsCount * timelineManager.rowHeight * (7 / 10);
      const rows = Math.ceil(unwrappedWidth / viewportWidth);
      // Timeline captions (FL-33) add a caption row under every row of photos.
      const height =
        month.groupHeaderHeight + Math.max(1, rows) * (timelineManager.rowHeight + timelineManager.captionHeight);
      month.height = height;
    }
    return;
  }
  layoutTimelineMonth(timelineManager, month, noDefer);
}

export function layoutTimelineMonth(timelineManager: TimelineManager, month: TimelineMonth, noDefer: boolean = false) {
  if (timelineManager.continuousGroups) {
    // All (and Years when not shown as cards), and the Browse and Work grids: the month is laid out
    // as part of one flow that runs on across months (FL-143).
    requestFlowLayout(timelineManager, month);
    return;
  }
  leaveFlow(month);
  if (timelineManager.grouping !== 'days') {
    layoutGroupedMonth(timelineManager, month);
    return;
  }
  let cumulativeHeight = 0;
  let cumulativeWidth = 0;
  let currentRowHeight = 0;

  let timelineDayRow = 0;
  let timelineDayCol = 0;

  const options = timelineManager.justifiedLayoutOptions;
  for (const timelineDay of month.timelineDays) {
    timelineDay.layout(options, noDefer);

    // Calculate space needed for this item (including gap if not first in row)
    const spaceNeeded = timelineDay.width + (timelineDayCol > 0 ? timelineManager.gap : 0);
    const fitsInCurrentRow = cumulativeWidth + spaceNeeded <= timelineManager.viewportWidth;

    if (fitsInCurrentRow) {
      timelineDay.row = timelineDayRow;
      timelineDay.col = timelineDayCol++;
      timelineDay.start = cumulativeWidth;
      timelineDay.top = cumulativeHeight;
    } else {
      // Move to next row
      cumulativeHeight += currentRowHeight;
      cumulativeWidth = 0;
      timelineDayRow++;
      timelineDayCol = 0;

      // Position at start of new row
      timelineDay.row = timelineDayRow;
      timelineDay.col = timelineDayCol;
      timelineDay.start = 0;
      timelineDay.top = cumulativeHeight;

      timelineDayCol++;
    }
    cumulativeWidth += timelineDay.width + timelineManager.gap;
    currentRowHeight = timelineDay.height + timelineManager.headerHeight;
  }

  // Add the height of the final row
  cumulativeHeight += currentRowHeight;

  month.height = cumulativeHeight;
  month.isHeightActual = true;
}

/**
 * Month grouping: the whole month is one justified flow under its group header, as the prototype
 * lays out a group (`TimelineLibrary.jsx` justifiedRows over `group.assets`). The days stay the data
 * model, so selection, navigation and live updates keep working by day; each day holds its share of
 * the month's positions, all measured from the month's first row.
 *
 * All (and Years when not shown as cards) over the Timeline's filling rows run the flow on across
 * months instead (`flow-support.svelte.ts`, FL-143); this per-month flow remains for them only with
 * the upstream row layouts, which cannot be resumed part-way through a row.
 */
function layoutGroupedMonth(timelineManager: TimelineManager, month: TimelineMonth) {
  const viewerAssets = month.timelineDays.flatMap((day) => day.viewerAssets);
  const geometry = getJustifiedLayoutFromAssets(
    viewerAssets.map((viewerAsset) => viewerAsset.asset),
    timelineManager.justifiedLayoutOptions,
  );
  placeMonthFlow(month, geometry);
}

type MonthFlow = {
  containerWidth: number;
  containerHeight: number;
  getPosition: (index: number) => { top: number; left: number; width: number; height: number };
};

/** Hand each day its share of a month-wide flow, all measured from the month's first row. */
function placeMonthFlow(month: TimelineMonth, geometry: MonthFlow) {
  const days = month.timelineDays;
  const viewerAssets = days.flatMap((day) => day.viewerAssets);
  const height = viewerAssets.length === 0 ? 0 : geometry.containerHeight;
  let index = 0;
  for (const day of days) {
    for (const viewerAsset of day.viewerAssets) {
      viewerAsset.position = geometry.getPosition(index++);
    }
    day.deferredLayout = false;
    day.row = 0;
    day.col = 0;
    day.start = 0;
    day.top = 0;
    day.width = geometry.containerWidth;
    day.height = height;
    day.updateAssetBoundaries();
  }
  month.height = viewerAssets.length === 0 ? 0 : month.groupHeaderHeight + height;
  month.isHeightActual = true;
}

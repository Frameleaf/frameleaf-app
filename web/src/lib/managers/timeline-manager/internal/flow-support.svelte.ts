import { justifiedFlowLayout } from '$lib/frameleaf/justified-rows';
import type { TimelineManager } from '../timeline-manager.svelte';
import type { TimelineMonth } from '../timeline-month.svelte';
import type { FlowItem } from '../types';

/**
 * Years and All: one justified flow across month buckets (FL-143).
 *
 * The prototype justifies a whole year or "All" group as one flow (`TimelineLibrary.jsx`
 * `justifiedRows` over `group.assets`). Production loads the library a month bucket at a time, so a
 * group's flow is assembled from its months as they load:
 *
 * - Each loaded month lays out the rows it completes. The row still unfinished at its end (its
 *   *tail*) is either laid out as its last row (the month is *closed*), or, when the next month of
 *   the group is loaded and *runs on* from it, handed to that month, which lays those tiles out at the
 *   start of its own rows and draws them. The justified algorithm's state at a row break is just the
 *   unfinished row, so the rows of `[...tail, ...next month]` are exactly the rows the flow over the
 *   whole group produces from there: once every month of a stretch runs on, its rows are the
 *   prototype's rows.
 * - A month only runs on from a loaded neighbour, so no month's geometry ever depends on a month
 *   that is not loaded; an unloaded month keeps its estimated height as before.
 * - Running on changes the previous month's last row and this month's rows, and every later month
 *   whose carried row changes in turn. That is never done to content on screen that has settled
 *   (`FLOW_SETTLE_MS` after it was first laid out): a month that loads above what the person is
 *   reading closes its own last row, and the rows run on once that stretch is off screen. A change
 *   wholly above the viewport keeps the scroll position, so nothing visible moves.
 * - Tiles a later month lays out are drawn by that month (`TimelineMonth.flowCarried`), inside its
 *   own virtualized container, but still measured from their own month (`ViewerAsset.position`), so
 *   scrolling to an asset, the scroll anchor and the scrubber keep working by month.
 */

/**
 * How long a month's rows may still change after they are first laid out. Months that load together
 * (the first screen, a scrubber jump) arrive within this window in any order and join up; after it,
 * rows on screen stay put.
 */
export const FLOW_SETTLE_MS = 300;

type Compensation = 'setter' | 'region';

const isSettling = (month: TimelineMonth, now: number) =>
  month.flowShownAt === undefined || now < month.flowShownAt + FLOW_SETTLE_MS;

const sameItems = (a: FlowItem[], b: FlowItem[]) =>
  a.length === b.length && a.every((item, index) => item.viewerAsset === b[index].viewerAsset);

/** Whether the month at `index` may run on from the month before it: both loaded, in one group. */
function canRunOn(manager: TimelineManager, index: number) {
  const month = manager.months[index];
  const previous = manager.months[index - 1];
  if (!manager.continuousGroups || !month || !previous || !month.isLoaded || !previous.isLoaded) {
    return false;
  }
  return manager.grouping === 'all' || previous.yearMonth.year === month.yearMonth.year;
}

function ownItems(month: TimelineMonth): FlowItem[] {
  const items: FlowItem[] = [];
  for (const day of month.timelineDays) {
    for (const viewerAsset of day.viewerAssets) {
      items.push({ viewerAsset, day });
    }
  }
  return items;
}

function flowOf(manager: TimelineManager, month: TimelineMonth, carry: FlowItem[], closeTail: boolean) {
  const items = carry.length > 0 ? [...carry, ...ownItems(month)] : ownItems(month);
  const layout = justifiedFlowLayout(
    items.map((item) => item.viewerAsset.asset.ratio),
    manager.justifiedLayoutOptions,
    { closeTail },
  );
  return { items, layout };
}

/** Where a tile's top is in the timeline, whichever month draws it. */
function absoluteTop(item: FlowItem): number | undefined {
  const { viewerAsset } = item;
  const host = viewerAsset.flowHost;
  const position = host ? viewerAsset.flowPosition : viewerAsset.position;
  if (!position) {
    return undefined;
  }
  const month = host ?? item.day.timelineMonth;
  return month.top + month.groupHeaderHeight + position.top;
}

function isOnScreen(manager: TimelineManager, top: number, bottom: number) {
  const { top: windowTop, bottom: windowBottom } = manager.visibleWindow;
  return manager.viewportHeight > 0 && bottom > windowTop && top < windowBottom;
}

/**
 * Lay one month out as part of its group's flow: its carried row (if it runs on), its own tiles, and
 * its tail either closed here or left for the next month.
 */
function layoutFlowMonth(manager: TimelineManager, index: number, compensation: Compensation, now: number) {
  const month = manager.months[index];
  const next = manager.months[index + 1];
  const carry = month.flowLinkedTo ? month.flowLinkedTo.flowTail : [];
  const closeTail = next?.flowLinkedTo !== month;
  const { items, layout } = flowOf(manager, month, carry, closeTail);
  const laid = closeTail ? items.length : layout.tailStart;

  for (let cursor = 0; cursor < laid; cursor++) {
    const { viewerAsset, day } = items[cursor];
    const position = layout.positions[cursor] ?? { top: 0, left: 0, width: 0, height: 0 };
    if (cursor < carry.length) {
      viewerAsset.placeInFlow(month, day.timelineMonth, position);
    } else {
      viewerAsset.position = position;
    }
  }
  month.flowTail = items.slice(layout.tailStart);
  month.flowCarried = carry.slice(0, Math.min(carry.length, laid));
  month.flowClosed = closeTail;
  month.flowContentWidth = layout.width;
  month.flowContentHeight = layout.height;
  month.flowShownAt ??= now;

  for (const day of month.timelineDays) {
    day.deferredLayout = false;
    day.row = 0;
    day.col = 0;
    day.start = 0;
    day.top = 0;
    day.width = layout.width;
    day.height = layout.height;
  }

  // Everything handed on: the month keeps only the space that puts the next month's first row one
  // row gap below the rows (or header) above it.
  const spacing = manager.justifiedLayoutOptions.spacing;
  const height =
    items.length === 0
      ? 0
      : layout.rowCount > 0
        ? month.groupHeaderHeight + layout.height
        : Math.max(0, month.groupHeaderHeight - spacing);

  const oldHeight = month.height;
  const wasAbove = month.top + oldHeight <= manager.visibleWindow.top;
  if (compensation === 'region') {
    manager.flowHoldsScroll = true;
  }
  try {
    month.height = height;
  } finally {
    manager.flowHoldsScroll = false;
  }
  month.isHeightActual = true;
  if (compensation === 'region' && wasAbove && height !== oldHeight) {
    // The change is wholly above the viewport: keep what is on screen where it is.
    manager.scrollBy(height - oldHeight);
  }
  for (const day of month.timelineDays) {
    day.updateAssetBoundaries();
  }
}

/** The tail a month would hand on if it ran on from `carry`, without laying anything out. */
function tailFor(manager: TimelineManager, month: TimelineMonth, carry: FlowItem[]) {
  const { items, layout } = flowOf(manager, month, carry, false);
  return items.slice(layout.tailStart);
}

/**
 * Let the month at `index` run on from the month before it, unless that would move settled rows on
 * screen. Returns whether any geometry changed.
 */
function runOn(manager: TimelineManager, index: number, now: number) {
  const { months } = manager;
  const previous = months[index - 1];
  const month = months[index];

  if (previous.flowTail.length === 0) {
    // The previous month's rows ended exactly: nothing runs on and nothing moves.
    month.flowLinkedTo = previous;
    previous.flowClosed = false;
    return false;
  }

  // The previous month's last row moves into this month's rows.
  if (previous.flowClosed) {
    const top = absoluteTop(previous.flowTail[0]);
    const settled = !isSettling(previous, now) && !isSettling(month, now);
    if (top !== undefined && settled && isOnScreen(manager, top, previous.top + previous.height)) {
      return false;
    }
  }
  // This month's rows change, and every later month's whose carried row changes in turn.
  let carry = previous.flowTail;
  for (let cursor = index; cursor < months.length; cursor++) {
    const current = months[cursor];
    if (!isSettling(current, now) && isOnScreen(manager, current.top, current.top + current.height)) {
      return false;
    }
    const next = months[cursor + 1];
    if (!next || next.flowLinkedTo !== current) {
      break;
    }
    const tail = tailFor(manager, current, carry);
    if (sameItems(tail, current.flowTail)) {
      break;
    }
    carry = tail;
  }

  month.flowLinkedTo = previous;
  layoutFlowMonth(manager, index - 1, 'region', now);
  for (let cursor = index; cursor < months.length; cursor++) {
    const current = months[cursor];
    const before = current.flowTail;
    layoutFlowMonth(manager, cursor, 'region', now);
    const next = months[cursor + 1];
    if (!next || next.flowLinkedTo !== current || sameItems(before, current.flowTail)) {
      break;
    }
  }
  return true;
}

function linkPending(manager: TimelineManager, now: number) {
  let changed = false;
  for (let index = 1; index < manager.months.length; index++) {
    const month = manager.months[index];
    if (!month.flowLinkedTo && canRunOn(manager, index) && month.flowShownAt !== undefined) {
      changed = runOn(manager, index, now) || changed;
    }
  }
  return changed;
}

/**
 * Lay out the months whose flow needs it: every month asked for since the last pass, and the months
 * after them whose carried row changed. Months shown for the first time run on from the month
 * before them straight away; the rest run on when that no longer moves settled rows on screen.
 */
export function reconcileFlow(manager: TimelineManager) {
  if (manager.flowReconciling) {
    return;
  }
  manager.flowReconciling = true;
  let changed = false;
  try {
    for (let pass = 0; pass < 3 && manager.flowDirty.size > 0; pass++) {
      const dirty = manager.flowDirty;
      manager.flowDirty = new Set();
      changed = reconcilePass(manager, dirty) || changed;
    }
  } finally {
    manager.flowReconciling = false;
  }
  if (changed) {
    manager.updateViewportProximities();
  }
}

function reconcilePass(manager: TimelineManager, dirty: Set<TimelineMonth>) {
  const { months } = manager;
  const now = Date.now();
  if (!manager.continuousGroups) {
    return false;
  }
  const touched = new Set<TimelineMonth>();

  // Runs that no longer hold: a month was inserted before this one, or it now starts a group.
  for (const [index, month] of months.entries()) {
    if (month.flowLinkedTo && (month.flowLinkedTo !== months[index - 1] || !canRunOn(manager, index))) {
      month.flowLinkedTo = undefined;
      touched.add(month);
    }
  }
  // A month shown for the first time (or still settling) runs on from the month before it.
  for (const [index, month] of months.entries()) {
    if (dirty.has(month) && !month.flowLinkedTo && canRunOn(manager, index) && isSettling(month, now)) {
      month.flowLinkedTo = months[index - 1];
      touched.add(month);
    }
  }

  let changed = false;
  let tailChanged = false;
  for (const [index, month] of months.entries()) {
    if (!month.isLoaded) {
      tailChanged = false;
      continue;
    }
    const closes = months[index + 1]?.flowLinkedTo !== month;
    const needsLayout =
      dirty.has(month) ||
      touched.has(month) ||
      month.flowShownAt === undefined ||
      month.flowClosed !== closes ||
      (month.flowLinkedTo !== undefined && tailChanged);
    if (!needsLayout) {
      tailChanged = false;
      continue;
    }
    const before = month.flowTail;
    layoutFlowMonth(manager, index, dirty.has(month) ? 'setter' : 'region', now);
    tailChanged = !sameItems(before, month.flowTail);
    changed = true;
  }

  return linkPending(manager, now) || changed;
}

/** Ask for a month to be laid out as part of its group's flow; batched callers lay out once. */
export function requestFlowLayout(manager: TimelineManager, month: TimelineMonth) {
  manager.flowDirty.add(month);
  if (manager.flowBatchDepth === 0) {
    reconcileFlow(manager);
  }
}

/** Run `update` (which may ask for many months) and lay the flow out once afterwards. */
export function batchFlow(manager: TimelineManager, update: () => void) {
  manager.flowBatchDepth++;
  try {
    update();
  } finally {
    manager.flowBatchDepth--;
  }
  if (manager.flowBatchDepth === 0 && manager.flowDirty.size > 0) {
    reconcileFlow(manager);
  }
}

/** Run on wherever that no longer moves settled rows on screen; called as the viewport moves. */
export function linkFlows(manager: TimelineManager) {
  if (!manager.continuousGroups || manager.flowReconciling || manager.flowBatchDepth > 0) {
    return;
  }
  manager.flowReconciling = true;
  let changed = false;
  try {
    changed = linkPending(manager, Date.now());
  } finally {
    manager.flowReconciling = false;
  }
  if (changed) {
    manager.updateViewportProximities();
  }
}

/** A month laid out on its own (Days, Months, the cell grids): forget any flow it was part of. */
export function leaveFlow(month: TimelineMonth) {
  month.flowLinkedTo = undefined;
  month.flowTail = [];
  month.flowClosed = true;
  month.flowShownAt = undefined;
  if (month.flowCarried.length > 0) {
    month.flowCarried = [];
  }
  month.flowContentWidth = 0;
  month.flowContentHeight = 0;
}

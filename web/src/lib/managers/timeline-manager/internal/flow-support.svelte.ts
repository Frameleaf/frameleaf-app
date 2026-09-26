import { justifiedFlowLayout, type JustifiedFlowLayout } from '$lib/frameleaf/justified-rows';
import { cellGrid, type CellGridOptions } from '$lib/frameleaf/library-grid';
import type { CommonPosition } from '$lib/utils/layout-utils';
import type { TimelineManager } from '../timeline-manager.svelte';
import type { TimelineMonth } from '../timeline-month.svelte';
import type { FlowItem } from '../types';

/**
 * One continuous flow across month buckets (FL-143).
 *
 * The prototype justifies a whole group as one flow (`TimelineLibrary.jsx` `justifiedRows` over
 * `group.assets`: in production the All grouping, and Years where it is not shown as cards), and
 * lays Browse and Work out as one grid over everything (`App.jsx` `.media-grid`, no date groups at
 * all). Production loads the library a month bucket at a time, so a group's flow is assembled from
 * its months as they load. A cell grid is the simple case: its unfinished row is just the cells
 * after the last full row.
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
 *   whose carried row changes in turn. That is never done to rows on screen that have settled
 *   (`FLOW_SETTLE_MS` after they were first laid out). A month that loads above what the person is
 *   reading closes its own last row, and the rows run on once that stretch is off screen.
 * - A change inside an earlier month (a new upload, a removal) would ripple through every later
 *   month. The ripple is *held* at the first later month that is on screen and settled, or not near
 *   the viewport at all: the month before it hands on exactly the tiles it handed on before
 *   (`TimelineMonth.flowHandOff`) and closes the rest as its own last row, so the held month is not
 *   touched. The hold is let go, and the rows run on again, once that stretch is off screen but
 *   near the viewport. A change wholly above the viewport keeps the scroll position.
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

/**
 * Whether the month at `index` may run on from the month before it: both loaded, in one group. The
 * Browse and Work grids are one group over the whole library.
 */
function canRunOn(manager: TimelineManager, index: number) {
  const month = manager.months[index];
  const previous = manager.months[index - 1];
  if (!manager.continuousGroups || !month || !previous || !month.isLoaded || !previous.isLoaded) {
    return false;
  }
  return !!manager.cells || manager.grouping === 'all' || previous.yearMonth.year === month.yearMonth.year;
}

/** The row gap inside the flow: the grid's gutter, or the justified rows' spacing. */
const flowGap = (manager: TimelineManager) => manager.cells?.gap ?? manager.justifiedLayoutOptions.spacing;

/**
 * A cell grid laid out like a justified flow: the full rows, and the cells after the last full row as
 * the unfinished row (laid out as the last row only with `closeTail`).
 */
function cellFlowLayout(count: number, width: number, cells: CellGridOptions, closeTail: boolean): JustifiedFlowLayout {
  const grid = cellGrid(count, width, cells);
  if (grid.cellWidth === 0) {
    return {
      positions: Array.from({ length: count }, () => undefined),
      tailStart: count,
      rowCount: 0,
      width: 0,
      height: 0,
    };
  }
  const full = Math.floor(count / grid.columns) * grid.columns;
  const tailStart = full;
  const laid = closeTail ? count : full;
  const rowCount = Math.ceil(laid / grid.columns);
  return {
    positions: Array.from({ length: count }, (_, index) => (index < laid ? grid.position(index) : undefined)),
    tailStart,
    rowCount,
    width: rowCount === 0 ? 0 : grid.width,
    height: rowCount === 0 ? 0 : rowCount * grid.rowPitch - Math.max(0, cells.gap),
  };
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

const carryOf = (month: TimelineMonth) => (month.flowLinkedTo ? month.flowLinkedTo.flowTail : []);

const itemsOf = (month: TimelineMonth, carry: FlowItem[]) =>
  carry.length > 0 ? [...carry, ...ownItems(month)] : ownItems(month);

function layoutOf(manager: TimelineManager, items: FlowItem[], closeTail: boolean) {
  return manager.cells
    ? cellFlowLayout(items.length, manager.viewportWidth, manager.cells, closeTail)
    : justifiedFlowLayout(
        items.map((item) => item.viewerAsset.asset.ratio),
        manager.justifiedLayoutOptions,
        { closeTail },
      );
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

/** A month whose rows must not change now: settled and on screen. */
const isProtected = (manager: TimelineManager, month: TimelineMonth, now: number) =>
  !isSettling(month, now) && isOnScreen(manager, month.top, month.top + month.height);

/**
 * Where a change in the month before `month` stops rippling on: at a month that must not change now,
 * or one far from the viewport, where laying it out again would be work nobody sees yet.
 */
const holdsRipple = (manager: TimelineManager, month: TimelineMonth, now: number) =>
  !month.isInOrNearViewport || isProtected(manager, month, now);

/**
 * Whether the previous month's unfinished row, laid out by the previous month itself, may move into
 * the next month now. In a cell grid those cells land in the same place, so it always may; justified
 * rows are laid out again, so settled rows on screen stay put.
 */
function mayMoveTail(manager: TimelineManager, previous: TimelineMonth, tops: FlowItem[], now: number) {
  if (manager.cells || isSettling(previous, now)) {
    return true;
  }
  const top = Math.min(...tops.map((item) => absoluteTop(item) ?? Infinity));
  return !Number.isFinite(top) || !isOnScreen(manager, top, previous.top + previous.height);
}

/**
 * Lay one month out as part of its group's flow: its carried row (if it runs on), its own tiles, and
 * its tail either closed here or left for the next month. A held month (`flowHandOff`) hands on
 * exactly that many of its last tiles and closes the rest as its own last row.
 */
function layoutFlowMonth(manager: TimelineManager, index: number, compensation: Compensation, now: number) {
  const month = manager.months[index];
  const next = manager.months[index + 1];
  const carry = carryOf(month);
  const closeTail = next?.flowLinkedTo !== month;
  if (closeTail) {
    month.flowHandOff = undefined;
  }
  const items = itemsOf(month, carry);
  const handOff = month.flowHandOff === undefined ? undefined : Math.min(month.flowHandOff, items.length);
  const laidItems = handOff === undefined ? items : items.slice(0, items.length - handOff);
  const layout = layoutOf(manager, laidItems, closeTail || handOff !== undefined);
  const tailStart = handOff === undefined ? layout.tailStart : laidItems.length;
  const laid = closeTail || handOff !== undefined ? laidItems.length : layout.tailStart;

  for (let cursor = 0; cursor < laid; cursor++) {
    const { viewerAsset, day } = items[cursor];
    const position = layout.positions[cursor] ?? { top: 0, left: 0, width: 0, height: 0 };
    if (cursor < carry.length) {
      viewerAsset.placeInFlow(month, day.timelineMonth, position);
    } else {
      viewerAsset.position = position;
    }
  }
  month.flowTail = items.slice(tailStart);
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
  const height =
    items.length === 0
      ? 0
      : layout.rowCount > 0
        ? month.groupHeaderHeight + layout.height
        : Math.max(0, month.groupHeaderHeight - flowGap(manager));

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
  const items = itemsOf(month, carry);
  return items.slice(layoutOf(manager, items, false).tailStart);
}

/** Where a month's handed-on tiles are drawn now, so a hold can put them back exactly. */
type Handed = { items: FlowItem[]; places: { item: FlowItem; host?: TimelineMonth; position?: CommonPosition }[] };

const handedOf = (month: TimelineMonth): Handed => ({
  items: month.flowTail,
  places: month.flowTail.map((item) => ({
    item,
    host: item.viewerAsset.flowHost,
    position: item.viewerAsset.flowPosition,
  })),
});

/** Whether handing on the last `handed.length` of `items` hands on exactly `handed`. */
const holdKeeps = (items: FlowItem[], handed: FlowItem[]) =>
  items.length >= handed.length && sameItems(items.slice(items.length - handed.length), handed);

/**
 * Keep the month at `index` exactly as it is while the month before it changed: that month hands on
 * the same number of tiles as before (`handed`) and closes the rest itself. Returns whether the held
 * month still carries exactly what it carried, so it needs no layout at all.
 */
function holdAt(manager: TimelineManager, index: number, { items: handed, places }: Handed, now: number) {
  const previous = manager.months[index - 1];
  const items = itemsOf(previous, carryOf(previous));
  if (items.length < handed.length) {
    return false;
  }
  if (!manager.cells && !holdKeeps(items, handed)) {
    // Justified rows are laid out by their tiles: handing on other tiles would move the held month
    // anyway, so the change runs on instead.
    return false;
  }
  previous.flowHandOff = handed.length;
  layoutFlowMonth(manager, index - 1, 'region', now);
  if (!sameItems(previous.flowTail, handed)) {
    return false;
  }
  // Laying the earlier month out again may have placed some of these tiles in its own rows first;
  // they go back exactly where the held month draws them.
  for (const { item, host, position } of places) {
    if (host && position) {
      item.viewerAsset.placeInFlow(host, item.day.timelineMonth, position);
    }
  }
  return true;
}

/**
 * Lay out the month at `index` again, and the later months its change reaches: each linked month
 * whose carried row changed, until a month that holds the ripple (see `holdsRipple`).
 */
function relayoutChain(manager: TimelineManager, index: number, now: number) {
  const { months } = manager;
  for (let cursor = index; cursor < months.length; cursor++) {
    const current = months[cursor];
    const before = handedOf(current);
    layoutFlowMonth(manager, cursor, 'region', now);
    const next = months[cursor + 1];
    if (!next || next.flowLinkedTo !== current || sameItems(before.items, current.flowTail)) {
      return;
    }
    if (holdsRipple(manager, next, now) && holdAt(manager, cursor + 1, before, now)) {
      return;
    }
  }
}

/**
 * Let the month at `index` run on from the month before it (or let go of a hold between them),
 * unless that would move settled rows on screen. Returns whether any geometry changed.
 */
function runOn(manager: TimelineManager, index: number, now: number) {
  const { months } = manager;
  const previous = months[index - 1];
  const month = months[index];
  const held = month.flowLinkedTo === previous && previous.flowHandOff !== undefined;
  // The cheap refusals first: this runs as the viewport moves, and the tail below lays a month out.
  if ((month.flowLinkedTo === previous && !held) || isProtected(manager, month, now)) {
    return false;
  }
  const natural = tailFor(manager, previous, carryOf(previous));

  if (month.flowLinkedTo === previous && sameItems(natural, previous.flowTail)) {
    // A hold that hands on exactly the natural row: nothing to let go of.
    previous.flowHandOff = undefined;
    return false;
  }
  if (month.flowLinkedTo !== previous && natural.length === 0) {
    // The previous month's rows end exactly: nothing runs on and nothing moves.
    month.flowLinkedTo = previous;
    previous.flowClosed = false;
    return false;
  }

  // The previous month's last row moves into this month's rows. While held, the previous month
  // closed a last row of its own, which letting go lays out again: that row counts as well.
  const moving = [...natural.slice(0, 1), ...previous.flowTail.slice(0, 1)];
  if (held) {
    const items = itemsOf(previous, carryOf(previous));
    const lastLaid = items.length - previous.flowTail.length - 1;
    if (lastLaid >= 0) {
      moving.push(items[lastLaid]);
    }
  }
  if (!mayMoveTail(manager, previous, moving, now)) {
    return false;
  }
  // This month's rows change, and every later month's whose carried row changes in turn, up to a
  // month that will hold the ripple.
  let carry = natural;
  for (let cursor = index; cursor < months.length; cursor++) {
    const current = months[cursor];
    const next = months[cursor + 1];
    if (!next || next.flowLinkedTo !== current) {
      break;
    }
    const tail = tailFor(manager, current, carry);
    if (sameItems(tail, current.flowTail)) {
      break;
    }
    if (holdsRipple(manager, next, now)) {
      // A far month is held whatever it carries; a settled month on screen only if the hold leaves
      // it exactly the tiles it carries now.
      if (!next.isInOrNearViewport || holdKeeps(itemsOf(current, carry), current.flowTail)) {
        break;
      }
      return false;
    }
    carry = tail;
  }

  month.flowLinkedTo = previous;
  previous.flowHandOff = undefined;
  layoutFlowMonth(manager, index - 1, 'region', now);
  relayoutChain(manager, index, now);
  return true;
}

function linkPending(manager: TimelineManager, now: number) {
  let changed = false;
  for (let index = 1; index < manager.months.length; index++) {
    const month = manager.months[index];
    const previous = manager.months[index - 1];
    if (!canRunOn(manager, index) || month.flowShownAt === undefined) {
      continue;
    }
    const pending = !month.flowLinkedTo;
    // A held boundary is let go of once the held month comes near the viewport (while the rows that
    // change are still off screen).
    const held = month.flowLinkedTo === previous && previous.flowHandOff !== undefined;
    if (pending || (held && month.isInOrNearViewport)) {
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
    if (!month.flowLinkedTo || (month.flowLinkedTo === months[index - 1] && canRunOn(manager, index))) {
      continue;
    }
    month.flowLinkedTo = undefined;
    touched.add(month);
  }
  // A month shown for the first time (or still settling) runs on from the month before it, unless
  // that would move a settled last row on screen.
  for (const [index, month] of months.entries()) {
    if (!dirty.has(month) || month.flowLinkedTo || !canRunOn(manager, index) || !isSettling(month, now)) {
      continue;
    }
    const previous = months[index - 1];
    if (mayMoveTail(manager, previous, previous.flowTail.slice(0, 1), now)) {
      month.flowLinkedTo = previous;
      touched.add(month);
    }
  }

  let changed = false;
  let tailChanged = false;
  let handedBefore: Handed = { items: [], places: [] };
  for (const [index, month] of months.entries()) {
    if (!month.isLoaded) {
      tailChanged = false;
      continue;
    }
    const closes = months[index + 1]?.flowLinkedTo !== month;
    const rippled = month.flowLinkedTo !== undefined && tailChanged;
    const ownChange =
      dirty.has(month) || touched.has(month) || month.flowShownAt === undefined || month.flowClosed !== closes;
    if (!ownChange && !rippled) {
      tailChanged = false;
      continue;
    }
    if (!ownChange && holdsRipple(manager, month, now) && holdAt(manager, index, handedBefore, now)) {
      // The change above stops here: this month keeps exactly what it had.
      tailChanged = false;
      continue;
    }
    const before = handedOf(month);
    layoutFlowMonth(manager, index, dirty.has(month) ? 'setter' : 'region', now);
    tailChanged = !sameItems(before.items, month.flowTail);
    handedBefore = before;
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

/** Every month is about to be laid out again (a new width or layout): holds no longer apply. */
export function releaseFlowHolds(manager: TimelineManager) {
  for (const month of manager.months) {
    month.flowHandOff = undefined;
  }
}

/** Run on wherever that no longer moves settled rows on screen; called as the viewport moves. */
export function linkFlows(manager: TimelineManager) {
  if (!manager.continuousGroups || manager.flowReconciling || manager.flowBatchDepth > 0) {
    return;
  }
  manager.flowReconciling = true;
  let changed: boolean;
  try {
    changed = linkPending(manager, Date.now());
  } finally {
    manager.flowReconciling = false;
  }
  if (changed) {
    manager.updateViewportProximities();
  }
}

/** A month laid out on its own (Days, Months): forget any flow it was part of. */
export function leaveFlow(month: TimelineMonth) {
  month.flowLinkedTo = undefined;
  month.flowTail = [];
  month.flowClosed = true;
  month.flowHandOff = undefined;
  month.flowShownAt = undefined;
  if (month.flowCarried.length > 0) {
    month.flowCarried = [];
  }
  month.flowContentWidth = 0;
  month.flowContentHeight = 0;
}

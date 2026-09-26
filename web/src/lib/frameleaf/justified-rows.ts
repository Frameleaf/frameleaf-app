import type { CommonJustifiedLayout, CommonLayoutOptions, CommonPosition } from '$lib/utils/layout-utils';

/**
 * Justified ("Flickr-style") row layout for a day group.
 *
 * Ported for FL-33 from the approved prototype `design/frameleaf/template/src/justified-layout.mjs`.
 * It is pure and deterministic: every row, *including the last one*, fills the container width
 * exactly unless filling it would push the row past `maxRowHeight`.
 *
 * That last-row behaviour is the whole reason this exists next to the upstream
 * `justified-layout` package. The September 22, 2026 interaction revision requires that
 * "Timeline day groups must fill the available photo area, including groups with fewer thumbnails
 * than the maximum column count" — a day holding two photos draws them at the full width of the
 * timeline rather than leaving the rest of the row empty.
 *
 * The algorithm works on aspect ratios alone, so the timeline manager can lay out a bucket without
 * holding any asset body: production keeps virtualizing by month bucket, and only the buckets in or
 * near the viewport are laid out.
 */
const DEFAULT_ASPECT = 3 / 2;
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 6;

const positive = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const nonNegative = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

/** Width / height for an item, falling back to 3:2 and clamping extreme ratios. */
export const clampAspectRatio = (value: unknown): number => {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return DEFAULT_ASPECT;
  }
  return Math.min(Math.max(ratio, MIN_ASPECT), MAX_ASPECT);
};

export type JustifiedTile = { index: number; width: number; height: number };
export type JustifiedRow = { top: number; height: number; width: number; tiles: JustifiedTile[] };

export type JustifiedRowsOptions = {
  containerWidth: number;
  targetRowHeight?: number;
  gap?: number;
  maxRowHeight?: number;
};

const layoutRow = (
  indexes: number[],
  ratios: number[],
  height: number,
  gap: number,
  containerWidth: number,
  stretch: boolean,
  top: number,
): JustifiedRow => {
  const rounded = Math.max(1, Math.round(height));
  const tiles: JustifiedTile[] = indexes.map((index) => ({
    index,
    height: rounded,
    width: Math.max(1, Math.round(ratios[index] * rounded)),
  }));
  if (stretch && tiles.length > 0) {
    // Rounding can leave a pixel or two of slack; give it to the last tile so the row edge lines
    // up with the rows above it.
    const used = tiles.reduce((sum, tile) => sum + tile.width, 0) + gap * (tiles.length - 1);
    const last = tiles.at(-1) as JustifiedTile;
    last.width = Math.max(1, last.width + Math.round(containerWidth - used));
  }
  return {
    top,
    height: rounded,
    width: tiles.reduce((sum, tile) => sum + tile.width, 0) + gap * (tiles.length - 1),
    tiles,
  };
};

/**
 * A justified flow that may stop short of its last row. `tailStart` is the index of the first item
 * in the unfinished last row (the item count when every row closed exactly). With `closeTail` the
 * unfinished row is laid out as the last row, exactly as {@link justifiedRows} does; without it the
 * row is left open so the flow can run on into the next month bucket (FL-143).
 */
export type JustifiedFlow = { rows: JustifiedRow[]; tailStart: number };

/**
 * The greedy row filling behind {@link justifiedRows}. Its state at the end of a run is just the
 * unfinished row, so starting a new run with that row's items continues the same flow: the rows of
 * `[...tail, ...next]` are the rows the flow over everything would have produced from that point.
 */
export const justifiedFlow = (
  ratios: readonly number[],
  options: JustifiedRowsOptions,
  { closeTail = true }: { closeTail?: boolean } = {},
): JustifiedFlow => {
  const containerWidth = Number(options?.containerWidth);
  const targetRowHeight = positive(options?.targetRowHeight, 200);
  const gap = nonNegative(options?.gap, 4);
  const maxRowHeight = Math.max(targetRowHeight, positive(options?.maxRowHeight, targetRowHeight * 1.5));
  const list = Array.isArray(ratios) ? ratios.map((ratio) => clampAspectRatio(ratio)) : [];
  if (list.length === 0 || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return { rows: [], tailStart: list.length };
  }

  const fillHeight = (aspectSum: number, count: number) => Math.max(1, containerWidth - gap * (count - 1)) / aspectSum;

  const rows: JustifiedRow[] = [];
  let row: number[] = [];
  let aspectSum = 0;
  let top = 0;
  const push = (height: number, stretch: boolean) => {
    const laid = layoutRow(row, list, height, gap, containerWidth, stretch, top);
    rows.push(laid);
    top += laid.height + gap;
    row = [];
    aspectSum = 0;
  };

  for (const [index, aspect] of list.entries()) {
    const withItem = fillHeight(aspectSum + aspect, row.length + 1);
    if (row.length > 0 && withItem < targetRowHeight) {
      const without = fillHeight(aspectSum, row.length);
      // Closing the row before this item can leave a row nearer the target height. Only do it when
      // the shorter row is genuinely closer and does not overshoot the maximum.
      const closerWithout =
        without <= maxRowHeight && Math.abs(without - targetRowHeight) < Math.abs(withItem - targetRowHeight);
      if (closerWithout) {
        push(without, true);
      }
    }
    row.push(index);
    aspectSum += aspect;
    if (fillHeight(aspectSum, row.length) <= targetRowHeight) {
      push(fillHeight(aspectSum, row.length), true);
    }
  }
  const tailStart = row.length > 0 ? row[0] : list.length;
  if (row.length > 0 && closeTail) {
    const fill = fillHeight(aspectSum, row.length);
    const stretch = fill <= maxRowHeight;
    push(stretch ? fill : Math.min(targetRowHeight, maxRowHeight), stretch);
  }
  return { rows, tailStart };
};

/**
 * Lay aspect ratios out in justified rows. `ratios` is indexed in visible order; every returned
 * tile carries the index it came from, so callers never have to re-derive the order.
 */
export const justifiedRows = (ratios: readonly number[], options: JustifiedRowsOptions): JustifiedRow[] =>
  justifiedFlow(ratios, options).rows;

/** Row height that keeps roughly `perRow` landscape photos per row at this width. */
export const rowHeightFor = (containerWidth: number, { min = 120, max = 260 }: { min?: number; max?: number } = {}) => {
  const width = containerWidth;
  if (!Number.isFinite(width) || width <= 0) {
    return min;
  }
  const perRow = width < 480 ? 2 : width < 760 ? 3 : width < 1100 ? 4 : 5;
  return Math.round(Math.min(max, Math.max(min, width / perRow / 1.5)));
};

/**
 * Positions for a justified flow in the timeline manager's terms (`CommonLayoutOptions`): the tiles
 * of the rows that were laid out, a caption row under each row, and the flow's size. Without
 * `closeTail` the unfinished last row is left out (its items have no position here) so a later
 * month can carry it on (FL-143).
 */
export type JustifiedFlowLayout = {
  /** Indexed like the ratios; items of an unfinished row that was left open are `undefined`. */
  positions: (CommonPosition | undefined)[];
  tailStart: number;
  rowCount: number;
  width: number;
  height: number;
};

export const justifiedFlowLayout = (
  ratios: readonly number[],
  options: CommonLayoutOptions,
  { closeTail = true }: { closeTail?: boolean } = {},
): JustifiedFlowLayout => {
  const gap = nonNegative(options.spacing, 0);
  const rowWidth = positive(options.rowWidth, 0);
  const rowHeight = positive(options.rowHeight, 200);
  const tolerance = Number.isFinite(options.heightTolerance) ? Math.max(0, options.heightTolerance) : 0.25;
  const { rows, tailStart } = justifiedFlow(
    ratios,
    {
      containerWidth: rowWidth,
      targetRowHeight: rowHeight,
      gap,
      maxRowHeight: Math.round(rowHeight * (1 + tolerance)),
    },
    { closeTail },
  );
  const positions: (CommonPosition | undefined)[] = Array.from({ length: ratios.length }, () => undefined);
  // A caption row under each row (Timeline captions): the photos keep their height and every row
  // below starts that much lower.
  const caption = nonNegative(options.captionHeight, 0);
  let widest = 0;
  let bottom = 0;
  for (const [rowIndex, row] of rows.entries()) {
    const top = row.top + rowIndex * caption;
    let left = 0;
    for (const tile of row.tiles) {
      positions[tile.index] = { top, left, width: tile.width, height: tile.height };
      left += tile.width + gap;
    }
    widest = Math.max(widest, row.width);
    bottom = top + row.height + caption;
  }
  return {
    positions,
    tailStart,
    rowCount: rows.length,
    // Rows fill the container, so the flow is exactly as wide as the timeline allows. Falling back
    // to the widest row keeps a single short row (a day with one very tall photo) honest.
    width: rows.length === 0 ? 0 : Math.min(rowWidth, widest),
    height: bottom,
  };
};

/**
 * The `CommonJustifiedLayout` the timeline manager consumes, backed by the filling algorithm.
 * Positions are materialised once per day group; a group is only laid out when its month bucket is
 * in or near the viewport, so this never walks the whole library.
 */
class FilledJustifiedLayout implements CommonJustifiedLayout {
  readonly containerWidth: number;
  readonly containerHeight: number;
  readonly #positions: (CommonPosition | undefined)[];

  constructor(ratios: readonly number[], options: CommonLayoutOptions) {
    const layout = justifiedFlowLayout(ratios, options);
    this.#positions = layout.positions;
    this.containerWidth = layout.width;
    this.containerHeight = layout.height;
  }

  #at(boxIdx: number): CommonPosition {
    return this.#positions[boxIdx] ?? { top: 0, left: 0, width: 0, height: 0 };
  }

  getTop(boxIdx: number) {
    return this.#at(boxIdx).top;
  }

  getLeft(boxIdx: number) {
    return this.#at(boxIdx).left;
  }

  getWidth(boxIdx: number) {
    return this.#at(boxIdx).width;
  }

  getHeight(boxIdx: number) {
    return this.#at(boxIdx).height;
  }

  getPosition(boxIdx: number) {
    return this.#at(boxIdx);
  }
}

/** Build a filling justified layout from aspect ratios alone. */
export const filledJustifiedLayout = (ratios: readonly number[], options: CommonLayoutOptions): CommonJustifiedLayout =>
  new FilledJustifiedLayout(ratios, options);

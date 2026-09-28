// Justified ("Flickr-style") row layout for photo grids. Pure and deterministic:
// every row except the last fills the container width exactly; the last row keeps
// the target height unless the fill height would exceed maxRowHeight.
const DEFAULT_ASPECT = 3 / 2;
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 6;

const positive = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};
const nonNegative = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

/** Width / height for an asset, falling back to 3:2 and clamping extreme ratios. */
export function aspectRatio(item) {
  const width = Number(item?.width);
  const height = Number(item?.height);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return DEFAULT_ASPECT;
  return Math.min(Math.max(width / height, MIN_ASPECT), MAX_ASPECT);
}

function layoutRow(items, height, gap, containerWidth, stretch) {
  const rounded = Math.max(1, Math.round(height));
  const tiles = items.map((item) => ({
    item,
    height: rounded,
    width: Math.max(1, Math.round(aspectRatio(item) * rounded)),
  }));
  if (stretch) {
    // Rounding can leave a pixel or two of slack; give it to the last tile so
    // the row edge lines up with the others.
    const used =
      tiles.reduce((sum, tile) => sum + tile.width, 0) +
      gap * (tiles.length - 1);
    tiles[tiles.length - 1].width += Math.round(containerWidth - used);
  }
  return {
    height: rounded,
    width:
      tiles.reduce((sum, tile) => sum + tile.width, 0) +
      gap * (tiles.length - 1),
    items: tiles,
  };
}

/**
 * Lay items out in justified rows.
 * @returns {{height:number,width:number,items:{item:object,width:number,height:number}[]}[]}
 */
export function justifiedRows(items, options = {}) {
  const containerWidth = Number(options.containerWidth);
  const targetRowHeight = positive(options.targetRowHeight, 200);
  const gap = nonNegative(options.gap, 4);
  const maxRowHeight = Math.max(
    targetRowHeight,
    positive(options.maxRowHeight, targetRowHeight * 1.5),
  );
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length || !Number.isFinite(containerWidth) || containerWidth <= 0)
    return [];

  const fillHeight = (aspectSum, count) =>
    Math.max(1, containerWidth - gap * (count - 1)) / aspectSum;

  const rows = [];
  let row = [];
  let aspectSum = 0;
  for (const item of list) {
    const aspect = aspectRatio(item);
    const withItem = fillHeight(aspectSum + aspect, row.length + 1);
    if (row.length && withItem < targetRowHeight) {
      const without = fillHeight(aspectSum, row.length);
      const closerWithout =
        without <= maxRowHeight &&
        Math.abs(without - targetRowHeight) <
          Math.abs(withItem - targetRowHeight);
      if (closerWithout) {
        rows.push(layoutRow(row, without, gap, containerWidth, true));
        row = [];
        aspectSum = 0;
      }
    }
    row.push(item);
    aspectSum += aspect;
    if (fillHeight(aspectSum, row.length) <= targetRowHeight) {
      rows.push(
        layoutRow(
          row,
          fillHeight(aspectSum, row.length),
          gap,
          containerWidth,
          true,
        ),
      );
      row = [];
      aspectSum = 0;
    }
  }
  if (row.length) {
    const fill = fillHeight(aspectSum, row.length);
    const stretch = fill <= maxRowHeight;
    rows.push(
      layoutRow(
        row,
        stretch ? fill : Math.min(targetRowHeight, maxRowHeight),
        gap,
        containerWidth,
        stretch,
      ),
    );
  }
  return rows;
}

/** Row height that keeps roughly `perRow` landscape photos per row at this width. */
export function rowHeightFor(containerWidth, { min = 120, max = 260 } = {}) {
  const width = Number(containerWidth);
  if (!Number.isFinite(width) || width <= 0) return min;
  const perRow = width < 480 ? 2 : width < 760 ? 3 : width < 1100 ? 4 : 5;
  return Math.round(Math.min(max, Math.max(min, width / perRow / 1.5)));
}

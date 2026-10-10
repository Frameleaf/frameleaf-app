import type { CommonPosition } from '$lib/utils/layout-utils';

/**
 * Browse and Work grid geometry and the Thumbnail size scale (FL-33), ported from the September 24
 * template: `apple-style.css` "grids per tab", `styles.css` `.media-grid`, and `App.jsx` `zoomGrid`
 * and `rowScale`.
 *
 * - **Browse** is the Photos-style dense square grid: `minmax(calc(var(--thumb-size) * 0.8), 1fr)`
 *   columns, 2px gutters, and three columns on phones (`max-width: 700px`).
 * - **Work** is the Lightroom-style grid: `minmax(var(--thumb-size), 1fr)` columns of 3:2 cells
 *   with a caption row under each, 12px gutters, and two columns on phones.
 * - **Timeline** keeps its justified rows; Thumbnail size scales their target height instead.
 *
 * Everything here is pure, so the timeline manager can lay a month out from its asset count alone
 * (an unloaded month gets its exact height) and `AssetGrid` can window a result list without
 * measuring the tiles.
 */

/** Thumbnail size limits (`App.jsx` `zoomGrid`: 140–290 in steps of 30). */
export const THUMBNAIL_SIZE_MIN = 140;
export const THUMBNAIL_SIZE_MAX = 290;
export const THUMBNAIL_SIZE_STEP = 30;
/**
 * The default size, and the one at which Timeline rows keep their default height. The template's
 * `DEFAULT_THUMB_SIZE` is 190, which is not a stop on the 140–290 step-30 scale the story fixes;
 * 200 is the nearest stop, so the default sits on the scale and the slider can return to it.
 */
export const THUMBNAIL_SIZE_DEFAULT = 200;

/** The layouts a library tile is drawn in. `list` is Browse's and Work's List view (S-15). */
export type TileLayout = 'timeline' | 'browse' | 'work' | 'list';

/** Clamp a size into range and snap it to the step scale (140, 170, 200, 230, 260, 290). */
export const clampThumbnailSize = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return THUMBNAIL_SIZE_DEFAULT;
  }
  const clamped = Math.min(THUMBNAIL_SIZE_MAX, Math.max(THUMBNAIL_SIZE_MIN, number));
  return THUMBNAIL_SIZE_MIN + Math.round((clamped - THUMBNAIL_SIZE_MIN) / THUMBNAIL_SIZE_STEP) * THUMBNAIL_SIZE_STEP;
};

/** One step larger (`direction` 1) or smaller (-1), held at the limits. */
export const stepThumbnailSize = (size: number, direction: 1 | -1): number =>
  clampThumbnailSize(clampThumbnailSize(size) + direction * THUMBNAIL_SIZE_STEP);

/** Timeline row height for a Thumbnail size (`App.jsx` `rowScale={size / DEFAULT_THUMB_SIZE}`). */
export const timelineRowHeight = (baseRowHeight: number, size: number): number =>
  Math.max(1, Math.round(baseRowHeight * (clampThumbnailSize(size) / THUMBNAIL_SIZE_DEFAULT)));

export type CellGridOptions = {
  /** Smallest column width; columns stretch to fill the row (`minmax(min, 1fr)`). */
  minCellWidth: number;
  /** Width / height of the image part of a cell. */
  aspect: number;
  /** Gutter between columns and between rows. */
  gap: number;
  /** Space under each image for the caption (Work); 0 in Browse. */
  captionHeight: number;
  /** A fixed column count (phones), overriding `minCellWidth`. */
  columns?: number;
  /** A fixed image height (the list view's rows), overriding `aspect`. */
  imageHeight?: number;
};

export type CellGrid = {
  columns: number;
  cellWidth: number;
  /** Height of the image part of a cell. */
  imageHeight: number;
  /** Image plus caption. */
  cellHeight: number;
  /** Distance from one row's top to the next. */
  rowPitch: number;
  rows: number;
  /** Height of the whole grid, without a trailing gutter. */
  height: number;
  /** Width actually used by the rows. */
  width: number;
  position: (index: number) => CommonPosition;
  /**
   * Indexes whose rows meet `[top, bottom)` (grid coordinates), widened by `overscanRows` on each
   * side; `end` is exclusive and an empty window gives `start === end`.
   */
  range: (top: number, bottom: number, overscanRows?: number) => { start: number; end: number };
};

/** The caption row under a Work tile: 6px margin and one 12px line at 1.4 line height, rounded. */
export const WORK_CAPTION_HEIGHT = 24;

/**
 * The List view's row (template asset-tile.css `.asset-tile[data-layout="list"]`): a 96px 3:2
 * thumbnail with 6px padding above and below and a hairline between rows.
 */
export const LIST_ROW_HEIGHT = 77;

/** The geometry for the Browse or Work grid, per layout, device class and Thumbnail size. */
export const cellGridOptions = (layout: 'browse' | 'work' | 'list', size: number, phone: boolean): CellGridOptions => {
  if (layout === 'list') {
    return { minCellWidth: 1, aspect: 1, gap: 0, captionHeight: 0, columns: 1, imageHeight: LIST_ROW_HEIGHT };
  }
  const thumb = clampThumbnailSize(size);
  if (layout === 'browse') {
    // apple-style.css: minmax(calc(var(--thumb-size) * 0.8), 1fr); gap 2px; 3 columns ≤ 700px.
    return { minCellWidth: thumb * 0.8, aspect: 1, gap: 2, captionHeight: 0, columns: phone ? 3 : undefined };
  }
  // styles.css .media-grid: minmax(var(--thumb-size), 1fr); gap 12px (phones: 2 columns, 7–9px);
  // asset-tile.css: 3:2 cells with a caption 6px below (12px text at 1.4 line height).
  return {
    minCellWidth: thumb,
    aspect: 3 / 2,
    gap: phone ? 8 : 12,
    captionHeight: WORK_CAPTION_HEIGHT,
    columns: phone ? 2 : undefined,
  };
};

/** Lay `count` cells out in rows across `containerWidth`. */
export const cellGrid = (count: number, containerWidth: number, options: CellGridOptions): CellGrid => {
  const total = Math.max(0, Math.floor(count || 0));
  const width = Math.max(0, containerWidth || 0);
  const gap = Math.max(0, options.gap);
  const minCell = Math.max(1, options.minCellWidth);
  const fixed = options.columns && options.columns > 0 ? Math.floor(options.columns) : 0;
  const columns = Math.max(1, fixed || Math.floor((width + gap) / (minCell + gap)));
  const cellWidth = width > 0 ? Math.max(1, (width - gap * (columns - 1)) / columns) : 0;
  const imageHeight =
    cellWidth > 0 ? Math.max(1, Math.round(options.imageHeight ?? cellWidth / Math.max(0.1, options.aspect))) : 0;
  const cellHeight = imageHeight + Math.max(0, options.captionHeight);
  const rowPitch = cellHeight + gap;
  const rows = cellWidth > 0 ? Math.ceil(total / columns) : 0;
  const height = rows === 0 ? 0 : rows * rowPitch - gap;

  const edge = (column: number) => Math.round(column * (cellWidth + gap));
  const position = (index: number): CommonPosition => {
    if (index < 0 || index >= total || cellWidth === 0) {
      return { top: 0, left: 0, width: 0, height: 0 };
    }
    const column = index % columns;
    const left = edge(column);
    // Rounded edges so neighbouring cells meet the gutter exactly, and the last one ends flush.
    const right = column === columns - 1 ? Math.round(width) : edge(column + 1) - gap;
    return { top: Math.floor(index / columns) * rowPitch, left, width: Math.max(1, right - left), height: cellHeight };
  };

  const range = (top: number, bottom: number, overscanRows = 0) => {
    if (rows === 0 || rowPitch <= 0) {
      return { start: 0, end: 0 };
    }
    const first = Math.max(0, Math.floor(top / rowPitch) - overscanRows);
    const last = Math.min(rows - 1, Math.floor(Math.max(top, bottom - 1) / rowPitch) + overscanRows);
    if (first > last) {
      return { start: 0, end: 0 };
    }
    return { start: first * columns, end: Math.min(total, (last + 1) * columns) };
  };

  return { columns, cellWidth, imageHeight, cellHeight, rowPitch, rows, height, width, position, range };
};

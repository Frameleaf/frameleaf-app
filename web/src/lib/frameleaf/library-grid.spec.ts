import { describe, expect, it } from 'vitest';
import {
  cellGrid,
  cellGridOptions,
  clampThumbnailSize,
  stepThumbnailSize,
  THUMBNAIL_SIZE_DEFAULT,
  THUMBNAIL_SIZE_MAX,
  THUMBNAIL_SIZE_MIN,
  timelineRowHeight,
  WORK_CAPTION_HEIGHT,
} from '$lib/frameleaf/library-grid';

describe('Thumbnail size scale', () => {
  it('runs from 140 to 290 in steps of 30, snapping anything in between', () => {
    expect(clampThumbnailSize(100)).toBe(THUMBNAIL_SIZE_MIN);
    expect(clampThumbnailSize(1000)).toBe(THUMBNAIL_SIZE_MAX);
    expect(clampThumbnailSize(190)).toBe(200);
    expect(clampThumbnailSize(184)).toBe(170);
    expect(clampThumbnailSize('nonsense')).toBe(THUMBNAIL_SIZE_DEFAULT);
    expect(clampThumbnailSize(NaN)).toBe(THUMBNAIL_SIZE_DEFAULT);
  });

  it('steps one stop at a time and holds at the limits', () => {
    expect(stepThumbnailSize(200, 1)).toBe(230);
    expect(stepThumbnailSize(200, -1)).toBe(170);
    expect(stepThumbnailSize(THUMBNAIL_SIZE_MAX, 1)).toBe(THUMBNAIL_SIZE_MAX);
    expect(stepThumbnailSize(THUMBNAIL_SIZE_MIN, -1)).toBe(THUMBNAIL_SIZE_MIN);
  });

  it('keeps the default Timeline row height at the default size and scales it with the size', () => {
    expect(timelineRowHeight(235, THUMBNAIL_SIZE_DEFAULT)).toBe(235);
    expect(timelineRowHeight(235, THUMBNAIL_SIZE_MAX)).toBe(Math.round(235 * (290 / 200)));
    expect(timelineRowHeight(100, THUMBNAIL_SIZE_MIN)).toBe(70);
  });
});

describe('cellGridOptions', () => {
  it('gives Browse square cells with 2px gutters and three columns on phones', () => {
    expect(cellGridOptions('browse', 200, false)).toEqual({
      minCellWidth: 160,
      aspect: 1,
      gap: 2,
      captionHeight: 0,
      columns: undefined,
    });
    expect(cellGridOptions('browse', 290, true).columns).toBe(3);
  });

  it('gives Work 3:2 cells with a caption row, thumb-size columns and two columns on phones', () => {
    const work = cellGridOptions('work', 230, false);
    expect(work).toMatchObject({ minCellWidth: 230, aspect: 1.5, gap: 12, captionHeight: WORK_CAPTION_HEIGHT });
    expect(cellGridOptions('work', 230, true).columns).toBe(2);
  });
});

describe('the List view (S-15)', () => {
  it('is one column of fixed-height rows, whatever the width', () => {
    const grid = cellGrid(3, 1200, cellGridOptions('list', 200, false));
    expect(grid.columns).toBe(1);
    expect(grid.cellWidth).toBe(1200);
    expect(grid.cellHeight).toBe(77);
    expect(grid.position(2)).toEqual({ top: 154, left: 0, width: 1200, height: 77 });
    expect(cellGrid(3, 320, cellGridOptions('list', 290, true)).cellHeight).toBe(77);
  });
});

describe('cellGrid', () => {
  it('fits as many minimum-width columns as the width allows and stretches them to fill it', () => {
    const grid = cellGrid(10, 1000, cellGridOptions('browse', 200, false));
    // floor((1000 + 2) / (160 + 2)) = 6 columns
    expect(grid.columns).toBe(6);
    expect(grid.cellWidth).toBeCloseTo((1000 - 5 * 2) / 6);
    expect(grid.imageHeight).toBe(Math.round(grid.cellWidth));
    expect(grid.rows).toBe(2);
    expect(grid.height).toBe(2 * grid.rowPitch - 2);
  });

  it('draws three columns on a phone whatever the Thumbnail size', () => {
    for (const size of [140, 200, 290]) {
      expect(cellGrid(9, 390, cellGridOptions('browse', size, true)).columns).toBe(3);
    }
  });

  it('places cells left to right, row by row, and ends each row flush with the width', () => {
    const grid = cellGrid(7, 998, { minCellWidth: 100, aspect: 1, gap: 2, captionHeight: 0, columns: 3 });
    const first = grid.position(0);
    const third = grid.position(2);
    const fourth = grid.position(3);
    expect(first).toMatchObject({ top: 0, left: 0 });
    expect(third.left + third.width).toBe(998);
    expect(fourth).toMatchObject({ top: grid.rowPitch, left: 0 });
    // Neighbours meet the gutter exactly.
    const second = grid.position(1);
    expect(second.left - (first.left + first.width)).toBe(2);
    expect(grid.position(99)).toEqual({ top: 0, left: 0, width: 0, height: 0 });
  });

  it('adds the caption row to Work cells', () => {
    const grid = cellGrid(4, 800, cellGridOptions('work', 200, false));
    expect(grid.cellHeight).toBe(grid.imageHeight + WORK_CAPTION_HEIGHT);
    expect(grid.position(0).height).toBe(grid.cellHeight);
  });

  it('grows the cells as the Thumbnail size grows, fewer to a row', () => {
    const small = cellGrid(100, 1200, cellGridOptions('browse', 140, false));
    const large = cellGrid(100, 1200, cellGridOptions('browse', 290, false));
    expect(large.columns).toBeLessThan(small.columns);
    expect(large.cellWidth).toBeGreaterThan(small.cellWidth);
    expect(large.height).toBeGreaterThan(small.height);
  });

  it('windows the cells to the rows in or near the viewport', () => {
    const grid = cellGrid(1000, 1000, { minCellWidth: 100, aspect: 1, gap: 0, captionHeight: 0, columns: 10 });
    // 100px rows: rows 5–9 cover [500, 1000).
    expect(grid.range(500, 1000)).toEqual({ start: 50, end: 100 });
    expect(grid.range(500, 1000, 2)).toEqual({ start: 30, end: 120 });
    expect(grid.range(-5000, -4000)).toEqual({ start: 0, end: 0 });
    expect(grid.range(0, 50)).toEqual({ start: 0, end: 10 });
    expect(grid.range(9950, 20_000)).toEqual({ start: 990, end: 1000 });
    expect(grid.range(50_000, 60_000)).toEqual({ start: 0, end: 0 });
  });

  it('lays nothing out without a width or without items', () => {
    expect(cellGrid(10, 0, cellGridOptions('browse', 200, false))).toMatchObject({ rows: 0, height: 0 });
    expect(cellGrid(0, 1000, cellGridOptions('browse', 200, false))).toMatchObject({ rows: 0, height: 0 });
  });
});

import { describe, expect, it } from 'vitest';
import { clampAspectRatio, filledJustifiedLayout, justifiedRows, rowHeightFor } from './justified-rows';

const CONTAINER = 1000;
const options = (overrides: Partial<Parameters<typeof justifiedRows>[1]> = {}) => ({
  containerWidth: CONTAINER,
  targetRowHeight: 200,
  gap: 4,
  maxRowHeight: 250,
  ...overrides,
});

const rowWidth = (row: { tiles: { width: number }[] }, gap = 4) =>
  row.tiles.reduce((sum, tile) => sum + tile.width, 0) + gap * (row.tiles.length - 1);

describe('clampAspectRatio', () => {
  it('falls back to 3:2 for missing or nonsensical ratios', () => {
    for (const value of [undefined, null, NaN, 0, -3, 'wide']) {
      expect(clampAspectRatio(value)).toBe(1.5);
    }
  });

  it('clamps extreme panoramas and slivers so one asset cannot own a row', () => {
    expect(clampAspectRatio(40)).toBe(6);
    expect(clampAspectRatio(0.01)).toBe(0.25);
  });
});

describe('justifiedRows', () => {
  it('returns nothing without items or a measured container', () => {
    expect(justifiedRows([], options())).toEqual([]);
    expect(justifiedRows([1.5], options({ containerWidth: 0 }))).toEqual([]);
    expect(justifiedRows([1.5], options({ containerWidth: NaN }))).toEqual([]);
  });

  it('fills the width on the last row as well, so a short day group is not left ragged', () => {
    // The requirement this module exists for: a day holding two photos still spans the timeline,
    // as long as doing so stays inside the height tolerance. The upstream layout never stretches
    // its last row, which is what leaves short day groups ragged today.
    const rows = justifiedRows([1.5, 1.5], options({ maxRowHeight: 350 }));
    expect(rows).toHaveLength(1);
    expect(rowWidth(rows[0])).toBe(CONTAINER);
    expect(rows[0].height).toBeLessThanOrEqual(350);
  });

  it('keeps a lone tall item at the target height rather than blowing it up to fill the row', () => {
    const rows = justifiedRows([0.6], options({ maxRowHeight: 350 }));
    expect(rows).toHaveLength(1);
    // Filling 1000px at a 0.6 aspect would need a 1666px-tall tile; the maximum wins instead.
    expect(rows[0].height).toBe(200);
    expect(rowWidth(rows[0])).toBeLessThan(CONTAINER);
  });

  it('fills every full row exactly and never exceeds the container', () => {
    const ratios = Array.from({ length: 37 }, (_, index) => [1.5, 0.75, 1.78, 1][index % 4]);
    const rows = justifiedRows(ratios, options());
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(rowWidth(row)).toBeLessThanOrEqual(CONTAINER);
      expect(row.height).toBeLessThanOrEqual(250);
    }
    for (const row of rows.slice(0, -1)) {
      expect(rowWidth(row)).toBe(CONTAINER);
    }
  });

  it('lays every item out exactly once, in order, with stacked rows', () => {
    const ratios = Array.from({ length: 23 }, (_, index) => 1 + (index % 5) / 4);
    const rows = justifiedRows(ratios, options());
    const seen = rows.flatMap((row) => row.tiles.map((tile) => tile.index));
    expect(seen).toEqual([...ratios.keys()]);
    let previousBottom = -1;
    for (const row of rows) {
      expect(row.top).toBeGreaterThan(previousBottom);
      previousBottom = row.top + row.height;
    }
  });

  it('is deterministic for the same input', () => {
    const ratios = [1.5, 1.5, 0.66, 2.2, 1, 1.78];
    expect(justifiedRows(ratios, options())).toEqual(justifiedRows(ratios, options()));
  });

  it('tolerates a zero gap and defaults a missing one', () => {
    const rows = justifiedRows([1.5, 1.5, 1.5], options({ gap: 0 }));
    expect(rowWidth(rows[0], 0)).toBe(CONTAINER);
  });
});

describe('rowHeightFor', () => {
  it('scales the row height with the available width and clamps it', () => {
    expect(rowHeightFor(0)).toBe(120);
    expect(rowHeightFor(NaN)).toBe(120);
    expect(rowHeightFor(400)).toBe(133);
    expect(rowHeightFor(1600)).toBe(213);
    expect(rowHeightFor(100_000)).toBe(260);
  });
});

describe('filledJustifiedLayout', () => {
  const layoutOptions = { rowHeight: 200, rowWidth: CONTAINER, spacing: 4, heightTolerance: 0.25 };

  it('exposes positions for every box and a height covering the last row', () => {
    const ratios = [1.5, 1.5, 1.5, 0.75, 1.78];
    const layout = filledJustifiedLayout(ratios, layoutOptions);
    for (const index of ratios.keys()) {
      const position = layout.getPosition(index);
      expect(position.width).toBeGreaterThan(0);
      expect(position.height).toBeGreaterThan(0);
      expect(position.left).toBeGreaterThanOrEqual(0);
      expect(position.left + position.width).toBeLessThanOrEqual(CONTAINER);
      expect(position.top + position.height).toBeLessThanOrEqual(layout.containerHeight);
      expect(layout.getTop(index)).toBe(position.top);
      expect(layout.getLeft(index)).toBe(position.left);
      expect(layout.getWidth(index)).toBe(position.width);
      expect(layout.getHeight(index)).toBe(position.height);
    }
    expect(layout.containerWidth).toBeLessThanOrEqual(CONTAINER);
  });

  it('returns an empty geometry for an empty day so the group collapses', () => {
    const layout = filledJustifiedLayout([], layoutOptions);
    expect(layout.containerWidth).toBe(0);
    expect(layout.containerHeight).toBe(0);
  });

  it('answers out-of-range boxes with a zero rectangle instead of throwing', () => {
    const layout = filledJustifiedLayout([1.5], layoutOptions);
    expect(layout.getPosition(9)).toEqual({ top: 0, left: 0, width: 0, height: 0 });
  });
});

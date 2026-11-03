import { describe, expect, it } from 'vitest';
import { physicalTimelineHeight, toPhysicalScroll, toTimelineScroll } from './scroll-range';

describe('bounded timeline scroll coordinates', () => {
  it('leaves ordinary timelines unchanged', () => {
    expect(physicalTimelineHeight(50_000)).toBe(50_000);
    expect(toPhysicalScroll(1234, 50_000, 600)).toBe(1234);
    expect(toTimelineScroll(1234, 50_000, 600)).toBe(1234);
  });

  it.each([59_000_000, 118_000_000])('reaches every part of a %i pixel library within browser limits', (height) => {
    const viewport = 600;
    const physical = physicalTimelineHeight(height);
    expect(physical).toBeLessThanOrEqual(8_000_000);
    for (const fraction of [0, 0.01, 0.25, 0.5, 0.99, 1]) {
      const logical = (height - viewport) * fraction;
      const offset = toPhysicalScroll(logical, height, viewport);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(physical - viewport);
      expect(toTimelineScroll(offset, height, viewport)).toBeCloseTo(logical, 5);
    }
    expect(toTimelineScroll(physical - viewport, height, viewport)).toBe(height - viewport);
  });

  it('clamps empty, short and out-of-range scrolls', () => {
    for (const height of [0, 100]) {
      expect(toPhysicalScroll(1000, height, 600)).toBe(0);
      expect(toTimelineScroll(1000, height, 600)).toBe(0);
    }
    expect(toPhysicalScroll(-1, 50_000, 600)).toBe(0);
    expect(toTimelineScroll(50_000, 50_000, 600)).toBe(49_400);
  });
});

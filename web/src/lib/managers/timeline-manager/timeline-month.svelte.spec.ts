import { SvelteSet } from 'svelte/reactivity';
import type { TimelineDay } from './timeline-day.svelte';
import type { TimelineManager } from './timeline-manager.svelte';
import { TimelineMonth } from './timeline-month.svelte';

it('collects assets in day order without copying asset objects or mutating day arrays', () => {
  const month = new TimelineMonth({} as TimelineManager, { year: 2026, month: 10 }, 0, true);
  expect(month.getAssets()).toEqual([]);
  const first = { id: 'first' };
  const second = { id: 'second' };
  const firstDay = [first];
  const secondDay = [second];
  month.timelineDays = [
    { getAssets: () => firstDay },
    { getAssets: () => [] },
    { getAssets: () => secondDay },
  ] as unknown as TimelineDay[];
  const assets = month.getAssets();
  expect(assets).toEqual([first, second]);
  expect(assets[0]).toBe(first);
  expect(assets[1]).toBe(second);
  assets.pop();
  expect(firstDay).toEqual([first]);
  expect(secondDay).toEqual([second]);
});

describe('month asset callbacks', () => {
  it('collects processed IDs, preserves missing IDs and removes empty groups', () => {
    const month = new TimelineMonth({} as TimelineManager, { year: 2026, month: 10 }, 0, true);
    const first = {
      viewerAssets: [{}],
      runAssetCallback: vi.fn(() => ({ moveAssets: [], processedIds: new SvelteSet(['a']), changedGeometry: false })),
    };
    const second = {
      viewerAssets: [],
      runAssetCallback: vi.fn(() => ({ moveAssets: [], processedIds: new SvelteSet(['b']), changedGeometry: true })),
    };
    month.timelineDays = [first, second] as unknown as TimelineDay[];
    const ids = new Set(['a', 'b', 'missing']);
    const result = month.runAssetCallback(ids, vi.fn());
    expect([...result.processedIds]).toEqual(['b', 'a']);
    expect([...result.unprocessedIds]).toEqual(['missing']);
    expect(result.changedGeometry).toBe(true);
    expect(month.timelineDays).toHaveLength(1);
    expect([...ids]).toEqual(['a', 'b', 'missing']);
  });
});

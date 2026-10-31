import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import type { GroupInsertionCache } from './group-insertion-cache.svelte';
import { TimelineManager } from './timeline-manager.svelte';
import { TimelineMonth } from './timeline-month.svelte';
import type { TimelineAsset } from './types';

class Subject extends TimelineManager {
  created = 0;
  upserted = 0;
  insert(assets: TimelineAsset[]) {
    this.addAssetsUpsertSegments(assets);
  }
  protected override postCreateSegments() {
    this.created++;
  }
  protected override postUpsert(_: GroupInsertionCache) {
    this.upserted++;
  }
}

const managers: Subject[] = [];
const setup = () => {
  const manager = new Subject();
  managers.push(manager);
  return manager;
};

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.destroy();
  }
  vi.restoreAllMocks();
});

it('looks up existing months only linearly for a large insertion batch', () => {
  const manager = setup();
  let reads = 0;
  manager.months = Array.from({ length: 80 }, (_, index) => {
    const month = new TimelineMonth(manager, { year: 2000 + index, month: 1 }, 0, true);
    Object.defineProperty(month.yearMonth, 'year', {
      get: () => {
        reads++;
        return 2000 + index;
      },
    });
    vi.spyOn(month, 'addTimelineAsset').mockImplementation(() => {});
    return month;
  });
  const assets = timelineAssetFactory.buildList(128, { localDateTime: { year: 2079, month: 1, day: 1 } });
  manager.insert(assets);
  expect(manager.months[79].addTimelineAsset).toHaveBeenCalledTimes(128);
  expect(manager.created).toBe(0);
  expect(manager.upserted).toBe(1);
  expect(reads).toBeLessThanOrEqual(160);
});

it('uses the first duplicate bucket and shares newly created buckets within a batch', () => {
  const manager = setup();
  const first = new TimelineMonth(manager, { year: 2026, month: 10 }, 0, true);
  const duplicate = new TimelineMonth(manager, { year: 2026, month: 10 }, 0, true);
  manager.months = [first, duplicate];
  const add = vi.spyOn(TimelineMonth.prototype, 'addTimelineAsset').mockImplementation(() => {});
  const existing = timelineAssetFactory.build({ localDateTime: { year: 2026, month: 10, day: 1 } });
  const newAssets = timelineAssetFactory.buildList(2, { localDateTime: { year: 2026, month: 11, day: 1 } });
  manager.insert([existing, ...newAssets]);
  expect(add.mock.contexts).toEqual([first, manager.months[2], manager.months[2]]);
  expect(manager.months).toHaveLength(3);
  expect(new Set(add.mock.calls.map(([, context]) => context)).size).toBe(1);
  expect(manager.created).toBe(1);
  expect(manager.upserted).toBe(1);
});

it('keeps the first-match single-asset path without indexing unrelated months', () => {
  const manager = setup();
  const first = new TimelineMonth(manager, { year: 2026, month: 10 }, 0, true);
  const unrelated = new TimelineMonth(manager, { year: 2025, month: 10 }, 0, true);
  Object.defineProperty(unrelated, 'yearMonth', {
    get: () => {
      throw new Error('unneeded month lookup');
    },
  });
  manager.months = [first, unrelated];
  vi.spyOn(first, 'addTimelineAsset').mockImplementation(() => {});
  manager.insert([timelineAssetFactory.build({ localDateTime: { year: 2026, month: 10, day: 1 } })]);
  expect(first.addTimelineAsset).toHaveBeenCalledOnce();
});

it('does not reuse a NaN month that strict calendar comparison cannot match', () => {
  const manager = setup();
  const month = new TimelineMonth(manager, { year: 2026, month: 10 }, 0, true);
  month.yearMonth.year = NaN;
  manager.months = [month];
  const add = vi.spyOn(month, 'addTimelineAsset').mockImplementation(() => {});
  const assets = timelineAssetFactory.buildList(2, { localDateTime: { year: NaN, month: 10, day: 1 } });
  expect(() => manager.insert(assets)).toThrow();
  expect(add).not.toHaveBeenCalled();
  expect(manager.months).toHaveLength(1);
});

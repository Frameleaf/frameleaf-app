import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { TimelineManager } from '../timeline-manager.svelte';
import { isMismatched, updateObject } from './utils.svelte';

const managers: TimelineManager[] = [];
afterEach(() => {
  for (const manager of managers) {
    manager.destroy();
  }
  managers.length = 0;
});

it('updates every nested field after a scalar or earlier nested change', () => {
  const first = { value: 1 };
  const second = { value: 2 };
  const target = { scalar: false, first, second };
  expect(updateObject(target, { scalar: true, first: { value: 3 }, second: { value: 4 } })).toBe(true);
  expect(target).toEqual({ scalar: true, first: { value: 3 }, second: { value: 4 } });
  expect(target.first).toBe(first);
  expect(target.second).toBe(second);
  expect(updateObject(target, { first: { value: 5 }, second: { value: 6 } })).toBe(true);
  expect(target.second.value).toBe(6);
});

it('preserves omitted fields and does not report unchanged records', () => {
  const target = { metadata: { city: 'Edmonton', country: 'Canada' }, isFavorite: false };
  expect(updateObject(target, { metadata: { city: 'Edmonton' } })).toBe(false);
  expect(updateObject(target, { metadata: { city: 'Calgary' } })).toBe(true);
  expect(target).toEqual({ metadata: { city: 'Calgary', country: 'Canada' }, isFavorite: false });
});

it.each([null, undefined, false, 0, 'cleared'])('replaces a nested record with %s', (value) => {
  const target: { metadata: unknown } = { metadata: { city: 'Edmonton' } };
  expect(updateObject(target, { metadata: value })).toBe(true);
  expect(target.metadata).toBe(value);
});

it('installs metadata where the previous value was null', () => {
  const target: { metadata: unknown } = { metadata: null };
  const source = Object.freeze({ metadata: Object.freeze({ city: 'Edmonton' }) });
  expect(updateObject(target, source)).toBe(true);
  expect(target.metadata).toEqual({ city: 'Edmonton' });
  expect(source.metadata).toEqual({ city: 'Edmonton' });
});

it.each([[], ['one'], ['two', 'one'], ['one', 'two', 'three']].map((values) => ({ values })))(
  'replaces array snapshots with $values',
  ({ values }) => {
    const target = { tags: ['one', 'two'] };
    const source = Object.freeze({ tags: Object.freeze(values) });
    expect(updateObject(target, source)).toBe(true);
    expect(target.tags).toEqual(values);
    expect(source.tags).toEqual(values);
  },
);

it('retains equal arrays without rewriting their property', () => {
  const values = ['one', 'two'];
  const set = vi.fn();
  const target = {
    get tags() {
      return values;
    },
    set tags(value: string[]) {
      set(value);
    },
  };
  expect(updateObject(target, { tags: ['one', 'two'] })).toBe(false);
  expect(target.tags).toBe(values);
  expect(set).not.toHaveBeenCalled();
});

it('handles nullable arrays and record/array type changes', () => {
  const target: { metadata: unknown } = { metadata: ['one'] };
  expect(updateObject(target, { metadata: null })).toBe(true);
  expect(target.metadata).toBeNull();
  expect(updateObject(target, { metadata: ['two'] })).toBe(true);
  expect(target.metadata).toEqual(['two']);
  expect(updateObject(target, { metadata: { city: 'Edmonton' } })).toBe(true);
  expect(target.metadata).toEqual({ city: 'Edmonton' });
});

it('treats Date values as replacements and retains identical Date references', () => {
  const first = new Date('2024-01-01T00:00:00Z');
  const second = new Date('2024-02-01T00:00:00Z');
  const target: { date: unknown } = { date: first };
  expect(updateObject(target, { date: first })).toBe(false);
  expect(updateObject(target, { date: second })).toBe(true);
  expect(target.date).toBe(second);
  expect(updateObject(target, { date: { year: 2024 } })).toBe(true);
  expect(target.date).toEqual({ year: 2024 });
});

it('ignores inherited and dangerous keys at every existing record level', () => {
  const source = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"nested":{"__proto__":{"polluted":true},"safe":2}}',
  );
  Object.setPrototypeOf(source, { inherited: true });
  const target = { nested: { safe: 1 } };
  expect(updateObject(target, source)).toBe(true);
  expect(target).toEqual({ nested: { safe: 2 } });
  expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(target.nested)).toBe(Object.prototype);
  expect(Object.hasOwn(target, 'constructor')).toBe(false);
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
});

it('reads each changed scalar once and propagates source getter errors', () => {
  const targetRead = vi.fn(() => 1);
  const sourceRead = vi.fn(() => 2);
  const write = vi.fn();
  const target = Object.defineProperty({}, 'value', { get: targetRead, set: write, enumerable: true });
  const source = Object.defineProperty({}, 'value', { get: sourceRead, enumerable: true });
  expect(updateObject(target, source)).toBe(true);
  expect(targetRead).toHaveBeenCalledTimes(1);
  expect(sourceRead).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(2);
  const failure = new Error('metadata unavailable');
  expect(() =>
    updateObject(
      {},
      {
        get value() {
          throw failure;
        },
      },
    ),
  ).toThrow(failure);
});

it('ignores missing update roots', () => {
  expect(updateObject(null, { value: 1 })).toBe(false);
  expect(updateObject({}, undefined)).toBe(false);
  expect(updateObject({}, null)).toBe(false);
});

it('retains optional-filter strict comparison semantics', () => {
  expect(isMismatched(undefined, true)).toBe(false);
  expect(isMismatched(false, false)).toBe(false);
  expect(isMismatched(false, true)).toBe(true);
  expect(isMismatched(null, null)).toBe(false);
  expect(isMismatched(null, undefined)).toBe(true);
});

it('updates all timeline dates and moves the existing asset to its new month after a scalar change', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  const manager = new TimelineManager();
  managers.push(manager);
  await manager.updateViewport({ width: 1000, height: 700 });
  const january = fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z');
  const march = fromISODateTimeUTCToObject('2024-03-20T14:00:00.000Z');
  const april = fromISODateTimeUTCToObject('2024-04-20T15:00:00.000Z');
  const original = timelineAssetFactory.build({
    ratio: 1,
    localDateTime: january,
    createdAt: { ...january },
    fileCreatedAt: { ...january },
  });
  manager.upsertAssets([original]);
  const stored = manager.months[0].getFirstAsset();
  const update = Object.freeze({
    ...original,
    ratio: 2,
    localDateTime: march,
    createdAt: april,
    fileCreatedAt: { ...march },
  });
  manager.upsertAssets([update]);
  const month = manager.months.find((month) => month.yearMonth.month === 3)!;
  expect(month).toBeDefined();
  expect(month.getFirstAsset()).toBe(stored);
  expect(stored.localDateTime).toEqual(march);
  expect(stored.createdAt).toEqual(april);
  expect(stored.fileCreatedAt).toEqual(march);
  expect(manager.assetCount).toBe(1);
  expect(manager.months.find((month) => month.yearMonth.month === 1)?.getAssets()).toEqual([]);
});

it('removes stale people, tags and stack metadata through real timeline upserts', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  const manager = new TimelineManager();
  managers.push(manager);
  await manager.updateViewport({ width: 1000, height: 700 });
  const original = timelineAssetFactory.build({
    tags: ['one', 'two'],
    people: ['Ada', 'Grace'],
    stack: { id: 'stack', assetCount: 2, primaryAssetId: 'primary' },
  });
  manager.upsertAssets([original]);
  const stored = manager.months[0].getFirstAsset();
  manager.upsertAssets([{ ...original, tags: ['one'], people: [], stack: null }]);
  expect(stored.tags).toEqual(['one']);
  expect(stored.people).toEqual([]);
  expect(stored.stack).toBeNull();
  expect(manager.assetCount).toBe(1);
});

it('removes an existing asset from a filtered timeline when its selected tag is removed', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  const manager = new TimelineManager();
  managers.push(manager);
  await manager.updateOptions({ tagId: 'two' });
  await manager.updateViewport({ width: 1000, height: 700 });
  const original = timelineAssetFactory.build({ tags: ['one', 'two'] });
  manager.upsertAssets([original]);
  expect(manager.assetCount).toBe(1);
  manager.upsertAssets([{ ...original, tags: ['one'] }]);
  expect(manager.assetCount).toBe(0);
});

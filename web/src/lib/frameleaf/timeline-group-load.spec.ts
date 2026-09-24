import { describe, expect, it, vi } from 'vitest';
import { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
import { loadMonthsInOrder, selectGroupAfterLoading } from '$lib/frameleaf/timeline-group-load';

type Month = { key: string; ids: string[]; loaded: boolean };

const month = (key: string, loaded = false): Month => ({ key, ids: [`${key}-a`, `${key}-b`], loaded });

/** A load that finishes only when the test says so, to act while it is in flight. */
const deferredLoads = () => {
  const pending: { month: Month; finish: () => void }[] = [];
  const load = (target: Month) =>
    new Promise<void>((resolve) => {
      pending.push({
        month: target,
        finish: () => {
          target.loaded = true;
          resolve();
        },
      });
    });
  return { pending, load };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('loadMonthsInOrder', () => {
  it('loads the missing months one at a time, in order', async () => {
    const months = [month('2024-12'), month('2024-11', true), month('2024-10')];
    const { pending, load } = deferredLoads();
    const result = loadMonthsInOrder(months, { isLoaded: (m) => m.loaded, load, isCurrent: () => true });
    await flush();
    expect(pending.map(({ month }) => month.key)).toEqual(['2024-12']);
    pending[0].finish();
    await flush();
    // Never more than one request in flight; the loaded month is skipped.
    expect(pending.map(({ month }) => month.key)).toEqual(['2024-12', '2024-10']);
    pending[1].finish();
    await expect(result).resolves.toBe('done');
  });

  it('stops as soon as the request is no longer current', async () => {
    const months = [month('2024-12'), month('2024-11')];
    const { pending, load } = deferredLoads();
    let current = true;
    const result = loadMonthsInOrder(months, { isLoaded: (m) => m.loaded, load, isCurrent: () => current });
    await flush();
    current = false;
    pending[0].finish();
    await expect(result).resolves.toBe('stale');
    expect(pending).toHaveLength(1);
  });

  it('retries a load the manager cancelled, then reports the group incomplete', async () => {
    const load = vi.fn().mockResolvedValue('CANCELED');
    const failing = vi.fn().mockRejectedValue(new Error('network'));
    await expect(
      loadMonthsInOrder([month('2024-12')], { isLoaded: (m) => m.loaded, load, isCurrent: () => true }),
    ).resolves.toBe('incomplete');
    expect(load).toHaveBeenCalledTimes(2);
    await expect(
      loadMonthsInOrder([month('2024-12')], { isLoaded: (m) => m.loaded, load: failing, isCurrent: () => true }),
    ).resolves.toBe('incomplete');
  });
});

describe('selectGroupAfterLoading', () => {
  const store = () => new LibrarySessionStore({ userId: 'user-1', pageSize: 10 });

  it('selects the whole group once its months are loaded', async () => {
    const session = store();
    const months = [month('2024-12', true), month('2024-11')];
    const { pending, load } = deferredLoads();
    const result = selectGroupAfterLoading(session, {
      months,
      checked: true,
      isLoaded: (m) => m.loaded,
      load,
      idsOf: () => months.filter((m) => m.loaded).flatMap((m) => m.ids),
    });
    await flush();
    expect(session.selection).toEqual([]);
    pending[0].finish();
    await expect(result).resolves.toBe('done');
    expect(session.selection).toEqual(['2024-12-a', '2024-12-b', '2024-11-a', '2024-11-b']);
  });

  it('drops the result when the scope changes while the months load', async () => {
    const session = store();
    const months = [month('2024-12')];
    const { pending, load } = deferredLoads();
    const result = selectGroupAfterLoading(session, {
      months,
      checked: true,
      isLoaded: (m) => m.loaded,
      load,
      idsOf: () => months.flatMap((m) => m.ids),
    });
    await flush();
    session.setScope({ kind: 'album', id: 'album-2' });
    session.select('new-scope-asset');
    pending[0].finish();
    await expect(result).resolves.toBe('stale');
    // The old scope's ids never reach the new scope's selection.
    expect(session.selection).toEqual(['new-scope-asset']);
  });

  it('drops the result when the query changes while the months load', async () => {
    const session = store();
    const months = [month('2024-12')];
    const { pending, load } = deferredLoads();
    const result = selectGroupAfterLoading(session, {
      months,
      checked: true,
      isLoaded: (m) => m.loaded,
      load,
      idsOf: () => months.flatMap((m) => m.ids),
    });
    await flush();
    session.patchView({ sort: 'rating' });
    pending[0].finish();
    await expect(result).resolves.toBe('stale');
    expect(session.selection).toEqual([]);
  });

  it('drops the result when a newer group click superseded it', async () => {
    const session = store();
    const months = [month('2024-12')];
    const { pending, load } = deferredLoads();
    let latest = true;
    const result = selectGroupAfterLoading(session, {
      months,
      checked: true,
      isLoaded: (m) => m.loaded,
      load,
      idsOf: () => months.flatMap((m) => m.ids),
      isLatest: () => latest,
    });
    await flush();
    latest = false;
    pending[0].finish();
    await expect(result).resolves.toBe('stale');
    expect(session.selection).toEqual([]);
  });

  it('clears a group without loading anything', async () => {
    const session = store();
    session.select('2024-12-a');
    session.select('other');
    const load = vi.fn();
    await expect(
      selectGroupAfterLoading(session, {
        months: [month('2024-12', true), month('2024-11')],
        checked: false,
        isLoaded: (m) => m.loaded,
        load,
        idsOf: () => ['2024-12-a', '2024-12-b'],
      }),
    ).resolves.toBe('done');
    expect(load).not.toHaveBeenCalled();
    expect(session.selection).toEqual(['other']);
  });
});

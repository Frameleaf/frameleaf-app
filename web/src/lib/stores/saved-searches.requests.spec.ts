import type { SavedSearch, UserPreferencesResponseDto } from '@frameleaf/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { toSavedSearch } from '$lib/frameleaf/search-palette';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { savedSearchesStore as searches } from '$lib/stores/saved-searches.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

const query = (text: string) => ({ ...emptyDiscoveryQuery(), text });
const item = (name: string) => toSavedSearch(name, query(name));
const preferences = (savedSearches: SavedSearch[], revision = 'r1') =>
  preferencesFactory.build({ savedSearches, revision });
const deferred = () => {
  let resolve!: (value: UserPreferencesResponseDto) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<UserPreferencesResponseDto>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const names = () => searches.list.map(({ name }) => name);
const load = async (list: SavedSearch[] = [], revision = 'r1') => {
  sdkMock.getMyPreferences.mockResolvedValue(preferences(list, revision));
  await searches.load();
};

beforeEach(async () => {
  sdkMock.getMyPreferences.mockResolvedValue(preferences([]));
  eventManager.emit('AuthLogout');
  eventManager.emit('AuthLogout');
  await Promise.resolve();
  vi.resetAllMocks();
});

describe('saved search reads', () => {
  it('shares one read with a hundred readers and retains the fulfilled cache', async () => {
    const request = deferred();
    sdkMock.getMyPreferences.mockReturnValue(request.promise);
    const readers = Array.from({ length: 100 }, () => searches.load());
    try {
      await vi.waitFor(() => expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(1));
    } finally {
      request.resolve(preferences([item('A')]));
      await Promise.all(readers);
    }
    await searches.load();
    expect(names()).toEqual(['A']);
    expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(1);
  });

  it('orders an explicit reload after the preceding read settles', async () => {
    const old = deferred();
    sdkMock.getMyPreferences.mockReturnValueOnce(old.promise).mockResolvedValue(preferences([item('Fresh')], 'r2'));
    const first = searches.load();
    await vi.waitFor(() => expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(1));
    const force = searches.load(true);
    try {
      expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(1);
    } finally {
      old.resolve(preferences([item('Old')]));
      await Promise.all([first, force]);
    }
    expect(names()).toEqual(['Fresh']);
  });

  it('does not clear a newer reload when an older read fails', async () => {
    const old = deferred();
    const fresh = deferred();
    sdkMock.getMyPreferences.mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise);
    const first = searches.load();
    await vi.waitFor(() => expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(1));
    const force = searches.load(true);
    old.reject(new Error('old offline'));
    await first;
    await vi.waitFor(() => expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(2));
    const joined = searches.load();
    fresh.resolve(preferences([item('Fresh')]));
    await Promise.all([force, joined]);
    expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(2);
    expect(names()).toEqual(['Fresh']);
  });

  it('shares a reader submitted synchronously during SDK setup', async () => {
    const request = deferred();
    let joined: Promise<void> | undefined;
    sdkMock.getMyPreferences
      .mockImplementationOnce(() => {
        joined = searches.load();
        return request.promise;
      })
      .mockResolvedValue(preferences([]));
    const first = searches.load();
    try {
      await vi.waitFor(() => expect(joined).toBeDefined());
      expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(1);
    } finally {
      request.resolve(preferences([item('Shared')]));
      await Promise.all([first, joined]);
    }
  });

  it('lets a replacement read finish when access changes during SDK setup', async () => {
    const old = deferred();
    let replacement: Promise<void> | undefined;
    sdkMock.getMyPreferences
      .mockImplementationOnce(() => {
        eventManager.emit('AuthLogout');
        replacement = searches.load();
        return old.promise;
      })
      .mockResolvedValue(preferences([item('Current')]));
    const first = searches.load();
    let joined: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(names()).toEqual(['Current']));
      await replacement;
      let settled = false;
      joined = searches.load().then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
    } finally {
      old.resolve(preferences([item('Old')]));
      await Promise.all([first, replacement, joined]);
    }
    expect(names()).toEqual(['Current']);
  });
});

describe('saved search revisions', () => {
  it('requires a fresh base before another edit after the conflict reload failed', async () => {
    await load([item('Old')]);
    sdkMock.getMyPreferences
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(preferences([item('Remote')], 'r2'));
    sdkMock.updateMyPreferences.mockRejectedValueOnce(new Error('conflict')).mockImplementation((request) => {
      return request.userPreferencesUpdateDto.expectedRevision === 'r2'
        ? Promise.resolve(preferences([item('B'), item('Remote')], 'r3'))
        : Promise.reject(new Error('still stale'));
    });
    const first = searches.save('A', query('A'));
    const second = searches.save('B', query('B'));
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(sdkMock.updateMyPreferences.mock.calls[1][0]).toEqual({
      userPreferencesUpdateDto: { savedSearches: [item('B'), item('Remote')], expectedRevision: 'r2' },
    });
  });

  it('reads the server list before the first save instead of replacing searches it has not loaded', async () => {
    sdkMock.getMyPreferences.mockResolvedValue(preferences([item('Existing')], 'r1'));
    sdkMock.updateMyPreferences.mockResolvedValue(preferences([item('New'), item('Existing')], 'r2'));
    expect(await searches.save('New', query('New'))).toBe(true);
    expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(1);
    expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { savedSearches: [item('New'), item('Existing')], expectedRevision: 'r1' },
    });
  });

  it('refuses a first write when its initial server read fails', async () => {
    sdkMock.getMyPreferences.mockRejectedValue(new Error('offline'));
    sdkMock.updateMyPreferences.mockResolvedValue(preferences([item('New')], 'r2'));
    expect(await searches.save('New', query('New'))).toBe(false);
    expect(sdkMock.updateMyPreferences).not.toHaveBeenCalled();
  });

  it('builds two simultaneous saves from successive lists and revisions', async () => {
    await load();
    const firstResponse = deferred();
    sdkMock.updateMyPreferences
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue(preferences([item('B'), item('A')], 'r3'));
    const first = searches.save('A', query('A'));
    const second = searches.save('B', query('B'));
    try {
      await vi.waitFor(() => expect(sdkMock.updateMyPreferences).toHaveBeenCalledTimes(1));
    } finally {
      firstResponse.resolve(preferences([item('A')], 'r2'));
      await Promise.all([first, second]);
    }
    expect(sdkMock.updateMyPreferences.mock.calls[1][0]).toEqual({
      userPreferencesUpdateDto: { savedSearches: [item('B'), item('A')], expectedRevision: 'r2' },
    });
    expect(names()).toEqual(['B', 'A']);
  });

  it('applies a queued removal to the preceding successful save', async () => {
    await load([item('Keep'), item('Remove')]);
    const firstResponse = deferred();
    sdkMock.updateMyPreferences
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue(preferences([item('New'), item('Keep')], 'r3'));
    const first = searches.save('New', query('New'));
    const second = searches.remove('Remove');
    firstResponse.resolve(preferences([item('New'), item('Keep'), item('Remove')], 'r2'));
    await Promise.all([first, second]);
    expect(sdkMock.updateMyPreferences.mock.calls[1][0]).toEqual({
      userPreferencesUpdateDto: { savedSearches: [item('New'), item('Keep')], expectedRevision: 'r2' },
    });
  });

  it('waits for a preceding refresh before deriving a write and its expected revision', async () => {
    await load([item('Old')]);
    const read = deferred();
    sdkMock.getMyPreferences.mockReturnValue(read.promise);
    sdkMock.updateMyPreferences.mockResolvedValue(preferences([item('New'), item('Remote')], 'r3'));
    const refresh = searches.load(true);
    await vi.waitFor(() => expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(2));
    const save = searches.save('New', query('New'));
    try {
      expect(sdkMock.updateMyPreferences).not.toHaveBeenCalled();
    } finally {
      read.resolve(preferences([item('Remote')], 'r2'));
      await Promise.all([refresh, save]);
    }
    expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { savedSearches: [item('New'), item('Remote')], expectedRevision: 'r2' },
    });
  });

  it('runs a refresh requested during a write afterward and keeps its newer server result', async () => {
    await load();
    const write = deferred();
    sdkMock.updateMyPreferences.mockReturnValue(write.promise);
    sdkMock.getMyPreferences.mockResolvedValue(preferences([item('Remote')], 'r3'));
    const saving = searches.save('New', query('New'));
    await vi.waitFor(() => expect(sdkMock.updateMyPreferences).toHaveBeenCalledTimes(1));
    const refreshing = searches.load(true);
    try {
      expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(1);
    } finally {
      write.resolve(preferences([item('New')], 'r2'));
      await Promise.all([saving, refreshing]);
    }
    expect(names()).toEqual(['Remote']);
  });

  it('uses a conflict reload as the base for the next queued edit', async () => {
    await load([item('Old')]);
    sdkMock.getMyPreferences.mockResolvedValue(preferences([item('Remote')], 'r2'));
    sdkMock.updateMyPreferences
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValue(preferences([item('B'), item('Remote')], 'r3'));
    const first = searches.save('A', query('A'));
    const second = searches.save('B', query('B'));
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(sdkMock.updateMyPreferences.mock.calls[1][0]).toEqual({
      userPreferencesUpdateDto: { savedSearches: [item('B'), item('Remote')], expectedRevision: 'r2' },
    });
  });

  it('captures a queued query when save is called', async () => {
    await load();
    const firstResponse = deferred();
    sdkMock.updateMyPreferences
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue(preferences([item('B'), item('A')], 'r3'));
    const first = searches.save('A', query('A'));
    const submitted = query('before');
    const second = searches.save('B', submitted);
    submitted.text = 'after';
    firstResponse.resolve(preferences([item('A')], 'r2'));
    await Promise.all([first, second]);
    expect(sdkMock.updateMyPreferences.mock.calls[1][0].userPreferencesUpdateDto.savedSearches?.[0].query).toEqual(
      toSavedSearch('B', query('before')).query,
    );
  });
});

describe('saved search access ownership', () => {
  it('rechecks access between an initial read and the write continuation', async () => {
    const request = deferred();
    sdkMock.getMyPreferences.mockImplementation(() => {
      void request.promise.then(() => queueMicrotask(() => eventManager.emit('AuthLogout')));
      return request.promise;
    });
    sdkMock.updateMyPreferences.mockResolvedValue(preferences([item('Private')]));
    const saving = searches.save('A', query('A'));
    await vi.waitFor(() => expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(1));
    request.resolve(preferences([item('Private')], 'ra1'));
    expect(await saving).toBe(false);
    expect(sdkMock.updateMyPreferences).not.toHaveBeenCalled();
    expect(names()).toEqual([]);
  });

  it('retires queued operations before SDK dispatch when access is revoked', async () => {
    sdkMock.getMyPreferences.mockResolvedValue(preferences([]));
    sdkMock.updateMyPreferences.mockResolvedValue(preferences([item('Private')]));
    const reading = searches.load();
    const saving = searches.save('Private', query('Private'));
    eventManager.emit('AuthLogout');
    await reading;
    expect(await saving).toBe(false);
    expect(sdkMock.getMyPreferences).not.toHaveBeenCalled();
    expect(sdkMock.updateMyPreferences).not.toHaveBeenCalled();
    expect(names()).toEqual([]);
  });

  it('does not report a stale write as saved after an account change', async () => {
    eventManager.emit('AuthUserLoaded', userAdminFactory.build());
    await load([item('A')]);
    const write = deferred();
    sdkMock.updateMyPreferences.mockReturnValue(write.promise);
    const saving = searches.save('Private', query('Private'));
    await vi.waitFor(() => expect(sdkMock.updateMyPreferences).toHaveBeenCalledTimes(1));
    sdkMock.getMyPreferences.mockResolvedValue(preferences([item('B')], 'rb'));
    eventManager.emit('AuthUserLoaded', userAdminFactory.build());
    await searches.load();
    write.resolve(preferences([item('Private')]));
    expect(await saving).toBe(false);
    expect(names()).toEqual(['B']);
  });

  it('does not refresh the revoked account after an old write fails', async () => {
    await load();
    const write = deferred();
    sdkMock.updateMyPreferences.mockReturnValue(write.promise);
    const saving = searches.save('A', query('A'));
    await vi.waitFor(() => expect(sdkMock.updateMyPreferences).toHaveBeenCalledTimes(1));
    eventManager.emit('AuthLogout');
    write.reject(new Error('old offline'));
    expect(await saving).toBe(false);
    expect(sdkMock.getMyPreferences).toHaveBeenCalledTimes(1);
    expect(searches.loaded).toBe(false);
  });

  it('lets a new account read and save without waiting for the old write', async () => {
    await load([item('A')]);
    const old = deferred();
    sdkMock.updateMyPreferences.mockReturnValueOnce(old.promise).mockResolvedValue(preferences([item('B')], 'rb2'));
    const first = searches.save('Private', query('Private'));
    await vi.waitFor(() => expect(sdkMock.updateMyPreferences).toHaveBeenCalledTimes(1));
    eventManager.emit('AuthLogout');
    sdkMock.getMyPreferences.mockResolvedValue(preferences([], 'rb1'));
    eventManager.emit('AuthUserLoaded', userAdminFactory.build());
    const second = searches.save('B', query('B'));
    try {
      await vi.waitFor(() => expect(sdkMock.updateMyPreferences).toHaveBeenCalledTimes(2), { timeout: 200 });
      expect(await second).toBe(true);
    } finally {
      old.resolve(preferences([item('Private')], 'ra2'));
      await Promise.all([first, second]);
    }
    expect(sdkMock.updateMyPreferences.mock.calls[1][0].userPreferencesUpdateDto.expectedRevision).toBe('rb1');
    expect(names()).toEqual(['B']);
  });

  it('drops restricted searches immediately and loads the filtered list after a lock', async () => {
    await load([item('Private'), item('Visible')]);
    sdkMock.getMyPreferences.mockResolvedValue(preferences([item('Visible')], 'r2'));
    eventManager.emit('SessionLocked');
    expect(names()).toEqual([]);
    expect(searches.loaded).toBe(false);
    await searches.load();
    expect(names()).toEqual(['Visible']);
  });
});

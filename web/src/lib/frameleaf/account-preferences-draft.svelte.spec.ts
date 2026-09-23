import type { UserPreferencesResponseDto, UserPreferencesUpdateDto } from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SECTION_KEYS } from '$lib/frameleaf/account-preferences';
import { AccountPreferencesDraftStore } from '$lib/frameleaf/account-preferences-draft.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';

vi.mock('@immich/sdk', async (originalImport) => ({
  ...(await originalImport<typeof import('@immich/sdk')>()),
  isHttpError: (error: unknown) => typeof error === 'object' && error !== null && 'status' in error,
}));

vi.mock('$lib/utils/handle-error', () => ({
  getServerErrorMessage: (error: { data?: { message?: string } }) => error?.data?.message,
}));

const httpError = (status: number, message: string) => ({ status, data: { message } });

const loaded = preferencesFactory.build({
  people: { enabled: true, sidebarWeb: false, minimumFaces: 3 },
  download: { archiveSize: 1_234_567, includeEmbeddedVideos: false },
  emailNotifications: { enabled: true, albumInvite: true, albumUpdate: true },
  revision: 'revision-1',
});

describe('AccountPreferencesDraftStore (FL-77)', () => {
  let save: ReturnType<typeof vi.fn<(update: UserPreferencesUpdateDto) => Promise<UserPreferencesResponseDto>>>;
  let load: ReturnType<typeof vi.fn<() => Promise<UserPreferencesResponseDto>>>;
  let onUpdated: ReturnType<typeof vi.fn<(preferences: UserPreferencesResponseDto) => void>>;

  const adminStore = () => new AccountPreferencesDraftStore(loaded, { role: 'admin', save, load, onUpdated });

  beforeEach(() => {
    save = vi.fn();
    load = vi.fn();
    onUpdated = vi.fn();
  });

  it('keeps one draft across pages and saves only the changes with the loaded revision', async () => {
    const saved = preferencesFactory.build({ ...loaded, tags: { enabled: true, sidebarWeb: false }, revision: 'r2' });
    save.mockResolvedValue(saved);
    const store = adminStore();

    store.set('tags.enabled', true);
    store.setEmailNotifications(false);
    expect(store.dirty).toBe(true);

    await expect(store.save()).resolves.toBe(saved);
    expect(save).toHaveBeenCalledWith({
      tags: { enabled: true },
      emailNotifications: { enabled: false, albumInvite: false, albumUpdate: false },
      expectedRevision: 'revision-1',
    });
    expect(store.revision).toBe('r2');
    expect(store.notice).toBe('saved');
    expect(onUpdated).toHaveBeenCalledWith(saved);
  });

  it('keeps the draft and reports it stale when the server refuses a stale save', async () => {
    save.mockRejectedValue(httpError(409, 'These preferences changed after they were loaded.'));
    const store = adminStore();
    store.set('memories.duration', 9);

    await expect(store.save()).resolves.toBeUndefined();
    expect(store.stale).toBe(true);
    expect(store.error).toBeNull();
    expect(store.draft['memories.duration']).toBe(9);
    expect(store.revision).toBe('revision-1');
  });

  it('loads the latest preferences when the draft is discarded', async () => {
    const latest = preferencesFactory.build({
      ...loaded,
      memories: { ...loaded.memories, duration: 7 },
      revision: 'r3',
    });
    save.mockRejectedValue(httpError(409, 'changed'));
    load.mockResolvedValue(latest);
    const store = adminStore();
    store.set('memories.duration', 9);
    await store.save();

    await expect(store.loadLatest()).resolves.toBe(true);
    expect(store.stale).toBe(false);
    expect(store.dirty).toBe(false);
    expect(store.draft['memories.duration']).toBe(7);
    expect(store.revision).toBe('r3');
    expect(store.notice).toBe('latest_loaded');
  });

  it('keeps the draft and a clear error when a save fails for another reason', async () => {
    save.mockRejectedValue(httpError(403, 'Casting has been turned off by your administrator'));
    const store = adminStore();
    store.set('ratings.enabled', true);

    await store.save();
    expect(store.error).toEqual({ code: 'save_failed', detail: 'Casting has been turned off by your administrator' });
    expect(store.draft['ratings.enabled']).toBe(true);
    expect(store.stale).toBe(false);

    store.set('ratings.enabled', false);
    expect(store.error).toBeNull();
  });

  it('checks values before saving and does not call the server with an invalid value', async () => {
    const store = adminStore();
    store.set('people.minimumFaces', 0);

    await store.save();
    expect(store.error).toEqual({ code: 'minimum_faces' });
    expect(save).not.toHaveBeenCalled();
  });

  it('cancels back to the loaded values and resets one page to defaults', () => {
    const store = adminStore();
    store.set('tags.enabled', true);
    store.cancel();
    expect(store.dirty).toBe(false);

    store.resetSection('preferences');
    expect(store.draft['download.archiveSize']).toBe(4 * 1024 ** 3);
    expect(store.notice).toBe('defaults_restored');
    expect(store.dirty).toBe(true);
  });

  it("follows another group's save on the account's own settings page without losing its changes", () => {
    const store = new AccountPreferencesDraftStore(loaded, {
      role: 'self',
      keys: SECTION_KEYS.notifications,
      rebaseUnrelated: true,
      save,
      load,
    });
    store.setEmailNotifications(false);

    store.follow(preferencesFactory.build({ ...loaded, tags: { enabled: true, sidebarWeb: false }, revision: 'r2' }));

    expect(store.stale).toBe(false);
    expect(store.revision).toBe('r2');
    expect(store.draft['emailNotifications.enabled']).toBe(false);
  });
});

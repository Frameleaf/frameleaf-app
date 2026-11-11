import type { UserPreferencesResponseDto } from '@frameleaf/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { DEFAULT_LIBRARY_VIEW } from '$lib/frameleaf/library-view';
import { LibraryViewStore } from '$lib/frameleaf/library-view.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';

const preferences = (libraryView?: Record<string, unknown>) =>
  ({ libraryView }) as unknown as UserPreferencesResponseDto;

describe('LibraryViewStore (FL-1398)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(authManager, 'authenticated', 'get').mockReturnValue(true);
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(false);
    vi.spyOn(authManager, 'preferences', 'get').mockReturnValue(preferences({ groupBy: 'month', archived: true }));
    vi.spyOn(authManager, 'setPreferences').mockImplementation(() => {});
    sdkMock.updateMyPreferences.mockResolvedValue(preferences());
  });
  afterEach(() => vi.useRealTimers());

  it("reads the account's choices over the defaults", () => {
    expect(new LibraryViewStore().value).toEqual({ ...DEFAULT_LIBRARY_VIEW, groupBy: 'month', archived: true });
  });

  it('shows a change at once and saves switches flipped together in one request', async () => {
    const store = new LibraryViewStore();
    store.set({ ratings: false });
    store.set({ browseNames: true });
    expect(store.value).toMatchObject({ ratings: false, browseNames: true, groupBy: 'month' });
    expect(sdkMock.updateMyPreferences).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(sdkMock.updateMyPreferences).toHaveBeenCalledExactlyOnceWith({
      userPreferencesUpdateDto: { libraryView: { ratings: false, browseNames: true } },
    });
    expect(authManager.setPreferences).toHaveBeenCalledOnce();
  });

  it('keeps what this tab chose when the server does not store it', async () => {
    // an older server drops the group and answers without it
    const store = new LibraryViewStore();
    store.set({ stacksTogether: false });
    await vi.runAllTimersAsync();
    expect(store.value.stacksTogether).toBe(false);
  });

  it('resets every option, the stored ones too', async () => {
    const store = new LibraryViewStore();
    store.reset();
    expect(store.value).toEqual(DEFAULT_LIBRARY_VIEW);
    await vi.runAllTimersAsync();
    expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { libraryView: DEFAULT_LIBRARY_VIEW },
    });
  });

  it('gives a shared-link visitor the defaults and saves nothing', async () => {
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    const store = new LibraryViewStore();
    expect(store.value).toEqual(DEFAULT_LIBRARY_VIEW);
    store.set({ crop: false });
    await vi.runAllTimersAsync();
    expect(store.value.crop).toBe(false);
    expect(sdkMock.updateMyPreferences).not.toHaveBeenCalled();
  });
});

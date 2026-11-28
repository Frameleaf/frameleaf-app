import { updateMyPreferences } from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { t } from 'svelte-i18n';
import { persisted } from 'svelte-persisted-store';
import { get, writable } from 'svelte/store';
import { nameCollatorFor } from '$lib/frameleaf/album-directory';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { handleError } from '$lib/utils/handle-error';

/**
 * FL-1836 (owner 2026-11-27): the sidebar shows Pinned and Recent albums instead of the whole album tree.
 * Pinned albums are listed A to Z until someone drags one; from then on the order they set is kept
 * (`albums.pinnedCustomOrder`), and Sort A to Z goes back. Both live in the account's preferences, so
 * every device shows the same list. Recent is the albums opened on this device, newest first.
 */
export const PINNED_ALBUMS_MAX = 50;
export const RECENT_ALBUMS_MAX = 20;

/** Albums opened on this device, most recent first: a per-device convenience, never authority. */
export const recentAlbumIds = persisted<string[]>('frameleaf-recent-albums', []);

export const rememberOpenedAlbum = (albumId: string) =>
  recentAlbumIds.update((ids) => [albumId, ...ids.filter((id) => id !== albumId)].slice(0, RECENT_ALBUMS_MAX));

/**
 * The pinned albums in the order the sidebar lists them: A to Z by name unless the person set their own
 * order. Pins whose album is gone or out of reach are left out.
 */
export const pinnedInOrder = <T extends { id: string; name: string }>(
  pinned: string[],
  customOrder: boolean,
  find: (id: string) => T | undefined,
  locale?: string,
): T[] => {
  const collator = nameCollatorFor(locale);
  const albums = pinned.map((id) => find(id)).filter((album): album is T => !!album);
  return customOrder ? albums : albums.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
};

/** The ids with `albumId` placed at `index` (a drop, or ⌥↑ ⌥↓). */
export const placePinned = (ids: string[], albumId: string, index: number): string[] => {
  const next = ids.filter((id) => id !== albumId);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, albumId);
  return next;
};

/**
 * Saves run one after another, each from the list the last one left, so pinning two albums quickly keeps
 * both. `latest` is that list until the saves are done; then the account's preferences are the truth again.
 */
let latest: { pinned: string[]; custom: boolean } | undefined;
/** The pins as they will be once the saves in flight land: for labels that must not lag behind a click. */
export const pendingPins = writable<string[] | undefined>(undefined);
const setLatest = (value: typeof latest) => {
  latest = value;
  pendingPins.set(value?.pinned);
};
let queue: Promise<boolean> = Promise.resolve(true);
let waiting = 0;

const current = () =>
  latest ?? {
    pinned: authManager.preferences.albums.pinned ?? [],
    custom: authManager.preferences.albums.pinnedCustomOrder ?? false,
  };

const save = (pinned: string[], pinnedCustomOrder: boolean) => {
  setLatest({ pinned, custom: pinnedCustomOrder });
  waiting++;
  queue = queue.then(async () => {
    try {
      const preferences = await updateMyPreferences({
        userPreferencesUpdateDto: { albums: { pinned, pinnedCustomOrder } },
      });
      authManager.setPreferences(preferences);
      return true;
    } catch (error) {
      setLatest(undefined);
      handleError(error, get(t)('frameleaf_albums_pinned_save_failed'));
      return false;
    } finally {
      waiting--;
      if (waiting === 0) {
        setLatest(undefined);
      }
    }
  });
  return queue;
};

export const pinnedAlbumIds = () => current().pinned;
export const isPinned = (albumId: string) => pinnedAlbumIds().includes(albumId);

/**
 * Pin an album (it joins the end of a custom order) or unpin it. `known` are the albums this page can see:
 * only when the limit is reached are the other pins dropped to make room, as a page lists one workspace's
 * albums and the pins of the other workspace must survive a pin made here.
 */
export const togglePinned = (albumId: string, known?: (id: string) => boolean) => {
  const { pinned: saved, custom } = current();
  const pinned =
    known && saved.length >= PINNED_ALBUMS_MAX && !saved.includes(albumId) ? saved.filter((id) => known(id)) : saved;
  if (pinned.includes(albumId)) {
    return save(
      pinned.filter((id) => id !== albumId),
      custom,
    );
  }
  if (pinned.length >= PINNED_ALBUMS_MAX) {
    toastManager.primary(get(t)('frameleaf_albums_pin_limit', { values: { count: PINNED_ALBUMS_MAX } }));
    return Promise.resolve(false);
  }
  return save([...pinned, albumId], custom);
};

/** A drag set this order: it is kept from now on. */
export const savePinnedOrder = (ids: string[]) => save(ids, true);

/** Sort A to Z: back to alphabetical. */
export const sortPinnedByName = () => save(pinnedAlbumIds(), false);

/** For specs: the recent list as it stands. */
export const recentAlbums = () => get(recentAlbumIds);

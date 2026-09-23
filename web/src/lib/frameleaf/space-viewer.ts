import { filterToNew } from '$lib/frameleaf/shared-space';
import { Route } from '$lib/route';

/**
 * A shared space's own viewer (FL-55).
 *
 * A space is its own context, so opening one of its photos stays in it: the viewer lives at
 * `/sharing/{spaceId}/photos/{assetId}`, next and previous walk the space's photos in the order the
 * space's grid shows them, and Back returns to the space page on the panel the member left. These
 * are the rules that decide that, kept apart from the components so they can be read and tested on
 * their own.
 */

/**
 * The viewer address for one item in a space.
 *
 * The page's own query rides along — it names the open panel — so closing the viewer lands on the
 * same panel. `at` is dropped: it is a grid scroll hint for other pages and means nothing here.
 */
export const spaceAssetHref = (spaceId: string, assetId: string, search = ''): string => {
  const params = new URLSearchParams(search);
  params.delete('at');
  const query = params.toString();
  return Route.viewSharedSpaceAsset({ spaceId, assetId }) + (query ? `?${query}` : '');
};

/**
 * The list next and previous walk through.
 *
 * It is the grid's own list: every loaded item in the space, or — while a member is looking at only
 * what is new — just the new ones, in the same order. An item opened from somewhere other than that
 * narrowed grid (the map, a comment, a linked album) is not in the narrowed list, so the viewer
 * walks the whole space instead of offering no neighbours at all.
 */
export const spaceViewerList = <T extends { id: string }>(
  assets: T[],
  filter: Set<string> | undefined,
  currentId?: string | null,
): T[] => (filter && currentId && filter.has(currentId) ? filterToNew(assets, filter) : assets);

/** How close to the end of what is loaded the viewer may get before the next page is asked for. */
export const VIEWER_LOOKAHEAD = 5;

/**
 * How many pages the viewer will read looking for an item that is not loaded yet. A space's photos
 * are paged by date taken, so an item opened from a comment or the map can be anywhere; this bounds
 * the search for one that is not in the space at all (an old link, or an item since removed).
 */
export const VIEWER_SEEK_PAGES = 40;

/**
 * Whether the viewer should ask for another page of the space.
 *
 * Two reasons: the open item is not loaded yet, so its neighbours are unknown; or it is close to
 * the end of what is loaded, so "next" would stop short of the real end of the space.
 */
export const shouldPageForViewer = ({
  index,
  length,
  page,
  exhausted,
  loading,
  failed,
}: {
  /** Where the open item is in the loaded list, or -1 when it is not there. */
  index: number;
  length: number;
  /** The last page loaded; 0 before the first. */
  page: number;
  exhausted: boolean;
  loading: boolean;
  failed: boolean;
}): boolean => {
  if (exhausted || loading || failed) {
    return false;
  }
  if (index === -1) {
    return page < VIEWER_SEEK_PAGES;
  }
  return index >= length - 1 - VIEWER_LOOKAHEAD;
};

/** True when a navigation goes from a page into its viewer (the target names an item, the source does not). */
export const isEnteringViewer = (
  from: { params?: Record<string, string> | null } | null | undefined,
  to: { params?: Record<string, string> | null } | null | undefined,
): boolean => !!to?.params?.assetId && !from?.params?.assetId;

/** True when a navigation closes the viewer back onto its page. */
export const isLeavingViewer = (
  from: { params?: Record<string, string> | null } | null | undefined,
  to: { params?: Record<string, string> | null } | null | undefined,
): boolean => !!from?.params?.assetId && !!to && !to.params?.assetId;

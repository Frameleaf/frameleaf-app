import type { IdsFilter } from '@immich/sdk';
import { contextDiscoveryState, type DiscoveryContext } from '$lib/components/discovery/query';
import { readLibraryView } from '$lib/frameleaf/library-session';

/**
 * The query the top bar's search opens on (FL-48).
 *
 * The page's own search, or the scope the route stands for (an album, a pet, a shared space), comes
 * from `contextDiscoveryState`. A library page also carries its session's portable view state in the
 * URL (`fl`); its query and scope are added, so the filters the results toolbar shows as chips are
 * the filters the search dialog opens with. Searching again never resets a scope nobody asked to
 * leave.
 */

/** Require one more id in an id-list condition, keeping every group it already has. */
const requireId = (condition: IdsFilter | undefined, id: string): IdsFilter => {
  if (!condition) {
    return { any: [id] };
  }
  if ((condition.all ?? []).includes(id) || (condition.any?.length === 1 && condition.any[0] === id)) {
    return condition;
  }
  return { ...condition, all: [...new Set([...(condition.all ?? []), id])] };
};

export const searchContextFor = (url: URL): DiscoveryContext => {
  const context = contextDiscoveryState(url);
  if (/^\/(?:search|discover)(?:\/|$)/.test(url.pathname)) {
    return context;
  }
  const view = readLibraryView(url);
  if (!view) {
    return context;
  }
  const route = context.query;
  const query = structuredClone(view.query);
  if (view.scope.kind === 'album' && view.scope.id) {
    query.filter.albumIds = requireId(query.filter.albumIds, view.scope.id);
  }
  if (view.scope.kind === 'space' && view.scope.id && !query.spaceId) {
    query.spaceId = view.scope.id;
  }
  for (const field of ['albumIds', 'petIds'] as const) {
    for (const id of route.filter[field]?.any ?? []) {
      query.filter[field] = requireId(query.filter[field], id);
    }
  }
  if (route.spaceId && !query.spaceId) {
    query.spaceId = route.spaceId;
  }
  return { query, unsupported: [] };
};

import { LibraryScope, LibraryViewScope, type AlbumResponseDto, type IdsFilter } from '@frameleaf/sdk';
import { emptyDiscoveryQuery, contextDiscoveryState, type DiscoveryContext } from '$lib/components/discovery/query';
import { writeLibraryView, createLibrarySession, readLibraryView } from '$lib/frameleaf/library-session';

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
  if (/^\/(?:search|discover|pro)(?:\/|$)/.test(url.pathname)) {
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

/** Album membership remains required while the chosen workspace supplies its content scope. */
export const albumSearchContext = (url: URL, album: Pick<AlbumResponseDto, 'id' | 'libraryScope'>) => {
  const query = searchContextFor(url).query;
  const libraryScope =
    query.filter.libraryScope ??
    (album.libraryScope === LibraryScope.Design ? LibraryViewScope.Design : LibraryViewScope.Personal);
  return { ...query, filter: { ...query.filter, libraryScope, albumIds: requireId(query.filter.albumIds, album.id) } };
};

/** Workspace context travels through existing album routes without copying their data. */
export const workspaceHref = (href: string, scope: LibraryViewScope | undefined, origin: string) => {
  if (scope !== LibraryViewScope.Design) {
    return href;
  }
  const url = writeLibraryView(new URL(href, origin), {
    ...createLibrarySession().state,
    query: { ...emptyDiscoveryQuery(), filter: { libraryScope: LibraryViewScope.Design } },
  });
  return url.pathname + url.search;
};

/** New file publication uses the workspace that admitted the picker or drop. */
export const libraryUploadScope = (url: URL, album?: Pick<AlbumResponseDto, 'libraryScope'>) =>
  searchContextFor(url).query.filter.libraryScope === LibraryViewScope.Design ||
  album?.libraryScope === LibraryScope.Design
    ? LibraryScope.Design
    : undefined;

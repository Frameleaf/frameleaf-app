import { isHttpError } from '@immich/sdk';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import type { RouteId } from '$app/types';
import { COMMAND_CENTER_PATH } from '$lib/frameleaf/settings-areas';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { Route } from '$lib/route';

export type AssetGridRouteSearchParams = {
  at: string | null | undefined;
};

export const isPhotosRoute = (route?: string | null) => !!route?.startsWith('/(user)/photos/[[assetId=id]]');
const isRecentlyAddedRoute = (route?: string | null) => !!route?.startsWith('/(user)/recently-added/[[assetId=id]]');
const isSharedLinkSlugRoute = (route?: string | null) => !!route?.startsWith('/(user)/s/[slug]');
export const isSharedLinkRoute = (route?: string | null) =>
  !!route?.startsWith('/(user)/share/[key]') || isSharedLinkSlugRoute(route);
export const isAlbumsRoute = (route?: string | null) => !!route?.startsWith('/(user)/albums/[albumId=id]');
export const isPeopleRoute = (route?: string | null) => !!route?.startsWith('/(user)/people/[personId]');
export const isLockedFolderRoute = (route?: string | null) => !!route?.startsWith('/(user)/locked');

export const isAssetViewerRoute = (
  target?: { route?: { id?: RouteId | null }; params?: Record<string, string> | null } | null,
) => !!(target?.route?.id?.endsWith('/[[assetId=id]]') && 'assetId' in (target?.params || {}));

export function getAssetInfoFromParam({ assetId, slug, key }: { assetId?: string; key?: string; slug?: string }) {
  return assetId ? assetCacheManager.getAsset({ id: assetId, slug, key }, false) : undefined;
}

/**
 * FL-33: the page a deep link to `assetId` opens over, without the item (`/photos/<id>` → `/photos`,
 * `/albums/<a>/photos/<id>` → `/albums/<a>`), keeping the page's own query. Used when the linked
 * item is gone or no longer readable, so the library opens instead of an error page.
 */
export const libraryUrlWithoutAsset = (url: URL, assetId: string): string => {
  const suffixes = [`/photos/${assetId}`, `/${assetId}`];
  const suffix = suffixes.find((candidate) => url.pathname.endsWith(candidate));
  const pathname = suffix ? url.pathname.slice(0, -suffix.length) || Route.photos() : url.pathname;
  return `${pathname === '/' ? Route.photos() : pathname}${url.search}`;
};

/** An item that is gone or that the session may no longer read: not found, forbidden or refused. */
export const isInaccessibleAssetError = (error: unknown) =>
  isHttpError(error) && [400, 403, 404].includes(error.status);

/** The Command Center (FL-71) opens an item over its page with `?assetId=`, for utilities and Trash alike. */
const isCommandCenter = () => page.url.pathname === COMMAND_CENTER_PATH;

function currentUrlWithoutAsset() {
  if (isCommandCenter()) {
    const params = new URLSearchParams(page.url.search);
    params.delete('assetId');
    return `${page.url.pathname}?${params}`;
  }
  // This contains special casing for the /photos/:assetId route, which hangs directly
  // off / instead of a subpath, unlike every other asset-containing route.
  if (isPhotosRoute(page.route.id)) {
    return Route.photos() + page.url.search;
  }
  if (isRecentlyAddedRoute(page.route.id)) {
    return Route.recentlyAdded() + page.url.search;
  }
  return isSharedLinkSlugRoute(page.route.id)
    ? Route.viewSharedLink({ slug: page.data.slug, key: page.data.key }) + page.url.search
    : page.url.pathname.replace(/(\/photos.*)$/, '') + page.url.search;
}

export function currentUrlReplaceAssetId(assetId: string) {
  const params = new URLSearchParams(page.url.search);
  if (isCommandCenter()) {
    params.delete('at');
    params.set('assetId', assetId);
    return `${page.url.pathname}?${params}`;
  }
  // always remove the assetGridScrollTargetParams
  params.delete('at');
  const paramsString = params.toString();
  const searchparams = paramsString === '' ? '' : '?' + params.toString();
  // this contains special casing for the /photos/:assetId photos route, which hangs directly
  // off / instead of a subpath, unlike every other asset-containing route.
  if (isPhotosRoute(page.route.id)) {
    return `${Route.viewAsset({ id: assetId })}${searchparams}`;
  }

  if (isRecentlyAddedRoute(page.route.id)) {
    return `${Route.viewRecentlyAddedAsset({ id: assetId })}${searchparams}`;
  }

  return `${page.url.pathname.replace(/\/photos\/[^/]+$/, '')}/photos/${assetId}${searchparams}`;
}

function replaceScrollTarget(url: string, searchParams?: AssetGridRouteSearchParams | null) {
  const parsed = new URL(url, page.url);

  const { at: assetId } = searchParams || { at: null };

  if (!assetId) {
    return parsed.pathname;
  }

  const params = new URLSearchParams(page.url.search);
  if (assetId) {
    params.set('at', assetId);
  }
  return parsed.pathname + '?' + params.toString();
}

function currentUrl() {
  const current = page.url;
  return current.pathname + current.search + current.hash;
}

interface Route {
  /**
   * The route to target, or 'current' to stay on current route.
   */
  targetRoute: string | 'current';
}

interface AssetRoute extends Route {
  targetRoute: 'current';
  assetId: string | null | undefined;
}
interface AssetGridRoute extends Route {
  targetRoute: 'current';
  assetId: string | null | undefined;
  assetGridRouteSearchParams: AssetGridRouteSearchParams | null | undefined;
}

type ImmichRoute = AssetRoute | AssetGridRoute;

type NavOptions = {
  /* navigate even if url is the same */
  forceNavigate?: boolean | undefined;
  replaceState?: boolean | undefined;
  noScroll?: boolean | undefined;
  keepFocus?: boolean | undefined;
  invalidateAll?: boolean | undefined;
  state?: App.PageState | undefined;
};

function isAssetRoute(route: Route): route is AssetRoute {
  return route.targetRoute === 'current' && 'assetId' in route;
}

function isAssetGridRoute(route: Route): route is AssetGridRoute {
  return route.targetRoute === 'current' && 'assetId' in route && 'assetGridRouteSearchParams' in route;
}

async function navigateAssetRoute(route: AssetRoute, options?: NavOptions) {
  const { assetId } = route;
  const next = assetId ? currentUrlReplaceAssetId(assetId) : currentUrlWithoutAsset();
  const current = currentUrl();
  if (next !== current || options?.forceNavigate) {
    await goto(next, options);
  }
}

async function navigateAssetGridRoute(route: AssetGridRoute, options?: NavOptions) {
  const { assetId, assetGridRouteSearchParams: assetGridScrollTarget } = route;
  const assetUrl = assetId ? currentUrlReplaceAssetId(assetId) : currentUrlWithoutAsset();
  const next = replaceScrollTarget(assetUrl, assetGridScrollTarget);
  const current = currentUrl();
  if (next !== current || options?.forceNavigate) {
    await goto(next, options);
  }
}

export function navigate(change: ImmichRoute, options?: NavOptions): Promise<void> {
  if (isAssetGridRoute(change)) {
    return navigateAssetGridRoute(change, options);
  }
  if (isAssetRoute(change)) {
    return navigateAssetRoute(change, options);
  }
  // future navigation requests here
  throw `Invalid navigation: ${JSON.stringify(change)}`;
}

export const clearQueryParam = async (queryParam: string, url: URL) => {
  if (!url.searchParams.has(queryParam)) {
    return;
  }

  url.searchParams.delete(queryParam);
  await goto(url, { keepFocus: true });
};

export const setQueryValue = async (queryKey: string, queryValue: string) => {
  const url = location.href;
  const urlObject = new URL(url);
  urlObject.searchParams.set(queryKey, queryValue);
  await goto(urlObject, { keepFocus: true });
};

import { getMaintenanceStatus, MaintenanceAction, maintenanceLogin } from '@frameleaf/sdk';
import { isLicenseRelay } from '$lib/frameleaf/license-relay';
import { Route } from '$lib/route';
import { maintenanceStore } from '$lib/stores/maintenance.store';
import { websocketStore } from '$lib/stores/websocket';

export function maintenanceCreateUrl(url: URL) {
  // CLD-004: a licence link code (or an old key) is never carried on into another address
  const target = isLicenseRelay(url.pathname + url.search) ? url.pathname : url.pathname + url.search;
  return new URL(Route.maintenanceMode({ continue: target }), url.origin).href;
}

export function maintenanceReturnUrl(searchParams: URLSearchParams) {
  return Route.continue(searchParams.get('continue'), '/');
}

export function maintenanceShouldRedirect(maintenanceMode: boolean, currentUrl: URL | Location) {
  return maintenanceMode !== currentUrl.pathname.startsWith(Route.maintenanceMode());
}

/**
 * The maintenance token the address carries: in the fragment (`#token=…`, which the browser never
 * sends, so it stays out of server and proxy access logs) or, for links the server still issues, in
 * the query.
 */
export const maintenanceTokenOf = (url: Pick<URL, 'hash' | 'search'>): string | undefined =>
  new URLSearchParams(url.hash.replace(/^#/, '')).get('token') ??
  new URLSearchParams(url.search).get('token') ??
  undefined;

/**
 * Signs in to maintenance with the address's `token`, or the cookie a previous sign-in left.
 * Resolves `rejected` only when the address carried a token the server refused (expired after its
 * 4 hours, or from an earlier maintenance session), so the page can say so (FL-81); without a token a
 * refusal just means the visitor is not an administrator.
 */
export const loadMaintenanceAuth = async (): Promise<'signed-in' | 'rejected' | 'anonymous'> => {
  const token = maintenanceTokenOf(location);

  try {
    const auth = await maintenanceLogin({
      maintenanceLoginDto: {
        token,
      },
    });

    maintenanceStore.auth.set(auth);
    return 'signed-in';
  } catch {
    return token ? 'rejected' : 'anonymous';
  }
};

export const loadMaintenanceStatus = async () => {
  while (true) {
    try {
      const status = await getMaintenanceStatus();
      maintenanceStore.status.set(status);

      if (status.action === MaintenanceAction.End && !status.active) {
        websocketStore.serverRestarting.set({
          isMaintenanceMode: false,
        });
      }

      break;
    } catch (error) {
      const status = (error as { status: number })?.status;
      if (status && status >= 500 && status < 600) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      throw error;
    }
  }
};

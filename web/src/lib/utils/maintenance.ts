import { getMaintenanceStatus, MaintenanceAction, maintenanceLogin } from '@immich/sdk';
import { Route } from '$lib/route';
import { maintenanceStore } from '$lib/stores/maintenance.store';
import { websocketStore } from '$lib/stores/websocket';

export function maintenanceCreateUrl(url: URL) {
  return new URL(Route.maintenanceMode({ continue: url.pathname + url.search }), url.origin).href;
}

export function maintenanceReturnUrl(searchParams: URLSearchParams) {
  return Route.continue(searchParams.get('continue'), '/');
}

export function maintenanceShouldRedirect(maintenanceMode: boolean, currentUrl: URL | Location) {
  return maintenanceMode !== currentUrl.pathname.startsWith(Route.maintenanceMode());
}

/**
 * Signs in to maintenance with the address's `token`, or the cookie a previous sign-in left.
 * Resolves `rejected` only when the address carried a token the server refused (expired after its
 * 4 hours, or from an earlier maintenance session), so the page can say so (FL-81); without a token a
 * refusal just means the visitor is not an administrator.
 */
export const loadMaintenanceAuth = async (): Promise<'signed-in' | 'rejected' | 'anonymous'> => {
  const token = new URLSearchParams(location.search).get('token') ?? undefined;

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

      if (status.action === MaintenanceAction.End) {
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

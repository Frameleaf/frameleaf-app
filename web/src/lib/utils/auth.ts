import { getStorage } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { setupRedirect } from '$lib/frameleaf/first-run-setup';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { Route } from '$lib/route';
import { userInteraction } from '$lib/stores/user.svelte';

export interface AuthOptions {
  admin?: true;
  public?: boolean;
}

export const authenticate = async (url: URL, options?: AuthOptions) => {
  const { public: publicRoute, admin: adminRoute } = options || {};
  await authManager.load();

  if (publicRoute) {
    return;
  }

  if (!authManager.authenticated) {
    redirect(307, Route.login({ continue: url.pathname + url.search }));
  }

  if (adminRoute && !authManager.user.isAdmin) {
    redirect(307, Route.photos());
  }

  // FL-176: until Frameleaf setup is complete, an administrator is sent to it; others are not.
  let server: { isInitialized: boolean; isOnboarded: boolean } | undefined;
  try {
    server = serverConfigManager.value;
  } catch {
    server = undefined;
  }
  const setup = server ? setupRedirect(url.pathname, authManager.user, server) : null;
  if (setup) {
    redirect(307, setup);
  }
};

export const requestServerInfo = async () => {
  if (!authManager.authenticated) {
    return;
  }

  const data = await getStorage();
  userInteraction.serverInfo = data;
};

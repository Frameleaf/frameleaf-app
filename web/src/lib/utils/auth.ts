import { getStorage } from '@frameleaf/sdk';
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
  // a config that cannot be read fails the load rather than letting it past the setup redirect
  const server = await serverConfigManager.ready();
  // The path is read only while setup could redirect. Reading `url.pathname` here made every page
  // load that calls this depend on the path, so opening or closing an item in an album (or any other
  // view with the item in its address) loaded the whole page's data again.
  const setup = setupRedirect(() => url.pathname, authManager.user, server);
  if (setup) {
    redirect(307, setup);
  }
};

export const requestServerInfo = async () => {
  if (!authManager.authenticated) {
    return;
  }

  const isCurrent = authManager.captureSession();
  const data = await getStorage();
  if (isCurrent()) {
    userInteraction.serverInfo = data;
  }
};

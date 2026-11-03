import { redirect } from '@sveltejs/kit';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { Route } from '$lib/route';
import { init } from '$lib/utils/server-client';
import type { PageLoad } from './$types';

export const ssr = false;
export const csr = true;

/**
 * The address everyone lands on first. FL-708 (UI review items 1 and B5): a server nobody has set up
 * goes straight to setup's one welcome (`/auth/register`), which also offers "Restore from a backup";
 * there is no second welcome page in front of it.
 */
export const load = (async ({ fetch }) => {
  await init(fetch);

  if (serverConfigManager.value.maintenanceMode) {
    redirect(307, Route.maintenanceMode());
  }

  await authManager.load();
  if (authManager.authenticated) {
    redirect(307, Route.photos());
  }

  redirect(307, serverConfigManager.value.isInitialized ? Route.login() : Route.register());
}) satisfies PageLoad;

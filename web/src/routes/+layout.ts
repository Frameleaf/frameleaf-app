import { commandPaletteManager } from '@immich/ui';
import { goto } from '$app/navigation';
import { languageManager } from '$lib/managers/language-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { Route } from '$lib/route';
import { initLanguage } from '$lib/utils';
import { maintenanceCreateUrl, maintenanceReturnUrl, maintenanceShouldRedirect } from '$lib/utils/maintenance';
import { init } from '$lib/utils/server';
import type { LayoutLoad } from './$types';

export const ssr = false;
export const csr = true;

export const load = (async ({ fetch, url }) => {
  // FL-295: while the server gets ready (the safety copy before the first upgrade) it answers only this
  // page and its status; every other API call is refused, so nothing else is loaded here.
  if (url.pathname.startsWith(Route.gettingReady())) {
    await initLanguage();
    languageManager.init();
    return { error: undefined, meta: { title: 'Frameleaf' } };
  }

  let error;
  try {
    await init(fetch);

    if (maintenanceShouldRedirect(serverConfigManager.value.maintenanceMode, url)) {
      await goto(
        serverConfigManager.value.maintenanceMode ? maintenanceCreateUrl(url) : maintenanceReturnUrl(url.searchParams),
      );
    }
  } catch (initError) {
    error = initError;
  }

  commandPaletteManager.enable();
  languageManager.init();

  return {
    error,
    meta: {
      title: 'Frameleaf',
    },
  };
}) satisfies LayoutLoad;

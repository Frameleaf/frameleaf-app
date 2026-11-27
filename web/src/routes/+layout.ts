import { commandPaletteManager } from '@frameleaf/ui';
import { goto } from '$app/navigation';
import { languageManager } from '$lib/managers/language-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { loadRouteMessages } from '$lib/utils/i18n';
import { maintenanceCreateUrl, maintenanceReturnUrl, maintenanceShouldRedirect } from '$lib/utils/maintenance';
import { init } from '$lib/utils/server-client';
import type { LayoutLoad } from './$types';

export const ssr = false;
export const csr = true;

export const load = (async ({ fetch, url, route }) => {
  let error;
  try {
    await init(fetch);
    // FL-1797: the messages of the part of the app being opened, before it is drawn.
    await loadRouteMessages(route.id);

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

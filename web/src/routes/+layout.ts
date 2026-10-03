import { commandPaletteManager } from '@immich/ui';
import { goto } from '$app/navigation';
import { fetchStorageMigrationStatus, gettingReadyWaitsFor } from '$lib/frameleaf/storage-migration';
import { languageManager } from '$lib/managers/language-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { Route } from '$lib/route';
import { initLanguage } from '$lib/utils';
import { maintenanceCreateUrl, maintenanceReturnUrl, maintenanceShouldRedirect } from '$lib/utils/maintenance';
import { init } from '$lib/utils/server';
import type { LayoutLoad } from './$types';

export const ssr = false;
export const csr = true;

/** FL-326: whether this app load already asked if Getting Ready waits for the storage migration. */
let storageMigrationChecked = false;

/**
 * FL-326: while the one-time storage migration runs and nobody chose to let it run in the background,
 * reopening Frameleaf returns to Getting Ready. Sign-in stays reachable, so an administrator can sign
 * in to send it to the background. Asked once per app load.
 */
const waitsForStorageMigration = async (fetchFn: typeof fetch, url: URL) => {
  if (storageMigrationChecked || url.pathname.startsWith('/auth') || url.pathname.startsWith(Route.maintenanceMode())) {
    return false;
  }
  storageMigrationChecked = true;
  return gettingReadyWaitsFor(await fetchStorageMigrationStatus(fetchFn));
};

export const load = (async ({ fetch, url }) => {
  // FL-295: while the server gets ready (the safety copy before the first upgrade) it answers only this
  // page and its status; every other API call is refused, so nothing else is loaded here.
  if (url.pathname.startsWith(Route.gettingReady())) {
    await initLanguage();
    languageManager.init();
    return { error: undefined, meta: { title: 'Frameleaf' } };
  }

  if (await waitsForStorageMigration(fetch, url)) {
    await goto(Route.gettingReady({ continue: `${url.pathname}${url.search}` }));
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

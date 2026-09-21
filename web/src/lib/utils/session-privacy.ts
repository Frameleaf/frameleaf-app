import { browser } from '$app/environment';
import { downloadManager } from '$lib/managers/download-manager.svelte';

/** Discard route-independent protected state when elevated access is revoked. */
export const revokeSessionView = (destination: string) => {
  if (!browser) {
    return;
  }

  // Conceal portals and the current viewer before any asynchronous navigation.
  // Keep the old document concealed if navigation fails: a reload must authorize
  // fresh results before they can be displayed again.
  document.documentElement.style.setProperty('display', 'none', 'important');
  for (const media of document.querySelectorAll('video, audio')) {
    (media as HTMLMediaElement).pause();
  }
  downloadManager.clearAll();

  // A SvelteKit navigation retains singleton result caches and in-flight work.
  // Replace the whole document so they cannot repopulate a locked route.
  location.replace(destination);
};

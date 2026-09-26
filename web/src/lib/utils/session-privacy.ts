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
  const exitingPictureInPicture = clearSessionMedia();

  // A SvelteKit navigation retains singleton result caches and in-flight work.
  // Replace the whole document so they cannot repopulate a locked route.
  if (exitingPictureInPicture) {
    void exitingPictureInPicture.then(() => location.replace(destination));
  } else {
    location.replace(destination);
  }
};

/**
 * FL-83: stop already-playing media, Picture-in-Picture and downloads. Also used on its own while the
 * local lock shield is up, before the document is replaced.
 */
export const clearSessionMedia = () => {
  if (!browser) {
    return;
  }
  // Feature detection retains Firefox support, where native PiP is not exposed.
  const exitingPictureInPicture =
    'exitPictureInPicture' in document &&
    // eslint-disable-next-line tscompat/tscompat, compat/compat -- Guarded by the browser PiP API feature check.
    document.pictureInPictureElement
      ? // eslint-disable-next-line tscompat/tscompat, compat/compat -- Guarded by the browser PiP API feature check.
        document.exitPictureInPicture().catch(() => {})
      : undefined;
  const clearMedia = (root: Document | ShadowRoot) => {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        clearMedia(element.shadowRoot);
      }
      // The production HLS custom element unloads its HLS.js instance when src
      // is removed. Its native player lives in an open shadow root.
      if (element.localName === 'hls-video') {
        element.removeAttribute('src');
        element.removeAttribute('poster');
      }
      if (element instanceof HTMLMediaElement) {
        try {
          element.pause();
          const safariVideo = element as HTMLVideoElement & { webkitSetPresentationMode?: (mode: string) => void };
          safariVideo.webkitSetPresentationMode?.('inline');
        } catch {
          // A failed player API must not prevent source removal or navigation.
        }
        element.removeAttribute('src');
        element.removeAttribute('poster');
        element.srcObject = null;
        for (const source of element.querySelectorAll('source')) {
          source.remove();
        }
        try {
          element.load();
        } catch {
          // Continue clearing other players and discard the document.
        }
      }
    }
  };
  clearMedia(document);
  downloadManager.clearAll();

  return exitingPictureInPicture;
};

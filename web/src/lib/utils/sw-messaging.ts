const hasServiceWorker = globalThis.isSecureContext && 'serviceWorker' in navigator;
const serviceWorker = hasServiceWorker ? navigator.serviceWorker : undefined;

export function cancelImageUrl(url: string | undefined | null) {
  if (!url || !hasServiceWorker) {
    return;
  }
  serviceWorker!.controller?.postMessage({ type: 'cancel', url });
}

/** FL-1595: library access changed; the service worker reauthorizes every image URL again. */
export function reportAccessChange() {
  if (!hasServiceWorker) {
    return;
  }
  serviceWorker!.controller?.postMessage({ type: 'access' });
}

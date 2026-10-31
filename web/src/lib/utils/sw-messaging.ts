const hasServiceWorker = globalThis.isSecureContext && 'serviceWorker' in navigator;
const serviceWorker = hasServiceWorker ? navigator.serviceWorker : undefined;

export function cancelImageUrl(url: string | undefined | null) {
  if (!url || !hasServiceWorker) {
    return;
  }
  serviceWorker!.controller?.postMessage({ type: 'cancel', url });
}

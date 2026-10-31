/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { installMessageListener } from './messaging';
import { handleFetch as handleAssetFetch } from './request';

const ASSET_REQUEST_REGEX = /^\/api\/assets\/[a-f0-9-]+\/(original|thumbnail)/;

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

const handleLifecycle = (event: ExtendableEvent) => {
  event.waitUntil(event.type === 'install' ? sw.skipWaiting() : sw.clients.claim());
};

const handleFetch = (event: FetchEvent): void => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin || !ASSET_REQUEST_REGEX.test(url.pathname)) {
    return;
  }
  // The browser owns byte ranges and preconditions; a URL alone cannot identify their responses.
  if (
    ['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'].some((name) =>
      event.request.headers.has(name),
    )
  ) {
    return;
  }
  event.respondWith(handleAssetFetch(event.request));
};

sw.addEventListener('install', handleLifecycle, { passive: true });
sw.addEventListener('activate', handleLifecycle, { passive: true });
sw.addEventListener('fetch', handleFetch, { passive: true });
installMessageListener();

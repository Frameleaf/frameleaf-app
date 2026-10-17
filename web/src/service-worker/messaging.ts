/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { handleCancel } from './request';

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

const handleMessage = (event: ExtendableMessageEvent) => {
  if (!event.source || event.data?.type !== 'cancel' || typeof event.data.url !== 'string' || !event.data.url) {
    return;
  }
  let url: URL;
  try {
    url = new URL(event.data.url, sw.location.origin);
  } catch {
    return;
  }
  if (url.origin === sw.location.origin) {
    handleCancel(url);
  }
};

export const installMessageListener = () => sw.addEventListener('message', handleMessage);

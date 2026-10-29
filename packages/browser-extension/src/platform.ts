import type { CaptureState } from './queue';
import type { CapturePreview } from './preview';
import type { ConnectionStatus } from './settings';
import {
  CaptureFailure,
  normalizeServerAddress,
  serverPermissionPattern,
} from './api';

export type ExtensionRequest =
  | {
      type:
        | 'status'
        | 'refresh'
        | 'disconnect'
        | 'discover'
        | 'bookmark'
        | 'queue'
        | 'wake-queue';
    }
  | {
      type:
        'preview' | 'retry-capture' | 'cancel-capture' | 'release-screenshot';
      id: string;
    }
  | { type: 'screenshot'; mode: 'visible' | 'area' }
  | { type: 'create-album'; previewId: string; name: string; parentId?: string }
  | { type: 'release-candidates'; id: string; candidateIds: string[] }
  | {
      type: 'connect';
      address: string;
      token: string;
      allowLocalhost?: boolean;
    };
export interface QueueItem {
  id: string;
  label: string;
  state: CaptureState;
  offset: number;
  total?: number;
  retryAt?: number;
  error?: string;
  canRetry: boolean;
  canCancel: boolean;
}
export interface QueueProgress {
  items: QueueItem[];
  unfinished: number;
  hasMore: boolean;
  error?: string;
}
export type ExtensionReply =
  | {
      ok: true;
      connection: ConnectionStatus | null;
      preview?: CapturePreview;
      queue?: QueueProgress;
      albumId?: string;
    }
  | { ok: false; error: string; connection?: ConnectionStatus | null };
export const trustedStorage = () => chrome.storage.local;
export function trustedSender(
  sender: chrome.runtime.MessageSender,
  pages = ['/options.html', '/popup.html'],
): boolean {
  try {
    const url = new URL(sender.url ?? '');
    return (
      sender.id === chrome.runtime.id &&
      url.protocol === 'chrome-extension:' &&
      url.hostname === chrome.runtime.id &&
      pages.includes(url.pathname)
    );
  } catch {
    return false;
  }
}
export const hasServerAccess = (origin: string) =>
  chrome.permissions.contains({ origins: [serverPermissionPattern(origin)] });
export async function requestServerAccess(
  raw: string,
  allowLocalhost: boolean,
) {
  const origin = normalizeServerAddress(raw, allowLocalhost);
  if (
    !(await chrome.permissions.request({
      origins: [serverPermissionPattern(origin)],
    }))
  )
    throw new CaptureFailure('permission');
  return origin;
}
export const sendRequest = (
  request: ExtensionRequest,
): Promise<ExtensionReply> => chrome.runtime.sendMessage(request);
export const openOptions = () => chrome.runtime.openOptionsPage();
export function registerBackground(
  handler: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ) => Promise<ExtensionReply>,
  initialize: () => Promise<void>,
  permissionsChanged: () => Promise<void>,
) {
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    void handler(message, sender).then(reply);
    return true;
  });
  const start = () => {
    void initialize().catch(() => {});
  };
  chrome.runtime.onInstalled.addListener(start);
  chrome.runtime.onStartup.addListener(start);
  chrome.permissions.onRemoved.addListener(() => {
    void permissionsChanged().catch(() => {});
  });
  start();
}
export function watchConnection(changed: () => void) {
  const listener = (
    _changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area === 'local') changed();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export const openCapturePreview = (id: string) =>
  chrome.tabs.create({
    url: chrome.runtime.getURL(`capture.html?id=${encodeURIComponent(id)}`),
  });

function mediaPermissionPattern(origin: string) {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Choose a valid image origin.');
  return `${url.protocol}//${url.hostname}/*`;
}
export const hasMediaAccess = (origin: string) =>
  chrome.permissions.contains({ origins: [mediaPermissionPattern(origin)] });
export const requestMediaAccess = (origin: string) =>
  chrome.permissions.request({ origins: [mediaPermissionPattern(origin)] });

export function watchMediaAccess(removed: () => void) {
  chrome.permissions.onRemoved.addListener(removed);
  return () => chrome.permissions.onRemoved.removeListener(removed);
}

const deliveryAlarm = 'frameleaf-capture-queue';
export const ensureDeliveryAlarm = () =>
  chrome.alarms.create(deliveryAlarm, { periodInMinutes: 1 });
export function registerDeliveryAlarm(wake: () => void) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === deliveryAlarm) wake();
  });
}

export const requestMediaOrigins = (origins: string[]) =>
  chrome.permissions.request({
    origins: [...new Set(origins.map(mediaPermissionPattern))],
  });

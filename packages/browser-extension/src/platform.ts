import type { CapturePreview } from './preview';
import type { ConnectionStatus } from './settings';
import {
  CaptureFailure,
  normalizeServerAddress,
  serverPermissionPattern,
} from './api';

export type ExtensionRequest =
  | { type: 'status' | 'refresh' | 'disconnect' | 'discover' }
  | { type: 'preview'; id: string }
  | {
      type: 'connect';
      address: string;
      token: string;
      allowLocalhost?: boolean;
    };
export type ExtensionReply =
  | { ok: true; connection: ConnectionStatus | null; preview?: CapturePreview }
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

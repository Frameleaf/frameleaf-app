import { candidateUrl } from './candidates';
import {
  DiscoveryFailure,
  parseDiscovery,
  type PageDiscovery,
} from './discovery';
const imageMenu = 'frameleaf-save-image';
const pageMenu = 'frameleaf-save-page';
let initialization: Promise<void> | undefined;
export function initializeCaptureMenus(): Promise<void> {
  return (initialization ??= (async () => {
    // Callback completion preserves Chrome 116 support; menu promises arrived later.
    await new Promise<void>((resolve, reject) =>
      chrome.contextMenus.removeAll(() => {
        if (chrome.runtime.lastError) reject(new DiscoveryFailure());
        else resolve();
      }),
    );
    for (const [id, title, context] of [
      [imageMenu, 'Save image to Frameleaf', 'image'],
      [pageMenu, 'Save page bookmark to Frameleaf', 'page'],
    ] as const) {
      await new Promise<void>((resolve, reject) => {
        chrome.contextMenus.create(
          {
            id,
            title,
            contexts: [context],
            documentUrlPatterns: ['https://*/*', 'http://*/*'],
          },
          () => {
            if (chrome.runtime.lastError) reject(new DiscoveryFailure());
            else resolve();
          },
        );
      });
    }
  })().catch((error) => {
    initialization = undefined;
    throw error;
  }));
}
export function registerCaptureMenus(
  handler: (
    info: chrome.contextMenus.OnClickData,
    tab?: chrome.tabs.Tab,
  ) => Promise<void>,
) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handler(info, tab).catch(() => {});
  });
}
/** Context-menu invocation pins the clicked tab; it never scans the foreground tab. */
export async function discoverMenuPage(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
): Promise<PageDiscovery> {
  try {
    if (
      !tab?.id ||
      !tab.url ||
      info.pageUrl !== tab.url ||
      (info.frameId !== undefined && info.frameId !== 0) ||
      (info.frameUrl !== undefined && info.frameUrl !== tab.url) ||
      (info.menuItemId !== imageMenu && info.menuItemId !== pageMenu)
    )
      throw new DiscoveryFailure();
    const url = new URL(tab.url);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      tab.url.length > 8192
    )
      throw new DiscoveryFailure();
    let image: string | null = null;
    if (info.menuItemId === imageMenu) {
      if (info.mediaType !== 'image' || typeof info.srcUrl !== 'string')
        throw new DiscoveryFailure();
      image = candidateUrl(info.srcUrl, tab.url, tab.url);
      if (!image) throw new DiscoveryFailure();
    }
    const current = await chrome.tabs.get(tab.id);
    if (current.url !== tab.url) throw new DiscoveryFailure();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => ({
        documentUrl: document.URL,
        title: document.title.slice(0, 2000),
        candidates: [],
      }),
    });
    if (!result?.documentId || result.frameId !== 0)
      throw new DiscoveryFailure();
    const metadata = {
      ...parseDiscovery(result.result, tab.url),
      candidates: [],
    };
    return {
      tabId: tab.id,
      documentId: result.documentId,
      ...metadata,
      ...(image
        ? {
            candidates: [
              {
                id: 'candidate-1',
                kind: 'image' as const,
                url: image,
                pageUrl: metadata.pageUrl,
                title: metadata.title,
              },
            ],
          }
        : { bookmarkUrl: tab.url }),
    };
  } catch {
    throw new DiscoveryFailure();
  }
}

import { candidateUrl } from './candidates';
import {
  DiscoveryFailure,
  parseDiscovery,
  type PageDiscovery,
} from './discovery';
const imageMenu = 'frameleaf-save-image';
const pageMenu = 'frameleaf-save-page';
const linkMenu = 'frameleaf-save-link';
const selectionMenu = 'frameleaf-save-selection';
/** The capture API keeps a note of up to 20,000 characters; the selection is quoted. */
const NOTE_LIMIT = 20000;
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
    // FL-1729: Save page sits beside Save link and Save selection, as on the image menu.
    for (const [id, title, contexts] of [
      [imageMenu, 'Save image to Frameleaf', ['image']],
      [linkMenu, 'Save link to Frameleaf', ['link']],
      [selectionMenu, 'Save selection to Frameleaf', ['selection']],
      [pageMenu, 'Save page to Frameleaf', ['page', 'image', 'link', 'selection']],
    ] as const) {
      await new Promise<void>((resolve, reject) => {
        chrome.contextMenus.create(
          {
            id,
            title,
            contexts: [...contexts],
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
      ![imageMenu, pageMenu, linkMenu, selectionMenu].includes(
        String(info.menuItemId),
      )
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
    // FL-1729: the linked address is held to the same rules as a page address. It is never fetched.
    let link: string | null = null;
    if (info.menuItemId === linkMenu) {
      if (typeof info.linkUrl !== 'string' || info.linkUrl.length > 8192)
        throw new DiscoveryFailure();
      const linked = new URL(info.linkUrl);
      if (
        !['https:', 'http:'].includes(linked.protocol) ||
        linked.username ||
        linked.password
      )
        throw new DiscoveryFailure();
      link = info.linkUrl;
    }
    let note: string | undefined;
    if (info.menuItemId === selectionMenu) {
      const text =
        typeof info.selectionText === 'string' ? info.selectionText.trim() : '';
      if (!text) throw new DiscoveryFailure();
      note = `“${text.slice(0, NOTE_LIMIT - 2)}”`;
    }
    const current = await chrome.tabs.get(tab.id);
    if (current.url !== tab.url) throw new DiscoveryFailure();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      // A saved link is titled with the link's own words, read from this page's matching link.
      func: (linked: string | null) => {
        let title = document.title;
        if (linked) {
          const anchor = [
            ...document.querySelectorAll<HTMLAnchorElement>('a[href]'),
          ].find((value) => value.href === linked);
          title = (
            anchor?.innerText ||
            anchor?.getAttribute('aria-label') ||
            anchor?.getAttribute('title') ||
            ''
          )
            .replaceAll(/\s+/g, ' ')
            .trim();
        }
        return {
          documentUrl: document.URL,
          title: title.slice(0, 2000),
          candidates: [],
        };
      },
      args: [link],
    });
    if (!result?.documentId || result.frameId !== 0)
      throw new DiscoveryFailure();
    const metadata = {
      ...parseDiscovery(result.result, tab.url),
      candidates: [],
    };
    if (link && !metadata.title) metadata.title = link.slice(0, 2000);
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
        : { bookmarkUrl: link ?? tab.url }),
      ...(link && { menu: 'link' as const }),
      ...(note && { menu: 'selection' as const, note }),
    };
  } catch {
    throw new DiscoveryFailure();
  }
}

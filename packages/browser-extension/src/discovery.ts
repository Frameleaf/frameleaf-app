import {
  candidateUrl,
  discoveryLimits,
  type CaptureCandidate,
} from './candidates';
import { sanitizeSourceUrl } from './source-url';

declare const FrameleafDiscovery: {
  collectCandidates(document: Document): CaptureCandidate[];
};
export interface PageDiscovery {
  tabId: number;
  documentId: string;
  pageUrl: string;
  title: string;
  candidates: CaptureCandidate[];
  bookmarkUrl?: string;
}
export class DiscoveryFailure extends Error {
  constructor() {
    super('Could not inspect this page. Return to the webpage and try again.');
  }
}
const failure = () => new DiscoveryFailure();

/** A content result is untrusted even when it came from our isolated script. */
export function parseDiscovery(
  value: unknown,
  expectedUrl: string,
): Pick<PageDiscovery, 'pageUrl' | 'title' | 'candidates'> {
  if (!value || typeof value !== 'object') throw failure();
  const raw = value as Record<string, unknown>;
  const pageUrl = sanitizeSourceUrl(expectedUrl);
  if (
    !pageUrl ||
    raw.documentUrl !== expectedUrl ||
    typeof raw.title !== 'string' ||
    raw.title.length > 4096 ||
    !Array.isArray(raw.candidates) ||
    raw.candidates.length > discoveryLimits.candidates
  )
    throw failure();
  const candidates: CaptureCandidate[] = [];
  const seen = new Set<string>();
  let characters = 0;
  for (const item of raw.candidates) {
    if (
      !item ||
      typeof item !== 'object' ||
      item.kind !== 'image' ||
      typeof item.url !== 'string'
    )
      throw failure();
    const url = candidateUrl(item.url, expectedUrl, expectedUrl);
    if (!url || url !== item.url) throw failure();
    characters += url.length;
    if (characters > discoveryLimits.urlCharacters) throw failure();
    if (seen.has(url)) continue;
    seen.add(url);
    const hint = (value: unknown) =>
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= 2 ** 31 - 1
        ? value
        : undefined;
    candidates.push({
      id: `candidate-${candidates.length + 1}`,
      url,
      kind: 'image',
      pageUrl,
      title: raw.title,
      width: hint(item.width),
      height: hint(item.height),
    });
  }
  return { pageUrl, title: raw.title, candidates };
}

/** Chromium boundary: only the active top-level web document is inspected. */
export async function discoverActivePage(
  mode: 'images' | 'bookmark' = 'images',
): Promise<PageDiscovery> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (
      !tab?.id ||
      !tab.url ||
      !['https:', 'http:'].includes(new URL(tab.url).protocol) ||
      new URL(tab.url).username ||
      new URL(tab.url).password
    )
      throw failure();
    if (mode === 'bookmark') {
      if (tab.url.length > 8192) throw failure();
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => ({
          documentUrl: document.URL,
          title: document.title.slice(0, 2000),
          candidates: [],
        }),
      });
      if (!result?.documentId || result.frameId !== 0) throw failure();
      return {
        tabId: tab.id,
        documentId: result.documentId,
        ...parseDiscovery(result.result, tab.url),
        bookmarkUrl: tab.url,
      };
    }
    const [loaded] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
      world: 'ISOLATED',
    });
    if (!loaded?.documentId || loaded.frameId !== 0) throw failure();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, documentIds: [loaded.documentId] },
      world: 'ISOLATED',
      func: () => ({
        documentUrl: document.URL,
        title: document.title.slice(0, 4096),
        candidates: FrameleafDiscovery.collectCandidates(document),
      }),
    });
    if (
      !result ||
      result.frameId !== 0 ||
      result.documentId !== loaded.documentId
    )
      throw failure();
    return {
      tabId: tab.id,
      documentId: loaded.documentId,
      ...parseDiscovery(result.result, tab.url),
    };
  } catch {
    // Browser error strings may contain private page URLs; expose only a static retry message.
    throw failure();
  }
}

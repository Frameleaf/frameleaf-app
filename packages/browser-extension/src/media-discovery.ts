/**
 * FL-1427: "Find media" lists what a page plays so you can choose what your Library should look at.
 * Two sources, both for the one tab you asked about: what the page itself shows (its video and audio
 * elements and the addresses it has already loaded), and, only after you allow it, the requests the
 * tab makes from then on. Nothing here downloads anything, reads a cookie or a header, or leaves the
 * browser: only the addresses you tick are sent to your Library to inspect.
 */

const MANIFESTS = new Set(['m3u8', 'mpd']);
/** Pieces of a stream. On their own they are not a video, so they are never offered as one. */
const SEGMENTS = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'cmft']);
const FILES = new Set([
  'mp4',
  'm4v',
  'webm',
  'mov',
  'mkv',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'ogv',
  'opus',
  'wav',
  'flac',
]);
export type SeenKind = 'manifest' | 'segment' | 'file';
/** How the address was met: `media` when the browser itself was playing it. */
export type SeenHint = 'media' | 'other';
export interface SeenMedia {
  url: string;
  kind: SeenKind;
}

/** An http(s) address without a user name or password, short enough to send; else null. */
export function mediaUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}
export function classifyMedia(
  raw: unknown,
  hint: SeenHint = 'other',
): SeenMedia | null {
  const url = mediaUrl(raw);
  if (!url) return null;
  const extension =
    /\.([a-z\d]{2,5})$/i.exec(url.pathname)?.[1].toLowerCase() ?? '';
  const kind = MANIFESTS.has(extension)
    ? 'manifest'
    : SEGMENTS.has(extension)
      ? 'segment'
      : FILES.has(extension) || hint === 'media'
        ? 'file'
        : null;
  return kind && { url: url.href, kind };
}

export interface FoundMedia {
  id: string;
  /** `stream`: a playlist the Library can assemble; `file`: one playable file. */
  kind: 'stream' | 'file' | 'parts';
  /** The address sent to the Library if you choose it. `parts` have none: there is no playlist. */
  url?: string;
  host: string;
  name: string;
  /** How many pieces of this stream were seen. */
  parts: number;
}
const directory = (url: URL) =>
  url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
function fileName(url: URL) {
  const raw = url.pathname.split('/').at(-1) || url.hostname;
  try {
    return decodeURIComponent(raw).slice(0, 120);
  } catch {
    return raw.slice(0, 120);
  }
}
/** Numbered files that differ only in their numbers ("seg-1.mp4", "seg-2.mp4") share a shape. */
const shape = (url: URL) =>
  `${url.origin}${url.pathname.replaceAll(/\d+/g, '#')}`;

/**
 * Turns everything seen into the list you choose from. Pieces of a stream (.ts, .m4s, and runs of
 * numbered files) are counted under the playlist they belong to and never listed as videos; pieces
 * with no playlist in sight are shown as one line you can't send.
 */
export function groupMedia(seen: SeenMedia[], limit = 50): FoundMedia[] {
  const unique = new Map<string, { url: URL; kind: SeenKind }>();
  for (const item of seen) {
    const url = mediaUrl(item.url);
    // The same file asked for again (another byte range, a refreshed signature) is one file.
    if (url && !unique.has(url.origin + url.pathname))
      unique.set(url.origin + url.pathname, { url, kind: item.kind });
  }
  const files = [...unique.values()].filter((item) => item.kind === 'file');
  const shapes = new Map<string, number>();
  for (const { url } of files)
    shapes.set(shape(url), (shapes.get(shape(url)) ?? 0) + 1);
  const manifests = [...unique.values()].filter(
    (item) => item.kind === 'manifest',
  );
  const found: FoundMedia[] = manifests.map(({ url }) => ({
    id: '',
    kind: 'stream',
    url: url.href,
    host: url.host,
    name: fileName(url),
    parts: 0,
  }));
  const loose = new Map<string, FoundMedia>();
  for (const { url, kind } of unique.values()) {
    if (kind === 'manifest') continue;
    const piece = kind === 'segment' || (shapes.get(shape(url)) ?? 0) >= 3;
    if (!piece) {
      found.push({
        id: '',
        kind: 'file',
        url: url.href,
        host: url.host,
        name: fileName(url),
        parts: 0,
      });
      continue;
    }
    // The playlist in the nearest folder above the piece, on the same site, owns it.
    let owner: FoundMedia | undefined;
    let depth = -1;
    manifests.forEach((manifest, index) => {
      const folder = directory(manifest.url);
      if (
        manifest.url.origin === url.origin &&
        url.pathname.startsWith(folder) &&
        folder.length > depth
      ) {
        owner = found[index];
        depth = folder.length;
      }
    });
    if (!owner) {
      const key = url.origin + directory(url);
      owner = loose.get(key);
      if (!owner) {
        owner = {
          id: '',
          kind: 'parts',
          host: url.host,
          name: 'Stream',
          parts: 0,
        };
        loose.set(key, owner);
      }
    }
    owner.parts++;
  }
  const order = { stream: 0, file: 1, parts: 2 };
  return [...found, ...loose.values()]
    .sort((a, b) => order[a.kind] - order[b.kind])
    .slice(0, limit)
    .map((item, index) => ({ ...item, id: `found-${index + 1}` }));
}

const samePage = (a: string, b: string) => a.split('#')[0] === b.split('#')[0];
const MAX_SEEN = 2000;
/**
 * What one tab's current page has been seen to request. Kept in memory only (addresses can carry
 * signed tokens, so they are never written to storage) and forgotten the moment the tab goes to
 * another page, another tab is watched or the tab closes.
 */
export class MediaWatch {
  private tabId: number | undefined;
  private pageUrl = '';
  private seen = new Map<string, SeenMedia>();

  /** Starts over for this tab and page. */
  start(tabId: number, pageUrl: string) {
    this.tabId = tabId;
    this.pageUrl = pageUrl;
    this.seen.clear();
  }
  stop() {
    this.tabId = undefined;
    this.pageUrl = '';
    this.seen.clear();
  }
  watching(tabId: number, pageUrl: string) {
    return this.tabId === tabId && samePage(this.pageUrl, pageUrl);
  }
  /** A request made by a tab. Only the watched tab's are kept. */
  record(tabId: number, url: string, hint: SeenHint) {
    if (tabId !== this.tabId || this.seen.size >= MAX_SEEN) return;
    const media = classifyMedia(url, hint);
    if (media && !this.seen.has(media.url)) this.seen.set(media.url, media);
  }
  /** The tab loaded a new document (even the same address again): start over. */
  documentChanged(tabId: number, pageUrl: string) {
    if (tabId === this.tabId) this.start(tabId, pageUrl);
  }
  /** The tab went somewhere: what the last page loaded says nothing about the new one. */
  navigated(tabId: number, pageUrl: string) {
    if (tabId !== this.tabId || samePage(this.pageUrl, pageUrl)) return;
    this.pageUrl = pageUrl;
    this.seen.clear();
  }
  /** Whether that was the watched tab, and so watching has stopped. */
  closed(tabId: number) {
    if (tabId !== this.tabId) return false;
    this.stop();
    return true;
  }
  /** What was seen, only if it is still this tab on this page. */
  list(tabId: number, pageUrl: string): SeenMedia[] {
    if (tabId !== this.tabId) return [];
    this.navigated(tabId, pageUrl);
    return [...this.seen.values()];
  }
}

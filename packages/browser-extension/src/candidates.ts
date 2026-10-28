import srcset from 'srcset';
import { sanitizeSourceUrl } from './source-url';

export interface CaptureCandidate {
  id: string;
  url: string;
  width?: number;
  height?: number;
  kind: 'image';
  pageUrl: string;
  title: string;
}

export const discoveryLimits = {
  elements: 10_000,
  candidates: 1000,
  urlCharacters: 8 * 1024 * 1024,
  inlineCharacters: 256 * 1024,
};

export function candidateUrl(
  raw: string,
  baseUrl: string,
  pageUrl: string,
): string | null {
  if (!raw.trim() || raw.length > discoveryLimits.inlineCharacters) return null;
  try {
    const url = new URL(raw, baseUrl);
    if (url.username || url.password) return null;
    if (url.protocol === 'data:') {
      if (!/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i.test(raw))
        return null;
    } else if (url.protocol === 'blob:') {
      if (url.origin === 'null' || url.origin !== new URL(pageUrl).origin)
        return null;
    } else if (url.protocol !== 'https:' && url.protocol !== 'http:')
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function dimension(value: number | undefined): number | undefined {
  return value && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Reads only the invoked document's available DOM; never loads images or traverses frames. */
export function collectCandidates(document: Document): CaptureCandidate[] {
  const candidates = new Map<string, CaptureCandidate>();
  const pageUrl = sanitizeSourceUrl(document.URL) ?? '';
  const title = document.title.slice(0, 4096);
  let urlCharacters = 0;
  const add = (raw: string, width?: number, height?: number) => {
    const url = candidateUrl(raw, document.baseURI, document.URL);
    if (!url) return;
    const previous = candidates.get(url);
    if (previous) {
      previous.width =
        Math.max(previous.width ?? 0, dimension(width) ?? 0) || undefined;
      previous.height =
        Math.max(previous.height ?? 0, dimension(height) ?? 0) || undefined;
      return;
    }
    if (
      candidates.size >= discoveryLimits.candidates ||
      urlCharacters + url.length > discoveryLimits.urlCharacters
    )
      return;
    urlCharacters += url.length;
    candidates.set(url, {
      id: `candidate-${candidates.size + 1}`,
      url,
      width: dimension(width),
      height: dimension(height),
      kind: 'image',
      pageUrl,
      title,
    });
  };
  const addSrcset = (raw: string | null) => {
    if (!raw || raw.length > 64 * 1024) return;
    for (const source of srcset.parse(raw)) add(source.url, source.width);
  };
  const walker = document.createTreeWalker(document.documentElement, 1);
  let element = walker.currentNode as Element | null;
  for (
    let count = 0;
    element && count < discoveryLimits.elements;
    count++, element = walker.nextNode() as Element | null
  ) {
    if (element.tagName === 'IMG') {
      const image = element as HTMLImageElement;
      if (image.currentSrc)
        add(image.currentSrc, image.naturalWidth, image.naturalHeight);
      const raw = image.getAttribute('src');
      if (raw) add(raw, image.width, image.height);
      const lazy = image.getAttribute('data-src');
      if (lazy) add(lazy);
      addSrcset(image.getAttribute('srcset'));
      addSrcset(image.getAttribute('data-srcset'));
    } else if (
      element.tagName === 'SOURCE' &&
      element.parentElement?.tagName === 'PICTURE'
    ) {
      const media = element.getAttribute('media');
      if (!media || document.defaultView?.matchMedia(media).matches)
        addSrcset(element.getAttribute('srcset'));
    }
    const background =
      document.defaultView?.getComputedStyle(element).backgroundImage ?? '';
    if (background.length > discoveryLimits.inlineCharacters) continue;
    // CSSOM serializes URL tokens; decode CSS escapes before applying the URL policy.
    for (const match of background.matchAll(
      /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^)\\])*))\s*\)/gi,
    )) {
      const raw = (match[1] ?? match[2] ?? match[3])
        .trim()
        .replace(
          /\\([\da-f]{1,6}\s?|\r\n|[\n\r\f]|.)/gi,
          (_, escape: string) => {
            if (/^[\da-f]/i.test(escape)) {
              const code = Number.parseInt(escape.trim(), 16);
              return code === 0 ||
                code > 0x10ffff ||
                (code >= 0xd800 && code <= 0xdfff)
                ? '\uFFFD'
                : String.fromCodePoint(code);
            }
            return /^[\n\r\f]/.test(escape) ? '' : escape;
          },
        );
      add(raw);
    }
  }
  return [...candidates.values()].sort(
    (a, b) => (b.width ?? 0) - (a.width ?? 0),
  );
}

/** Dimensions and formats are page hints, not verified file metadata. */
export function filterCandidates(
  candidates: CaptureCandidate[],
  filters: { minWidth?: number; minHeight?: number; formats?: string[] },
): CaptureCandidate[] {
  return candidates.filter((candidate) => {
    if (filters.minWidth && (candidate.width ?? 0) < filters.minWidth)
      return false;
    if (filters.minHeight && (candidate.height ?? 0) < filters.minHeight)
      return false;
    if (!filters.formats?.length) return true;
    const url = new URL(candidate.url);
    const format =
      url.protocol === 'data:'
        ? /^data:image\/([^;,]+)/i.exec(url.href)?.[1]
        : /\.([a-z0-9]+)$/i.exec(url.pathname)?.[1];
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/^jpg$/, 'jpeg')
        .replace(/^svg\+xml$/, 'svg');
    return Boolean(
      format &&
      filters.formats.some((value) => normalize(value) === normalize(format)),
    );
  });
}

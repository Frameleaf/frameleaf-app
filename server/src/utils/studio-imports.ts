/**
 * Files uploaded into a Studio project rather than the library (FL-103 recordings, FL-105 media
 * import): microphone takes, music and sound files, stills, short video, SVG and Lottie graphics.
 *
 * The server never trusts the name or the declared type a browser sends. {@link sniffStudioImport}
 * reads the first bytes and decides the content type from what the file is, accepting only the
 * kinds the editor can place. Vector graphics are scanned: an SVG with script or event handlers is
 * refused outright, and every external subresource of an SVG or a Lottie document is counted so the
 * FL-90 resolver refuses a graphic that would reach the network when it is rendered.
 */

/** Largest single import. A take or a music file is far smaller; short video is the ceiling. */
export const STUDIO_IMPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Vector documents are parsed in memory, so they are bounded well below media files. */
export const STUDIO_IMPORT_VECTOR_MAX_BYTES = 16 * 1024 * 1024;

/** How many imports one project may declare; the resolver's reference ceiling bounds it again. */
export const STUDIO_IMPORT_MAX_PER_PROJECT = 1000;

export type StudioImportKind = 'audio' | 'image' | 'video' | 'vector';

export type StudioImportType = { contentType: string; kind: StudioImportKind; extension: string };

export class StudioImportRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioImportRefusal';
  }
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  new TextDecoder('latin1').decode(bytes.subarray(start, start + length));

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((value, index) => bytes[offset + index] === value);

/** ISO base media brands that are sound only. */
const audioBrands = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);
const quickTimeBrands = new Set(['qt  ']);

const textHead = (bytes: Uint8Array) => {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 1024));
  if (text.codePointAt(0) === 0xfe_ff) {
    text = text.slice(1);
  }
  return text.trimStart();
};

/**
 * The content type of an upload, decided from its first bytes (at least 64 are needed). `declared`
 * only chooses between two readings the bytes allow — a WebM that is sound only is `audio/webm`
 * when the browser recorded it as audio. Anything else is refused.
 */
export function sniffStudioImport(head: Uint8Array, declared: string | undefined): StudioImportType {
  const declaredType = (declared ?? '').split(';', 1)[0].trim().toLowerCase();
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && ascii(head, 8, 4) === 'WAVE') {
    return { contentType: 'audio/wav', kind: 'audio', extension: '.wav' };
  }
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && ascii(head, 8, 4) === 'WEBP') {
    return { contentType: 'image/webp', kind: 'image', extension: '.webp' };
  }
  if (ascii(head, 0, 4) === 'OggS') {
    return { contentType: 'audio/ogg', kind: 'audio', extension: '.ogg' };
  }
  if (ascii(head, 0, 4) === 'fLaC') {
    return { contentType: 'audio/flac', kind: 'audio', extension: '.flac' };
  }
  // ADTS AAC: a 12-bit sync with the layer bits zero. MPEG audio: an 11-bit sync with a layer.
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) {
    return { contentType: 'audio/aac', kind: 'audio', extension: '.aac' };
  }
  if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0)) {
    return { contentType: 'audio/mpeg', kind: 'audio', extension: '.mp3' };
  }
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (audioBrands.has(brand)) {
      return { contentType: 'audio/mp4', kind: 'audio', extension: '.m4a' };
    }
    if (quickTimeBrands.has(brand)) {
      return { contentType: 'video/quicktime', kind: 'video', extension: '.mov' };
    }
    if (brand.startsWith('avif') || brand === 'avis') {
      return { contentType: 'image/avif', kind: 'image', extension: '.avif' };
    }
    return declaredType === 'audio/mp4'
      ? { contentType: 'audio/mp4', kind: 'audio', extension: '.m4a' }
      : { contentType: 'video/mp4', kind: 'video', extension: '.mp4' };
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    const webm = /webm/i.test(new TextDecoder('latin1').decode(head.subarray(0, 64)));
    if (declaredType === 'audio/webm' || (declaredType === 'audio/x-matroska' && !webm)) {
      return webm
        ? { contentType: 'audio/webm', kind: 'audio', extension: '.webm' }
        : { contentType: 'audio/x-matroska', kind: 'audio', extension: '.mka' };
    }
    return webm
      ? { contentType: 'video/webm', kind: 'video', extension: '.webm' }
      : { contentType: 'video/x-matroska', kind: 'video', extension: '.mkv' };
  }
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: 'image/png', kind: 'image', extension: '.png' };
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) {
    return { contentType: 'image/jpeg', kind: 'image', extension: '.jpg' };
  }
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') {
    return { contentType: 'image/gif', kind: 'image', extension: '.gif' };
  }
  const text = textHead(head);
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text)) {
    return { contentType: 'image/svg+xml', kind: 'vector', extension: '.svg' };
  }
  if (text.startsWith('{')) {
    return { contentType: 'application/json', kind: 'vector', extension: '.json' };
  }
  throw new StudioImportRefusal('Studio can import sound, images, short video, SVG and Lottie files only');
}

/** Decode XML character references, so an encoded `javascript:` or `url(` is seen as written. */
const decodeCharacterReferences = (text: string) =>
  text.replaceAll(/&#(x[\da-f]+|\d+);?/gi, (reference: string, value: string) => {
    const code = value[0].toLowerCase() === 'x' ? Number.parseInt(value.slice(1), 16) : Number(value);
    return Number.isSafeInteger(code) && code >= 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : reference;
  });

/** Elements that run code or embed another document, whatever namespace prefix they carry. */
const activeElement = /<(?:[\w.-]+:)?(?:script|foreignObject|iframe|embed|object|handler|listener)\b/i;
const eventHandler = /[\s"'/](?:[\w.-]+:)?on[a-z]+\s*=/i;

/** A reference that stays inside the document: a fragment or embedded `data:` bytes. */
const internalReference = (value: string) => {
  const trimmed = value.trim().replaceAll(/^['"]|['"]$/g, '');
  return trimmed === '' || trimmed.startsWith('#') || /^data:/i.test(trimmed);
};

/**
 * External subresources an SVG would fetch when rendered. Active content — scripts, event handlers,
 * `javascript:`, embedded documents, entity declarations or a non-UTF-8 encoding — is refused, not
 * counted: a Studio graphic is a picture. The text is read after decoding character references and
 * without URL whitespace, with element and attribute names matched whatever their namespace prefix,
 * and anything CSS could resolve that a pattern cannot follow (escapes, `image-set()`) counts as
 * external, so an uncertain graphic is refused at render rather than trusted.
 */
export function scanStudioSvg(text: string): number {
  const declared = /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(text)?.[1];
  if (declared && !/^utf-?8$/i.test(declared.trim())) {
    throw new StudioImportRefusal('An SVG must be UTF-8');
  }
  if (/<!ENTITY/i.test(text)) {
    throw new StudioImportRefusal('An SVG with entity declarations cannot be imported');
  }
  const decoded = decodeCharacterReferences(text);
  const compact = decoded.replaceAll(/[\t\n\r\f\0]/g, '');
  if (activeElement.test(decoded) || eventHandler.test(decoded) || /javascript:|vbscript:/i.test(compact)) {
    throw new StudioImportRefusal('An SVG with scripts, event handlers or embedded documents cannot be imported');
  }
  let external = 0;
  for (const match of decoded.matchAll(/[\s"'/](?:[\w.-]+:)?(?:href|src|srcset)\s*=\s*("[^"]*"|'[^']*')/gi)) {
    if (!internalReference(match[1])) {
      external++;
    }
  }
  // SMIL can set an href or a paint to a URL while the animation runs: any value that is not a
  // fragment, embedded data or plain number, length, colour or keyword text counts.
  for (const match of decoded.matchAll(/[\s"'/](?:[\w.-]+:)?(?:to|values|from|by)\s*=\s*("[^"]*"|'[^']*')/gi)) {
    for (const value of match[1].slice(1, -1).split(';')) {
      const item = value.trim();
      if (
        item &&
        !item.startsWith('#') &&
        !/^data:/i.test(item) &&
        (/[/\\(]/.test(item) || /\.[a-z]{2,5}$/i.test(item))
      ) {
        external++;
      }
    }
  }
  for (const match of decoded.matchAll(/url\(\s*([^)]*)\)/gi)) {
    if (!internalReference(match[1])) {
      external++;
    }
  }
  external += decoded.matchAll(/@import\b|(?:-webkit-)?image-set\s*\(|\bimage\s*\(|cross-fade\s*\(/gi).toArray().length;
  // A CSS escape can spell `url(` or `@import` in a way no pattern here follows.
  if (/\\/.test(decoded)) {
    external++;
  }
  return external;
}

/**
 * External subresources a Lottie document names. Images in `assets` are embedded only when `p` is
 * a `data:` URI; anything else is fetched from `u` + `p` at render time. Font lists
 * with a `fPath` are fetched too. The document must be a Lottie animation, not any JSON.
 */
export function scanStudioLottie(text: string): number {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new StudioImportRefusal('The file is not valid JSON');
  }
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    !Array.isArray((document as { layers?: unknown }).layers) ||
    typeof (document as { v?: unknown }).v !== 'string'
  ) {
    throw new StudioImportRefusal('The JSON file is not a Lottie animation');
  }
  let external = 0;
  const assets = (document as { assets?: unknown }).assets;
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (!asset || typeof asset !== 'object') {
      continue;
    }
    const { p, u } = asset as { p?: unknown; u?: unknown };
    if (typeof p !== 'string') {
      continue; // A precomposition: layers, not a file.
    }
    // Embedded only when the bytes are in the document; a player reads `p` as a URL even with `e` set.
    if (/^data:/i.test(p.trim())) {
      continue;
    }
    if (typeof u === 'string' || p.length > 0) {
      external++;
    }
  }
  const fonts = (document as { fonts?: { list?: unknown } }).fonts?.list;
  for (const font of Array.isArray(fonts) ? fonts : []) {
    if (
      font &&
      typeof font === 'object' &&
      typeof (font as { fPath?: unknown }).fPath === 'string' &&
      (font as { fPath: string }).fPath.length > 0
    ) {
      external++;
    }
  }
  return external;
}

/** The recorded external-reference count of a vector import; undefined for other kinds. */
export function scanStudioVector(type: StudioImportType, text: string): number | undefined {
  if (type.kind !== 'vector') {
    return undefined;
  }
  return type.contentType === 'image/svg+xml' ? scanStudioSvg(text) : scanStudioLottie(text);
}

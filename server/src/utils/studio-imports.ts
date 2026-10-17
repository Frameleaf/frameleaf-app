/**
 * Files uploaded into a Studio project rather than the library (FL-103 recordings, FL-105 media
 * import): microphone takes, music and sound files, stills, short video, SVG and Lottie graphics,
 * SubRip and WebVTT caption files and `.cube` 3D LUTs.
 *
 * The server never trusts the name or the declared type a browser sends. {@link sniffStudioImport}
 * reads the first bytes and decides the content type from what the file is, accepting only the
 * kinds the editor can place. Vector graphics are scanned: an SVG with script or event handlers is
 * refused outright, and every external subresource of an SVG or a Lottie document is counted so the
 * FL-90 resolver refuses a graphic that would reach the network when it is rendered. Caption files
 * and LUTs are text with no signature, so the whole file is read and must be exactly the format its
 * first lines look like ({@link validateStudioImportText}).
 */

/** Largest single import. A take or a music file is far smaller; short video is the ceiling. */
export const STUDIO_IMPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Vector documents are parsed in memory, so they are bounded well below media files. */
export const STUDIO_IMPORT_VECTOR_MAX_BYTES = 16 * 1024 * 1024;

/** A caption file is a few hundred kilobytes for a feature-length film; this is generous. */
export const STUDIO_IMPORT_CAPTIONS_MAX_BYTES = 4 * 1024 * 1024;

/** A 65-point 3D LUT, the largest accepted, is about 9 MB of text. */
export const STUDIO_IMPORT_LUT_MAX_BYTES = 16 * 1024 * 1024;

/** The largest 3D LUT grid accepted: 65 points an axis, the largest size grading tools write. */
export const STUDIO_IMPORT_LUT_MAX_SIZE = 65;

/** How many imports one project may declare; the resolver's reference ceiling bounds it again. */
export const STUDIO_IMPORT_MAX_PER_PROJECT = 1000;

export type StudioImportKind = 'audio' | 'image' | 'video' | 'vector' | 'captions' | 'lut';

export const STUDIO_IMPORT_SUBRIP_TYPE = 'application/x-subrip';
export const STUDIO_IMPORT_WEBVTT_TYPE = 'text/vtt';
/** `.cube` has no registered media type; this one is the server's own. */
export const STUDIO_IMPORT_CUBE_LUT_TYPE = 'text/x-cube-lut';

/** What an import is, from the content type the server recorded for it. */
export const studioImportKind = (contentType: string): StudioImportKind => {
  switch (contentType) {
    case 'image/svg+xml':
    case 'application/json': {
      return 'vector';
    }
    case STUDIO_IMPORT_SUBRIP_TYPE:
    case STUDIO_IMPORT_WEBVTT_TYPE: {
      return 'captions';
    }
    case STUDIO_IMPORT_CUBE_LUT_TYPE: {
      return 'lut';
    }
    default: {
      return contentType.split('/', 1)[0] as StudioImportKind;
    }
  }
};

/** Kinds that are read whole and checked as text, with the largest file each may be. */
export const STUDIO_IMPORT_TEXT_LIMITS: Partial<Record<StudioImportKind, { maxBytes: number; label: string }>> = {
  vector: { maxBytes: STUDIO_IMPORT_VECTOR_MAX_BYTES, label: 'A vector graphic' },
  captions: { maxBytes: STUDIO_IMPORT_CAPTIONS_MAX_BYTES, label: 'A caption file' },
  lut: { maxBytes: STUDIO_IMPORT_LUT_MAX_BYTES, label: 'A LUT' },
};

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

const unplaceable =
  'Studio can import sound, images, short video, SVG and Lottie graphics, .srt and .vtt captions and .cube LUTs only';

/** A keyword line of a `.cube` file (Adobe Cube LUT 1.0, plus the input range Resolve writes). */
const cubeKeyword =
  /^(TITLE|LUT_3D_SIZE|LUT_1D_SIZE|DOMAIN_MIN|DOMAIN_MAX|LUT_3D_INPUT_RANGE|LUT_1D_INPUT_RANGE)(?:[ \t]|$)/;

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
  // Caption files and LUTs have no signature: these only choose which whole-file check runs.
  if (/^WEBVTT(?:[ \t\r\n]|$)/.test(text)) {
    return { contentType: STUDIO_IMPORT_WEBVTT_TYPE, kind: 'captions', extension: '.vtt' };
  }
  if (/^\d{1,10}[ \t]*\r?\n\d{2,4}:\d{2}:\d{2}[,.]\d{3} --> \d/.test(text)) {
    return { contentType: STUDIO_IMPORT_SUBRIP_TYPE, kind: 'captions', extension: '.srt' };
  }
  // A `.cube` LUT opens with comments and then a keyword; the keyword must be within the head.
  const statement = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'));
  if (statement && cubeKeyword.test(statement)) {
    return { contentType: STUDIO_IMPORT_CUBE_LUT_TYPE, kind: 'lut', extension: '.cube' };
  }
  throw new StudioImportRefusal(unplaceable);
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

/* ------------------------------------------------------------------ */
/* Caption files and LUTs                                               */
/* ------------------------------------------------------------------ */

/** Lines of a text import: no byte-order mark, any newline convention, no control characters. */
const textLines = (text: string, label: string): string[] => {
  // eslint-disable-next-line no-control-regex
  if (/[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}]/u.test(text)) {
    throw new StudioImportRefusal(`${label} must be plain text`);
  }
  return (text.codePointAt(0) === 0xfe_ff ? text.slice(1) : text).split(/\r\n|\r|\n/);
};

type TextBlock = { line: number; lines: string[] };

/** Runs of consecutive non-empty lines, each with the number of its first line for messages. */
const textBlocks = (lines: string[], offset = 0): TextBlock[] => {
  const blocks: TextBlock[] = [];
  let current: TextBlock | undefined;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      current = undefined;
    } else if (current) {
      current.lines.push(line);
    } else {
      current = { line: offset + index + 1, lines: [line] };
      blocks.push(current);
    }
  }
  return blocks;
};

const srtTiming =
  /^(\d{2,4}):(\d{2}):(\d{2})[,.](\d{3}) --> (\d{2,4}):(\d{2}):(\d{2})[,.](\d{3})(?:[ \t]+X1:\d+ X2:\d+ Y1:\d+ Y2:\d+)?[ \t]*$/;
const vttTiming =
  /^(?:(\d{2,4}):)?(\d{2}):(\d{2})\.(\d{3})[ \t]+-->[ \t]+(?:(\d{2,4}):)?(\d{2}):(\d{2})\.(\d{3})(?:[ \t]+[a-z]+:[^\s:]\S*)*[ \t]*$/;
/** CSS that could fetch something, or an escape that could spell it: refused in a WebVTT style block. */
const cssReachesNetwork = /url\s*\(|@import\b|image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|\\/i;

/** Check one timing line: both times well formed, minutes and seconds in range, not running backwards. */
const checkCueTiming = (pattern: RegExp, text: string | undefined, line: number) => {
  const match = pattern.exec(text ?? '');
  const time = (found: RegExpExecArray, at: number) =>
    Number(found[at + 1]) > 59 || Number(found[at + 2]) > 59
      ? NaN
      : ((Number(found[at] ?? 0) * 60 + Number(found[at + 1])) * 60 + Number(found[at + 2])) * 1000 +
        Number(found[at + 3]);
  if (!match || !(time(match, 5) >= time(match, 1))) {
    throw new StudioImportRefusal(`The caption timing on line ${line} is not valid`);
  }
};

const checkNoTiming = (block: TextBlock, from: number) => {
  if (block.lines.slice(from).some((line) => line.includes('-->'))) {
    throw new StudioImportRefusal(
      `The block starting on line ${block.line} of the caption file has a stray timing line`,
    );
  }
};

/**
 * A SubRip file, whole: captions separated by blank lines, each a counter, a
 * `hh:mm:ss,mmm --> hh:mm:ss,mmm` line that does not run backwards, then its text. Anything else in
 * the file refuses it. The text itself is kept as written: it is data, shown as text.
 */
export function validateStudioSubRip(text: string): void {
  const blocks = textBlocks(textLines(text, 'A caption file'));
  if (blocks.length === 0) {
    throw new StudioImportRefusal('The caption file has no captions');
  }
  for (const block of blocks) {
    if (!/^\d{1,10}[ \t]*$/.test(block.lines[0])) {
      throw new StudioImportRefusal(`Line ${block.line} of the caption file is not a caption number`);
    }
    checkCueTiming(srtTiming, block.lines[1], block.line + 1);
    checkNoTiming(block, 2);
  }
}

/**
 * A WebVTT file, whole: the `WEBVTT` line first, then notes, style and region blocks and captions,
 * each caption with a timing line that does not run backwards. A style block that could fetch
 * anything is refused: captions never reach the network when they are shown or rendered.
 */
export function validateStudioWebVtt(text: string): void {
  const lines = textLines(text, 'A caption file');
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0])) {
    throw new StudioImportRefusal('A WebVTT file starts with WEBVTT');
  }
  // The header runs to the first blank line and holds no caption.
  const headerEnd = lines.findIndex((line) => line.trim() === '');
  if ((headerEnd === -1 ? lines : lines.slice(0, headerEnd)).some((line) => line.includes('-->'))) {
    throw new StudioImportRefusal('A WebVTT caption must follow a blank line');
  }
  let captions = 0;
  for (const block of headerEnd === -1 ? [] : textBlocks(lines.slice(headerEnd), headerEnd)) {
    const [first] = block.lines;
    if (/^NOTE(?:[ \t]|$)/.test(first)) {
      checkNoTiming(block, 0);
      continue;
    }
    if (/^(?:STYLE|REGION)[ \t]*$/.test(first)) {
      if (captions > 0) {
        throw new StudioImportRefusal(`The block on line ${block.line} must come before the first caption`);
      }
      checkNoTiming(block, 0);
      if (first.startsWith('STYLE') && cssReachesNetwork.test(block.lines.join('\n'))) {
        throw new StudioImportRefusal('A caption file whose styles load other files cannot be imported');
      }
      continue;
    }
    // A caption: an optional identifier line, the timing line, then text.
    const at = first.includes('-->') ? 0 : 1;
    checkCueTiming(vttTiming, block.lines[at], block.line + at);
    checkNoTiming(block, at + 1);
    captions++;
  }
  if (captions === 0) {
    throw new StudioImportRefusal('The caption file has no captions');
  }
}

const cubeNumber = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const cubeTriple = new RegExp(String.raw`^(${cubeNumber})[ \t]+(${cubeNumber})[ \t]+(${cubeNumber})$`);
const cubePair = new RegExp(String.raw`^(${cubeNumber})[ \t]+(${cubeNumber})$`);
/** The specification allows 250 characters a line; a table row or keyword is never longer. */
const CUBE_MAX_LINE = 250;

/** Three finite numbers, or undefined. */
const readCubeTriple = (text: string): number[] | undefined => {
  const values = cubeTriple.exec(text)?.slice(1).map(Number);
  return values?.every((value) => Number.isFinite(value)) ? values : undefined;
};

/**
 * A `.cube` 3D LUT, whole (Adobe Cube LUT Specification 1.0): comments, then the keywords, then
 * exactly `LUT_3D_SIZE`³ rows of three finite numbers. A 1D LUT, a grid outside 2 to
 * {@link STUDIO_IMPORT_LUT_MAX_SIZE}, an unknown keyword, a keyword after the table has begun or a
 * table of any other length refuses the file.
 */
export function validateStudioCubeLut(text: string): { size: number; domainMin: number[]; domainMax: number[] } {
  let size: number | undefined;
  let rows = 0;
  let title = false;
  let inputRange: number[] | undefined;
  const domain: { DOMAIN_MIN?: number[]; DOMAIN_MAX?: number[] } = {};
  const refuse: (line: number, problem: string) => never = (line, problem) => {
    throw new StudioImportRefusal(`Line ${line} of the LUT ${problem}`);
  };
  for (const [index, raw] of textLines(text, 'A LUT').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    if (line.length > CUBE_MAX_LINE) {
      refuse(index + 1, 'is too long');
    }
    const keyword = cubeKeyword.exec(line)?.[1];
    if (!keyword) {
      const triple = readCubeTriple(line);
      if (!triple || triple.some((value) => Math.abs(value) > 1e37)) {
        refuse(index + 1, 'is not three numbers');
      }
      if (size === undefined) {
        refuse(index + 1, 'comes before LUT_3D_SIZE');
      }
      if (++rows > size ** 3) {
        refuse(index + 1, 'is past the end of the table');
      }
      continue;
    }
    if (rows > 0) {
      refuse(index + 1, 'is a keyword inside the table');
    }
    const value = line.slice(keyword.length).trim();
    switch (keyword) {
      case 'TITLE': {
        if (title || value === '') {
          refuse(index + 1, 'is not a valid title');
        }
        title = true;
        break;
      }
      case 'LUT_3D_SIZE': {
        if (size !== undefined || !/^\d{1,3}$/.test(value)) {
          refuse(index + 1, 'is not a valid LUT_3D_SIZE');
        }
        size = Number(value);
        if (size < 2 || size > STUDIO_IMPORT_LUT_MAX_SIZE) {
          refuse(index + 1, `has a grid size outside 2 to ${STUDIO_IMPORT_LUT_MAX_SIZE}`);
        }
        break;
      }
      case 'DOMAIN_MIN':
      case 'DOMAIN_MAX': {
        const triple = readCubeTriple(value);
        if (domain[keyword] || !triple) {
          refuse(index + 1, `is not a valid ${keyword}`);
        }
        domain[keyword] = triple;
        break;
      }
      case 'LUT_3D_INPUT_RANGE': {
        const pair = cubePair.exec(value);
        if (
          inputRange ||
          !pair ||
          [Number(pair[1]), Number(pair[2])].some((value) => !Number.isFinite(value)) ||
          !(Number(pair[1]) < Number(pair[2]))
        ) {
          refuse(index + 1, 'is not a valid LUT_3D_INPUT_RANGE');
        }
        inputRange = [Number(pair![1]), Number(pair![2])];
        break;
      }
      default: {
        throw new StudioImportRefusal('Only 3D .cube LUTs can be imported');
      }
    }
  }
  if (size === undefined) {
    throw new StudioImportRefusal('The LUT has no LUT_3D_SIZE');
  }
  if (
    inputRange &&
    (domain.DOMAIN_MIN?.some((value) => value !== inputRange![0]) ||
      domain.DOMAIN_MAX?.some((value) => value !== inputRange![1]))
  ) {
    throw new StudioImportRefusal('The LUT input range conflicts with its domain');
  }
  const min = domain.DOMAIN_MIN ?? Array.from({ length: 3 }, () => inputRange?.[0] ?? 0);
  const max = domain.DOMAIN_MAX ?? Array.from({ length: 3 }, () => inputRange?.[1] ?? 1);
  if (min.some((value, axis) => !(value < max[axis]))) {
    throw new StudioImportRefusal('The LUT domain is not valid');
  }
  if (
    min.some((value, axis) => {
      const lo = Math.fround(value),
        hi = Math.fround(max[axis]);
      const span = Math.fround(hi - lo);
      return (
        Math.abs(value) > 1e37 || Math.abs(max[axis]) > 1e37 || !(span > 0) || !Number.isFinite(Math.fround(1 / span))
      );
    })
  )
    throw new StudioImportRefusal('The LUT domain is not representable');
  if (rows !== size ** 3) {
    throw new StudioImportRefusal(`The LUT has ${rows} rows where its size needs ${size ** 3}`);
  }
  return { size, domainMin: min, domainMax: max };
}

/** Check a caption file or a LUT in full. Other kinds have their own checks and pass through. */
export function validateStudioImportText(type: StudioImportType, text: string): void {
  switch (type.contentType) {
    case STUDIO_IMPORT_SUBRIP_TYPE: {
      validateStudioSubRip(text);
      break;
    }
    case STUDIO_IMPORT_WEBVTT_TYPE: {
      validateStudioWebVtt(text);
      break;
    }
    case STUDIO_IMPORT_CUBE_LUT_TYPE: {
      validateStudioCubeLut(text);
      break;
    }
  }
}

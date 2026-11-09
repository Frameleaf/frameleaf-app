/**
 * JPEG repair (Library Care): byte-level fixes for the damage old JPEGs commonly carry. Each fix gives
 * a candidate; the sharp worker decodes every candidate and keeps the best picture.
 *
 * Where the picture starts:
 * - Bytes before the start-of-image (SOI) marker: a MacBinary or PICT header, padding, a partial
 *   download. The decoder cannot recognise the file ("Input buffer contains unsupported image format",
 *   or ImageMagick guessing TGA: "improper image header … ReadTGAImage").
 * - A repeated SOI ("Duplicate SOI marker"), or no SOI at all before a JFIF/Exif header.
 * - Several files joined together, where a later one is whole. An embedded EXIF thumbnail starts with
 *   the same marker; the worker prefers the largest picture, so it wins only when nothing larger decodes.
 *
 * Inside the header (`rebuildHeader`):
 * - A segment whose length runs past the next marker (broken EXIF, maker notes, comments) is dropped
 *   and the walk picks up at the next real marker ("Bogus marker length", "Invalid JPEG file structure").
 * - A second variant also drops all metadata segments but JFIF, ICC and Adobe, for metadata the decoder
 *   chokes on even when its framing is right.
 * - Missing Huffman tables, as in Motion-JPEG frames saved by old cameras ("Huffman table 0x00 was not
 *   defined"): the standard tables of the JPEG specification (ITU T.81 Annex K.3) are put in.
 *
 * Where the picture ends:
 * - A cut-off file ("premature end of JPEG image", "Incomplete scan"): zero or FF padding after the cut
 *   is trimmed and the end-of-image marker added. Lost data cannot come back; the worker decodes what
 *   is there.
 */
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
export const JPEG_EOI = EOI;
/** ponytail: caps the decodes per repair; a file with more SOI markers than this is beyond telling apart. */
export const MAX_JPEG_REPAIR_STARTS = 8;
const MAX_CANDIDATES = 24;
/** ponytail: where a header without its SOI is looked for, and how hard; past this it is not a JPEG. */
const HEADER_SEARCH_BYTES = 64 * 1024;
const HEADER_SEARCH_TRIES = 200;
const HEADER_WINDOW_BYTES = 1024 * 1024;
/** A run this long of 0x00 or 0xFF at the end of a cut-off file is padding, not picture data. */
const PADDING_RUN = 64;

/**
 * How a repair turned out. lossless: the picture is untouched; rebuilt: rewritten from what decoded;
 * preview: only the small picture embedded in the file could be saved; converted: not a JPEG inside.
 */
export const JPEG_REPAIR_METHODS = ['lossless', 'rebuilt', 'preview', 'converted'] as const;
export type JpegRepairMethod = (typeof JPEG_REPAIR_METHODS)[number];
export type JpegRepairResult = {
  method: JpegRepairMethod;
  width: number;
  height: number;
  /** Metadata the original carries that the repaired file does not. */
  metadataLost: JpegMetadataGroup[];
  /**
   * FL-1337: for `rebuilt`, how much of the picture is really there, as a whole percentage of its
   * rows: a picture cut short decodes to flat grey after the cut. Every other method keeps the whole
   * picture it has (`preview` keeps only the small one), so it is left out.
   */
  percentSaved?: number;
};

export type JpegMetadataGroup = 'EXIF' | 'XMP' | 'IPTC';
/** How each group's segment announces itself: APP1 Exif, APP1 XMP, APP13 Photoshop (IPTC). */
const METADATA_SIGNATURES: Array<[JpegMetadataGroup, string]> = [
  ['EXIF', 'Exif\0\0'],
  // the XMP namespace is a fixed identifier, not a link to follow
  // eslint-disable-next-line unicorn/prefer-https
  ['XMP', 'http://ns.adobe.com/xap/1.0/\0'],
  ['IPTC', 'Photoshop 3.0\0'],
];

export const JPEG_REPAIR_EXTENSIONS: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.jpe', '.jfif']);

const counts = (...values: number[]) => Buffer.from(values);
const table = (classAndId: number, bits: Buffer, values: Buffer) => Buffer.concat([counts(classAndId), bits, values]);
const range = (length: number) => Buffer.from(Array.from({ length }, (_, index) => index));
const hex = (text: string) => Buffer.from(text.replaceAll(/\s/g, ''), 'hex');

/** ITU T.81 Annex K.3: the standard DC and AC tables for luminance (0) and chrominance (1). */
const STANDARD_HUFFMAN_TABLES = [
  table(0x00, counts(0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0), range(12)),
  table(
    0x10,
    counts(0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d),
    hex(`
      01 02 03 00 04 11 05 12 21 31 41 06 13 51 61 07
      22 71 14 32 81 91 a1 08 23 42 b1 c1 15 52 d1 f0
      24 33 62 72 82 09 0a 16 17 18 19 1a 25 26 27 28
      29 2a 34 35 36 37 38 39 3a 43 44 45 46 47 48 49
      4a 53 54 55 56 57 58 59 5a 63 64 65 66 67 68 69
      6a 73 74 75 76 77 78 79 7a 83 84 85 86 87 88 89
      8a 92 93 94 95 96 97 98 99 9a a2 a3 a4 a5 a6 a7
      a8 a9 aa b2 b3 b4 b5 b6 b7 b8 b9 ba c2 c3 c4 c5
      c6 c7 c8 c9 ca d2 d3 d4 d5 d6 d7 d8 d9 da e1 e2
      e3 e4 e5 e6 e7 e8 e9 ea f1 f2 f3 f4 f5 f6 f7 f8
      f9 fa`),
  ),
  table(0x01, counts(0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0), range(12)),
  table(
    0x11,
    counts(0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77),
    hex(`
      00 01 02 03 11 04 05 21 31 06 12 41 51 07 61 71
      13 22 32 81 08 14 42 91 a1 b1 c1 09 23 33 52 f0
      15 62 72 d1 0a 16 24 34 e1 25 f1 17 18 19 1a 26
      27 28 29 2a 35 36 37 38 39 3a 43 44 45 46 47 48
      49 4a 53 54 55 56 57 58 59 5a 63 64 65 66 67 68
      69 6a 73 74 75 76 77 78 79 7a 82 83 84 85 86 87
      88 89 8a 92 93 94 95 96 97 98 99 9a a2 a3 a4 a5
      a6 a7 a8 a9 aa b2 b3 b4 b5 b6 b7 b8 b9 ba c2 c3
      c4 c5 c6 c7 c8 c9 ca d2 d3 d4 d5 d6 d7 d8 d9 da
      e2 e3 e4 e5 e6 e7 e8 e9 ea f2 f3 f4 f5 f6 f7 f8
      f9 fa`),
  ),
];
const DHT_BODY = Buffer.concat(STANDARD_HUFFMAN_TABLES);
export const STANDARD_DHT = Buffer.concat([
  counts(0xff, 0xc4, (DHT_BODY.length + 2) >> 8, (DHT_BODY.length + 2) & 0xff),
  DHT_BODY,
]);

const isApp = (marker: number) => marker >= 0xe0 && marker <= 0xef;
/** SOF markers: C0-CF without DHT (C4), JPG (C8) and DAC (CC). */
const isFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
/** Huffman-coded frames (C0-C3, C5-C7); C9-CF are arithmetic-coded and need no DHT. */
const isHuffmanFrame = (marker: number) => isFrame(marker) && marker < 0xc8;
/** Markers a lost walk may resume at: frames, tables, restart interval, scan, metadata. */
const isResyncMarker = (marker: number) =>
  isFrame(marker) || [0xc4, 0xcc, 0xdb, 0xdd, 0xda, 0xfe].includes(marker) || isApp(marker);
/** JFIF, ICC profile and Adobe colour transform: needed to show the picture right, so always kept. */
const isPictureApp = (marker: number) => [0xe0, 0xe2, 0xee].includes(marker);

const nextMarker = (bytes: Buffer, from: number) => {
  for (
    let index = bytes.indexOf(0xff, from);
    index !== -1 && index + 1 < bytes.length;
    index = bytes.indexOf(0xff, index + 1)
  ) {
    if (isResyncMarker(bytes[index + 1])) {
      return index;
    }
  }
  return -1;
};

export type JpegHeader = {
  /** The file again, when anything had to change; undefined when it was already sound. */
  rebuilt?: Buffer;
  /** The walk reached a scan: there is a picture to decode. */
  scan?: boolean;
  width?: number;
  height?: number;
};

/** Walk a JPEG's header from its SOI to its first scan, rebuilding what is broken. */
export const rebuildHeader = (body: Buffer, options: { stripMetadata?: boolean } = {}): JpegHeader => {
  const parts: Buffer[] = [SOI];
  let changed = false;
  let hasTables = false;
  let huffman = false;
  let width: number | undefined;
  let height: number | undefined;
  let position = 2;

  while (position + 1 < body.length) {
    if (body[position] !== 0xff) {
      // lost: pick up at the next real marker
      const next = nextMarker(body, position);
      if (next === -1) {
        return { width, height };
      }
      changed = true;
      position = next;
      continue;
    }
    const marker = body[position + 1];
    if (marker === 0xff) {
      position++; // fill byte
      continue;
    }
    if (marker === 0xda) {
      if (huffman && !hasTables) {
        parts.push(STANDARD_DHT);
        changed = true;
      }
      parts.push(body.subarray(position));
      return { rebuilt: changed ? Buffer.concat(parts) : undefined, scan: true, width, height };
    }
    if (marker === 0xd9 || marker === 0xd8) {
      return { width, height }; // no scan in this file
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      position += 2;
      continue;
    }

    const length = position + 3 < body.length ? body.readUInt16BE(position + 2) : 0;
    const end = position + 2 + length;
    if (length < 2 || end + 1 >= body.length || body[end] !== 0xff) {
      // a broken segment: drop it and pick up at the next real marker
      const next = nextMarker(body, position + 2);
      if (next === -1) {
        return { width, height };
      }
      changed = true;
      position = next;
      continue;
    }

    const segment = body.subarray(position, end);
    if (marker === 0xc4) {
      hasTables = true;
    }
    if (isFrame(marker) && width === undefined && length >= 7) {
      huffman = isHuffmanFrame(marker);
      height = body.readUInt16BE(position + 5);
      width = body.readUInt16BE(position + 7);
    }
    if (options.stripMetadata && ((isApp(marker) && !isPictureApp(marker)) || marker === 0xfe)) {
      changed = true;
    } else {
      parts.push(segment);
    }
    position = end;
  }
  return { width, height };
};

/** Trim padding after a cut and close the file with an end-of-image marker. */
const closeFile = (body: Buffer) => {
  if (body.length >= 4 && body.subarray(-2).equals(EOI)) {
    return body;
  }
  let end = body.length;
  const pad = body[end - 1];
  if (pad === 0x00 || pad === 0xff) {
    while (end > 2 && body[end - 1] === pad) {
      end--;
    }
    if (body.length - end < PADDING_RUN) {
      end = body.length;
    }
  }
  return Buffer.concat([body.subarray(0, end), EOI]);
};

/** Where pictures may start: each SOI, and a JFIF/Exif header with no SOI before it. */
const pictureStarts = (bytes: Buffer): Buffer[] => {
  const starts: Buffer[] = [];
  const firstSoi = bytes.indexOf(SOI);
  // no SOI before the header (lost with the bytes ahead of it): the first spot a sound header starts
  const before = Math.min(firstSoi === -1 ? bytes.length : firstSoi, HEADER_SEARCH_BYTES);
  let tries = 0;
  for (
    let at = bytes.indexOf(0xff);
    at !== -1 && at < before && tries < HEADER_SEARCH_TRIES;
    at = bytes.indexOf(0xff, at + 1)
  ) {
    const marker = bytes[at + 1];
    if (!isApp(marker) && marker !== 0xdb && marker !== 0xc4 && !isFrame(marker)) {
      continue;
    }
    tries++;
    const header = rebuildHeader(Buffer.concat([SOI, bytes.subarray(at, at + HEADER_WINDOW_BYTES)]));
    if (header.scan && !header.rebuilt && header.width) {
      starts.push(Buffer.concat([SOI, bytes.subarray(at)]));
      break;
    }
  }

  let offset = firstSoi;
  while (offset !== -1 && starts.length < MAX_JPEG_REPAIR_STARTS) {
    let start = offset;
    // a repeated SOI: keep the last one, which is followed by a real marker
    while (bytes[start + 2] === 0xff && bytes[start + 3] === 0xd8) {
      start += 2;
    }
    // SOI is always followed by another marker (FF xx); anything else is a stray FF D8 in data
    if (bytes[start + 2] === 0xff) {
      starts.push(bytes.subarray(start));
    }
    offset = bytes.indexOf(SOI, start + 2);
  }
  return starts;
};

export type JpegRepairCandidates = {
  /** In order of preference: the worker keeps an earlier one when a later one is no better. */
  candidates: Buffer[];
  /** The main picture's size from its header, when it could be read: tells a thumbnail rescue apart. */
  width?: number;
  height?: number;
  /** Metadata the file carries: a repair without one of these has lost the photo's details. */
  metadata: JpegMetadataGroup[];
};

export const jpegRepairCandidates = (bytes: Buffer): JpegRepairCandidates => {
  const candidates: Buffer[] = [];
  const add = (candidate?: Buffer) => {
    if (candidate && candidates.length < MAX_CANDIDATES && candidates.every((item) => !item.equals(candidate))) {
      candidates.push(candidate);
    }
  };
  let size: Pick<JpegHeader, 'width' | 'height'> = {};
  for (const start of pictureStarts(bytes)) {
    const body = closeFile(start);
    const header = rebuildHeader(body);
    if (size.width === undefined) {
      size = { width: header.width, height: header.height };
    }
    add(body);
    add(header.rebuilt);
    add(rebuildHeader(body, { stripMetadata: true }).rebuilt);
  }
  const metadata = METADATA_SIGNATURES.filter(([, signature]) => bytes.includes(signature)).map(([group]) => group);
  return { candidates, ...size, metadata };
};

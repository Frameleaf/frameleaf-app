import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import { mimeTypes } from 'src/utils/mime-types.js';

export type FileCause =
  'cut-short' | 'junk-in-front' | 'broken-details' | 'blank' | 'unreadable' | 'not-supported' | 'busy' | 'changed';

export const REPAIRABLE_CAUSES: ReadonlySet<FileCause> = new Set<FileCause>([
  'cut-short',
  'junk-in-front',
  'broken-details',
]);

export type FileShape = { jpegMarkerAt: number | null; blank: boolean; extension: string };

/** How far into a file a JPEG start marker (`FF D8 FF`) is looked for. */
export const JPEG_MARKER_WINDOW = 64 * 1024;

/** The offset of the first JPEG start marker lying wholly within the first 64 KiB of `bytes`, or null. */
export const findJpegMarker = (bytes: Buffer): number | null => {
  const end = Math.min(bytes.length, JPEG_MARKER_WINDOW);
  let from = 0;
  while (from + 2 < end) {
    const at = bytes.indexOf(0xff, from);
    if (at === -1 || at + 2 >= end) {
      return null;
    }
    if (bytes[at + 1] === 0xd8 && bytes[at + 2] === 0xff) {
      return at;
    }
    from = at + 1;
  }
  return null;
};

/** Reads the file once. A 0-byte file counts as blank. */
export const readFileShape = async (path: string): Promise<FileShape> => {
  const head: Buffer[] = [];
  let headLength = 0;
  let allZero = true;
  let allOnes = true;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    if (headLength < JPEG_MARKER_WINDOW) {
      const part = chunk.subarray(0, JPEG_MARKER_WINDOW - headLength);
      head.push(part);
      headLength += part.length;
    }
    if (allZero && chunk.some((byte) => byte !== 0x00)) {
      allZero = false;
    }
    if (allOnes && chunk.some((byte) => byte !== 0xff)) {
      allOnes = false;
    }
  }
  return {
    jpegMarkerAt: findJpegMarker(Buffer.concat(head)),
    blank: allZero || allOnes,
    extension: extname(path).toLowerCase(),
  };
};

const NOT_DECODED_EXTENSIONS = new Set(['.psd', '.ai', '.indd']);

const isBusy = (message: string) => /timeout|timed out|busy|\bEIO\b|\bEAGAIN\b|worker.*exit/i.test(message);
const isCutShort = (message: string) => /premature end|truncated|incomplete/i.test(message);
const isBrokenDetails = (message: string) => /huffman|\bSOI\b|marker|\bAPP\d* segment/i.test(message);

export const classifyFileProblem = ({
  message,
  shape,
  matchesStoredChecksum,
}: {
  message: string;
  shape: FileShape;
  matchesStoredChecksum: boolean | null;
}): FileCause => {
  if (matchesStoredChecksum === false) {
    return 'changed';
  }
  if (shape.blank) {
    return 'blank';
  }
  if (isBusy(message)) {
    return 'busy';
  }
  if (isCutShort(message)) {
    return 'cut-short';
  }
  if (
    (shape.jpegMarkerAt !== null && shape.jpegMarkerAt > 0) ||
    (shape.jpegMarkerAt !== null && /unsupported image format|improper image header/i.test(message))
  ) {
    return 'junk-in-front';
  }
  if (isBrokenDetails(message)) {
    return 'broken-details';
  }
  if (
    /unsupported/i.test(message) &&
    shape.jpegMarkerAt === null &&
    (NOT_DECODED_EXTENSIONS.has(shape.extension) || mimeTypes.isRaw(`file${shape.extension}`))
  ) {
    return 'not-supported';
  }
  return 'unreadable';
};

export type FixAction = 'retry-later' | 'leave-as-is' | 'find-original' | 'repair' | 'needs-you';

export const nextFixAction = ({
  cause,
  attempt,
  autoRepair,
  declined,
  repairableType,
  writable,
}: {
  cause: FileCause;
  attempt: number;
  autoRepair: boolean;
  declined: boolean;
  repairableType: boolean;
  writable: boolean;
}): FixAction => {
  if (cause === 'busy') {
    return attempt < 3 ? 'retry-later' : 'needs-you';
  }
  if (cause === 'not-supported') {
    return 'leave-as-is';
  }
  if (cause === 'changed') {
    return 'find-original';
  }
  if (REPAIRABLE_CAUSES.has(cause) && repairableType && writable && autoRepair && !declined) {
    return 'repair';
  }
  return 'needs-you';
};

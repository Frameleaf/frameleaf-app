import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { readTakeoutZipDirectory, takeoutZipDataOffset, TakeoutZipError } from 'src/utils/takeout-zip.js';

/**
 * Design files (FL-1358). One ladder shows them, in `MediaRepository`:
 *
 *   rendered    Photoshop and GIMP through ImageMagick, PDF and PDF-compatible Illustrator through pdfium
 *   container   the preview picture a ZIP-based document keeps at a known path
 *   embedded    a preview ExifTool finds inside the file (Photoshop thumbnail, EPS preview, XMP page image)
 *   placeholder nothing to show: the file is kept and gets the plain tile, never a damage finding
 */
export type DesignRung = 'rendered' | 'container' | 'embedded';

/** The file is fine and kept; it just holds no picture Frameleaf can show. */
export class DesignPreviewUnavailableError extends Error {
  constructor(path: string) {
    super(`No preview inside ${extname(path).toLowerCase() || 'this'} design file`);
  }
}

const RENDERED = new Set(['.psd', '.psb', '.xcf', '.pdf', '.ai']);
/** Whether libvips opens the file itself. */
export const isRenderedDesign = (path: string) => RENDERED.has(extname(path).toLowerCase());

/** The binary tags ExifTool reads a preview from, best first. */
export const DESIGN_PREVIEW_TAGS = [
  'PageImage',
  'PreviewImage',
  'PhotoshopThumbnail',
  'TIFFPreview',
  'PreviewTIFF',
  'ThumbnailImage',
  'ThumbnailTIFF',
];

/** Where each ZIP-based format keeps its flattened picture, best first. */
const CONTAINER_PREVIEWS: Record<string, string[]> = {
  '.cdr': ['previews/thumbnail.png', 'metadata/thumbnails/thumbnail.bmp'],
  '.fig': ['thumbnail.png'],
  '.kra': ['mergedimage.png', 'preview.png'],
  '.ora': ['mergedimage.png', 'Thumbnails/thumbnail.png'],
  '.procreate': ['QuickLook/Thumbnail.png'],
  '.sketch': ['previews/preview.png'],
  '.xd': ['preview.png', 'thumbnail.png'],
};

/** ponytail: a preview is read into memory whole; a larger one is skipped for the next path in the table. */
const MAX_PREVIEW_BYTES = 128 * 1024 * 1024;

/**
 * The preview picture inside a ZIP-based design file, or null when the file is not a ZIP, is not a
 * format in the table, or holds no preview. A file that cannot be read at all still throws.
 */
export const extractContainerPreview = async (path: string): Promise<Buffer | null> => {
  const wanted = CONTAINER_PREVIEWS[extname(path).toLowerCase()];
  if (!wanted) {
    return null;
  }
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const source = {
      size,
      read: async (position: number, length: number) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return buffer.subarray(0, bytesRead);
      },
    };
    const entries = await readTakeoutZipDirectory(source);
    for (const name of wanted) {
      const entry = entries.find((candidate) => candidate.name === name);
      if (!entry || entry.refused || Math.max(entry.compressedSize, entry.uncompressedSize) > MAX_PREVIEW_BYTES) {
        continue;
      }
      const stored = await source.read(await takeoutZipDataOffset(source, entry), entry.compressedSize);
      const data =
        entry.compression === 'store' ? stored : inflateRawSync(stored, { maxOutputLength: MAX_PREVIEW_BYTES });
      if (data.length === entry.uncompressedSize && crc32(data) === entry.crc32) {
        return data;
      }
    }
    return null;
  } catch (error) {
    // Not a ZIP, or a broken one: there is no container preview. Trouble reading the drive is not that.
    if (error instanceof TakeoutZipError || (error as NodeJS.ErrnoException).code?.startsWith('Z_')) {
      return null;
    }
    if (error instanceof RangeError || (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      return null;
    }
    throw error;
  } finally {
    await handle.close();
  }
};

const ZIP = Buffer.from('PK\u0003\u0004', 'latin1');
const DOS_EPS = Buffer.from([0xc5, 0xd0, 0xd3, 0xc6]);
const startsWith = (magic: Buffer | string) => (head: Buffer) =>
  head.subarray(0, magic.length).equals(Buffer.from(magic as string, 'latin1'));
const isZip = startsWith(ZIP);
/** A PDF may have a little junk before its header (the specification allows 1024 bytes). */
const isPdf = (head: Buffer) => head.subarray(0, 1024).includes('%PDF-', 0, 'latin1');
const isPostScript = (head: Buffer) => startsWith('%!PS')(head) || startsWith(DOS_EPS)(head);
const isPhotoshop = startsWith('8BPS');

/** How each design format announces itself. Older versions of a format are listed with the newer. */
const SIGNATURES: Record<string, (head: Buffer) => boolean> = {
  '.ai': (head) => isPdf(head) || isPostScript(head),
  '.cdr': (head) => isZip(head) || startsWith('RIFF')(head),
  '.eps': isPostScript,
  '.fig': (head) => isZip(head) || startsWith('fig-')(head),
  '.kra': isZip,
  '.ora': isZip,
  '.pdf': isPdf,
  '.procreate': isZip,
  '.psb': isPhotoshop,
  '.psd': isPhotoshop,
  '.sketch': (head) => isZip(head) || startsWith('SQLite format 3')(head) || startsWith('bplist')(head),
  '.xcf': startsWith('gimp xcf'),
  '.xd': isZip,
};

/** How much of the file `hasDesignSignature` wants to see. */
const DESIGN_SIGNATURE_BYTES = 1024 + 5;

/** Whether the first bytes are what a file of this name should start with. Unknown names are not judged. */
export const hasDesignSignature = (fileName: string, head: Buffer): boolean =>
  SIGNATURES[extname(fileName).toLowerCase()]?.(head) ?? true;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Fireworks keeps its editable document (pages, layers, text) in these private chunks beside the flat picture. */
const FIREWORKS_CHUNKS = new Set(['mkBF', 'mkBS', 'mkBT', 'mkTS', 'prVW']);
/** ponytail: Fireworks writes its chunks before the picture; a file with more chunks than this is not walked on. */
const MAX_PNG_CHUNKS = 4096;

/** Whether a PNG was saved by Fireworks with its editable data: told from its chunk names, never by decoding. */
export const isFireworksPng = async (path: string): Promise<boolean> => {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(8);
    if ((await handle.read(header, 0, 8, 0)).bytesRead < 8 || !header.equals(PNG_SIGNATURE)) {
      return false;
    }
    let position = 8;
    for (let count = 0; count < MAX_PNG_CHUNKS; count++) {
      if ((await handle.read(header, 0, 8, position)).bytesRead < 8) {
        return false;
      }
      const type = header.toString('latin1', 4, 8);
      if (FIREWORKS_CHUNKS.has(type)) {
        return true;
      }
      if (type === 'IEND') {
        return false;
      }
      position += 12 + header.readUInt32BE(0);
    }
    return false;
  } finally {
    await handle.close();
  }
};

/** Whether the file on the drive starts the way a design file of this name should. */
export const designFileHasSignature = async (path: string, fileName: string): Promise<boolean> => {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(DESIGN_SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return hasDesignSignature(fileName, head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
};

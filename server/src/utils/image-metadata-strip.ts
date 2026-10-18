/**
 * FL-455: a preview with its metadata removed and its pixels untouched, for smart search and faces on
 * Frameleaf Cloud. The cloud must see exactly the pixels this server's own ML service reads, so the preview
 * is never decoded and written again: only the segments or chunks that carry metadata (EXIF, XMP, IPTC,
 * comments, text) are left out. The colour profile is kept: it does not identify anyone, and neither the
 * local service nor the cloud runtime applies it. Anything this cannot read is refused, never sent as it is.
 */

export type StrippedImage = { data: Buffer; contentType: 'image/jpeg' | 'image/webp' | 'image/png' };

export class ImageMetadataStripError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageMetadataStripError';
  }
}

const fail = (message: string): never => {
  throw new ImageMetadataStripError(message);
};

/* ------------------------------------------------------------------ */
/* JPEG                                                                */
/* ------------------------------------------------------------------ */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP2 = 0xe2;
const APP14 = 0xee;
const COM = 0xfe;
const ICC_SIGNATURE = Buffer.from('ICC_PROFILE\0', 'latin1');

/** Whether a marker segment carries metadata: every APPn but JFIF, the ICC profile and Adobe, and comments. */
const isJpegMetadata = (marker: number, payload: Buffer): boolean => {
  if (marker === COM) {
    return true;
  }
  if (marker < APP0 || marker > 0xef) {
    return false;
  }
  if (marker === APP0) {
    // JFIF and JFXX: the first may carry a thumbnail, which is image data of no use; JFXX is a thumbnail only
    return !payload.subarray(0, 5).equals(Buffer.from('JFIF\0', 'latin1'));
  }
  if (marker === APP2) {
    return !payload.subarray(0, ICC_SIGNATURE.length).equals(ICC_SIGNATURE);
  }
  // APP14 "Adobe" says how the colour channels are coded; dropping it would change the decoded pixels
  return marker !== APP14;
};

/** Markers with no length field. */
const isStandalone = (marker: number) =>
  marker === SOI || marker === EOI || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;

export const stripJpegMetadata = (input: Buffer): Buffer => {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== SOI) {
    fail('not a JPEG');
  }
  const out: Buffer[] = [input.subarray(0, 2)];
  let offset = 2;
  let sawScan = false;
  for (;;) {
    if (offset + 2 > input.length) {
      return fail('the JPEG ends before its end marker');
    }
    if (input[offset] !== 0xff) {
      return fail('a JPEG marker was expected');
    }
    let marker = input[offset + 1];
    // fill bytes
    while (marker === 0xff) {
      offset++;
      if (offset + 2 > input.length) {
        return fail('the JPEG ends before its end marker');
      }
      marker = input[offset + 1];
    }
    if (marker === EOI) {
      if (!sawScan) {
        fail('the JPEG has no image data');
      }
      out.push(input.subarray(offset, offset + 2));
      // anything after the end marker (an appended second image, a trailer) is left out
      return Buffer.concat(out);
    }
    if (isStandalone(marker)) {
      out.push(input.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > input.length) {
      return fail('a JPEG segment is cut short');
    }
    const length = input.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > input.length) {
      return fail('a JPEG segment is cut short');
    }
    const payload = input.subarray(offset + 4, end);
    if (!isJpegMetadata(marker, payload)) {
      out.push(input.subarray(offset, end));
    }
    offset = end;
    if (marker === SOS) {
      sawScan = true;
      // entropy-coded data runs until the next marker that is not stuffing (0xFF00) or a restart (RSTn)
      let scan = offset;
      while (scan + 1 < input.length) {
        if (input[scan] === 0xff) {
          const next = input[scan + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) {
            break;
          }
        }
        scan++;
      }
      if (scan + 1 >= input.length) {
        return fail('the JPEG ends inside its image data');
      }
      out.push(input.subarray(offset, scan));
      offset = scan;
    }
  }
};

/* ------------------------------------------------------------------ */
/* WebP                                                                */
/* ------------------------------------------------------------------ */

const fourcc = (value: Buffer, at: number) => value.toString('latin1', at, at + 4);

export const stripWebpMetadata = (input: Buffer): Buffer => {
  if (input.length < 20 || fourcc(input, 0) !== 'RIFF' || fourcc(input, 8) !== 'WEBP') {
    fail('not a WebP');
  }
  const size = input.readUInt32LE(4) + 8;
  if (size > input.length) {
    fail('the WebP is cut short');
  }
  const chunks: Buffer[] = [];
  let offset = 12;
  let image = false;
  while (offset + 8 <= size) {
    const id = fourcc(input, offset);
    const length = input.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (end > size) {
      return fail('a WebP chunk is cut short');
    }
    if (['VP8 ', 'VP8L', 'ANMF'].includes(id)) {
      image = true;
    }
    if (id !== 'EXIF' && id !== 'XMP ') {
      const chunk = Buffer.from(input.subarray(offset, end));
      if (id === 'VP8X' && length >= 1) {
        // the extended header says which chunks follow: the EXIF (0x08) and XMP (0x04) flags are cleared
        chunk[8] &= ~0x0c;
      }
      chunks.push(chunk);
    }
    offset = end;
  }
  if (!image) {
    fail('the WebP has no image data');
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
};

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks that carry metadata and never change the pixels. */
const PNG_METADATA = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

export const stripPngMetadata = (input: Buffer): Buffer => {
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('not a PNG');
  }
  const out: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  for (;;) {
    if (offset + 12 > input.length) {
      return fail('the PNG ends before its end chunk');
    }
    const length = input.readUInt32BE(offset);
    const type = input.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > input.length) {
      return fail('a PNG chunk is cut short');
    }
    if (!PNG_METADATA.has(type)) {
      out.push(input.subarray(offset, end));
    }
    offset = end;
    if (type === 'IEND') {
      return Buffer.concat(out);
    }
  }
};

/** The preview without its metadata, with its pixels exactly as they are, or a refusal. */
export const stripImageMetadata = (input: Buffer): StrippedImage => {
  if (input.length >= 2 && input[0] === 0xff && input[1] === SOI) {
    return { data: stripJpegMetadata(input), contentType: 'image/jpeg' };
  }
  if (input.length >= 12 && fourcc(input, 0) === 'RIFF' && fourcc(input, 8) === 'WEBP') {
    return { data: stripWebpMetadata(input), contentType: 'image/webp' };
  }
  if (input.length >= 8 && input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { data: stripPngMetadata(input), contentType: 'image/png' };
  }
  return fail('only JPEG, WebP and PNG previews are sent');
};

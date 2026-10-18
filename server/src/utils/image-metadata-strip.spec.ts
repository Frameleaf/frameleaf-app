import { describe, expect, it } from 'vitest';
import {
  ImageMetadataStripError,
  stripImageMetadata,
  stripJpegMetadata,
  stripPngMetadata,
  stripWebpMetadata,
} from 'src/utils/image-metadata-strip.js';

const segment = (marker: number, payload: Buffer) => {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
};
const latin = (value: string) => Buffer.from(value, 'latin1');

describe('stripJpegMetadata (FL-455)', () => {
  const soi = Buffer.from([0xff, 0xd8]);
  const eoi = Buffer.from([0xff, 0xd9]);
  const jfif = segment(0xe0, Buffer.concat([latin('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]));
  const exif = segment(0xe1, Buffer.concat([latin('Exif\0\0'), latin('GPS 51.5N 0.1W')]));
  const xmp = segment(0xe1, latin('https://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'));
  const iptc = segment(0xed, latin('Photoshop 3.0\0IPTC'));
  const icc = segment(0xe2, Buffer.concat([latin('ICC_PROFILE\0'), Buffer.from([1, 1, 9, 9, 9])]));
  const mpf = segment(0xe2, latin('MPF\0data'));
  const adobe = segment(0xee, latin('Adobe\0d\0\0\0\0\u{1}'));
  const comment = segment(0xfe, latin('taken at home'));
  const dqt = segment(0xdb, Buffer.alloc(65, 1));
  const sof = segment(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0]));
  const sos = segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]));
  // entropy data with byte stuffing (FF 00) and a restart marker (FF D0) that must be kept as they are
  const scan = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);

  it('leaves out EXIF, XMP, IPTC, comments and other APP data, keeping every image byte as it is', () => {
    const input = Buffer.concat([soi, jfif, exif, xmp, iptc, icc, mpf, adobe, comment, dqt, sof, sos, scan, eoi]);
    const output = stripJpegMetadata(input);
    expect(output).toEqual(Buffer.concat([soi, jfif, icc, adobe, dqt, sof, sos, scan, eoi]));
    expect(output.includes(latin('GPS'))).toBe(false);
    expect(output.includes(latin('xmpmeta'))).toBe(false);
  });

  it('keeps every scan of a progressive JPEG and leaves out data after the end marker', () => {
    const dht = segment(0xc4, Buffer.alloc(20, 2));
    const input = Buffer.concat([soi, dqt, sof, sos, scan, dht, comment, sos, scan, eoi, latin('trailer with Exif')]);
    expect(stripJpegMetadata(input)).toEqual(Buffer.concat([soi, dqt, sof, sos, scan, dht, sos, scan, eoi]));
  });

  it('refuses a file that is not a complete JPEG', () => {
    expect(() => stripJpegMetadata(latin('nope'))).toThrow(ImageMetadataStripError);
    expect(() => stripJpegMetadata(Buffer.concat([soi, dqt, sof, sos, scan]))).toThrow(ImageMetadataStripError);
    expect(() => stripJpegMetadata(Buffer.concat([soi, jfif, eoi]))).toThrow(/no image data/);
  });
});

const chunk = (id: string, data: Buffer) => {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'latin1');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const riff = (...chunks: Buffer[]) => {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
};

describe('stripWebpMetadata (FL-455)', () => {
  it('leaves out the EXIF and XMP chunks and clears their flags, keeping the image and colour profile', () => {
    const flags = Buffer.from([0x20 | 0x08 | 0x04, 0, 0, 0, 15, 0, 0, 15, 0, 0]);
    const iccp = chunk('ICCP', Buffer.alloc(12, 3));
    const image = chunk('VP8 ', Buffer.alloc(31, 4));
    const output = stripWebpMetadata(
      riff(chunk('VP8X', flags), iccp, image, chunk('EXIF', latin('GPS 51.5N')), chunk('XMP ', latin('<x:xmpmeta/>'))),
    );
    const expected = Buffer.from(flags);
    expected[0] = 0x20;
    expect(output).toEqual(riff(chunk('VP8X', expected), iccp, image));
    expect(output.readUInt32LE(4)).toBe(output.length - 8);
  });

  it('refuses a WebP without image data', () => {
    expect(() => stripWebpMetadata(riff(chunk('EXIF', latin('x'))))).toThrow(ImageMetadataStripError);
  });
});

const pngChunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, latin(type), data, Buffer.alloc(4, 7)]);
};

describe('stripPngMetadata (FL-455)', () => {
  it('leaves out text, EXIF and time chunks, keeping the image and colour profile', () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = pngChunk('IHDR', Buffer.alloc(13, 1));
    const iccp = pngChunk('iCCP', Buffer.alloc(9, 2));
    const idat = pngChunk('IDAT', Buffer.alloc(20, 3));
    const iend = pngChunk('IEND', Buffer.alloc(0));
    const input = Buffer.concat([
      signature,
      ihdr,
      pngChunk('tEXt', latin('Comment\0at home')),
      pngChunk('eXIf', latin('GPS')),
      iccp,
      pngChunk('tIME', Buffer.alloc(7)),
      idat,
      pngChunk('iTXt', latin('XML:com.adobe.xmp\0')),
      iend,
    ]);
    expect(stripPngMetadata(input)).toEqual(Buffer.concat([signature, ihdr, iccp, idat, iend]));
  });
});

describe(stripImageMetadata.name, () => {
  it('names the format it read and refuses anything else', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', Buffer.alloc(13)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(stripImageMetadata(png).contentType).toBe('image/png');
    expect(() => stripImageMetadata(latin('GIF89a....'))).toThrow(/only JPEG, WebP and PNG/);
  });
});

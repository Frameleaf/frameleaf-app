import { STANDARD_DHT, jpegRepairCandidates, rebuildHeader } from 'src/utils/jpeg-repair.js';

const segment = (marker: number, ...payload: number[]) =>
  Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload]);
/** SOF0, 16×8, one component. */
const frame = segment(0xc0, 8, 0, 8, 0, 16, 1, 1, 0x11, 0);
const scan = Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34]);
const EOI = Buffer.from([0xff, 0xd9]);
const jpeg = (...parts: Buffer[]) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...parts, scan, EOI]);
const dht = segment(0xc4, 0x00, ...Array.from({ length: 16 }, () => 0));
const exif = segment(0xe1, ...Buffer.from('Exif\0\0data'));

describe('jpegRepairCandidates', () => {
  it('keeps a whole file as it is, first', () => {
    const file = jpeg(dht, frame);
    expect(jpegRepairCandidates(file)).toEqual({ candidates: [file], width: 16, height: 8, metadata: [] });
  });

  it('drops a header before the start of the image', () => {
    const file = jpeg(dht, frame);
    expect(jpegRepairCandidates(Buffer.concat([Buffer.alloc(128, 7), file])).candidates[0]).toEqual(file);
  });

  it('collapses a repeated start-of-image marker', () => {
    const file = jpeg(dht, frame);
    const doubled = Buffer.concat([Buffer.from([0xff, 0xd8]), file]);
    expect(jpegRepairCandidates(doubled).candidates[0]).toEqual(file);
  });

  it('puts back a start-of-image marker lost with the bytes before it', () => {
    const file = jpeg(dht, frame);
    expect(jpegRepairCandidates(Buffer.concat([Buffer.from('junk'), file.subarray(2)])).candidates[0]).toEqual(file);
  });

  it('closes a cut-off file and trims padding after the cut', () => {
    const cut = jpeg(dht, frame).subarray(0, -2);
    expect(jpegRepairCandidates(cut).candidates[0]).toEqual(Buffer.concat([cut, EOI]));
    expect(jpegRepairCandidates(Buffer.concat([cut, Buffer.alloc(500)])).candidates[0]).toEqual(
      Buffer.concat([cut, EOI]),
    );
  });

  it('offers each joined file and skips a stray FF D8 in data', () => {
    const second = jpeg(dht, frame);
    const first = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xd8, 0x00, 9]);
    expect(jpegRepairCandidates(Buffer.concat([first, second])).candidates).toContainEqual(second);
  });

  it('notes the metadata it carries, and finds nothing in a file with no picture', () => {
    // eslint-disable-next-line unicorn/prefer-https
    const xmp = segment(0xe1, ...Buffer.from('http://ns.adobe.com/xap/1.0/\0<x/>'));
    expect(jpegRepairCandidates(jpeg(exif, xmp, dht, frame)).metadata).toEqual(['EXIF', 'XMP']);
    expect(jpegRepairCandidates(Buffer.from('not a jpeg')).candidates).toEqual([]);
  });
});

describe('rebuildHeader', () => {
  it('leaves a sound header alone and reads the picture size', () => {
    expect(rebuildHeader(jpeg(dht, frame))).toEqual({ scan: true, width: 16, height: 8 });
  });

  it('drops a segment whose length runs past the next marker', () => {
    const broken = Buffer.from(exif);
    broken.writeUInt16BE(exif.length + 3, 2);
    expect(rebuildHeader(jpeg(broken, dht, frame)).rebuilt).toEqual(jpeg(dht, frame));
  });

  it('can drop metadata but keeps what the picture needs', () => {
    const jfif = segment(0xe0, ...Buffer.from('JFIF\0'));
    const comment = segment(0xfe, 1, 2);
    expect(rebuildHeader(jpeg(jfif, exif, comment, dht, frame), { stripMetadata: true }).rebuilt).toEqual(
      jpeg(jfif, dht, frame),
    );
  });

  it('adds the standard Huffman tables when a Huffman frame has none', () => {
    expect(rebuildHeader(jpeg(frame)).rebuilt).toEqual(jpeg(frame, STANDARD_DHT));
    // arithmetic-coded frames need none
    const arithmetic = Buffer.from(frame);
    arithmetic[1] = 0xc9;
    expect(rebuildHeader(jpeg(arithmetic)).rebuilt).toBeUndefined();
  });
});

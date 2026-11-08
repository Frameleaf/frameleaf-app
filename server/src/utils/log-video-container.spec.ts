import { readContainerLogSignals } from 'src/utils/log-video-container.js';

const box = (type: string, ...children: Buffer[]) => {
  const body = Buffer.concat(children);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
};
const fullBox = (type: string, ...children: Buffer[]) => box(type, Buffer.alloc(4), ...children);

/** A ProRes visual sample entry as AVFoundation writes it for Apple Log: colr, fiel, logs, then a 4-byte terminator. */
const appleLogSampleEntry = (identifier: string) =>
  box(
    'apcn',
    Buffer.alloc(78),
    box('colr', Buffer.from('nclc'), Buffer.from([0, 9, 0, 2, 0, 9])),
    box('fiel', Buffer.from([1, 0])),
    box('logs', Buffer.from(identifier, 'latin1')),
    Buffer.alloc(4),
  );

const movie = (...entries: Buffer[]) => {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(entries.length);
  return box(
    'moov',
    box('mvhd', Buffer.alloc(100)),
    box(
      'trak',
      box('tkhd', Buffer.alloc(84)),
      box('mdia', box('minf', box('stbl', fullBox('stsd', count, ...entries), box('stts', Buffer.alloc(8))))),
    ),
  );
};

const sonyXml = `<?xml version="1.0" encoding="UTF-8"?>
<NonRealTimeMeta xmlns="urn:schemas-professionalDisc:nonRealTimeMeta:ver.2.20">
  <AcquisitionRecord>
    <Group name="CameraUnitMetadataSet">
      <Item name="CaptureGammaEquation" value="s-log3-cine"/>
      <Item name="CaptureColorPrimaries" value="S-Gamut3.Cine-SLog3"/>
      <Item name="CodingEquations" value="rec709"/>
    </Group>
  </AcquisitionRecord>
  <Device manufacturer="Sony" modelName="ILCE-7SM3"/>
</NonRealTimeMeta>`;

const sonyMeta = () =>
  fullBox(
    'meta',
    fullBox('hdlr', Buffer.alloc(4), Buffer.from('nrtm'), Buffer.alloc(13)),
    fullBox('xml ', Buffer.from(sonyXml, 'utf8')),
  );

const read = (file: Buffer) => {
  const reads: Array<[number, number]> = [];
  const reader = (position: number, length: number) => {
    reads.push([position, length]);
    return Promise.resolve(file.subarray(position, position + length));
  };
  return { reads, signals: () => readContainerLogSignals(reader, file.length) };
};

const ftyp = box('ftyp', Buffer.from('qt  '), Buffer.alloc(4), Buffer.from('qt  '));
const mdat = (size: number) => box('mdat', Buffer.alloc(size));

describe('readContainerLogSignals', () => {
  it('reads the Apple Log identifier from the sample entry', async () => {
    const file = Buffer.concat([ftyp, mdat(64), movie(appleLogSampleEntry('com.apple.rec2020.apple-log'))]);
    await expect(read(file).signals()).resolves.toEqual({
      sampleEntryLogTag: 'com.apple.rec2020.apple-log',
      sonyCaptureGamma: null,
      sonyCaptureGamut: null,
    });
  });

  it('reads Apple Log 2 the same way', async () => {
    const file = Buffer.concat([ftyp, movie(appleLogSampleEntry('com.apple.apple-wide-gamut.apple-log')), mdat(8)]);
    await expect(read(file).signals()).resolves.toMatchObject({
      sampleEntryLogTag: 'com.apple.apple-wide-gamut.apple-log',
    });
  });

  it('reads every Sony XML item, not just the first', async () => {
    const file = Buffer.concat([box('ftyp', Buffer.from('XAVC')), mdat(32), movie(), sonyMeta()]);
    await expect(read(file).signals()).resolves.toEqual({
      sampleEntryLogTag: null,
      sonyCaptureGamma: 's-log3-cine',
      sonyCaptureGamut: 'S-Gamut3.Cine-SLog3',
    });
  });

  it('finds Sony XML inside moov as well', async () => {
    const moov = movie();
    const withMeta = box('moov', moov.subarray(8), sonyMeta());
    await expect(read(Buffer.concat([ftyp, withMeta])).signals()).resolves.toMatchObject({
      sonyCaptureGamma: 's-log3-cine',
    });
  });

  it('finds nothing in an ordinary file', async () => {
    const ordinary = box('avc1', Buffer.alloc(78), box('avcC', Buffer.alloc(16)), box('pasp', Buffer.alloc(8)));
    await expect(read(Buffer.concat([ftyp, movie(ordinary), mdat(16)])).signals()).resolves.toEqual({
      sampleEntryLogTag: null,
      sonyCaptureGamma: null,
      sonyCaptureGamut: null,
    });
  });

  it('never reads the media data', async () => {
    const big = mdat(4096);
    const file = Buffer.concat([ftyp, big, movie(appleLogSampleEntry('com.apple.rec2020.apple-log'))]);
    const { reads, signals } = read(file);
    await signals();
    expect(reads.every(([position, length]) => !(position === ftyp.length && length > 16))).toBe(true);
    expect(reads.reduce((total, [, length]) => total + length, 0)).toBeLessThan(1024);
  });

  it('handles 64-bit box sizes', async () => {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1);
    header.write('mdat', 4, 'latin1');
    header.writeBigUInt64BE(BigInt(16 + 32), 8);
    const file = Buffer.concat([
      ftyp,
      header,
      Buffer.alloc(32),
      movie(appleLogSampleEntry('com.apple.rec2020.apple-log')),
    ]);
    await expect(read(file).signals()).resolves.toMatchObject({ sampleEntryLogTag: 'com.apple.rec2020.apple-log' });
  });

  it('stops quietly on a malformed or truncated file', async () => {
    const truncated = movie(appleLogSampleEntry('com.apple.rec2020.apple-log')).subarray(0, 40);
    await expect(read(Buffer.concat([ftyp, truncated])).signals()).resolves.toEqual({
      sampleEntryLogTag: null,
      sonyCaptureGamma: null,
      sonyCaptureGamut: null,
    });
    await expect(read(Buffer.from('not a movie at all')).signals()).resolves.toMatchObject({ sampleEntryLogTag: null });
  });

  it('rejects an identifier that is not a plain reverse-DNS string', async () => {
    const file = Buffer.concat([ftyp, movie(appleLogSampleEntry('com.apple <script>'))]);
    await expect(read(file).signals()).resolves.toMatchObject({ sampleEntryLogTag: null });
  });
});

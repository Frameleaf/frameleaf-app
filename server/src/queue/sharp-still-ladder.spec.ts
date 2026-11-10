import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { Colorspace } from 'src/enum.js';
import { SharpOperations } from 'src/queue/sharp-operations.js';

const fixture = (name: string) => resolve(import.meta.dirname, '../../test/fixtures/formats', name);
const options = { colorspace: Colorspace.Srgb, processInvalidImages: false };

describe('still ladder: the libvips rungs (FL-1356)', () => {
  const sut = new SharpOperations();

  it('opens a sound picture strictly', async () => {
    const decoded = await sut.decodeImage(fixture('jpeg/baseline.jpg'), options);
    expect(decoded).toMatchObject({ rung: 'strict', info: { width: 320, height: 240 } });
  });

  it('reads a cut-short JPEG leniently without being asked to', async () => {
    const decoded = await sut.decodeImage(fixture('jpeg/truncated-tail.jpg'), options);
    expect(decoded).toMatchObject({ rung: 'lenient', info: { width: 320, height: 240 } });
  });

  it('stops at the strict reading when only that is wanted', async () => {
    await expect(
      sut.decodeImage(fixture('jpeg/truncated-tail.jpg'), { ...options, ladder: 'strict' }),
    ).rejects.toThrow();
  });

  it('skips the strict reading when lenient is forced', async () => {
    const decoded = await sut.decodeImage(fixture('jpeg/baseline.jpg'), { ...options, processInvalidImages: true });
    expect(decoded.rung).toBe('lenient');
  });

  it('finds the JPEG behind junk at the start of the file', async () => {
    const decoded = await sut.decodeImage(fixture('jpeg/junk-before-soi.jpg'), options);
    expect(decoded).toMatchObject({ rung: 'lenient', info: { width: 320, height: 240 } });
  });

  it('does not take a picture embedded in some other kind of file for the file itself', async () => {
    const jpeg = await readFile(fixture('jpeg/baseline.jpg'));
    const wrapped = Buffer.concat([Buffer.from('not a picture format'), jpeg]);
    await expect(sut.decodeImage(wrapped, options)).rejects.toThrow();
  });

  it('keeps the first complaint when no reading opens the file', async () => {
    await expect(sut.decodeImage(Buffer.from('damaged image'), options)).rejects.toThrow('unsupported image format');
  });

  it('reports the rung with a thumbnail batch', async () => {
    const input = await sharp({ create: { width: 16, height: 8, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const batch = { outputs: [], edits: [], checkTransparency: false };
    expect(await sut.generateImageThumbnails(input, options, batch)).toMatchObject({ rung: 'strict' });
  });
});

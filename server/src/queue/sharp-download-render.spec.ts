import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { SharpOperations } from 'src/queue/sharp-operations.js';

describe('renderDownloadJpeg (FL-826)', () => {
  const sut = new SharpOperations();
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'download-render-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A transparent PNG stored on its side (EXIF orientation 6). */
  const source = async () => {
    const path = join(dir, 'source.png');
    await sharp({ create: { width: 3000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .withMetadata({ orientation: 6 })
      .toFile(path);
    return path;
  };

  it('writes an upright full-size JPEG on white without the source metadata', async () => {
    const output = join(dir, 'full.jpg');
    await sut.renderDownloadJpeg(await source(), output, null);
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 1000, height: 3000 });
    expect(metadata.orientation).toBeUndefined();
    const { data } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)]).toEqual([255, 255, 255]);
  });

  it('fits a web-size JPEG inside the long edge and never enlarges', async () => {
    const web = join(dir, 'web.jpg');
    await sut.renderDownloadJpeg(await source(), web, 2048);
    await expect(sharp(web).metadata()).resolves.toMatchObject({ width: 683, height: 2048 });

    const small = join(dir, 'small.png');
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#336699' } })
      .png()
      .toFile(small);
    const kept = join(dir, 'small.jpg');
    await sut.renderDownloadJpeg(small, kept, 2048);
    await expect(sharp(kept).metadata()).resolves.toMatchObject({ width: 800, height: 600 });
  });

  it('refuses to write over its input or an invalid size', async () => {
    const input = await source();
    await expect(sut.renderDownloadJpeg(input, input, null)).rejects.toThrow('INVALID_DOWNLOAD_RENDER');
    await expect(sut.renderDownloadJpeg(input, join(dir, 'x.jpg'), 0)).rejects.toThrow('INVALID_DOWNLOAD_RENDER');
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { SharpOperations } from 'src/queue/sharp-operations.js';

describe('measureImageQuality', () => {
  const sut = new SharpOperations();
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'image-quality-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const solid = async (size: number) => {
    const path = join(dir, `solid-${size}.png`);
    await sharp({ create: { width: size, height: size, channels: 3, background: '#c81e1e' } })
      .png()
      .toFile(path);
    return path;
  };

  it('reports finite values for a 1x1 image, whose stdev libvips gives as NaN', async () => {
    const stats = await sut.measureImageQuality(await solid(1));
    for (const value of Object.values(stats)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(stats.contrast).toBe(0);
    await expect(sut.scoreThumbnailCandidate(await solid(1))).resolves.toBe(stats.thumbnailScore);
  });
});

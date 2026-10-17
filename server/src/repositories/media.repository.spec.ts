import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AssetEditAction, MirrorAxis } from 'src/dtos/editing.dto.js';
import { Colorspace, ImageFormat } from 'src/enum.js';
import { SharpOperations } from 'src/queue/sharp-operations.js';
import { sharpProcessPool } from 'src/queue/sharp-pool.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { orientedToOriginal } from 'src/utils/develop-cleanup.js';
import { AudioChannelPolicy, findAudioLayoutMismatch, findAvAlignmentMismatch } from 'src/utils/media-policy.js';
import {
  audioReattachOffsetSeconds,
  chunkClipOutputOptions,
  fullVideoUploadOutputOptions,
  previewClipOutputOptions,
  reattachAudioOutputOptions,
  uploadClipOutputOptions,
} from 'src/utils/media-privacy.js';
import { automock } from 'test/utils.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    // CI installs ffmpeg through mise: there a missing ffmpeg is a broken runner, never a skip
    if (process.env.CI) {
      throw new Error('[media.repository.spec] ffmpeg is not installed on CI; the byte-level clip tests must run');
    }
    console.warn('[media.repository.spec] ffmpeg is not installed; the byte-level clip tests are skipped');
    return false;
  }
})();

const getPixelColor = async (buffer: Buffer, x: number, y: number) => {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width!;
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * width + x) * 4;
  return {
    r: data[idx],
    g: data[idx + 1],
    b: data[idx + 2],
  };
};

const buildTestQuadImage = async () => {
  // build a 4 quadrant image for testing mirroring
  const base = sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png();

  const tl = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();

  const tr = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 0, g: 255, b: 0 } },
  })
    .png()
    .toBuffer();

  const bl = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer();

  const br = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 255, g: 255, b: 0 } },
  })
    .png()
    .toBuffer();

  const image = base.composite([
    { input: tl, left: 0, top: 0 }, // top-left
    { input: tr, left: 500, top: 0 }, // top-right
    { input: bl, left: 0, top: 500 }, // bottom-left
    { input: br, left: 500, top: 500 }, // bottom-right
  ]);

  return image.png().toBuffer();
};

describe(MediaRepository.name, () => {
  let sut: MediaRepository;

  afterAll(() => sharpProcessPool.close());

  beforeEach(() => {
    // eslint-disable-next-line no-sparse-arrays
    sut = new MediaRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
  });

  describe('HDR capability discovery', () => {
    it('shares an in-flight probe, bounds admission and caches a temporary failure', async () => {
      let signal: AbortSignal | undefined;
      const run = vi.spyOn(sharpProcessPool, 'run').mockImplementation((_operation, _args, abort) => {
        signal = abort;
        return new Promise((_resolve, reject) =>
          abort?.addEventListener('abort', () => reject(abort.reason), { once: true }),
        );
      });
      try {
        const first = sut.getHdrCodecCapabilities();
        expect(sut.getHdrCodecCapabilities()).toBe(first);
        await expect(first).resolves.toBeNull();
        expect(signal?.aborted).toBe(true);
        await expect(sut.getHdrCodecCapabilities()).resolves.toBeNull();
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        run.mockRestore();
      }
    });

    it('reuses a successful installed-codec result across feature requests', async () => {
      const codecs = { libheif: '1.23.3', libultrahdr: '2.0.2', heicDecoder: true, avifDecoder: false };
      const run = vi.spyOn(sharpProcessPool, 'run').mockResolvedValue(codecs);
      try {
        await expect(sut.getHdrCodecCapabilities()).resolves.toEqual(codecs);
        await expect(sut.getHdrCodecCapabilities()).resolves.toEqual(codecs);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        run.mockRestore();
      }
    });
  });

  describe('applyEdits (single actions)', () => {
    it('should apply crop edit correctly', async () => {
      const result = new SharpOperations().applyEdits(
        sharp({
          create: {
            width: 1000,
            height: 1000,
            channels: 4,
            background: { r: 255, g: 0, b: 0, alpha: 0.5 },
          },
        }).png(),
        [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 100,
              y: 200,
              width: 700,
              height: 300,
            },
          },
        ],
      );

      const metadata = await result.toBuffer().then((buf) => sharp(buf).metadata());
      expect(metadata.width).toBe(700);
      expect(metadata.height).toBe(300);
    });
    it('should apply rotate edit correctly', async () => {
      const result = new SharpOperations().applyEdits(
        sharp({
          create: {
            width: 500,
            height: 1000,
            channels: 4,
            background: { r: 255, g: 0, b: 0, alpha: 0.5 },
          },
        }).png(),
        [
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
        ],
      );

      const metadata = await result.toBuffer().then((buf) => sharp(buf).metadata());
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);
    });

    it('should apply mirror edit correctly', async () => {
      const resultHorizontal = new SharpOperations().applyEdits(sharp(await buildTestQuadImage()), [
        {
          action: AssetEditAction.Mirror,
          parameters: {
            axis: MirrorAxis.Horizontal,
          },
        },
      ]);

      const bufferHorizontal = await resultHorizontal.toBuffer();
      const metadataHorizontal = await resultHorizontal.metadata();
      expect(metadataHorizontal.width).toBe(1000);
      expect(metadataHorizontal.height).toBe(1000);

      expect(await getPixelColor(bufferHorizontal, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 990, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 10, 990)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });

      const resultVertical = new SharpOperations().applyEdits(sharp(await buildTestQuadImage()), [
        {
          action: AssetEditAction.Mirror,
          parameters: {
            axis: MirrorAxis.Vertical,
          },
        },
      ]);

      const bufferVertical = await resultVertical.toBuffer();
      const metadataVertical = await resultVertical.metadata();
      expect(metadataVertical.width).toBe(1000);
      expect(metadataVertical.height).toBe(1000);

      // top-left should now be bottom-left (blue)
      expect(await getPixelColor(bufferVertical, 10, 10)).toEqual({ r: 0, g: 0, b: 255 });
      // top-right should now be bottom-right (yellow)
      expect(await getPixelColor(bufferVertical, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      // bottom-left should now be top-left (red)
      expect(await getPixelColor(bufferVertical, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      // bottom-right should now be top-right (blue)
      expect(await getPixelColor(bufferVertical, 990, 990)).toEqual({ r: 0, g: 255, b: 0 });
    });
  });

  describe('applyEdits (multiple sequential edits)', () => {
    it('should apply horizontal mirror then vertical mirror (equivalent to 180° rotation)', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = new SharpOperations().applyEdits(sharp(imageBuffer), [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply rotate 90° then horizontal mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = new SharpOperations().applyEdits(sharp(imageBuffer), [
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 255, b: 0 });
    });

    it('should apply 180° rotation', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = new SharpOperations().applyEdits(sharp(imageBuffer), [
        { action: AssetEditAction.Rotate, parameters: { angle: 180 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply 270° rotations', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = new SharpOperations().applyEdits(sharp(imageBuffer), [
        { action: AssetEditAction.Rotate, parameters: { angle: 270 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should apply crop then rotate 90°', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = new SharpOperations().applyEdits(sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1000, height: 500 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(500);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('should apply rotate 90° then crop', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = new SharpOperations().applyEdits(sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 1000 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply vertical mirror then horizontal mirror then rotate 90°', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = new SharpOperations().applyEdits(sharp(imageBuffer), [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should apply crop to single quadrant then mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = new SharpOperations().applyEdits(sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 500 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(500);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 490, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 10, 490)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 490, 490)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply all operations: crop, rotate, mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = new SharpOperations().applyEdits(sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 1000 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
    });
  });

  describe('renderDevelopGeometry (FL-113, FL-233)', () => {
    it('turns, then mirrors the turned frame, exactly as brush and bitmap masks map back to the original', async () => {
      const width = 5;
      const height = 3;
      // every pixel's red channel is its index in the original
      const input = Buffer.alloc(width * height * 3);
      for (let index = 0; index < width * height; index += 1) {
        input[index * 3] = index * 10;
      }
      for (const rotation of [0, 90, 180, 270] as const) {
        for (const flipHorizontal of [false, true]) {
          for (const flipVertical of [false, true]) {
            const oriented = rotation % 180 === 0 ? { width, height } : { width: height, height: width };
            const { data, info } = await sut.renderDevelopGeometry(
              input,
              { width, height, channels: 3 },
              {
                rotation,
                flipHorizontal,
                flipVertical,
                oriented,
                straighten: 0,
                extract: { left: 0, top: 0, ...oriented },
                output: oriented,
              },
            );
            expect({ width: info.width, height: info.height }).toEqual(oriented);
            const mapping = { oriented, rotation, flipHorizontal, flipVertical };
            for (let oy = 0; oy < oriented.height; oy += 1) {
              for (let ox = 0; ox < oriented.width; ox += 1) {
                const point = orientedToOriginal(ox + 0.5, oy + 0.5, mapping);
                const source = Math.floor(point.y) * width + Math.floor(point.x);
                expect({
                  rotation,
                  flipHorizontal,
                  flipVertical,
                  ox,
                  oy,
                  value: data[(oy * info.width + ox) * info.channels],
                }).toEqual({
                  rotation,
                  flipHorizontal,
                  flipVertical,
                  ox,
                  oy,
                  value: source * 10,
                });
              }
            }
          }
        }
      }
    });

    it('mirrors the turned frame: a quarter turn then a left-right mirror', async () => {
      // [[0, 1, 2], [3, 4, 5]] turned clockwise is [[3, 0], [4, 1], [5, 2]], mirrored [[0, 3], [1, 4], [2, 5]]
      const input = Buffer.from([0, 1, 2, 3, 4, 5].flatMap((value) => [value * 40, 0, 0]));
      const oriented = { width: 2, height: 3 };
      const { data, info } = await sut.renderDevelopGeometry(
        input,
        { width: 3, height: 2, channels: 3 },
        {
          rotation: 90,
          flipHorizontal: true,
          flipVertical: false,
          oriented,
          straighten: 0,
          extract: { left: 0, top: 0, ...oriented },
          output: oriented,
        },
      );
      const red = Array.from({ length: 6 }, (_, index) => data[index * info.channels] / 40);
      expect(red).toEqual([0, 3, 1, 4, 2, 5]);
    });

    it('applies the keystone correction to the oriented frame, keeping its size (renderer v4)', async () => {
      const width = 20;
      const height = 20;
      // a white column at x = 0 on black
      const input = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y += 1) input.fill(255, y * width * 3, y * width * 3 + 3);
      const plan = {
        rotation: 0 as const,
        flipHorizontal: false,
        flipVertical: false,
        oriented: { width, height },
        straighten: 0,
        extract: { left: 0, top: 0, width, height },
        output: { width, height },
      };
      const flat = await sut.renderDevelopGeometry(input, { width, height, channels: 3 }, plan);
      const keystone = await sut.renderDevelopGeometry(
        input,
        { width, height, channels: 3 },
        { ...plan, perspective: { vertical: 100, horizontal: 0 } },
      );
      expect({ width: keystone.info.width, height: keystone.info.height }).toEqual({ width, height });
      // the widened top samples inside the frame, off the column; the bottom row still shows it
      expect(flat.data[0]).toBe(255);
      expect(keystone.data[0]).toBeLessThan(64);
      expect(keystone.data[(height - 1) * width * 3]).toBeGreaterThan(200);
    });
  });

  describe('develop artifacts (FL-233)', () => {
    it('stores a mask as greyscale PNG and a fill with alpha, identically every time, and decodes them', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'develop-artifact-'));
      try {
        const input = join(dir, 'in.png');
        writeFileSync(
          input,
          await sharp({
            create: { width: 4, height: 3, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 0.5 } },
          })
            .png()
            .toBuffer(),
        );
        const mask = await sut.normalizeDevelopArtifact(input, 'mask');
        expect(mask).toMatchObject({ width: 4, height: 3 });
        expect((await sharp(mask.data).metadata()).channels).toBe(1);
        expect((await sut.normalizeDevelopArtifact(input, 'mask')).data).toEqual(mask.data);

        const fill = await sut.normalizeDevelopArtifact(input, 'fill');
        expect((await sharp(fill.data).metadata()).channels).toBe(4);

        const stored = join(dir, 'fill.png');
        writeFileSync(stored, fill.data);
        const decoded = await sut.decodeDevelopArtifact(stored, 'fill');
        expect(decoded).toMatchObject({ width: 4, height: 3, channels: 4 });
        expect([...decoded.data.subarray(0, 4)]).toEqual([200, 100, 50, 128]);

        writeFileSync(stored, mask.data);
        const grey = await sut.decodeDevelopArtifact(stored, 'mask');
        expect(grey).toMatchObject({ width: 4, height: 3, channels: 1 });
        expect(grey.data).toHaveLength(12);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('generateThumbnail', () => {
    it('should process random Authentik thumbnail image', async () => {
      const response = await fetch(
        'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NHB4IiBoZWlnaHQ9IjY0cHgiIHZpZXdCb3g9IjAgMCA2NCA2NCIgdmVyc2lvbj0iMS4xIj48cmVjdCBmaWxsPSIjMzc3YjM3IiBjeD0iMzIiIGN5PSIzMiIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByPSIzMiIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBzdHlsZT0iY29sb3I6ICNmZmY7IGxpbmUtaGVpZ2h0OiAxOyBmb250LWZhbWlseTogJ1JlZEhhdFRleHQnLCdPdmVycGFzcycsb3ZlcnBhc3MsaGVsdmV0aWNhLGFyaWFsLHNhbnMtc2VyaWY7ICIgZmlsbD0iI2ZmZiIgYWxpZ25tZW50LWJhc2VsaW5lPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtc2l6ZT0iMjgiIGZvbnQtd2VpZ2h0PSI0MDAiIGR5PSIuMWVtIj5BQTwvdGV4dD48L3N2Zz4=',
      );
      const buffer = Buffer.from(await response.arrayBuffer());
      // fs.mkdtempDisposableSync requires Node >= 24; use mkdtempSync + manual cleanup
      const dirPath = mkdtempSync(join(tmpdir(), 'media-repository-'));
      try {
        const file = join(dirPath, 'test.webp');
        await sut.generateThumbnail(
          buffer,
          { colorspace: Colorspace.P3, quality: 80, format: ImageFormat.Webp, processInvalidImages: false },
          file,
        );

        expect(statSync(file).blksize).toBeGreaterThan(0);
      } finally {
        rmSync(dirPath, { recursive: true, force: true });
      }
    });
  });

  describe('isolated image orientation', () => {
    it('applies EXIF orientation in the child, strips metadata and leaves the original bytes intact', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'sharp-orientation-'));
      try {
        const input = join(directory, 'original.jpg');
        const output = join(directory, 'derived.png');
        await sharp({ create: { width: 12, height: 8, channels: 3, background: '#c02020' } })
          .withMetadata({ orientation: 6 })
          .withIccProfile('p3')
          .jpeg()
          .toFile(input);
        const original = readFileSync(input);
        expect(await sut.getOrientedSize(input)).toEqual({ width: 8, height: 12 });
        await sut.writeStrippedStill(input, output, 'png');
        const metadata = await sharp(output).metadata();
        expect(metadata).toMatchObject({ width: 8, height: 12, format: 'png' });
        expect(metadata.icc).toBeDefined();
        expect(metadata.exif).toBeUndefined();
        expect(metadata.orientation).toBeUndefined();
        expect(readFileSync(input)).toEqual(original);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  describe('writeStrippedStill (FL-162)', () => {
    it('keeps the pixels and the ICC profile, and drops every EXIF, GPS and XMP byte', async () => {
      const dirPath = mkdtempSync(join(tmpdir(), 'media-repository-'));
      try {
        const input = join(dirPath, 'located.jpg');
        await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 40, b: 40 } } })
          .withIccProfile('p3')
          .withExif({
            IFD0: { Make: 'FrameleafTestCamera', Copyright: 'Private person' },
            IFD3: {
              GPSLatitudeRef: 'N',
              GPSLatitude: '51/1 30/1 0/1',
              GPSLongitudeRef: 'W',
              GPSLongitude: '0/1 7/1 0/1',
            },
          })
          .jpeg()
          .toFile(input);
        const before = await sharp(input).metadata();
        expect(before.exif).toBeDefined();

        const output = join(dirPath, 'stripped.jpg');
        await sut.writeStrippedStill(input, output, 'jpeg');

        const after = await sharp(output).metadata();
        expect(after.format).toBe('jpeg');
        expect(after.width).toBe(64);
        expect(after.height).toBe(48);
        expect(after.exif).toBeUndefined();
        expect(after.xmp).toBeUndefined();
        expect(after.iptc).toBeUndefined();
        expect(after.icc).toBeDefined();
        // the bytes that would be uploaded carry none of the camera or location text
        const bytes = readFileSync(output).toString('latin1');
        expect(bytes).not.toContain('FrameleafTestCamera');
        expect(bytes).not.toContain('Private person');
        expect(bytes).not.toContain('Exif\u{0}\u{0}');
      } finally {
        rmSync(dirPath, { recursive: true, force: true });
      }
    });

    it('writes anything that is not a JPEG as a lossless PNG without metadata', async () => {
      const dirPath = mkdtempSync(join(tmpdir(), 'media-repository-'));
      try {
        const input = join(dirPath, 'located.png');
        await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } } })
          .withExif({ IFD0: { Make: 'FrameleafTestCamera' } })
          .png()
          .toFile(input);

        const output = join(dirPath, 'stripped.png');
        await sut.writeStrippedStill(input, output, 'png');

        const after = await sharp(output).metadata();
        expect(after.format).toBe('png');
        expect(after.exif).toBeUndefined();
        expect(readFileSync(output).toString('latin1')).not.toContain('FrameleafTestCamera');
      } finally {
        rmSync(dirPath, { recursive: true, force: true });
      }
    });
  });

  /*
   * FL-162: the clips cut from a video for another machine (the preview comparison clip, what is
   * uploaded from it, and a chunk of a whole video) are made with real ffmpeg from a fixture that
   * carries a location, a creation time, camera tags, a custom handler name and chapters, and then
   * read back with ffprobe and as raw bytes. Skipped only where no ffmpeg is installed; CI installs
   * the pinned jellyfin-ffmpeg through mise.
   */
  it.skipIf(!hasFfmpeg)('reads mastering from the later default video stream (FL-107)', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'studio-mastering-'));
    const file = join(folder, 'hdr.mp4');
    try {
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=white:size=32x16:rate=24',
          '-map',
          '0:v',
          '-map',
          '0:v',
          '-frames:v',
          '1',
          '-c:v',
          'libx265',
          '-pix_fmt',
          'yuv420p10le',
          '-color_trc',
          'smpte2084',
          '-x265-params:v:0',
          'master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,50)',
          '-x265-params:v:1',
          'master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(40000000,50)',
          '-disposition:v:0',
          '0',
          '-disposition:v:1',
          'default',
          file,
        ],
        { timeout: 30_000, stdio: 'ignore' },
      );
      const output = await sut.probe(file);
      expect(output.videoStreams.map(({ index }) => index)).toEqual([1, 0]);
      expect(
        (await sut.probeHdrMastering(file, 0)).find((entry) => entry.side_data_type === 'Mastering display metadata'),
      ).toMatchObject({ max_luminance: '10000000/10000' });
      expect(
        (await sut.probeHdrMastering(file, output.videoStreams[0].index)).find(
          (entry) => entry.side_data_type === 'Mastering display metadata',
        ),
      ).toMatchObject({
        max_luminance: '40000000/10000',
        min_luminance: '50/10000',
        red_x: '35400/50000',
        white_point_y: '16450/50000',
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  describe.skipIf(!hasFfmpeg)('video clips for another machine (FL-162)', () => {
    const secrets = [
      '+51.5007-000.1246/',
      'FrameleafTestCamera',
      'Private person',
      'Birthday at home',
      'SecretHandler',
    ];
    let dirPath: string;
    let fixture: string;

    const transcode = (input: string, output: string, inputOptions: string[], outputOptions: string[]) =>
      sut.transcode(input, output, {
        inputOptions,
        outputOptions,
        twoPass: false,
        progress: { frameCount: 0, percentInterval: 5 },
      });

    beforeAll(() => {
      dirPath = mkdtempSync(join(tmpdir(), 'media-repository-clips-'));
      const chapters = join(dirPath, 'chapters.txt');
      writeFileSync(
        chapters,
        ';FFMETADATA1\ntitle=Private person\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1500\ntitle=Birthday at home\n' +
          '[CHAPTER]\nTIMEBASE=1/1000\nSTART=1500\nEND=3000\ntitle=Cake\n',
      );
      fixture = join(dirPath, 'located.mp4');
      execFileSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=160x120:rate=25:duration=3',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=3',
          '-i',
          chapters,
          '-map',
          '0:v',
          '-map',
          '1:a',
          '-map_metadata',
          '2',
          '-map_chapters',
          '2',
          '-metadata',
          'location=+51.5007-000.1246/',
          '-metadata',
          'location-eng=+51.5007-000.1246/',
          '-metadata',
          'creation_time=2019-04-01T10:00:00Z',
          '-metadata',
          'make=FrameleafTestCamera',
          '-metadata',
          'model=FrameleafTestCamera Pro',
          '-metadata:s:v',
          'handler_name=SecretHandler',
          '-metadata:s:a',
          'handler_name=SecretHandler',
          '-metadata:s:v',
          'creation_time=2019-04-01T10:00:00Z',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-movflags',
          'use_metadata_tags',
          fixture,
        ],
        { stdio: 'pipe' },
      );
    });

    afterAll(() => {
      rmSync(dirPath, { recursive: true, force: true });
    });

    const ffprobe = (file: string) =>
      JSON.parse(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file],
          { encoding: 'utf8' },
        ),
      ) as {
        format: { tags?: Record<string, string> };
        streams: { codec_type: string; tags?: Record<string, string> }[];
        chapters: unknown[];
      };

    /** Tags an MP4 muxer writes by itself in bitexact mode; none of them describes the person or the place. */
    const structural = new Set([
      'major_brand',
      'minor_version',
      'compatible_brands',
      'encoder',
      'language',
      'handler_name',
      'vendor_id',
    ]);

    const expectNoMetadata = (file: string, streams: string[]) => {
      const probe = ffprobe(file);
      expect(probe.chapters).toEqual([]);
      expect(probe.streams.map((stream) => stream.codec_type)).toEqual(streams);
      const tags = [probe.format.tags ?? {}, ...probe.streams.map((stream) => stream.tags ?? {})];
      for (const set of tags) {
        expect(Object.keys(set).filter((key) => !structural.has(key))).toEqual([]);
        expect(Object.values(set).join(' ')).not.toMatch(/SecretHandler|Frameleaf|2019/);
      }
      const bytes = readFileSync(file).toString('latin1');
      for (const secret of secrets) {
        expect(bytes).not.toContain(secret);
      }
      expect(bytes).not.toContain('2019-04-01');
    };

    it('starts from a fixture that really carries a location, dates, camera tags and chapters', () => {
      const probe = ffprobe(fixture);
      expect(probe.chapters).toHaveLength(2);
      expect(probe.format.tags).toMatchObject({ location: '+51.5007-000.1246/', make: 'FrameleafTestCamera' });
      expect(probe.format.tags?.creation_time).toMatch(/^2019-04-01/);
      expect(readFileSync(fixture).toString('latin1')).toContain('Birthday at home');
    });

    it('cuts the preview comparison clip with its audio and none of that metadata', async () => {
      const clip = join(dirPath, 'before.mp4');
      await transcode(fixture, clip, ['-ss', '0.500', '-t', '1.500'], previewClipOutputOptions());
      expectNoMetadata(clip, ['video', 'audio']);
    });

    it('cuts a cropped preview clip without metadata too', async () => {
      const clip = join(dirPath, 'before-cropped.mp4');
      await transcode(
        fixture,
        clip,
        ['-ss', '0.000', '-t', '1.000'],
        previewClipOutputOptions(['-vf', 'crop=80:60:0:0']),
      );
      expectNoMetadata(clip, ['video', 'audio']);
    });

    it('uploads the clip as its video stream alone, still without metadata', async () => {
      const clip = join(dirPath, 'before-for-upload.mp4');
      await transcode(fixture, clip, ['-ss', '0.500', '-t', '1.500'], previewClipOutputOptions());
      const upload = join(dirPath, 'input.mp4');
      await transcode(clip, upload, [], uploadClipOutputOptions());
      expectNoMetadata(upload, ['video']);
    });

    /**
     * The handler type of every track in an MP4, read from the file's own bytes: `moov` → `trak` →
     * `mdia` → `hdlr`, whose handler type (`vide`, `soun`, …) sits 8 bytes into its payload. An audio
     * track is a `soun` handler, whatever ffprobe makes of it.
     */
    const trackHandlers = (file: string): string[] => {
      const bytes = readFileSync(file);
      const handlers: string[] = [];
      const walk = (start: number, end: number) => {
        let offset = start;
        while (offset + 8 <= end) {
          let size = bytes.readUInt32BE(offset);
          const type = bytes.toString('latin1', offset + 4, offset + 8);
          let header = 8;
          if (size === 1) {
            size = Number(bytes.readBigUInt64BE(offset + 8));
            header = 16;
          } else if (size === 0) {
            size = end - offset;
          }
          if (size < header || offset + size > end) {
            throw new Error(`malformed ${type} box at ${offset}`);
          }
          if (['moov', 'trak', 'mdia'].includes(type)) {
            walk(offset + header, offset + size);
          } else if (type === 'hdlr') {
            handlers.push(bytes.toString('latin1', offset + header + 8, offset + header + 12));
          }
          offset += size;
        }
      };
      walk(0, bytes.length);
      return handlers;
    };

    it('uploads a whole video for restoration or Smooth motion with no audio track in its bytes (FC-47)', async () => {
      // the source really carries an audio track (and a chapter text track)
      expect(trackHandlers(fixture)).toEqual(expect.arrayContaining(['vide', 'soun']));
      // stream-copied, as a copyable codec is, with its SEI messages dropped
      const copied = join(dirPath, 'whole-copied.mp4');
      await transcode(
        fixture,
        copied,
        [],
        fullVideoUploadOutputOptions({ copy: true, bsf: 'filter_units=remove_types=6' }),
      );
      expect(trackHandlers(copied)).toEqual(['vide']);
      expect(ffprobe(copied).streams.map((stream) => stream.codec_type)).toEqual(['video']);
      // re-encoded, as any other codec is
      const encoded = join(dirPath, 'whole-encoded.mp4');
      await transcode(fixture, encoded, [], fullVideoUploadOutputOptions({ copy: false }));
      expect(trackHandlers(encoded)).toEqual(['vide']);
      // and the preview clip that is uploaded
      const clip = join(dirPath, 'before-bytes.mp4');
      await transcode(fixture, clip, ['-ss', '0.500', '-t', '1.500'], previewClipOutputOptions());
      expect(trackHandlers(clip)).toEqual(['vide', 'soun']);
      const upload = join(dirPath, 'input-bytes.mp4');
      await transcode(clip, upload, [], uploadClipOutputOptions());
      expect(trackHandlers(upload)).toEqual(['vide']);
    });

    it('puts the original audio back on the returned video, in step, as ffprobe confirms (CLD-202)', async () => {
      // what came back from the cloud: the picture alone
      const returned = join(dirPath, 'returned.mp4');
      await transcode(fixture, returned, [], fullVideoUploadOutputOptions({ copy: true }));
      const original = await sut.probe(fixture);
      const offset = audioReattachOffsetSeconds(original.videoStreams[0].startTime, original.audioStreams[0].startTime);
      const version = join(dirPath, 'version.mp4');
      await transcode(returned, version, [], reattachAudioOutputOptions(fixture, offset));

      expect(trackHandlers(version)).toEqual(['vide', 'soun']);
      const probe = await sut.probe(version);
      const source = original.audioStreams[0];
      expect(
        findAudioLayoutMismatch(
          {
            policy: AudioChannelPolicy.Preserve,
            channels: source.channels ?? null,
            channelLayout: source.channelLayout ?? null,
            sampleRate: source.sampleRate ?? null,
          },
          probe.audioStreams[0],
        ),
      ).toBeNull();
      expect(findAvAlignmentMismatch(probe.videoStreams[0], probe.audioStreams[0])).toBeNull();
      expect(Math.abs((probe.audioStreams[0].startTime ?? 0) - (probe.videoStreams[0].startTime ?? 0))).toBeLessThan(
        0.05,
      );
    });

    it('cuts a chunk of the whole video with no audio and no metadata', async () => {
      const chunk = join(dirPath, 'chunk-0-in.mp4');
      await transcode(fixture, chunk, ['-ss', '1.000', '-t', '2.000'], chunkClipOutputOptions());
      expectNoMetadata(chunk, ['video']);
    });
  });
});

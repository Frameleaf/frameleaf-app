import { exiftool } from 'exiftool-vendored';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AssetEditAction, MirrorAxis } from 'src/dtos/editing.dto.js';
import { Colorspace, ImageFormat } from 'src/enum.js';
import { SharpOperations } from 'src/queue/sharp-operations.js';
import { SharpOperationError, sharpProcessPool } from 'src/queue/sharp-pool.js';
import { SharpResourceLimitError } from 'src/queue/sharp-protocol.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { cloudVideoClip, isPlainVideoStream } from 'src/utils/cloud-ml-job.js';
import { DesignPreviewUnavailableError } from 'src/utils/design-preview.js';
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

  describe('design files (FL-1358)', () => {
    const options = { colorspace: Colorspace.Srgb, processInvalidImages: false };
    const decoded = { data: Buffer.alloc(3), info: { width: 1, height: 1, channels: 3 } } as never;
    const batch = { outputs: [], edits: [], checkTransparency: false };
    const design = (name: string) => join('test/fixtures/formats/design', name);
    let run: ReturnType<typeof vi.spyOn>;
    let embedded: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      run = vi.spyOn(sharpProcessPool, 'run').mockResolvedValue(decoded);
      embedded = vi.spyOn(exiftool, 'extractBinaryTagToBuffer').mockRejectedValue(new Error('no such tag'));
    });
    afterEach(() => vi.restoreAllMocks());

    it('renders a Photoshop document itself', async () => {
      await expect(sut.decodeImage(design('layered-no-composite.psd'), options)).resolves.toMatchObject({
        designRung: 'rendered',
      });
      expect(run).toHaveBeenCalledWith('decodeImage', [design('layered-no-composite.psd'), options]);
      expect(embedded).not.toHaveBeenCalled();
    });

    it('shows the picture inside a container without asking the renderer to open the container', async () => {
      await expect(sut.decodeImage(design('painting.kra'), options)).resolves.toMatchObject({
        designRung: 'container',
      });
      expect(run).toHaveBeenCalledTimes(1);
      const [, [source]] = run.mock.calls[0] as [string, [Buffer]];
      expect(Buffer.isBuffer(source) && source.subarray(1, 4).toString()).toBe('PNG');
    });

    it('falls back to the preview a document carries when it cannot be rendered or is too large to', async () => {
      for (const failure of [
        new SharpOperationError('magickload: cache resources exhausted', true),
        new SharpResourceLimitError('Input image exceeds pixel limit'),
      ]) {
        run.mockReset().mockRejectedValueOnce(failure).mockResolvedValue(decoded);
        embedded
          .mockReset()
          .mockImplementation((tag: string) =>
            tag === 'PhotoshopThumbnail' ? Promise.resolve(Buffer.from('jpeg')) : Promise.reject(new Error('none')),
          );
        const thumbnails = await sut.generateImageThumbnails(design('thumbnail-only.psd'), options, batch);
        expect(thumbnails).toMatchObject({ designRung: 'embedded' });
        expect(run).toHaveBeenLastCalledWith('generateImageThumbnails', [Buffer.from('jpeg'), options, batch]);
      }
    });

    it('has nothing to show for a file with no picture inside, which is not a decode failure', async () => {
      for (const name of ['no-preview.eps', 'no-preview.sketch']) {
        await expect(sut.decodeImage(design(name), options)).rejects.toBeInstanceOf(DesignPreviewUnavailableError);
      }
      run.mockRejectedValue(new SharpOperationError('magickload: improper image header', true));
      await expect(sut.decodeImage(design('thumbnail-only.psd'), options)).rejects.toBeInstanceOf(
        DesignPreviewUnavailableError,
      );
    });

    it('does not take a stopped image worker, or a thumbnail it could not write, for a file that will not render', async () => {
      const stopped = new Error('Sharp child closed');
      run.mockRejectedValue(stopped);
      await expect(sut.decodeImage(design('flat.psd'), options)).rejects.toBe(stopped);
      const unwritable = new SharpOperationError('EACCES: permission denied, open /thumbs/a.webp');
      run.mockRejectedValue(unwritable);
      await expect(sut.generateImageThumbnails(design('flat.psd'), options, batch)).rejects.toBe(unwritable);
      expect(embedded).not.toHaveBeenCalled();
    });

    it('never sends a design file to the sensor decoder', async () => {
      run.mockRejectedValue(new SharpOperationError('magickload: improper image header', true));
      await expect(sut.decodeImage(design('flat.psd'), options)).rejects.toBeInstanceOf(DesignPreviewUnavailableError);
      // one render attempt, and no second one from a LibRaw rendering
      expect(run).toHaveBeenCalledTimes(1);
    });
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

  /*
   * FL-1489: a Matroska track whose default duration is a negative number stored unsigned. ffprobe
   * divides it by the 1,000,000 ns timestamp scale and reports 18446744072576 ticks for every
   * packet, which does not fit asset_keyframe's integer[] and failed the whole metadata statement.
   * The file is real: ffmpeg writes it, then the 4-byte DefaultDuration is widened to 8 bytes in
   * the room left by dropping the track's "und" Language element, so no element size changes.
   */
  it.skipIf(!hasFfmpeg)('reads a packet duration past the integer range as unstated (FL-1489)', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'wrapped-duration-'));
    const file = join(folder, 'wrapped.mkv');
    try {
      execFileSync(
        'ffmpeg',
        ['-v', 'error', '-f', 'lavfi', '-i', 'color=white:size=32x16:rate=25', '-frames:v', '3', '-c:v', 'mpeg4', file],
        { timeout: 30_000, stdio: 'ignore' },
      );
      const language = Buffer.from('22b59c83756e64', 'hex');
      const original = readFileSync(file);
      const at = original.indexOf(language);
      const trimmed = Buffer.concat([original.subarray(0, at), original.subarray(at + language.length)]);
      const duration = trimmed.indexOf(Buffer.from('23e38384', 'hex'));
      expect(Math.min(at, duration)).toBeGreaterThan(0);
      const wrapped = Buffer.alloc(8);
      wrapped.writeBigInt64BE(-1_133_551_616n);
      writeFileSync(
        file,
        Buffer.concat([
          trimmed.subarray(0, duration),
          Buffer.from('23e38388', 'hex'),
          wrapped,
          Buffer.from('ec8100', 'hex'), // a Void element fills the rest of the dropped Language
          trimmed.subarray(duration + 8),
        ]),
      );
      expect(
        execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=duration', '-of', 'csv=p=0', file])
          .toString()
          .split('\n', 1)[0],
      ).toBe('18446744072576');

      const { videoStreams } = await sut.probe(file);
      expect(videoStreams[0]).toMatchObject({ codecName: 'mpeg4', timeBase: 1000, width: 32, height: 16 });
      // no keyframe index to store, so the video and its other metadata are saved without one
      await expect(sut.probePackets(file, videoStreams[0].index)).resolves.toBeNull();
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
  /**
   * FL-1725: Frameleaf Cloud's worker checks an uploaded clip's own size and packet count and then decodes
   * it. Real clips, made by ffmpeg and prepared with the options the server uploads with.
   */
  describe.skipIf(!hasFfmpeg)('a video for Frameleaf Cloud restoration or Smooth motion (FL-1725)', () => {
    let folder: string;
    const make = (arguments_: string[]) =>
      execFileSync('ffmpeg', ['-v', 'error', '-y', ...arguments_], { timeout: 60_000, stdio: 'ignore' });
    const upload = (input: string, output: string, copy: boolean, constantRate?: string) =>
      sut.transcode(input, output, {
        inputOptions: [],
        outputOptions: fullVideoUploadOutputOptions({
          copy,
          bsf: copy ? 'filter_units=remove_types=6' : undefined,
          constantRate,
        }),
        twoPass: false,
        progress: { frameCount: 0, percentInterval: 5 },
      });
    /** What a decoder shows: the frames ffprobe reads when it decodes the stream. */
    const decodedFrames = (file: string) =>
      Number(
        execFileSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-count_frames',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=nb_read_frames',
            '-of',
            'csv=p=0',
            file,
          ],
          { encoding: 'utf8' },
        ).trim(),
      );
    const measured = async (file: string) => {
      const stream = (await sut.probe(file, { countFrames: true })).videoStreams[0];
      return { stream, packets: await sut.countPackets(file, stream.index) };
    };

    beforeAll(() => {
      folder = mkdtempSync(join(tmpdir(), 'media-repository-cloud-video-'));
      make([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30',
        '-t',
        '4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '30',
        join(folder, 'plain.mp4'),
      ]);
      for (const rotation of [90, 180, 270]) {
        make([
          '-display_rotation',
          String(rotation),
          '-i',
          join(folder, 'plain.mp4'),
          '-c',
          'copy',
          join(folder, `rotated-${rotation}.mp4`),
        ]);
      }
      // a trim made by stream copy: the packets before the cut stay in the file, hidden by its edit list
      make(['-ss', '1.5', '-i', join(folder, 'plain.mp4'), '-t', '2.1', '-c', 'copy', join(folder, 'trimmed.mp4')]);
    });

    afterAll(() => rmSync(folder, { recursive: true, force: true }));

    it('copies a plain stream: every packet is a frame, and the declared length counts back to them', async () => {
      const { stream, packets } = await measured(join(folder, 'plain.mp4'));
      expect(isPlainVideoStream(stream, packets)).toBe(true);
      const copy = join(folder, 'plain-upload.mp4');
      await upload(join(folder, 'plain.mp4'), copy, true);
      const uploaded = await measured(copy);
      expect(isPlainVideoStream(uploaded.stream, uploaded.packets)).toBe(true);
      expect(uploaded.packets).toMatchObject({ packets: 120, hidden: 0, uneven: false, unordered: false });
      expect(decodedFrames(copy)).toBe(120);
      const clip = cloudVideoClip('v1', uploaded.stream)!;
      expect(clip).toMatchObject({ fps: 30, width: 320, height: 240 });
      expect(Math.floor(clip.durationSec * clip.fps + 0.5)).toBe(120);
    });

    it.each([
      [90, 240, 320],
      [180, 320, 240],
      [270, 240, 320],
    ])(
      'never copies a source turned %i degrees: the upload is upright with no rotation',
      async (rotation, width, height) => {
        const source = join(folder, `rotated-${rotation}.mp4`);
        const { stream, packets } = await measured(source);
        expect(isPlainVideoStream(stream, packets)).toBe(false);
        // what a copy would send: the rotation survives the metadata strip, against the stream's own size
        const copied = join(folder, `rotated-${rotation}-copied.mp4`);
        await upload(source, copied, true);
        const kept = await measured(copied);
        expect(isPlainVideoStream(kept.stream, kept.packets)).toBe(false);
        // what is sent instead
        const encoded = join(folder, `rotated-${rotation}-upload.mp4`);
        await upload(source, encoded, false);
        const uploaded = await measured(encoded);
        expect(isPlainVideoStream(uploaded.stream, uploaded.packets)).toBe(true);
        expect(cloudVideoClip('v1', uploaded.stream)).toMatchObject({ width, height, fps: 30 });
        expect(decodedFrames(encoded)).toBe(uploaded.packets.packets);
      },
    );

    it('never copies a variable-rate source: the upload has one frame rate', async () => {
      const source = join(folder, 'variable.mp4');
      // the first second at 30 frames a second, then every third frame
      make([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30',
        '-t',
        '4',
        '-vf',
        String.raw`select='lt(n\,30)+not(mod(n\,3))'`,
        '-fps_mode',
        'vfr',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        source,
      ]);
      const { stream, packets } = await measured(source);
      expect(packets).toMatchObject({ hidden: 0, uneven: true });
      expect(isPlainVideoStream(stream, packets)).toBe(false);

      const rate = stream.frameRateRational!;
      const encoded = join(folder, 'variable-upload.mp4');
      await upload(source, encoded, false, `${rate.num}/${rate.den}`);
      const uploaded = await measured(encoded);
      expect(uploaded.packets).toMatchObject({ hidden: 0, uneven: false });
      expect(isPlainVideoStream(uploaded.stream, uploaded.packets)).toBe(true);
      expect(cloudVideoClip('v1', uploaded.stream)!.fps).toBeCloseTo(rate.num / rate.den, 6);
      expect(decodedFrames(encoded)).toBe(uploaded.packets.packets);
    });

    it('does not take the one-tick jitter of a millisecond time base for a variable rate', async () => {
      const source = join(folder, 'jitter.mkv');
      make([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=60',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        source,
      ]);
      expect(await sut.countPackets(source, 0)).toMatchObject({ packets: 120, hidden: 0, uneven: false });
    });

    it('takes a frame rate that changes by less than half for a variable rate', async () => {
      const source = join(folder, 'thirty-then-twentyfive.mp4');
      // 30 frames a second for a second, then 25: packet durations of 400 and 480 ticks of 1/12000
      make([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30',
        '-frames:v',
        '60',
        '-vf',
        String.raw`settb=1/12000,setpts='if(lt(N\,30)\,N/30\,1+(N-30)/25)/TB'`,
        '-fps_mode',
        'passthrough',
        '-enc_time_base',
        '1/12000',
        '-video_track_timescale',
        '12000',
        '-c:v',
        'libx264',
        '-bf',
        '0',
        '-pix_fmt',
        'yuv420p',
        source,
      ]);
      expect(await sut.countPackets(source, 0)).toMatchObject({ packets: 60, hidden: 0, uneven: true });
    });

    it('re-encodes a turned frame with odd sides by cropping to even ones', async () => {
      const odd = join(folder, 'odd.mp4');
      const source = join(folder, 'odd-rotated.mp4');
      make([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=96x64:rate=30',
        '-t',
        '1',
        '-vf',
        'crop=95:63',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv444p',
        odd,
      ]);
      make(['-display_rotation', '90', '-i', odd, '-c', 'copy', source]);
      const encoded = join(folder, 'odd-upload.mp4');
      await upload(source, encoded, false, '30/1');
      const uploaded = await measured(encoded);
      expect(isPlainVideoStream(uploaded.stream, uploaded.packets)).toBe(true);
      expect(cloudVideoClip('v1', uploaded.stream)).toMatchObject({ width: 62, height: 94 });
    });

    it('never copies B-frames whose times are only their decode order (an AVI remuxed by copy)', async () => {
      const avi = join(folder, 'b-frames.avi');
      const source = join(folder, 'b-frames-remuxed.mp4');
      make([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30',
        '-t',
        '4',
        '-c:v',
        'libx264',
        '-bf',
        '2',
        '-g',
        '30',
        '-pix_fmt',
        'yuv420p',
        avi,
      ]);
      make(['-i', avi, '-c', 'copy', source]);
      const { stream, packets } = await measured(source);
      expect(packets).toMatchObject({ hidden: 0, uneven: false, unordered: true });
      expect(isPlainVideoStream(stream, packets)).toBe(false);

      const encoded = join(folder, 'b-frames-upload.mp4');
      await upload(source, encoded, false, '30/1');
      const uploaded = await measured(encoded);
      expect(uploaded.packets).toMatchObject({ unordered: false });
      expect(isPlainVideoStream(uploaded.stream, uploaded.packets)).toBe(true);
    });

    it('never copies a stream with keyframes far apart: the upload has one every 2 seconds', async () => {
      const source = join(folder, 'long-gop.mp4');
      make([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30',
        '-t',
        '12',
        '-c:v',
        'libx264',
        '-g',
        '1000',
        '-sc_threshold',
        '0',
        '-pix_fmt',
        'yuv420p',
        source,
      ]);
      const { stream, packets } = await measured(source);
      expect(packets.keyGap).toBeGreaterThan(10);
      expect(isPlainVideoStream(stream, packets)).toBe(false);

      const encoded = join(folder, 'long-gop-upload.mp4');
      await upload(source, encoded, false, '30/1');
      const uploaded = await measured(encoded);
      expect(uploaded.packets.keyGap).toBeCloseTo(2, 3);
      expect(isPlainVideoStream(uploaded.stream, uploaded.packets)).toBe(true);
    });

    it('never copies a frame with odd sides, turned or not', async () => {
      const source = join(folder, 'odd-plain.mp4');
      make([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=96x64:rate=30',
        '-t',
        '1',
        '-vf',
        'crop=95:63',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv444p',
        source,
      ]);
      const { stream, packets } = await measured(source);
      expect(isPlainVideoStream(stream, packets)).toBe(false);
      const encoded = join(folder, 'odd-plain-upload.mp4');
      await upload(source, encoded, false, '30/1');
      const uploaded = await measured(encoded);
      expect(isPlainVideoStream(uploaded.stream, uploaded.packets)).toBe(true);
      expect(cloudVideoClip('v1', uploaded.stream)).toMatchObject({ width: 94, height: 62 });
    });

    it('never copies a trimmed source: the upload holds only the frames the video shows', async () => {
      const source = join(folder, 'trimmed.mp4');
      const { stream, packets } = await measured(source);
      // more packets than frames: no length could be declared that the worker both counts and decodes
      expect(packets.hidden).toBeGreaterThan(0);
      expect(decodedFrames(source)).toBe(packets.packets - packets.hidden);
      expect(stream.frameCount).toBe(packets.packets);
      expect(isPlainVideoStream(stream, packets)).toBe(false);

      const encoded = join(folder, 'trimmed-upload.mp4');
      await upload(source, encoded, false);
      const uploaded = await measured(encoded);
      expect(isPlainVideoStream(uploaded.stream, uploaded.packets)).toBe(true);
      expect(uploaded.packets.packets).toBe(packets.packets - packets.hidden);
      expect(decodedFrames(encoded)).toBe(uploaded.packets.packets);
      const clip = cloudVideoClip('v1', uploaded.stream)!;
      expect(Math.floor(clip.durationSec * clip.fps + 0.5)).toBe(uploaded.packets.packets);
    });
  });
});

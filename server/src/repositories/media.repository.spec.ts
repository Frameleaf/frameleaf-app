import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AssetEditAction, MirrorAxis } from 'src/dtos/editing.dto.js';
import { Colorspace, ImageFormat } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { chunkClipOutputOptions, previewClipOutputOptions, uploadClipOutputOptions } from 'src/utils/media-privacy.js';
import { automock } from 'test/utils.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
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

  beforeEach(() => {
    // eslint-disable-next-line no-sparse-arrays
    sut = new MediaRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
  });

  describe('applyEdits (single actions)', () => {
    it('should apply crop edit correctly', async () => {
      const result = sut['applyEdits'](
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
      const result = sut['applyEdits'](
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
      const resultHorizontal = sut['applyEdits'](sharp(await buildTestQuadImage()), [
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

      const resultVertical = sut['applyEdits'](sharp(await buildTestQuadImage()), [
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
      const result = sut['applyEdits'](sharp(imageBuffer), [
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
      const result = sut['applyEdits'](sharp(imageBuffer), [
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
      const result = sut['applyEdits'](sharp(imageBuffer), [
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
      const result = sut['applyEdits'](sharp(imageBuffer), [
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
      const result = sut['applyEdits'](sharp(imageBuffer), [
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
      const result = sut['applyEdits'](sharp(imageBuffer), [
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
      const result = sut['applyEdits'](sharp(imageBuffer), [
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
      const result = sut['applyEdits'](sharp(imageBuffer), [
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
      const result = sut['applyEdits'](sharp(imageBuffer), [
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

    it('cuts a chunk of the whole video with no audio and no metadata', async () => {
      const chunk = join(dirPath, 'chunk-0-in.mp4');
      await transcode(fixture, chunk, ['-ss', '1.000', '-t', '2.000'], chunkClipOutputOptions());
      expectNoMetadata(chunk, ['video']);
    });
  });
});

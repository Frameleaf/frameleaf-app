import sharp, { type Sharp } from 'sharp';
import { compose, flipX, flipY, identity, rotate } from 'transformation-matrix';
// Standalone Node child has no application alias loader.
// eslint-disable-next-line no-restricted-imports
import { type LinearHdrImage, imageHdrInput, imageHdrOperation } from './image-hdr.js';
// eslint-disable-next-line no-restricted-imports
import { SharpDecodeError, SharpResourceLimitError, sharpPayloadBytes } from './sharp-protocol.js';

import type { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import type { ImageFormat } from 'src/enum.js';
import type {
  DecodeToBufferOptions,
  GenerateThumbhashOptions,
  GenerateThumbnailOptions,
  ImageDimensions,
  RawImageInfo,
} from 'src/types.js';
import type { DevelopDetailPlan, DevelopGeometryPlan } from 'src/utils/develop-recipe.js';

export type ThumbnailOutput = {
  path: string;
  options: Pick<GenerateThumbnailOptions, 'format' | 'quality' | 'progressive' | 'size'>;
};

// Kept local so the subprocess loads no application services, database or decorators.
const ORIENTATION_TO_SHARP_ROTATION: Record<number, { angle: number; flip?: boolean; flop?: boolean }> = {
  1: { angle: 0 },
  2: { angle: 0, flop: true },
  3: { angle: 180 },
  4: { angle: 180, flop: true },
  5: { angle: 270, flip: true },
  6: { angle: 90 },
  7: { angle: 90, flip: true },
  8: { angle: 270 },
};

/** Pure native image operations. Production callers execute these only in sharp-worker. */
export class SharpOperations {
  constructor(
    private readonly maxPixels = 200_000_000,
    private readonly progress: () => void = () => {},
    private readonly maxBytes = 1024 ** 3,
  ) {}

  async inspectImageEncoding(input: string | Buffer) {
    const bytes = await imageHdrInput(input, this.maxBytes);
    return imageHdrOperation((codec) => codec.inspect(bytes, this.maxPixels, this.maxBytes));
  }

  async decodeHdrImage(input: string | Buffer) {
    const bytes = await imageHdrInput(input, this.maxBytes);
    return imageHdrOperation((codec) => codec.decode(bytes, this.maxPixels, this.maxBytes));
  }

  encodeHdrImage(image: LinearHdrImage) {
    return imageHdrOperation((codec) =>
      codec.encode(image.data, image.width, image.height, image.gamut, this.maxPixels, this.maxBytes),
    );
  }

  async decodeImage(input: string | Buffer, options: DecodeToBufferOptions) {
    return this.getImageDecodingPipeline(input, options).raw().toBuffer({ resolveWithObject: true });
  }

  async generateImageThumbnails(
    input: string | Buffer,
    decode: DecodeToBufferOptions,
    {
      outputs,
      edits,
      checkTransparency,
    }: { outputs: ThumbnailOutput[]; edits: AssetEditActionItem[]; checkTransparency: boolean },
  ) {
    const decoded = await this.decodeImage(input, decode).catch((error: unknown) => {
      throw new SharpDecodeError(error instanceof Error ? error.message : String(error));
    });
    // Retain the previous decoded-buffer ceiling even though pixels no longer cross IPC.
    if (sharpPayloadBytes(decoded) > this.maxBytes) {
      throw new SharpResourceLimitError('decoded buffer is too large');
    }
    this.progress();
    const { data, info } = decoded;
    const isTransparent = checkTransparency ? (await this.getImageMetadata(input)).isTransparent : false;
    const base = { colorspace: decode.colorspace, processInvalidImages: false, raw: info, edits };
    const thumbhash = await this.generateThumbhash(data, base);
    this.progress();
    // One child owns every output. No sibling can keep writing after failure or cancellation.
    for (const { path, options } of outputs) {
      await this.generateThumbnail(data, { ...options, ...base }, path);
      this.progress();
    }
    return { info: this.toRawInfo(info), thumbhash, isTransparent };
  }

  applyEdits(pipeline: Sharp, edits: AssetEditActionItem[]): Sharp {
    const crop = edits.find((edit) => edit.action === 'crop');
    if (crop) {
      pipeline = pipeline.extract({
        left: Math.round(crop.parameters.x),
        top: Math.round(crop.parameters.y),
        width: Math.round(crop.parameters.width),
        height: Math.round(crop.parameters.height),
      });
    }

    const affineEditOperations = edits.filter((edit) => edit.action !== 'crop');
    if (affineEditOperations.length > 0) {
      const { a, b, c, d } = compose(
        identity(),
        ...affineEditOperations.map((edit) => {
          if (edit.action === 'rotate') {
            return rotate((-edit.parameters.angle * Math.PI) / 180);
          }
          if (edit.action === 'mirror') {
            return edit.parameters.axis === 'horizontal' ? flipY() : flipX();
          }
          return identity();
        }),
      );
      pipeline = pipeline.affine([
        [a, b],
        [c, d],
      ]);
    }

    return pipeline;
  }

  async generateThumbnail(input: string | Buffer, options: GenerateThumbnailOptions, output: string): Promise<void> {
    await this.getImageDecodingPipeline(input, options)
      .toFormat(options.format, {
        quality: options.quality,
        // this is default in libvips (except the threshold is 90), but we need to set it manually in sharp
        chromaSubsampling: options.quality >= 80 ? '4:4:4' : '4:2:0',
        progressive: options.progressive,
      })
      .toFile(output);
  }

  /**
   * FL-163: the copy of a photo that may leave this server for Frameleaf Cloud. The preview is decoded and
   * written again as a JPEG; sharp keeps no EXIF, XMP or IPTC unless asked to (`keepExif`,
   * `withMetadata`), so the capture location, camera, dates and every other tag stay here. Colours are
   * converted to sRGB and only the sRGB profile is embedded: the preview's own ICC profile is not kept,
   * because it could identify the device and a description model reads sRGB anyway.
   */
  async writeCloudUpload(input: string, output: string): Promise<void> {
    await sharp(input, { failOn: 'error', limitInputPixels: this.maxPixels })
      .rotate()
      .withIccProfile('srgb')
      .jpeg({ quality: 90, chromaSubsampling: '4:4:4', progressive: false })
      .toFile(output);
  }

  /**
   * FL-162: a full-resolution copy of a still for work that runs on another machine (Frameleaf Cloud,
   * a restoration worker): the pixels as they are displayed (EXIF orientation applied) with the
   * original ICC colour profile kept, and no EXIF, XMP, IPTC or GPS at all. A JPEG stays a JPEG at
   * quality 98 without chroma subsampling; anything else is written as a lossless PNG.
   */
  async writeStrippedStill(input: string, output: string, format: 'jpeg' | 'png'): Promise<void> {
    const image = sharp(input, { failOn: 'error', limitInputPixels: this.maxPixels }).rotate().keepIccProfile();
    const encoded = format === 'jpeg' ? image.jpeg({ quality: 98, chromaSubsampling: '4:4:4' }) : image.png();
    await encoded.toFile(output);
  }

  /**
   * Compose a set of input images into a single JPEG grid (left-to-right,
   * top-to-bottom). Cells are letterboxed to a fixed size on a black canvas
   * to keep aspect ratios intact. Used to feed multiple video frames through
   * the single-image describeImage() ML endpoint.
   */
  async composeImageGrid(
    inputs: string[],
    options: { cols: number; rows: number; cellSize: number; output: string },
  ): Promise<void> {
    const { cols, rows, cellSize, output } = options;
    const canvasWidth = cols * cellSize;
    const canvasHeight = rows * cellSize;

    const cells: Buffer[] = [];
    for (const path of inputs.slice(0, cols * rows)) {
      cells.push(
        await sharp(path, { limitInputPixels: this.maxPixels })
          .rotate()
          .resize(cellSize, cellSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
          .toFormat('jpeg')
          .toBuffer(),
      );
      this.progress();
    }

    const composites = cells.map((buffer, index) => ({
      input: buffer,
      left: (index % cols) * cellSize,
      top: Math.floor(index / cols) * cellSize,
    }));

    await sharp({
      create: { width: canvasWidth, height: canvasHeight, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite(composites)
      .jpeg({ quality: 85, chromaSubsampling: '4:2:0', progressive: false })
      .toFile(output);
  }

  private getImageDecodingPipeline(input: string | Buffer, options: DecodeToBufferOptions) {
    let pipeline = sharp(input, {
      // some invalid images can still be processed by sharp, but we want to fail on them by default to avoid crashes
      failOn: options.processInvalidImages ? 'none' : 'error',
      limitInputChannels: false,
      limitInputPixels: this.maxPixels,
      raw: options.raw,
      unlimited: true,
    })
      .pipelineColorspace(options.colorspace === 'srgb' ? 'srgb' : 'rgb16')
      .withIccProfile(options.colorspace);

    if (!options.raw) {
      const { angle, flip, flop } = options.orientation ? ORIENTATION_TO_SHARP_ROTATION[options.orientation] : {};
      pipeline = pipeline.rotate(angle);
      if (flip) {
        pipeline = pipeline.flip();
      }

      if (flop) {
        pipeline = pipeline.flop();
      }
    }

    if (options.edits && options.edits.length > 0) {
      pipeline = this.applyEdits(pipeline, options.edits);
    }

    if (options.size !== undefined) {
      pipeline = pipeline.resize(options.size, options.size, { fit: 'outside', withoutEnlargement: true });
    }
    return pipeline;
  }

  /**
   * Still-image develop geometry (FL-113): quarter turns and flips, then an arbitrary
   * straighten with the frame scaled back to cover its own bounds, then the recipe crop.
   * Runs as staged pipelines because sharp allows one rotation and two extracts per pipeline.
   * Input and output are 8-bit interleaved raw buffers; the original file is only ever read.
   */
  async renderDevelopGeometry(
    input: Buffer,
    raw: RawImageInfo,
    plan: DevelopGeometryPlan,
  ): Promise<{ data: Buffer; info: RawImageInfo }> {
    // The recipe turns first and mirrors the turned frame (the editor's preview, the protocol and the
    // mask mapping all do). sharp mirrors before it rotates, whatever the call order, so after a
    // quarter turn the mirror axes swap: mirroring the turned frame left to right is mirroring the
    // original top to bottom.
    const quarter = plan.rotation === 90 || plan.rotation === 270;
    let current = await sharp(input, { raw, limitInputPixels: this.maxPixels, unlimited: true })
      .rotate(plan.rotation)
      .flop(quarter ? plan.flipVertical : plan.flipHorizontal)
      .flip(quarter ? plan.flipHorizontal : plan.flipVertical)
      .raw()
      .toBuffer({ resolveWithObject: true });

    this.progress();
    const { width, height } = plan.oriented;
    if (plan.straighten !== 0) {
      const theta = (Math.abs(plan.straighten) * Math.PI) / 180;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      // The rotated bitmap grows to these bounds; the centre window of the original size divided
      // by the cover scale, resized back up, is the straightened frame the client previews.
      const scale = Math.max((width * cos + height * sin) / width, (width * sin + height * cos) / height);
      const windowWidth = Math.max(1, Math.round(width / scale));
      const windowHeight = Math.max(1, Math.round(height / scale));
      const rotated = await sharp(current.data, {
        raw: this.toRawInfo(current.info),
        limitInputPixels: this.maxPixels,
        unlimited: true,
      })
        .rotate(plan.straighten, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
        .raw()
        .toBuffer({ resolveWithObject: true });
      this.progress();
      current = await sharp(rotated.data, {
        raw: this.toRawInfo(rotated.info),
        limitInputPixels: this.maxPixels * 2,
        unlimited: true,
      })
        .extract({
          left: Math.max(0, Math.round((rotated.info.width - windowWidth) / 2)),
          top: Math.max(0, Math.round((rotated.info.height - windowHeight) / 2)),
          width: Math.min(windowWidth, rotated.info.width),
          height: Math.min(windowHeight, rotated.info.height),
        })
        .resize(width, height, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      this.progress();
    }

    const { extract } = plan;
    if (extract.left !== 0 || extract.top !== 0 || extract.width !== width || extract.height !== height) {
      current = await sharp(current.data, {
        raw: this.toRawInfo(current.info),
        limitInputPixels: this.maxPixels,
        unlimited: true,
      })
        .extract({
          left: Math.min(extract.left, Math.max(0, current.info.width - 1)),
          top: Math.min(extract.top, Math.max(0, current.info.height - 1)),
          width: Math.min(extract.width, current.info.width - extract.left),
          height: Math.min(extract.height, current.info.height - extract.top),
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
    }

    return { data: current.data, info: this.toRawInfo(current.info) };
  }

  /**
   * Detail stages after the tone pass (noise reduction, clarity, sharpening) and encoding of
   * one develop output. `size` bounds the longest edge for a preview and is omitted for the
   * edited master, which keeps the source resolution. Writes to `output` when given, otherwise
   * returns the encoded bytes.
   */
  async encodeDevelopOutput(
    input: Buffer,
    raw: RawImageInfo,
    options: {
      detail: DevelopDetailPlan;
      colorspace: string;
      format: ImageFormat;
      quality: number;
      progressive?: boolean;
      size?: number;
    },
    output?: string,
  ): Promise<Buffer | undefined> {
    let data = input;
    let info = raw;
    const open = () => sharp(data, { raw: info, limitInputPixels: this.maxPixels, unlimited: true });
    const { detail } = options;
    if (detail.median > 0 || detail.clarity) {
      let pipeline = open();
      if (detail.median > 0) {
        pipeline = pipeline.median(detail.median);
      }
      if (detail.clarity) {
        pipeline = pipeline.sharpen(detail.clarity);
      }
      const result = await pipeline.raw().toBuffer({ resolveWithObject: true });
      this.progress();
      data = result.data;
      info = this.toRawInfo(result.info);
    }
    let pipeline = open();
    if (detail.sharpen) {
      pipeline = pipeline.sharpen(detail.sharpen);
    }
    if (options.size !== undefined) {
      pipeline = pipeline.resize(options.size, options.size, { fit: 'inside', withoutEnlargement: true });
    }
    pipeline = pipeline.withIccProfile(options.colorspace).toFormat(options.format, {
      quality: options.quality,
      chromaSubsampling: options.quality >= 80 ? '4:4:4' : '4:2:0',
      progressive: options.progressive ?? false,
    });
    if (output) {
      await pipeline.toFile(output);
      return;
    }
    return pipeline.toBuffer();
  }

  private toRawInfo(info: { width: number; height: number; channels: number }): RawImageInfo {
    return { width: info.width, height: info.height, channels: info.channels as RawImageInfo['channels'] };
  }

  async generateThumbhash(input: string | Buffer, options: GenerateThumbhashOptions): Promise<Buffer> {
    const { rgbaToThumbHash } = await import('thumbhash');

    const { data, info } = await this.getImageDecodingPipeline(input, {
      colorspace: options.colorspace,
      processInvalidImages: options.processInvalidImages,
      raw: options.raw,
      edits: options.edits,
    })
      .resize(100, 100, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    return Buffer.from(rgbaToThumbHash(info.width, info.height, data));
  }

  /**
   * FL-233: a develop artifact stored the same way every time: EXIF orientation applied, metadata
   * dropped, 8-bit PNG, greyscale for a mask and RGBA for a fill. The PNG's SHA-256 is its id.
   */
  async normalizeDevelopArtifact(
    input: string,
    kind: 'mask' | 'fill',
  ): Promise<{ data: Buffer; width: number; height: number }> {
    let pipeline = sharp(input, { failOn: 'error', limitInputPixels: Math.min(200_000_000, this.maxPixels) }).rotate();
    pipeline = kind === 'mask' ? pipeline.greyscale().removeAlpha().toColourspace('b-w') : pipeline.ensureAlpha();
    const { data, info } = await pipeline
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }

  /** FL-233: a stored develop artifact as raw pixels: 1 channel for a mask, 4 for a fill. */
  async decodeDevelopArtifact(
    input: string,
    kind: 'mask' | 'fill',
  ): Promise<{ data: Buffer; width: number; height: number; channels: 1 | 4 }> {
    let pipeline = sharp(input, { failOn: 'error', limitInputPixels: Math.min(200_000_000, this.maxPixels) });
    pipeline = kind === 'mask' ? pipeline.extractChannel(0) : pipeline.ensureAlpha();
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: kind === 'mask' ? 1 : 4 };
  }

  async getImageMetadata(input: string | Buffer): Promise<ImageDimensions & { isTransparent: boolean }> {
    const {
      width = 0,
      height = 0,
      hasAlpha = false,
    } = await sharp(input, { unlimited: true, limitInputPixels: this.maxPixels }).metadata();
    return { width, height, isTransparent: hasAlpha };
  }

  /** Width and height as the image is displayed, after its EXIF orientation (FL-64 imported versions). */
  async getOrientedSize(input: string): Promise<ImageDimensions> {
    const {
      width = 0,
      height = 0,
      orientation,
    } = await sharp(input, { unlimited: true, limitInputPixels: this.maxPixels }).metadata();
    return orientation && orientation >= 5 ? { width: height, height: width } : { width, height };
  }

  async scoreThumbnailCandidate(input: string): Promise<number> {
    const stats = await sharp(input, { limitInputPixels: this.maxPixels }).stats();
    const channels = stats.channels.slice(0, 3);
    const mean = channels.reduce((sum, channel) => sum + channel.mean, 0) / channels.length;
    const contrast = channels.reduce((sum, channel) => sum + channel.stdev, 0) / channels.length;
    const { entropy = 0, sharpness = 0 } = stats as typeof stats & { entropy?: number; sharpness?: number };

    const exposureScore = 40 - Math.abs(mean - 128) / 4;
    const blackFramePenalty = mean < 18 ? (18 - mean) * 12 : 0;
    const blownFramePenalty = mean > 245 ? (mean - 245) * 6 : 0;
    const flatFramePenalty = contrast < 4 ? (4 - contrast) * 12 : 0;
    const logoLikePenalty = entropy < 1.2 && contrast < 12 ? 35 : 0;

    return (
      exposureScore +
      contrast * 1.5 +
      entropy * 14 +
      sharpness * 0.1 -
      blackFramePenalty -
      blownFramePenalty -
      flatFramePenalty -
      logoLikePenalty
    );
  }
}

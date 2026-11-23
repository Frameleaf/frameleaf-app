import type { AssetFile } from 'src/database.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { MediaRepository } from 'src/repositories/media.repository.js';
import { getAssetFiles } from 'src/utils/asset.util.js';

/** FL-955: the words an owner reads when Suggested colours is refused. */
export const ALREADY_IN_COLOUR = 'This photo is already in colour';
export const HAND_TINTED = 'Looks coloured by hand. A guess would replace those colours.';
export const COLOUR_UNKNOWN = 'Frameleaf could not check whether this photo is black and white';

/** The refusal as a stable word for clients and batch skip reasons. */
export const colourRefusalReason = (refusal: string) => {
  if (refusal === ALREADY_IN_COLOUR) {
    return 'already-in-colour';
  }
  return refusal === HAND_TINTED ? 'hand-tinted' : 'colour-unknown';
};

/** Large enough that both crops of the rule are still reduced to its working size, not enlarged. */
const COLOUR_CHECK_EDGE = 1024;

// A port of `machine-learning/video-restoration/runtimes/colourise.py`. Keep the two the same: both
// test suites read `machine-learning/video-restoration/qualification/tint-vectors.json`.
const TINT_WORK_EDGE = 384;
const TINT_LEVELS = 24;
const TINT_DISTANCE = 6;
const TINT_OUTER_INSET = 0.15;
const TINT_OUTER_SHARE = 0.05;
const TINT_INNER_INSET = 0.25;
const TINT_INNER_SHARE = 0.001;
const TINT_COLOUR_SHARE = 0.25;
const BLUR_RADIUS = 3;

export type PhotoColour = 'monochrome' | 'hand-tinted' | 'in-colour';
export type RgbImage = { data: Uint8Array; width: number; height: number; channels: number };

const LINEAR = Float64Array.from({ length: 256 }, (_, value) => {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
});

const BLUR_KERNEL = (() => {
  const raw = Array.from({ length: BLUR_RADIUS * 2 + 1 }, (_, index) => Math.exp(-((index - BLUR_RADIUS) ** 2) / 2));
  const sum = raw.reduce((total, value) => total + value, 0);
  return raw.map((value) => value / sum);
})();

/** Python's `round`: halves go to the even neighbour. */
const roundHalfEven = (value: number) => {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest === 0.5) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(value);
};

/** For one axis, each output sample as source indices and weights (OpenCV's INTER_AREA). */
const areaWeights = (source: number, target: number, shrinking: boolean) => {
  const scale = source / target;
  const samples: { index: number[]; weight: number[] }[] = [];
  for (let out = 0; out < target; out++) {
    const index: number[] = [];
    const weight: number[] = [];
    if (shrinking) {
      const start = out * scale;
      const end = (out + 1) * scale;
      for (let at = Math.floor(start); at < Math.min(source, Math.ceil(end)); at++) {
        const cover = Math.min(end, at + 1) - Math.max(start, at);
        if (cover > 1e-9) {
          index.push(at);
          weight.push(cover / scale);
        }
      }
    } else {
      const at = Math.floor(out * scale);
      const raw = out + 1 - (at + 1) / scale;
      const part = raw <= 0 ? 0 : raw - Math.floor(raw);
      index.push(Math.min(at, source - 1), Math.min(at + 1, source - 1));
      weight.push(1 - part, part);
    }
    samples.push({ index, weight });
  }
  return samples;
};

const resizeArea = (rgb: Float32Array, width: number, height: number, outWidth: number, outHeight: number) => {
  const shrinking = width >= outWidth && height >= outHeight;
  const across = areaWeights(width, outWidth, shrinking);
  const down = areaWeights(height, outHeight, shrinking);
  const wide = new Float32Array(outWidth * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < outWidth; x++) {
      const { index, weight } = across[x];
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let position = 0; position < index.length; position++) {
          sum += rgb[(y * width + index[position]) * 3 + channel] * weight[position];
        }
        wide[(y * outWidth + x) * 3 + channel] = sum;
      }
    }
  }
  const out = new Float32Array(outWidth * outHeight * 3);
  for (let y = 0; y < outHeight; y++) {
    const { index, weight } = down[y];
    for (let cell = 0; cell < outWidth * 3; cell++) {
      let sum = 0;
      for (let position = 0; position < index.length; position++) {
        sum += wide[index[position] * outWidth * 3 + cell] * weight[position];
      }
      out[y * outWidth * 3 + cell] = Math.round(sum);
    }
  }
  return out;
};

/** OpenCV's default border: the edge pixel is not repeated. */
const reflect = (at: number, size: number) => {
  if (size === 1) {
    return 0;
  }
  const period = 2 * size - 2;
  const wrapped = ((at % period) + period) % period;
  return wrapped < size ? wrapped : period - wrapped;
};

const blur = (rgb: Float32Array, width: number, height: number) => {
  const taps = BLUR_RADIUS * 2 + 1;
  const across = Int32Array.from({ length: width * taps }, (_, at) =>
    reflect(Math.trunc(at / taps) + (at % taps) - BLUR_RADIUS, width),
  );
  const down = Int32Array.from({ length: height * taps }, (_, at) =>
    reflect(Math.trunc(at / taps) + (at % taps) - BLUR_RADIUS, height),
  );
  const wide = new Float32Array(rgb.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let tap = 0; tap < taps; tap++) {
          sum += rgb[(y * width + across[x * taps + tap]) * 3 + channel] * BLUR_KERNEL[tap];
        }
        wide[(y * width + x) * 3 + channel] = sum;
      }
    }
  }
  const out = new Uint8Array(rgb.length);
  for (let y = 0; y < height; y++) {
    for (let cell = 0; cell < width * 3; cell++) {
      let sum = 0;
      for (let tap = 0; tap < taps; tap++) {
        sum += wide[down[y * taps + tap] * width * 3 + cell] * BLUR_KERNEL[tap];
      }
      out[y * width * 3 + cell] = Math.max(0, Math.min(255, Math.round(sum)));
    }
  }
  return out;
};

const labPart = (value: number) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);

const median = (values: Float32Array) => {
  values.sort();
  const middle = values.length >> 1;
  return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};

/**
 * Of the picture inside `inset`, the share of pixels whose colour differs from the usual colour of
 * pixels equally bright. A toned print has one colour per brightness, however strong; paint adds a second.
 */
export const offToneShare = ({ data, width, height, channels }: RgbImage, inset: number): number => {
  const top = Math.trunc(height * inset);
  const left = Math.trunc(width * inset);
  const cropWidth = width - 2 * left;
  const cropHeight = height - 2 * top;
  const crop = new Float32Array(cropWidth * cropHeight * 3);
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const from = ((y + top) * width + x + left) * channels;
      const to = (y * cropWidth + x) * 3;
      crop[to] = data[from];
      crop[to + 1] = data[from + 1];
      crop[to + 2] = data[from + 2];
    }
  }
  const scale = TINT_WORK_EDGE / Math.max(cropWidth, cropHeight);
  const outWidth = Math.max(1, roundHalfEven(cropWidth * scale));
  const outHeight = Math.max(1, roundHalfEven(cropHeight * scale));
  const small = blur(resizeArea(crop, cropWidth, cropHeight, outWidth, outHeight), outWidth, outHeight);

  const count = outWidth * outHeight;
  const levels = new Uint8Array(count);
  const labA = new Float32Array(count);
  const labB = new Float32Array(count);
  const inLevel = new Uint32Array(TINT_LEVELS);
  for (let pixel = 0; pixel < count; pixel++) {
    const red = LINEAR[small[pixel * 3]];
    const green = LINEAR[small[pixel * 3 + 1]];
    const blue = LINEAR[small[pixel * 3 + 2]];
    const fx = labPart((0.412453 * red + 0.35758 * green + 0.180423 * blue) / 0.950456);
    const luminance = 0.212671 * red + 0.71516 * green + 0.072169 * blue;
    const fy = labPart(luminance);
    const fz = labPart((0.019334 * red + 0.119193 * green + 0.950227 * blue) / 1.088754);
    const lightness = luminance > 0.008856 ? 116 * Math.cbrt(luminance) - 16 : 903.3 * luminance;
    const level = Math.max(0, Math.min(TINT_LEVELS - 1, Math.trunc((lightness / 100) * TINT_LEVELS)));
    levels[pixel] = level;
    labA[pixel] = 500 * (fx - fy);
    labB[pixel] = 200 * (fy - fz);
    inLevel[level]++;
  }

  const usualA = new Float32Array(TINT_LEVELS);
  const usualB = new Float32Array(TINT_LEVELS);
  const valuesA = Array.from(inLevel, (size) => new Float32Array(size));
  const valuesB = Array.from(inLevel, (size) => new Float32Array(size));
  const filled = new Uint32Array(TINT_LEVELS);
  for (let pixel = 0; pixel < count; pixel++) {
    const level = levels[pixel];
    valuesA[level][filled[level]] = labA[pixel];
    valuesB[level][filled[level]++] = labB[pixel];
  }
  for (let level = 0; level < TINT_LEVELS; level++) {
    if (inLevel[level] > 0) {
      usualA[level] = median(valuesA[level]);
      usualB[level] = median(valuesB[level]);
    }
  }

  let off = 0;
  for (let pixel = 0; pixel < count; pixel++) {
    const level = levels[pixel];
    if (Math.hypot(labA[pixel] - usualA[level], labB[pixel] - usualB[level]) > TINT_DISTANCE) {
      off++;
    }
  }
  return off / count;
};

/**
 * FL-955: the one rule for Suggested colours. Black and white or toned, hand-tinted, or a colour photo.
 * The tighter second crop keeps a coloured mount or a gilt case from counting. Fewer than three
 * channels has no colour to look at.
 */
export const classifyPhotoColour = (image: RgbImage): PhotoColour => {
  if (image.channels < 3) {
    return 'monochrome';
  }
  if (image.width < 1 || image.height < 1 || image.data.length < image.width * image.height * image.channels) {
    throw new Error('The decoded picture is shorter than its size says');
  }
  const outer = offToneShare(image, TINT_OUTER_INSET);
  if (outer <= TINT_OUTER_SHARE || offToneShare(image, TINT_INNER_INSET) <= TINT_INNER_SHARE) {
    return 'monochrome';
  }
  return outer > TINT_COLOUR_SHARE ? 'in-colour' : 'hand-tinted';
};

/**
 * FL-955: why this photo cannot get suggested colours, or null when it can. Read from its preview, the
 * smallest file that still holds enough detail for the rule. A photo that cannot be read is refused too,
 * rather than guessed at. `allowHandTinted` is the owner's override; it never reaches a colour photo.
 */
export const photoColourRefusal = async (
  mediaRepository: Pick<MediaRepository, 'decodeImage'>,
  logger: Pick<LoggingRepository, 'warn'>,
  assetId: string,
  files: AssetFile[],
  allowHandTinted = false,
): Promise<string | null> => {
  try {
    const { thumbnailFile, previewFile } = getAssetFiles(files);
    const file = previewFile ?? thumbnailFile;
    if (!file) {
      return COLOUR_UNKNOWN;
    }
    const { data, info } = await mediaRepository.decodeImage(file.path, {
      colorspace: 'srgb',
      processInvalidImages: false,
      size: COLOUR_CHECK_EDGE,
      fit: 'inside',
    });
    const colour = classifyPhotoColour({ data, width: info.width, height: info.height, channels: info.channels });
    if (colour === 'in-colour') {
      return ALREADY_IN_COLOUR;
    }
    return colour === 'hand-tinted' && !allowHandTinted ? HAND_TINTED : null;
  } catch (error) {
    logger.warn(`Could not check the colour of ${assetId}: ${error}`);
    return COLOUR_UNKNOWN;
  }
};

import type { AssetFile } from 'src/database.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { MediaRepository } from 'src/repositories/media.repository.js';
import { getAssetFiles } from 'src/utils/asset.util.js';

/** FL-955: the words an owner reads when Colourise is refused. */
export const ALREADY_IN_COLOUR = 'This photo is already in colour';
export const COLOUR_UNKNOWN = 'Frameleaf could not check whether this photo is black and white';

/** Thumbnails are enough to tell a black-and-white photo from a colour one. */
const COLOUR_CHECK_EDGE = 64;

/** A pixel whose channels differ by no more than this reads as grey, JPEG noise included. */
const NEUTRAL_CHROMA = 12;
/** Up to this share of tinted pixels (a date stamp, a coloured border) still leaves a grey photo. */
const MAX_TINTED_SHARE = 0.02;
/** How tightly the tinted pixels must agree on one hue to be a single toned print: 1 is exactly one hue. */
const MIN_TONE_AGREEMENT = 0.9;
/** A toned print is muted. A saturated picture of one hue (a sunset, a red wall) is a colour photo. */
const MAX_TONED_CHROMA = 70;

const hueRadians = (red: number, green: number, blue: number, max: number, chroma: number) => {
  let sector: number;
  if (max === red) {
    sector = ((green - blue) / chroma + 6) % 6;
  } else if (max === green) {
    sector = (blue - red) / chroma + 2;
  } else {
    sector = (red - green) / chroma + 4;
  }
  return (sector / 6) * 2 * Math.PI;
};

/**
 * FL-955: whether raw 8-bit pixels of a small thumbnail are a black-and-white photo, the only kind
 * Colourise takes. A print toned one colour (sepia, selenium, cyanotype) counts: nearly every pixel is
 * either grey or the same muted hue. Fewer than three channels has no colour to look at.
 */
export const isMonochromeImage = (data: Uint8Array, channels: number): boolean => {
  if (channels < 3) {
    return true;
  }
  const pixels = Math.floor(data.length / channels);
  if (pixels === 0) {
    return false;
  }
  let tinted = 0;
  let chromaSum = 0;
  let hueX = 0;
  let hueY = 0;
  for (let index = 0; index < pixels * channels; index += channels) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const max = Math.max(red, green, blue);
    const chroma = max - Math.min(red, green, blue);
    if (chroma <= NEUTRAL_CHROMA) {
      continue;
    }
    const hue = hueRadians(red, green, blue, max, chroma);
    tinted++;
    chromaSum += chroma;
    hueX += Math.cos(hue);
    hueY += Math.sin(hue);
  }
  if (tinted / pixels <= MAX_TINTED_SHARE) {
    return true;
  }
  const agreement = Math.hypot(hueX, hueY) / tinted;
  return agreement >= MIN_TONE_AGREEMENT && chromaSum / tinted <= MAX_TONED_CHROMA;
};

/**
 * FL-955: why this photo cannot be colourised, or null for a black-and-white one (sepia counts). Read
 * from its small thumbnail. A photo that cannot be read is refused too, rather than guessed at.
 */
export const photoColourRefusal = async (
  mediaRepository: Pick<MediaRepository, 'decodeImage'>,
  logger: Pick<LoggingRepository, 'warn'>,
  assetId: string,
  files: AssetFile[],
): Promise<string | null> => {
  try {
    const { thumbnailFile, previewFile } = getAssetFiles(files);
    const file = thumbnailFile ?? previewFile;
    if (!file) {
      return COLOUR_UNKNOWN;
    }
    const { data, info } = await mediaRepository.decodeImage(file.path, {
      colorspace: 'srgb',
      processInvalidImages: false,
      size: COLOUR_CHECK_EDGE,
      fit: 'inside',
    });
    return isMonochromeImage(data, info.channels) ? null : ALREADY_IN_COLOUR;
  } catch (error) {
    logger.warn(`Could not check the colour of ${assetId}: ${error}`);
    return COLOUR_UNKNOWN;
  }
};

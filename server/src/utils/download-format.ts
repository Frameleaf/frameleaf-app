import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { Readable } from 'node:stream';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { MediaRepository } from 'src/repositories/media.repository.js';
import { AssetType, type DownloadFormat } from 'src/enum.js';
import { isLockedPath, makeWorkDir, withPlainCopy } from 'src/utils/locked-read.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/** FL-826: the long edge of a web-size download. */
export const WEB_SIZE_LONG_EDGE = 2048;

/**
 * What a download JPEG (quality 92, 4:4:4) is estimated to take per pixel before it is rendered: photos
 * land between about 0.3 and 0.8 bytes, so sizes shown before a download are a guide, not a promise.
 */
export const JPEG_BYTES_PER_PIXEL = 0.6;

/**
 * The format a request gets. A shared link limited to web size gets web whatever it asks for; otherwise
 * the request's own choice, then (signed-in accounts only) the account's `download.defaultFormat`.
 */
export const downloadFormatFor = (
  auth: Pick<AuthDto, 'sharedLink'>,
  requested: DownloadFormat | undefined,
  preferred?: DownloadFormat,
): DownloadFormat => {
  if (auth.sharedLink?.webSizeOnly) {
    return 'web';
  }
  return requested ?? (auth.sharedLink ? 'original' : (preferred ?? 'original'));
};

const isJpeg = (path: string) => /\.jpe?g$/i.test(path);

type ConversionAsset = { type: AssetType | string; width: number | null; height: number | null };

/**
 * How an item's file changes for the format, or null when it goes as it is: videos and anything that is
 * not a photo always do, so does a JPEG asked for as jpeg, and a JPEG that already fits the web size.
 * `maxEdge` null is a full-size JPEG.
 */
export const downloadConversionFor = (
  asset: ConversionAsset,
  shownPath: string,
  format: DownloadFormat,
): { maxEdge: number | null } | null => {
  if (format === 'original' || asset.type !== AssetType.Image) {
    return null;
  }
  if (format === 'jpeg') {
    return isJpeg(shownPath) ? null : { maxEdge: null };
  }
  const longEdge = Math.max(asset.width ?? 0, asset.height ?? 0);
  return isJpeg(shownPath) && longEdge > 0 && longEdge <= WEB_SIZE_LONG_EDGE ? null : { maxEdge: WEB_SIZE_LONG_EDGE };
};

/** A converted file keeps its name with the .jpg extension (archives then keep names unique). */
export const convertedFileName = (fileName: string) => `${parse(fileName).name}.jpg`;

/**
 * FL-826: what an item takes in a download of this format. An item that goes as it is counts its
 * original size (`size`, additional originals included). A converted photo counts the full-size file
 * already made for it when one exists (jpeg), else an estimate from its pixels (`JPEG_BYTES_PER_PIXEL`),
 * scaled to the web size for web; without known dimensions, its original file size (jpeg) or that capped
 * at a web-size photo's estimate (web).
 */
export const estimateDownloadSize = (
  item: ConversionAsset & {
    originalFileName: string;
    size: number | null;
    fileSizeInByte?: number | null;
    fullsizeSize?: number | string | null;
  },
  format: DownloadFormat,
): number => {
  const conversion = downloadConversionFor(item, item.originalFileName, format);
  if (!conversion) {
    return Number(item.size || 0);
  }
  const original = Number(item.fileSizeInByte ?? item.size ?? 0);
  const width = item.width ?? 0;
  const height = item.height ?? 0;
  if (conversion.maxEdge === null) {
    if (item.fullsizeSize) {
      return Number(item.fullsizeSize);
    }
    return width && height ? Math.round(width * height * JPEG_BYTES_PER_PIXEL) : original;
  }
  if (!width || !height) {
    const webPixels = WEB_SIZE_LONG_EDGE * ((WEB_SIZE_LONG_EDGE * 3) / 4);
    return Math.min(original, Math.round(webPixels * JPEG_BYTES_PER_PIXEL));
  }
  const scale = Math.min(1, WEB_SIZE_LONG_EDGE / Math.max(width, height));
  return Math.round(width * height * scale * scale * JPEG_BYTES_PER_PIXEL);
};

export type ConversionSources = {
  originalPath: string;
  originalFileName: string;
  /** The edited file shown instead of the original (develop master or edited full-size), when there is one. */
  shownEditedPath?: string | null;
  fullsizePath?: string | null;
  previewPath?: string | null;
  editedPreviewPath?: string | null;
};

/**
 * The files a converted download is rendered from, best first. An edited photo is only ever rendered
 * from its edited pixels. Otherwise the original, except a RAW original, which the image library cannot
 * read: its full-size copy, then its preview. When no full-size copy was made (full-size generation off),
 * a RAW's JPEG is the preview's size: a documented shortfall, not an error.
 */
export const conversionSourcesOf = ({
  originalPath,
  originalFileName,
  shownEditedPath,
  fullsizePath,
  previewPath,
  editedPreviewPath,
}: ConversionSources): string[] => {
  const sources = shownEditedPath
    ? [shownEditedPath, editedPreviewPath]
    : mimeTypes.isRaw(originalFileName)
      ? [fullsizePath, previewPath]
      : [originalPath, fullsizePath, previewPath];
  return [...new Set(sources.filter((source): source is string => !!source))];
};

/**
 * Renders a download JPEG from the first source that renders, then copies the original's metadata into it
 * (without any location when `removeLocation`). The file lives in its own work folder, inside the locked
 * tmpfs when any input is a sealed Locked file; `release` removes it.
 */
export const renderDownloadFile = async (
  media: Pick<MediaRepository, 'renderDownloadJpeg' | 'copyDownloadMetadata'>,
  {
    sources,
    metadataSource,
    maxEdge,
    removeLocation,
    viewerId,
    signal,
  }: {
    sources: string[];
    metadataSource: string;
    maxEdge: number | null;
    removeLocation: boolean;
    viewerId: string | undefined;
    signal?: AbortSignal;
  },
): Promise<{ path: string; release: () => Promise<void> }> => {
  const sealed = (await Promise.all([...sources, metadataSource].map((path) => isLockedPath(path)))).some(Boolean);
  const folder = await makeWorkDir('download', sealed);
  const output = join(folder, 'download.jpg');
  const release = () => rm(folder, { recursive: true, force: true });
  try {
    let failure: unknown = new Error('No file to render the download from');
    let rendered = false;
    for (const source of sources) {
      try {
        await withPlainCopy(source, (plain) => media.renderDownloadJpeg(plain, output, maxEdge, signal), { viewerId });
        rendered = true;
        break;
      } catch (error) {
        signal?.throwIfAborted();
        failure = error;
      }
    }
    if (!rendered) {
      throw failure;
    }
    await withPlainCopy(metadataSource, (plain) => media.copyDownloadMetadata(plain, output, { removeLocation }), {
      viewerId,
    });
    return { path: output, release };
  } catch (error) {
    await release();
    throw error;
  }
};

/**
 * A stream of a converted download that renders only when it is first read, so an archive renders its
 * photos one at a time as it reaches them, and removes each rendered file once it has been sent (or the
 * archive is abandoned).
 */
export const renderedDownloadStream = (render: () => Promise<{ path: string; release: () => Promise<void> }>) =>
  Readable.from(
    (async function* () {
      const file = await render();
      try {
        for await (const chunk of createReadStream(file.path)) {
          yield chunk as Buffer;
        }
      } finally {
        await file.release();
      }
    })(),
    { objectMode: false },
  );

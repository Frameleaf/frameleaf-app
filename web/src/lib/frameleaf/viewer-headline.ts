/**
 * The short technical line the Frameleaf viewer shows under the file name (FL-35).
 *
 * Ported from `design/frameleaf/template/src/media-viewer.mjs` (`viewerHeadline` and the
 * formatters it uses), adapted to the production `AssetResponseDto`/`ExifResponseDto`.
 * Pure: it reads the metadata the detail panel already receives and renders no markup.
 */
import { AssetTypeEnum, type AssetResponseDto, type ExifResponseDto } from '@immich/sdk';

export const formatFileSize = (bytes: number | null | undefined): string | null => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(2)} GB`;
  }
  if (bytes >= 1e6) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
  }
  if (bytes >= 1e3) {
    return `${Math.round(bytes / 1e3)} KB`;
  }
  return `${Math.round(bytes)} B`;
};

export const megapixels = (width: number | null | undefined, height: number | null | undefined): string | null => {
  if ([width, height].some((value) => !(typeof value === 'number' && Number.isFinite(value) && value > 0))) {
    return null;
  }
  const value = (width! * height!) / 1e6;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} MP`;
};

/** `duration` on the asset DTO is milliseconds; the prototype formats whole seconds. */
export const formatDuration = (milliseconds: number | null | undefined): string | null => {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  const whole = Math.floor(milliseconds / 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
};

const assetDimensions = (asset: AssetResponseDto): { width: number | null; height: number | null } => ({
  width: asset.exifInfo?.exifImageWidth ?? asset.width ?? null,
  height: asset.exifInfo?.exifImageHeight ?? asset.height ?? null,
});

export const dimensionsLabel = (asset: AssetResponseDto): string | null => {
  const { width, height } = assetDimensions(asset);
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
    ? `${width.toLocaleString()} × ${height.toLocaleString()}`
    : null;
};

export const cameraLabel = (exif: ExifResponseDto | undefined): string | null =>
  [exif?.make, exif?.model].filter(Boolean).join(' ') || null;

const exposureSeconds = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const text = value.trim();
  return text.endsWith('s') ? text : `${text} s`;
};

export const exposureParts = (exif: ExifResponseDto | undefined): string[] => {
  if (!exif) {
    return [];
  }
  return [
    exif.fNumber ? `ƒ/${exif.fNumber}` : null,
    exposureSeconds(exif.exposureTime),
    exif.iso ? `ISO ${exif.iso}` : null,
    exif.focalLength ? `${exif.focalLength} mm` : null,
  ].filter((part): part is string => !!part);
};

/** `29.97 fps`, or null when the frame rate is unknown. */
export const frameRateLabel = (fps: number | null | undefined): string | null =>
  typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? `${Number(fps.toFixed(2))} fps` : null;

/**
 * The headline parts, in the template's order (`viewerHeadline`, media-viewer.mjs:265-277): camera,
 * lens, exposure (stills only), dimensions, frame rate and duration (video only), file size (V-26).
 */
export function viewerHeadline(asset: AssetResponseDto): string[] {
  const exif = asset.exifInfo;
  const isVideo = asset.type === AssetTypeEnum.Video;

  return [
    cameraLabel(exif),
    exif?.lensModel || null,
    ...(isVideo ? [] : exposureParts(exif)),
    dimensionsLabel(asset),
    isVideo ? frameRateLabel(exif?.fps) : null,
    isVideo ? formatDuration(asset.duration) : null,
    formatFileSize(exif?.fileSizeInByte),
  ].filter((part): part is string => !!part);
}

export const viewerHeadlineText = (asset: AssetResponseDto): string => viewerHeadline(asset).join(' · ');

/** The folder an offline original was last seen in, for the relink action. */
export const folderOf = (path: string | null | undefined): string | null => {
  if (typeof path !== 'string' || !path.includes('/')) {
    return null;
  }
  return path.slice(0, path.lastIndexOf('/')) || '/';
};

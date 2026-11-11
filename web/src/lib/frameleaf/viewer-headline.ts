/**
 * The short technical line the Frameleaf viewer shows under the file name (FL-35).
 *
 * Ported from `design/frameleaf/template/src/media-viewer.mjs` (`viewerHeadline` and the
 * formatters it uses), adapted to the production `AssetResponseDto`/`ExifResponseDto`.
 * Pure: it reads the metadata the detail panel already receives and renders no markup.
 */
import { AssetTypeEnum, type AssetResponseDto, type ExifResponseDto } from '@frameleaf/sdk';
import type { DateTime } from 'luxon';
import { get } from 'svelte/store';
import { formatLuxon } from '$lib/frameleaf/date-format';
import { locale } from '$lib/stores/preferences.store';
import { fromISODateTime, fromISODateTimeUTC } from '$lib/utils/timeline-util';

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
    ? `${width.toLocaleString(get(locale))} × ${height.toLocaleString(get(locale))}`
    : null;
};

export const cameraLabel = (exif: ExifResponseDto | undefined): string | null => {
  const make = exif?.make?.trim() ?? '';
  const model = exif?.model?.trim() ?? '';
  return model.toLowerCase().startsWith(make.toLowerCase()) ? model || null : [make, model].filter(Boolean).join(' ');
};

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

/**
 * When the photo was taken, on the clock of the place it was taken in: the capture time in the
 * photo's own zone when it has one, else the server's local date and time. The Information panel's
 * date row and the viewer's title read the same value.
 */
export const captureDateTime = (asset: AssetResponseDto): DateTime | null => {
  const timeZone = asset.exifInfo?.timeZone;
  const value =
    timeZone && asset.exifInfo?.dateTimeOriginal
      ? fromISODateTime(asset.exifInfo.dateTimeOriginal, timeZone)
      : asset.localDateTime
        ? fromISODateTimeUTC(asset.localDateTime)
        : null;
  return value?.isValid ? value : null;
};

/**
 * The viewer's title (FL-1392, UI review 2026-11-10 B3; prototype `heading` in `MediaViewer.jsx`):
 * when and where ("Sun, Aug 16, 2026 · Banff, Alberta"), not the camera's file name. A photo with no
 * place is titled with its date alone; one with neither is titled with its file name. `time` leads
 * the line under the title. Both follow the person's date and time format (FL-783).
 */
export const viewerWhenWhere = (
  asset: AssetResponseDto,
  dateLocale: string | undefined = get(locale),
): { title: string; time: string } => {
  const captured = captureDateTime(asset);
  const date = captured
    ? formatLuxon(captured, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }, dateLocale)
    : '';
  const place = [asset.exifInfo?.city, asset.exifInfo?.state].filter(Boolean).join(', ');
  return {
    title: [date, place].filter(Boolean).join(' · ') || asset.originalFileName,
    time: captured ? formatLuxon(captured, { hour: 'numeric', minute: '2-digit' }, dateLocale) : '',
  };
};

/** The folder an offline original was last seen in, for the relink action. */
export const folderOf = (path: string | null | undefined): string | null => {
  if (typeof path !== 'string' || !path.includes('/')) {
    return null;
  }
  return path.slice(0, path.lastIndexOf('/')) || '/';
};

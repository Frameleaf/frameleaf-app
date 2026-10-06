import type { ExifResponseDto } from '@frameleaf/sdk';

/** Keep Frameleaf's -1 state while legacy EXIF responses expose only stars or null. */
export const getExifRating = (exif: Pick<ExifResponseDto, 'rating' | 'isRejected'> | undefined): number | null =>
  exif?.isRejected === true ? -1 : (exif?.rating ?? null);

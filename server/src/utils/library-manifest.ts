import { BadRequestException } from '@nestjs/common';
import { CaptureSourceDto } from 'src/dtos/bookmark.dto.js';

/** Attribution URLs are portable; browser credentials and fetch-only query strings are not. */
const attributionUrl = (value: string | null | undefined) => {
  if (!value) return null;
  if (!URL.canParse(value)) throw new BadRequestException('Source URL unavailable');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestException('Source URL unavailable');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
};

export const portableCaptureSource = (value: {
  captureId: string;
  pageUrl: string;
  mediaUrl?: string | null;
  title: string;
  capturedAt: Date | string;
  note?: string | null;
  creator?: string | null;
  licenseUrl?: string | null;
}): CaptureSourceDto => ({
  captureId: value.captureId,
  pageUrl: attributionUrl(value.pageUrl)!,
  mediaUrl: attributionUrl(value.mediaUrl),
  title: value.title,
  capturedAt: (value.capturedAt instanceof Date ? value.capturedAt : new Date(value.capturedAt)).toISOString(),
  note: value.note ?? null,
  creator: value.creator ?? null,
  licenseUrl: attributionUrl(value.licenseUrl),
});

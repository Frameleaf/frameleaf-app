import type { CaptureCandidate } from './candidates';
import type { ServerBinding } from './api';
import { QueueFailure, type EnqueueCapture } from './queue';
import { sanitizeSourceUrl } from './source-url';
/**
 * A time as ISO with this browser's UTC offset rather than Z, so the server knows the zone it was saved in and
 * Captured reads in local time (FL-698).
 */
export function localIsoTime(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const pad = (value: number) => String(Math.abs(value)).padStart(2, '0');
  const wall = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, -1);
  return `${wall}${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}
const extensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/jxl': 'jxl',
  'image/x-icon': 'ico',
};
export function captureInput(
  form: {
    binding: ServerBinding;
    albumId: string;
    tagIds: string[];
    note: string;
  },
  candidate: CaptureCandidate,
  blob: Blob,
  capturedAt = localIsoTime(),
): EnqueueCapture {
  const pageUrl = sanitizeSourceUrl(candidate.pageUrl);
  if (!pageUrl)
    throw new QueueFailure('Enter a valid source page address before saving.');
  let name = 'capture';
  try {
    const url = new URL(candidate.url);
    if (['https:', 'http:'].includes(url.protocol))
      name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '') || name;
  } catch {}
  const originalExtension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
  const extension = extensions[blob.type] ?? originalExtension ?? 'img';
  const base =
    name
      .replace(/\.[a-z0-9]{1,8}$/i, '')
      .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
      .replace(/^\.+/, '')
      .trim()
      .replace(/[. ]+$/, '') || 'capture';
  const filename = base.slice(0, 254 - extension.length) + '.' + extension;
  const mediaUrl = sanitizeSourceUrl(candidate.url);
  return {
    binding: form.binding,
    albumId: form.albumId,
    tagIds: [...form.tagIds],
    note: form.note,
    source: {
      pageUrl,
      title: candidate.title.slice(0, 2000),
      capturedAt,
      ...(mediaUrl && { mediaUrl }),
    },
    file: { blob, filename },
  };
}

export function bookmarkInput(
  form: {
    binding: ServerBinding;
    albumId: string;
    tagIds: string[];
    note: string;
  },
  target: string,
  page: string,
  title: string,
  capturedAt = localIsoTime(),
): EnqueueCapture {
  const pageUrl = sanitizeSourceUrl(page);
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new QueueFailure('Enter a valid bookmark address before saving.');
  }
  if (
    !pageUrl ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.length > 8192
  )
    throw new QueueFailure(
      'Enter a valid bookmark address without embedded credentials before saving.',
    );
  const name = title.slice(0, 2000);
  return {
    binding: form.binding,
    albumId: form.albumId,
    tagIds: [...form.tagIds],
    note: form.note,
    source: { pageUrl, title: name, capturedAt },
    bookmark: { url: url.href, title: name },
  };
}

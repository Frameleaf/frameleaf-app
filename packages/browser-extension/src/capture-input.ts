import type { CaptureCandidate } from './candidates';
import type { ServerBinding } from './api';
import { QueueFailure, type EnqueueCapture } from './queue';
import { sanitizeSourceUrl } from './source-url';
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
  capturedAt = new Date().toISOString(),
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

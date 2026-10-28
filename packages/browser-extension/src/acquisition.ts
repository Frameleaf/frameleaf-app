import { candidateUrl, type CaptureCandidate } from './candidates';
import { hasMediaAccess } from './platform';
export const MAX_CAPTURE_BYTES = 100 * 1024 * 1024;
export class MediaFailure extends Error {}
export function mediaOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}
const unavailable = () =>
  new MediaFailure(
    'Could not download this image. Redirects or protected images may need a bookmark or screenshot instead.',
  );

/** No Frameleaf request options, browser cookies, referrers or redirect following are used here. */
export async function acquireCandidate(
  candidate: CaptureCandidate,
  approvedOrigins: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Blob> {
  if (
    candidateUrl(candidate.url, candidate.pageUrl, candidate.pageUrl) !==
    candidate.url
  )
    throw unavailable();
  if (signal?.aborted) throw new MediaFailure('Image download cancelled.');
  const origin = mediaOrigin(candidate.url);
  if (
    origin &&
    (!approvedOrigins.has(origin) || !(await hasMediaAccess(origin)))
  )
    throw new MediaFailure(
      'Allow access to this exact image origin before downloading.',
    );
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 30_000);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  controller.signal.addEventListener('abort', cancel, { once: true });
  try {
    if (controller.signal.aborted) throw unavailable();
    response = await globalThis.fetch(candidate.url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (
      response.redirected ||
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400)
    )
      throw new MediaFailure(
        'Redirected images cannot be downloaded here. Save a bookmark or screenshot instead.',
      );
    if (response.status === 401 || response.status === 403)
      throw new MediaFailure(
        'This image requires access the extension does not have. Save a bookmark or screenshot instead.',
      );
    if (!response.ok || !response.body) throw unavailable();
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_CAPTURE_BYTES)
      throw new MediaFailure('Images must be no larger than 100 MiB.');
    const type = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (
      type &&
      !/^image\/[a-z0-9.+-]+$/.test(type) &&
      type !== 'application/octet-stream'
    )
      throw new MediaFailure(
        'This response is not an image. Save a bookmark or screenshot instead.',
      );
    reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) throw unavailable();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CAPTURE_BYTES)
        throw new MediaFailure('Images must be no larger than 100 MiB.');
      chunks.push(value);
    }
    if (!size) throw unavailable();
    return new Blob(chunks, { type: type || 'application/octet-stream' });
  } catch (error) {
    if (controller.signal.aborted)
      throw new MediaFailure('Image download stopped or timed out. Try again.');
    throw error instanceof MediaFailure ? error : unavailable();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancel);
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    } else await response?.body?.cancel().catch(() => {});
  }
}

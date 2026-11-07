import { AssetMediaStatus, getBaseUrl } from '@frameleaf/sdk';
import { AbortError, ApiError, sleep, uploadRequest } from '$lib/utils';

/**
 * FL-1268: a large file goes to the server as parts sent side by side (`PUT /assets/uploads/:id/parts`).
 * No per-file size limit; parts are large on Wi-Fi or wired connections and small on cellular.
 */

const MiB = 2 ** 20;
const MIN_PART = 8 * MiB;
const MAX_ATTEMPTS = 6;

type Connection = { type?: string; saveData?: boolean };
type PartsResult = { id: string; status: AssetMediaStatus };
type Range = { offset: number; size: number };

export type ParallelUploadInput = {
  file: File;
  /** SHA-256 of the whole file, hex. */
  sha256: string;
  metadata: Record<string, unknown>;
  signal: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
};

/** Wi-Fi/wired: 256 MiB parts, 4 at once. Cellular or data saver: 16 MiB, 2 at once. */
export const partPolicy = (connection: Connection | undefined) =>
  connection?.type === 'cellular' || connection?.saveData
    ? { partSize: 16 * MiB, parallel: 2 }
    : { partSize: 256 * MiB, parallel: 4 };

/** Reads `key=value` items of a structured header such as `Upload-Limit`. */
const headerNumber = (header: string | null, key: string) => {
  const match = new RegExp(String.raw`(?:^|,)\s*${key}=(\d+)`).exec(header ?? '');
  return match ? Number(match[1]) : undefined;
};

const hexToBase64 = (hex: string) =>
  btoa(String.fromCodePoint(...(hex.match(/../g) ?? []).map((h) => Number.parseInt(h, 16))));

const base64Url = (value: string) =>
  btoa(String.fromCodePoint(...new TextEncoder().encode(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

/** Splits `range` into pieces no larger than `size`. */
export const splitRange = ({ offset, size }: Range, partSize: number): Range[] => {
  const pieces: Range[] = [];
  for (let at = offset; at < offset + size; at += partSize) {
    pieces.push({ offset: at, size: Math.min(partSize, offset + size - at) });
  }
  return pieces;
};

/**
 * Uploads `file` in parallel parts. Returns undefined when the server cannot take parts
 * (an older server), so the caller falls back to the single-request upload.
 */
export async function uploadInParts({ file, sha256, metadata, signal, onProgress }: ParallelUploadInput) {
  const base = getBaseUrl() + '/assets/uploads';
  const options = await fetch(base, { method: 'OPTIONS', signal });
  const maxParallel = headerNumber(options.headers.get('Upload-Parts'), 'max-parallel');
  const limit = options.headers.get('Upload-Limit');
  const maxAppend = headerNumber(limit, 'max-append-size');
  const maxSize = headerNumber(limit, 'max-size');
  if (!options.ok || !maxParallel || !maxAppend || (maxSize !== undefined && file.size > maxSize)) {
    return;
  }
  const policy = partPolicy((navigator as Navigator & { connection?: Connection }).connection);
  const partSize = Math.max(MIN_PART, Math.min(policy.partSize, maxAppend));
  const parallel = Math.min(policy.parallel, maxParallel);

  const created = await fetch(base, {
    method: 'POST',
    signal,
    headers: {
      'Upload-Draft-Interop-Version': '9',
      'Upload-Complete': '?0',
      'Upload-Length': String(file.size),
      'Content-Type': file.type,
      'Repr-Digest': `sha-256=:${hexToBase64(sha256)}:`,
      'Asset-Metadata': base64Url(JSON.stringify(metadata)),
    },
  });
  const location = created.headers.get('Location');
  if (created.status !== 201 || !location) {
    throw new ApiError(created.statusText, created.status, await created.text());
  }
  const url = new URL(location, globalThis.location.href).toString();
  try {
    return await sendParts(url, file, signal, partSize, parallel, onProgress);
  } catch (error) {
    // The web app cannot resume after a reload, so free the slot (the server allows a few incomplete uploads).
    void fetch(url, { method: 'DELETE' }).catch(() => {});
    throw error;
  }
}

async function sendParts(
  url: string,
  file: File,
  signal: AbortSignal,
  initialPartSize: number,
  parallel: number,
  onProgress: ParallelUploadInput['onProgress'],
) {
  let partSize = initialPartSize;
  const pending = splitRange({ offset: 0, size: file.size }, partSize);
  const loaded = new Map<number, number>();
  const report = () => {
    let sum = 0;
    for (const value of loaded.values()) {
      sum += value;
    }
    onProgress?.(sum, file.size);
  };
  let result: PartsResult | undefined;

  const sendPart = async (range: Range) => {
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await uploadRequest<PartsResult | null>({
          url: `${url}/parts`,
          method: 'PUT',
          data: file.slice(range.offset, range.offset + range.size),
          headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(range.offset) },
          onUploadProgress: (event) => {
            loaded.set(range.offset, event.loaded);
            report();
          },
        });
        loaded.set(range.offset, range.size);
        report();
        if (response.status === 200 && response.data) {
          result = response.data;
        }
        return;
      } catch (error) {
        loaded.delete(range.offset);
        report();
        const status = error instanceof ApiError ? error.statusCode : 0;
        // 409 is final (overlap or closed upload); anything else is retried, and a dropped part shrinks later ones.
        if (error instanceof AbortError || status === 409 || attempt >= MAX_ATTEMPTS) {
          throw error;
        }
        if (status === 0 && range.size > MIN_PART) {
          partSize = Math.max(MIN_PART, Math.floor(range.size / 2));
          pending.unshift(...splitRange(range, partSize));
          return;
        }
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      }
    }
  };

  const worker = async () => {
    for (let range = pending.shift(); range; range = pending.shift()) {
      if (range.size > partSize) {
        const [first, ...rest] = splitRange(range, partSize);
        pending.unshift(...rest);
        range = first;
      }
      await sendPart(range);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));

  // Every part is in; the request that finalized the file may have been another one.
  for (let wait = 1000; !result; wait = Math.min(wait * 2, 10_000)) {
    signal.throwIfAborted();
    const response = await fetch(`${url}/result`, { signal });
    if (response.status === 200) {
      result = (await response.json()) as PartsResult;
    } else if (response.status === 202) {
      await sleep(wait);
    } else {
      throw new ApiError(response.statusText, response.status, await response.text());
    }
  }
  return result;
}

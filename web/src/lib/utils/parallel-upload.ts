import { AssetMediaStatus, getBaseUrl } from '@frameleaf/sdk';
import { AbortError, ApiError, sleep, uploadRequest } from '$lib/utils';

/**
 * FL-1268: a large file goes to the server as parts sent side by side (`PUT /assets/uploads/:id/parts`).
 * No per-file size limit; parts are large on Wi-Fi or wired connections and small on cellular.
 */

const MiB = 2 ** 20;
const MIN_PART = 8 * MiB;
const MAX_ATTEMPTS = 6;
const MAX_RESULT_POLLS = 120;
/** 30 s apart, so a busy part waits out the server's 15-minute lease. */
const MAX_BUSY_RETRIES = 32;

/** The parts of `range` the server has not received, or 'complete' when the whole file is in. */
const missingRanges = async (url: string, range: Range, signal: AbortSignal): Promise<Range[] | 'complete'> => {
  const response = await fetch(`${url}/parts`, { signal });
  if (!response.ok) {
    throw new ApiError(response.statusText, response.status, await response.text());
  }
  const listing = (await response.json()) as { offset: number; size: number | null; parts: Range[] };
  if (listing.size !== null && listing.offset >= listing.size) {
    return 'complete';
  }
  const gaps: Range[] = [];
  let at = range.offset;
  const end = range.offset + range.size;
  for (const part of listing.parts) {
    if (part.offset + part.size <= at || part.offset >= end) {
      continue;
    }
    if (part.offset > at) {
      gaps.push({ offset: at, size: part.offset - at });
    }
    at = Math.max(at, part.offset + part.size);
  }
  if (at < end) {
    gaps.push({ offset: at, size: end - at });
  }
  return gaps;
};

/** 409s that only mean another request holds the upload or this part for a moment. */
const isTransientConflict = (error: unknown) => {
  const details = error instanceof ApiError ? (error.details as unknown) : undefined;
  const message = typeof details === 'string' ? details : JSON.stringify(details ?? '');
  return /active request|admission expired/i.test(message);
};

type Connection = { type?: string; saveData?: boolean };
type PartsResult = { id: string; status: AssetMediaStatus };
type Range = { offset: number; size: number };

export type ParallelUploadInput = {
  file: File;
  sidecarFile?: File;
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
export async function uploadInParts({ file, sidecarFile, sha256, metadata, signal, onProgress }: ParallelUploadInput) {
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
  // Too many unfinished uploads on this account (other devices count too): send this one in a single request.
  if (created.status === 429) {
    return;
  }
  const location = created.headers.get('Location');
  if (created.status !== 201 || !location) {
    throw new ApiError(created.statusText, created.status, await created.text());
  }
  const url = new URL(location, globalThis.location.href).toString();
  try {
    if (sidecarFile) {
      const body = new FormData();
      body.append('sidecarData', sidecarFile);
      const response = await fetch(`${url}/sidecar`, { method: 'PUT', body, signal });
      if ([404, 405].includes(response.status)) {
        await fetch(url, { method: 'DELETE' }).catch(() => {});
        return;
      }
      if (!response.ok) {
        throw new ApiError(response.statusText, response.status, await response.text());
      }
    }
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
  // Set when the server already has the whole file (a part whose response was lost completed it).
  let closed = false;

  const sendPart = async (range: Range) => {
    for (let attempt = 1, busy = 0; ; attempt++) {
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
        if (status === 409 && isTransientConflict(error)) {
          // An earlier attempt still holds this part on the server; its lease lasts up to 15 minutes.
          if (++busy > MAX_BUSY_RETRIES) {
            throw error;
          }
          attempt--;
          await sleep(30_000);
          continue;
        }
        if (status === 409) {
          // The server already has some of these bytes (a part whose response was lost) or the upload is complete.
          let gaps: Awaited<ReturnType<typeof missingRanges>>;
          try {
            gaps = await missingRanges(url, range, signal);
          } catch (listError) {
            // A dropped listing is retried like any failed attempt (the resend 409s again and relists).
            if (listError instanceof AbortError || signal.aborted || attempt >= MAX_ATTEMPTS) {
              throw listError;
            }
            await sleep(Math.min(30_000, 1000 * 2 ** attempt));
            continue;
          }
          if (gaps === 'complete') {
            closed = true;
            return;
          }
          // Nothing of this range arrived, so the conflict is not about these bytes (the upload is closed).
          if (gaps.length === 1 && gaps[0].offset === range.offset && gaps[0].size === range.size) {
            throw error;
          }
          pending.unshift(...gaps);
          return;
        }
        // Anything else is retried; a dropped part shrinks later ones.
        if (error instanceof AbortError || status === 404 || attempt >= MAX_ATTEMPTS) {
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
    for (let range = pending.shift(); range && !closed; range = pending.shift()) {
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
  for (let wait = 1000, polls = 0; !result; wait = Math.min(wait * 2, 10_000), polls++) {
    signal.throwIfAborted();
    let response: Response;
    let body: string;
    try {
      response = await fetch(`${url}/result`, { signal });
      body = response.status === 202 ? '' : await response.text();
    } catch (error) {
      // A dropped connection (request or body) after every part is in: keep asking, within the same poll budget.
      if (signal.aborted || polls >= MAX_RESULT_POLLS) {
        throw error;
      }
      await sleep(wait);
      continue;
    }
    if (response.status === 200) {
      result = JSON.parse(body) as PartsResult;
    } else if (
      polls < MAX_RESULT_POLLS &&
      (response.status === 202 || (response.status === 409 && isTransientConflict(new ApiError('', 409, body))))
    ) {
      await sleep(wait);
    } else {
      throw new ApiError(response.statusText, response.status, body);
    }
  }
  return result;
}

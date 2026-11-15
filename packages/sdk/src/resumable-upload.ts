/**
 * FL-818: one client for the server's resumable upload resources (`/assets/uploads`, IETF resumable
 * upload draft, interop version 9), shared by the web uploader (Blob.slice) and the CLI (file handles).
 *
 * The resource is created without bytes and filled with PATCH appends; the last carries
 * `Upload-Complete: ?1`. A dropped connection or an offset conflict re-reads the durable offset with
 * HEAD and continues from there, so only the missing bytes are sent again. The server publishes an
 * asset only when the `Repr-Digest` SHA-256 matches what it received.
 *
 * ponytail: sequential appends only. Parallel `PUT :id/parts` (FL-1268) is faster on big files over
 * fast links; add it here when a caller measures the need.
 */

export interface ResumableUploadOptions {
  /** The API base, as for the generated client (`https://photos.example.com/api` or `/api`). */
  baseUrl: string;
  /** Sign-in headers, such as `x-api-key`; the browser's cookie needs none. */
  headers?: Record<string, string>;
  /** A fetch to use instead of the global one (tests, proxies). */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface ResumableUploadMetadata {
  filename: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  /** Integer milliseconds. */
  duration?: number;
  isFavorite?: boolean;
  visibility?: string;
  [key: string]: unknown;
}

export interface ResumableUploadInput extends ResumableUploadOptions {
  /** Bytes in the whole file. */
  size: number;
  /** SHA-256 of the whole file, as 64 hex characters. */
  sha256: string;
  /** The file's media type (`image/jpeg`, `video/mp4`, …); the server refuses a create without one. */
  contentType: string;
  metadata: ResumableUploadMetadata;
  /** `length` bytes from `offset`: `Blob.slice` in a browser, a file handle in Node. */
  readChunk: (offset: number, length: number) => Promise<Uint8Array>;
  /** Called with the resource URL before any bytes are sent, so a caller can keep it to resume later. */
  onResource?: (url: string) => void | Promise<void>;
  /** Bytes the server has durably acknowledged, never bytes merely sent. */
  onProgress?: (committed: number, size: number) => void;
  /** Largest append; capped by the server's `max-append-size`. Default 8 MiB. */
  chunkSize?: number;
  /** Network failures in a row before giving up. Default 6. */
  retries?: number;
  /** First backoff after a network failure, doubled each try. Default 500 ms. */
  backoffMs?: number;
}

/** What the server returns for a finished upload, like `AssetUploadResultDto`. */
export interface ResumableUploadResult {
  id: string;
  status: string;
  sha256: string;
}

export interface ResumableUploadLimits {
  maxSize: number | null;
  maxAppendSize: number | null;
  maxAge: number | null;
  /** Parallel parts the server accepts; null on a server without them. */
  maxParallel: number | null;
}

export type ResumableUploadRefusal =
  /** The account deleted this item and asked for it not to be uploaded again. */
  | 'deleted_by_owner'
  /** The item is already claimed by the server's iCloud Photos sync. */
  | 'icloud_claimed'
  /** The resource is gone or expired: start a new upload. */
  | 'unavailable'
  | 'other';

export class ResumableUploadError extends Error {
  override name = 'ResumableUploadError';

  constructor(
    readonly status: number,
    readonly reason: ResumableUploadRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** Every byte arrived and verified, but the server is still ingesting; resume the same URL later. */
export class ResumableUploadPendingError extends Error {
  override name = 'ResumableUploadPendingError';

  constructor(readonly url: string) {
    super('Upload received; the server is still processing it');
  }
}

export const isResumableUploadError = (error: unknown, reason?: ResumableUploadRefusal): error is ResumableUploadError =>
  error instanceof ResumableUploadError && (reason === undefined || error.reason === reason);

const INTEROP = '9';
const DEFAULT_CHUNK = 8 * 1024 * 1024;
const UUID = /([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\/?$/i;

const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

const hexBytes = (hex: string) => {
  if (!/^[\da-f]{64}$/i.test(hex)) {
    throw new TypeError('sha256 must be 64 hex characters');
  }
  return Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
};

/** RFC 9530 `Repr-Digest` for a SHA-256 of the whole file. */
export const reprDigest = (sha256: string) => `sha-256=:${base64(hexBytes(sha256))}:`;

/** Canonical base64url (no padding) of the metadata's UTF-8 JSON, as the server requires. */
export const encodeAssetMetadata = (metadata: ResumableUploadMetadata) =>
  base64(new TextEncoder().encode(JSON.stringify(metadata)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const number = (header: string | null, name: string) => {
  const match = header?.match(new RegExp(`${name}=(\\d+)`));
  return match ? Number(match[1]) : null;
};

const join = (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/, '')}${path}`;

const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', stop, { once: true });
  });

const refusal = async (response: Response, step: string) => {
  const body = await response.text().catch(() => '');
  let message = body;
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string') {
      message = parsed.message;
    }
  } catch {
    // not JSON: keep the text
  }
  const reason: ResumableUploadRefusal =
    message === 'deleted_by_owner' || message === 'icloud_claimed'
      ? message
      : response.status === 404 || response.status === 410
        ? 'unavailable'
        : 'other';
  return new ResumableUploadError(response.status, reason, `${step}: HTTP ${response.status} ${message.slice(0, 300)}`);
};

const requester = (options: ResumableUploadOptions) => {
  const request = options.fetch ?? fetch;
  return (url: string, method: string, headers: Record<string, string> = {}, body?: Uint8Array) =>
    request(url, {
      method,
      headers: { ...options.headers, ...headers },
      body: body as BodyInit | undefined,
      signal: options.signal,
      credentials: 'same-origin',
    });
};

/** The server's limits, or null for a server without resumable uploads (404, 405, or no `Upload-Limit`): use `POST /assets` there. */
export const getUploadLimits = async (options: ResumableUploadOptions): Promise<ResumableUploadLimits | null> => {
  const response = await requester(options)(join(options.baseUrl, '/assets/uploads'), 'OPTIONS');
  if (response.status === 404 || response.status === 405) {
    return null;
  }
  if (!response.ok) {
    throw await refusal(response, 'limits');
  }
  const limit = response.headers.get('Upload-Limit');
  if (!limit) {
    // An OPTIONS answer without the server's limits (a proxy answering CORS preflight, say) isn't
    // resumable-upload support.
    return null;
  }
  return {
    maxSize: number(limit, 'max-size'),
    maxAppendSize: number(limit, 'max-append-size'),
    maxAge: number(limit, 'max-age'),
    maxParallel: number(response.headers.get('Upload-Parts'), 'max-parallel'),
  };
};

const resourceUrl = (baseUrl: string, location: string | null) => {
  const id = location?.match(UUID)?.[1];
  if (!id) {
    throw new ResumableUploadError(0, 'other', `create: unexpected Location ${location}`);
  }
  return join(baseUrl, `/assets/uploads/${id}`);
};

/** Retries `attempt` on network failures with exponential backoff; HTTP answers and aborts pass through. */
const withRetries = async <T>(input: ResumableUploadInput, attempt: (tries: number) => Promise<T>) => {
  const retries = input.retries ?? 6;
  const backoff = input.backoffMs ?? 500;
  for (let tries = 0; ; tries++) {
    try {
      return await attempt(tries);
    } catch (error) {
      if (isAbort(error) || error instanceof ResumableUploadError || error instanceof ResumableUploadPendingError) {
        throw error;
      }
      if (tries + 1 >= retries) {
        throw error;
      }
      await sleep(backoff * 2 ** tries, input.signal);
    }
  }
};

const head = async (url: string, input: ResumableUploadInput) => {
  const response = await requester(input)(url, 'HEAD', { 'Upload-Draft-Interop-Version': INTEROP });
  if (!response.ok) {
    throw await refusal(response, 'offset');
  }
  return {
    offset: Number(response.headers.get('Upload-Offset') ?? Number.NaN),
    maxAppendSize: number(response.headers.get('Upload-Limit'), 'max-append-size'),
  };
};

/** The finished result; polls while the server is still ingesting, then hands back the URL to try later. */
const result = async (url: string, input: ResumableUploadInput) => {
  const retries = input.retries ?? 6;
  const backoff = input.backoffMs ?? 500;
  for (let tries = 0; tries < retries; tries++) {
    const response = await requester(input)(`${url}/result`, 'GET');
    if (response.status === 200) {
      return (await response.json()) as ResumableUploadResult;
    }
    if (response.status !== 202) {
      throw await refusal(response, 'result');
    }
    await sleep(backoff * 2 ** tries, input.signal);
  }
  throw new ResumableUploadPendingError(url);
};

const send = async (
  url: string,
  input: ResumableUploadInput,
  start: { offset: number; maxAppendSize: number | null },
): Promise<ResumableUploadResult> => {
  const chunkSize = Math.min(input.chunkSize ?? DEFAULT_CHUNK, start.maxAppendSize ?? Number.POSITIVE_INFINITY);
  let offset = start.offset;
  let failures = 0;
  let conflicts = 0;
  const retries = input.retries ?? 6;
  const backoff = input.backoffMs ?? 500;

  while (true) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > input.size) {
      throw new ResumableUploadError(0, 'other', `invalid upload offset ${offset}`);
    }
    input.onProgress?.(offset, input.size);
    if (offset === input.size && input.size > 0) {
      // Every byte is on the server, for example when the final answer was lost.
      return result(url, input);
    }
    const length = Math.min(chunkSize, input.size - offset);
    const last = offset + length >= input.size;
    let response: Response;
    try {
      const bytes = await input.readChunk(offset, length);
      if (bytes.byteLength !== length) {
        throw new ResumableUploadError(0, 'other', `read ${bytes.byteLength} of ${length} bytes at ${offset}`);
      }
      response = await requester(input)(
        url,
        'PATCH',
        {
          'Content-Type': 'application/partial-upload',
          'Upload-Draft-Interop-Version': INTEROP,
          'Upload-Offset': String(offset),
          'Upload-Complete': last ? '?1' : '?0',
        },
        bytes,
      );
    } catch (error) {
      if (isAbort(error) || error instanceof ResumableUploadError || ++failures >= retries) {
        throw error;
      }
      // A dropped connection: wait, then ask the server what it kept.
      await sleep(backoff * 2 ** (failures - 1), input.signal);
      offset = (await withRetries(input, () => head(url, input))).offset;
      continue;
    }
    failures = 0;
    switch (response.status) {
      case 200: {
        input.onProgress?.(input.size, input.size);
        return (await response.json()) as ResumableUploadResult;
      }
      case 202: {
        input.onProgress?.(input.size, input.size);
        return result(url, input);
      }
      case 204: {
        offset = Number(response.headers.get('Upload-Offset') ?? offset + length);
        if (last && offset >= input.size) {
          input.onProgress?.(input.size, input.size);
          return result(url, input);
        }
        break;
      }
      case 409: {
        const refused = await refusal(response, 'append');
        if (refused.reason !== 'other' || ++conflicts > retries) {
          throw refused;
        }
        // The server holds a different offset than this client thought: carry on from its offset.
        offset = (await withRetries(input, () => head(url, input))).offset;
        break;
      }
      default: {
        throw await refusal(response, 'append');
      }
    }
  }
};

/**
 * Creates an upload resource and sends the whole file. `onResource` receives the URL before any
 * bytes go, so a caller can store it and call `resumeResumableUpload` after a crash or reload.
 */
export const startResumableUpload = async (input: ResumableUploadInput): Promise<ResumableUploadResult> => {
  type Created = { done: ResumableUploadResult } | { url: string; maxAppendSize: number | null };
  const create = await withRetries<Created>(input, async () => {
    const response = await requester(input)(
      join(input.baseUrl, '/assets/uploads'),
      'POST',
      {
        'Content-Type': input.contentType,
        'Asset-Metadata': encodeAssetMetadata(input.metadata),
        'Repr-Digest': reprDigest(input.sha256),
        'Upload-Complete': '?0',
        'Upload-Draft-Interop-Version': INTEROP,
        'Upload-Length': String(input.size),
      },
      new Uint8Array(0),
    );
    if (response.status === 200) {
      // Already on the server (for example an identical file): nothing to send.
      return { done: (await response.json()) as ResumableUploadResult };
    }
    if (![201, 202, 204].includes(response.status)) {
      throw await refusal(response, 'create');
    }
    return {
      url: resourceUrl(input.baseUrl, response.headers.get('Location')),
      maxAppendSize: number(response.headers.get('Upload-Limit'), 'max-append-size'),
    };
  });
  if ('done' in create) {
    input.onProgress?.(input.size, input.size);
    return create.done;
  }
  await input.onResource?.(create.url);
  return send(create.url, input, { offset: 0, maxAppendSize: create.maxAppendSize });
};

/** Continues an upload from the offset the server holds; only the missing bytes are sent. */
export const resumeResumableUpload = async (url: string, input: ResumableUploadInput) =>
  send(url, input, await withRetries(input, () => head(url, input)));

/** Cancels an unpublished upload; an upload that is already gone counts as cancelled. */
export const cancelResumableUpload = async (url: string, options: ResumableUploadOptions) => {
  const response = await requester(options)(url, 'DELETE');
  if (!response.ok && response.status !== 404) {
    throw await refusal(response, 'cancel');
  }
};

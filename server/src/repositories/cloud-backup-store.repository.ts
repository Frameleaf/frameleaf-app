import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { type FileHandle, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { createBuddyDirectory, flushBuddyDirectory, writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import {
  clientBackupContext,
  clientBackupPlainSize,
  decryptClientBackup,
  encryptClientBackup,
} from 'src/utils/cloud-backup-crypto.js';
import {
  CLOUD_BACKUP_MARKER,
  CLOUD_BACKUP_MARKER_FORMAT,
  CLOUD_BACKUP_PART_BYTES,
  CLOUD_BACKUP_PROBE_PREFIX,
  CloudBackupMarker,
  parseMarker,
  sseCustomerHeaders,
} from 'src/utils/cloud-backup.js';
import { compareCodeUnits } from 'src/utils/compare.js';
import {
  advanceExecutionProgress,
  assertExecutionActive,
  executionDelay,
  executionSignal,
  executionTimeout,
  withExecutionCleanup,
} from 'src/utils/execution-signal.js';

/**
 * Cloud backup storage (FL-160): the S3 API calls the backup agent makes, signed with AWS Signature
 * Version 4 over Node's own `fetch` and `crypto`. No SDK and no extra binaries are in the image; SSE-C
 * needs the S3 API directly, and every provider the agent supports (Wasabi, and any SSE-C-capable S3
 * store for your own bucket) speaks it.
 *
 * - Legacy objects retain SSE-C customer-key headers. Versioned client objects carry locally encrypted
 *   bodies and never those headers. Requests log method and object name, never keys or payloads.
 * - **Integrity.** Every body is signed with its SHA-256 (`x-amz-content-sha256`) and sent with
 *   `Content-MD5`, so the provider refuses a body that changed in flight. A file is read once while it
 *   uploads and hashed as it goes: an object named `o/<sha256>` is completed only when what was sent
 *   hashes to that name. SSE-C ETags are not MD5 digests of the plaintext, so an ETag is required and
 *   recorded, never compared with one.
 * - **Path-style addressing** (`<endpoint>/<bucket>/<key>`), which every S3-compatible provider accepts.
 *   On Amazon S3 the storage address must be the bucket's regional endpoint
 *   (`https://s3.<region>.amazonaws.com`); another region answers with a redirect, reported as such.
 */

export type CloudBackupConnection = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * FL-164, Frameleaf-managed storage: a key rotated moments ago can take a few seconds to become valid, so
   * until this time (epoch ms) a `403 InvalidAccessKeyId` is waited out and retried rather than reported.
   */
  freshKeyUntil?: number;
  /** Local encryption/recovery authority; never serialized into a storage request. */
  vaultId?: string;
  stagingDirectory?: string;
  recoveryKeys?: Record<string, string>;
  trustedManifests?: Record<string, { versionId: string; ciphertextSha256: string }>;
  trustedManifestHead?: string;
  offlineDirectory?: string;
  clientFormatSupported?: boolean;
};

export type CloudBackupObjectInfo = { key: string; size: number; etag: string | null };

export type CloudBackupClaimRefusal =
  'claimed-by-another-server' | 'other-key' | 'not-empty' | 'sse-c-unsupported' | 'claim-missing';

/** A provider answered with an error, or could not be reached. The message never holds a secret. */
export class CloudBackupStoreError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'CloudBackupStoreError';
  }
}

/** The bucket cannot be claimed for this server; `reason` says why in words an administrator can act on. */
export class CloudBackupClaimError extends Error {
  constructor(
    readonly reason: CloudBackupClaimRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'CloudBackupClaimError';
  }
}

/** The file changed while it was read: what was sent does not hash to the name it was uploaded under. */
export class CloudBackupFileChangedError extends Error {
  constructor(readonly path: string) {
    super('The file changed while it was being backed up');
    this.name = 'CloudBackupFileChangedError';
  }
}

/** What an administrator reads when the provider refuses customer-provided keys on a bucket it lists. */
export const SSE_C_REFUSED_MESSAGE =
  'The storage provider refused an encrypted test write: the bucket may block customer-provided encryption keys (SSE-C), or these credentials can’t write to it. Amazon S3 turns SSE-C off by default on new buckets: allow it in the bucket’s default encryption settings (remove SSE-C from the blocked encryption types), check that the access key may write to the bucket, then check the bucket again.';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const REQUEST_TIMEOUT_MS = 120_000;
const PART_TIMEOUT_MS = 10 * 60_000;
/** A restore or verification reads a whole object in one request; a large video can take a while. */
const DOWNLOAD_TIMEOUT_MS = 4 * 60 * 60_000;
/** How long a freshly rotated managed key may take to become valid (Frameleaf Cloud FC-33). */
export const CLOUD_BACKUP_FRESH_KEY_MS = 30_000;
const LIST_PAGE = 1000;

const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const md5Base64 = (data: Buffer) => createHash('md5').update(data).digest('base64');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

const RESERVED: Record<string, string> = { '!': '%21', "'": '%27', '(': '%28', ')': '%29', '*': '%2A' };

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves `!'()*` alone). */
const encodeRfc3986 = (value: string) => encodeURIComponent(value).replaceAll(/[!'()*]/g, (char) => RESERVED[char]);

const decodeXml = (value: string) =>
  value
    .replaceAll(/&#x([\da-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replaceAll(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const xmlValues = (xml: string, tag: string) =>
  xml
    .matchAll(new RegExp(String.raw`<${tag}>([\s\S]*?)</${tag}>`, 'g'))
    .map((match) => decodeXml(match[1]))
    .toArray();

const xmlValue = (xml: string, tag: string) => xmlValues(xml, tag)[0] ?? null;

const PROVIDER_ERROR_CODES = [
  'AccessDenied',
  'BadDigest',
  'EntityTooLarge',
  'EntityTooSmall',
  'InternalError',
  'InvalidAccessKeyId',
  'InvalidArgument',
  'InvalidDigest',
  'InvalidPart',
  'InvalidPartOrder',
  'InvalidRequest',
  'NoSuchBucket',
  'NoSuchKey',
  'NoSuchUpload',
  'PermanentRedirect',
  'RequestTimeTooSkewed',
  'RequestTimeout',
  'ServiceUnavailable',
  'SignatureDoesNotMatch',
  'SlowDown',
  'TemporaryRedirect',
] as const;

const providerErrorCode = (code: string | null) => PROVIDER_ERROR_CODES.find((knownCode) => knownCode === code) ?? null;

/** Sanitize only transport reads and cancellation; callers retain their checksum and filesystem errors. */
export const sanitizeProviderResponse = (response: Response, action: string): Response => {
  if (!response.body) {
    return response;
  }
  const reader = response.body.getReader();
  let cancelled = false;
  const readFailure = () =>
    new CloudBackupStoreError(`The storage response could not be read (${action}).`, null, null);
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          if (!cancelled) {
            controller.error(readFailure());
            reader.releaseLock();
          }
          return;
        }
        if (cancelled) {
          return;
        }
        if (chunk.done) {
          controller.close();
          reader.releaseLock();
        } else {
          advanceExecutionProgress(chunk.value.length);
          controller.enqueue(chunk.value);
        }
      },
      async cancel(reason) {
        cancelled = true;
        try {
          await reader.cancel(reason);
        } catch {
          throw readFailure();
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const escapeXml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const amzDates = (now: Date) => {
  const amzDate = now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
};

/**
 * What a provider's refusal means, in words an administrator can act on. The common setup mistakes get
 * their own sentence; anything else is named by its status and code. Never a header, never a key.
 */
export const describeProviderError = (status: number, code: string | null, action: string) => {
  if (code === 'RequestTimeTooSkewed') {
    return 'The storage provider refused the request because this server’s clock is off. Correct the server’s time (for example with NTP) and try again.';
  }
  if (status === 301 || status === 307 || code === 'PermanentRedirect' || code === 'TemporaryRedirect') {
    return 'The bucket is in another region. Use the bucket’s regional endpoint as the storage address, for example https://s3.eu-central-1.amazonaws.com.';
  }
  if (code === 'NoSuchBucket') {
    return 'The storage provider has no bucket by that name.';
  }
  if (code === 'SignatureDoesNotMatch' || code === 'InvalidAccessKeyId') {
    return 'The storage provider refused these credentials. Check the access key ID and secret access key.';
  }
  const safeCode = providerErrorCode(code);
  return `The storage provider refused ${action}: ${status}${safeCode ? ` ${safeCode}` : ''}`;
};

/**
 * AWS Signature Version 4 for S3: the headers to send (without `host`, which `fetch` sets from the URL
 * it was signed for), including `authorization`, `x-amz-date` and `x-amz-content-sha256`. Every header
 * given is signed, the SSE-C ones included.
 */
export const signS3Request = (request: {
  method: string;
  host: string;
  canonicalUri: string;
  query: string;
  headers: Record<string, string>;
  body?: Buffer;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}): Record<string, string> => {
  const { amzDate, dateStamp } = amzDates(request.now);
  const payloadHash = request.body ? sha256Hex(request.body) : EMPTY_SHA256;
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value])),
    host: request.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedNames = Object.keys(headers).toSorted(compareCodeUnits);
  const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name].trim()}\n`).join('');
  const signedHeaders = signedNames.join(';');
  const canonicalRequest = [
    request.method,
    request.canonicalUri,
    request.query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${request.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${request.secretAccessKey}`, dateStamp), request.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const { host: _host, ...sent } = headers;
  sent.authorization = `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return sent;
};

type SignedRequest = {
  method: 'GET' | 'PUT' | 'HEAD' | 'POST' | 'DELETE';
  key?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
};

type ClientUploadState = {
  key: string;
  sha256: string;
  size: number;
  ciphertextSha256: string;
  completed?: { etag: string; versionId?: string };
  uploadId: string | null;
  parts: Part[];
};

type Part = { partNumber: number; etag: string };

@Injectable()
export class CloudBackupStoreRepository {
  /** Waits before the second and third attempt of a request that failed for a transient reason. */
  retryDelaysMs = [1000, 4000];
  /** FL-164: the wait between attempts while a freshly rotated managed key becomes valid. */
  freshKeyRetryMs = 3000;

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(CloudBackupStoreRepository.name);
  }

  /** One page of object names and sizes under a prefix. LIST needs no key. */
  async list(
    connection: CloudBackupConnection,
    prefix: string,
    options: { continuationToken?: string | null; maxKeys?: number } = {},
  ): Promise<{ objects: CloudBackupObjectInfo[]; nextToken: string | null }> {
    const query: Record<string, string> = { 'list-type': '2', 'max-keys': String(options.maxKeys ?? LIST_PAGE) };
    if (prefix) {
      query.prefix = prefix;
    }
    if (options.continuationToken) {
      query['continuation-token'] = options.continuationToken;
    }
    const response = await this.send(connection, { method: 'GET', query });
    const xml = await response.text();
    const objects = xmlValues(xml, 'Contents').map((entry) => ({
      key: xmlValue(entry, 'Key') ?? '',
      size: Number(xmlValue(entry, 'Size') ?? 0),
      etag: xmlValue(entry, 'ETag'),
    }));
    const truncated = xmlValue(xml, 'IsTruncated') === 'true';
    return {
      objects: objects.filter(({ key }) => key !== ''),
      nextToken: truncated ? xmlValue(xml, 'NextContinuationToken') : null,
    };
  }

  /** Every object under a prefix, a page at a time. */
  async listAll(
    connection: CloudBackupConnection,
    prefix: string,
    onPage: (objects: CloudBackupObjectInfo[]) => Promise<void>,
  ): Promise<number> {
    let token: string | null = null;
    let total = 0;
    do {
      const page = await this.list(connection, prefix, { continuationToken: token });
      total += page.objects.length;
      if (page.objects.length > 0) {
        await onPage(page.objects);
      }
      token = page.nextToken;
    } while (token);
    return total;
  }

  /** An object's size and ETag, or null when there is none. */
  async head(connection: CloudBackupConnection, key: string, bucketKey: Buffer): Promise<CloudBackupObjectInfo | null> {
    const response = await this.send(connection, {
      method: 'HEAD',
      key,
      headers: this.objectHeaders(connection, key, bucketKey),
    }).catch((error: unknown) => {
      if (error instanceof CloudBackupStoreError && error.status === 404) {
        return null;
      }
      throw error;
    });
    if (!response) {
      return null;
    }
    const stored = Number(response.headers.get('content-length') ?? 0);
    return {
      key,
      size: clientBackupContext(connection.bucket, key, connection.vaultId) ? clientBackupPlainSize(stored) : stored,
      etag: response.headers.get('etag'),
    };
  }

  /**
   * An object's contents. With `expectedSha256` (every `o/<sha256>` object), what came back must hash to
   * it, or the read is refused.
   */
  async get(
    connection: CloudBackupConnection,
    key: string,
    bucketKey: Buffer,
    expectedSha256?: string,
  ): Promise<Buffer> {
    const response = await this.send(connection, {
      method: 'GET',
      key,
      headers: this.objectHeaders(connection, key, bucketKey),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of this.objectBody(response, connection, key, bucketKey)) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (expectedSha256 && sha256Hex(body) !== expectedSha256) {
      throw new CloudBackupStoreError(
        `The backup copy of ${key} does not match its checksum`,
        null,
        'ChecksumMismatch',
      );
    }
    return body;
  }

  /** Bounded authenticated previews: verify actual bytes before any are returned to the caller. */
  async getPreview(
    connection: CloudBackupConnection,
    key: string,
    bucketKey: Buffer,
    sha256: string,
    expectedSize: number,
  ): Promise<Buffer> {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 8 * 1024 * 1024)
      throw new CloudBackupStoreError('Backup preview exceeds its limit', null, 'PreviewLimit');
    const response = await this.send(connection, {
      method: 'GET',
      key,
      headers: this.objectHeaders(connection, key, bucketKey),
    });
    const body = Readable.from(this.objectBody(response, connection, key, bucketKey));
    const chunks: Buffer[] = [];
    let size = 0;
    const digest = createHash('sha256');
    for await (const value of body) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > expectedSize) {
        body.destroy();
        throw new CloudBackupStoreError('Backup preview size mismatch', null, 'PreviewLimit');
      }
      digest.update(chunk);
      chunks.push(chunk);
    }
    if (size !== expectedSize || digest.digest('hex') !== sha256)
      throw new CloudBackupStoreError('Backup preview integrity check failed', null, 'ChecksumMismatch');
    return Buffer.concat(chunks, size);
  }

  /**
   * FL-164: an object streamed to `destination`, hashed as it arrives. It is written to a partial file
   * beside the destination and moved into place only when it hashes to `expectedSha256` (every `o/<sha256>`
   * object and every dump a manifest names); otherwise the partial file is removed and the read refused
   * (`ChecksumMismatch`). The destination's folder must exist; nothing already at `destination` is read.
   */
  async download(
    connection: CloudBackupConnection,
    key: string,
    bucketKey: Buffer,
    destination: string,
    expectedSha256: string | null,
  ): Promise<{ size: number; sha256: string }> {
    const response = await this.send(connection, {
      method: 'GET',
      key,
      headers: this.objectHeaders(connection, key, bucketKey),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    const partial = `${destination}.part-${randomUUID().slice(0, 8)}`;
    try {
      const { size, sha256 } = await this.hashBody(
        response,
        createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
        connection,
        key,
        bucketKey,
      );
      if (expectedSha256 && sha256 !== expectedSha256) {
        throw new CloudBackupStoreError(
          `The backup copy of ${key} does not match its checksum`,
          null,
          'ChecksumMismatch',
        );
      }
      assertExecutionActive();
      await rename(partial, destination);
      return { size, sha256 };
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  /** FL-164: an object read in full and hashed, never kept: what weekly verification checks. */
  async hashObject(
    connection: CloudBackupConnection,
    key: string,
    bucketKey: Buffer,
  ): Promise<{ size: number; sha256: string }> {
    const response = await this.send(connection, {
      method: 'GET',
      key,
      headers: this.objectHeaders(connection, key, bucketKey),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    return this.hashBody(response, null, connection, key, bucketKey);
  }

  private async hashBody(
    response: Response,
    sink: Writable | null,
    connection: CloudBackupConnection,
    key: string,
    bucketKey: Buffer,
  ) {
    const digest = createHash('sha256');
    let size = 0;
    const body = Readable.from(this.objectBody(response, connection, key, bucketKey));
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        digest.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    // without a sink the bytes are only hashed, and dropped as they arrive
    const discard = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    await pipeline(body, hasher, sink ?? discard, { signal: executionSignal() });
    return { size, sha256: digest.digest('hex') };
  }

  /** One object in one request. Answers the provider's ETag and whether it confirmed SSE-C. */
  async put(
    connection: CloudBackupConnection,
    key: string,
    body: Buffer,
    bucketKey: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<{ etag: string; encrypted: boolean }> {
    if (clientBackupContext(connection.bucket, key, connection.vaultId)) {
      const result = await this.uploadClientStream(connection, key, Readable.from([body]), bucketKey);
      return { etag: result.etag, encrypted: true };
    }
    const response = await this.send(connection, {
      method: 'PUT',
      key,
      body,
      headers: {
        ...sseCustomerHeaders(bucketKey),
        'content-type': contentType,
        'content-md5': md5Base64(body),
      },
    });
    const etag = response.headers.get('etag');
    if (!etag) {
      throw new CloudBackupStoreError(`The storage provider did not confirm ${key}`, response.status, 'MissingETag');
    }
    return {
      etag,
      encrypted: response.headers.get('x-amz-server-side-encryption-customer-algorithm') === 'AES256',
    };
  }

  /**
   * Remove one object. Only ever used on what the agent itself wrote: probes, old database dumps and (FL-164)
   * manifests past retention with the objects no kept manifest names.
   */
  async delete(connection: CloudBackupConnection, key: string): Promise<void> {
    await this.send(connection, { method: 'DELETE', key });
  }

  /**
   * Upload one local file as `key`, which must be `o/<expectedSha256>` or a dump's name. The file is read
   * once and hashed while it goes up; if it does not hash to `expectedSha256` the upload is abandoned
   * (a multipart upload is aborted, never completed) and `CloudBackupFileChangedError` is thrown.
   * Files up to 8 MiB go in one PUT, larger ones in 8 MiB parts. The local file is only read.
   */
  async uploadFile(
    connection: CloudBackupConnection,
    key: string,
    path: string,
    bucketKey: Buffer,
    expectedSha256: string,
  ): Promise<{ etag: string; size: number; versionId?: string; ciphertextSha256?: string }> {
    if (clientBackupContext(connection.bucket, key, connection.vaultId))
      return this.uploadClientFile(connection, key, path, bucketKey, expectedSha256);
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      if (size <= CLOUD_BACKUP_PART_BYTES) {
        const body = await this.readExactly(handle, path, 0, size);
        if (sha256Hex(body) !== expectedSha256) {
          throw new CloudBackupFileChangedError(path);
        }
        const { etag } = await this.put(connection, key, body, bucketKey);
        return { etag, size };
      }

      const digest = createHash('sha256');
      const readParts = async function* (store: CloudBackupStoreRepository) {
        for (let offset = 0; offset < size; offset += CLOUD_BACKUP_PART_BYTES) {
          const part = await store.readExactly(handle, path, offset, Math.min(CLOUD_BACKUP_PART_BYTES, size - offset));
          digest.update(part);
          yield part;
        }
      };
      const etag = await this.multipart(connection, key, bucketKey, 'application/octet-stream', readParts(this), () => {
        if (digest.digest('hex') !== expectedSha256) {
          throw new CloudBackupFileChangedError(path);
        }
      });
      return { etag, size };
    } finally {
      await handle.close();
    }
  }

  /**
   * Upload a stream of unknown length as `key` (a run's gzipped manifest), holding at most one 8 MiB part
   * in memory: one PUT when it all fits in a part, else a multipart upload.
   */
  async uploadStream(
    connection: CloudBackupConnection,
    key: string,
    source: AsyncIterable<Buffer | Uint8Array | string> | Iterable<Buffer | Uint8Array>,
    bucketKey: Buffer,
    contentType: string,
  ): Promise<{ etag: string; size: number; versionId?: string; ciphertextSha256?: string }> {
    if (clientBackupContext(connection.bucket, key, connection.vaultId))
      return this.uploadClientStream(connection, key, source, bucketKey);
    const iterator = this.partsOf(source)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const firstPart = first.done ? Buffer.alloc(0) : first.value;
    const second = first.done ? first : await iterator.next();
    if (second.done) {
      const { etag } = await this.put(connection, key, firstPart, bucketKey, contentType);
      return { etag, size: firstPart.length };
    }

    let size = 0;
    const all = async function* () {
      for (const part of [firstPart, second.value]) {
        size += part.length;
        yield part;
      }
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        size += next.value.length;
        yield next.value;
      }
    };
    const etag = await this.multipart(connection, key, bucketKey, contentType, all());
    return { etag, size };
  }

  private objectHeaders(connection: CloudBackupConnection, key: string, root: Buffer) {
    return clientBackupContext(connection.bucket, key, connection.vaultId) ? {} : sseCustomerHeaders(root);
  }

  private objectRoot(connection: CloudBackupConnection, key: string, root: Buffer) {
    const context = clientBackupContext(connection.bucket, key, connection.vaultId);
    const historical = context && connection.recoveryKeys?.[context.keyVersion];
    if (context && !historical) throw new Error('Missing historical backup key');
    const selected = historical ? Buffer.from(historical, 'base64') : root;
    if (selected.length !== 32) throw new Error('Invalid backup root key');
    return selected;
  }

  private async *objectBody(
    response: Response,
    connection: CloudBackupConnection,
    key: string,
    root: Buffer,
  ): AsyncGenerator<Buffer> {
    const source = response.body
      ? Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>, { signal: executionSignal() })
      : Readable.from([]);
    const context = clientBackupContext(connection.bucket, key, connection.vaultId);
    if (!context) {
      for await (const part of source) yield Buffer.from(part);
      return;
    }
    const trusted = connection.trustedManifests?.[key];
    if (context.kind === 'manifest' && !trusted) {
      source.destroy();
      throw new CloudBackupStoreError(
        'Encrypted manifest needs a trusted local recovery receipt',
        null,
        'ChecksumMismatch',
      );
    }
    const ciphertext = async function* () {
      const digest = createHash('sha256');
      for await (const part of source) {
        digest.update(part);
        yield part as Buffer;
      }
      if (trusted && digest.digest('hex') !== trusted.ciphertextSha256) throw new Error('Snapshot ciphertext mismatch');
    };
    try {
      yield* decryptClientBackup(ciphertext(), this.objectRoot(connection, key, root), context);
    } catch {
      assertExecutionActive();
      throw new CloudBackupStoreError('Encrypted backup authentication failed', null, 'ChecksumMismatch');
    } finally {
      source.destroy();
    }
  }

  /** Raw ciphertext (legacy exports are locally decrypted by SSE-C); no cloud account is needed to read the export. */
  async exportObject(connection: CloudBackupConnection, key: string, root: Buffer, directory: string) {
    await createBuddyDirectory(directory);
    const path = join(directory, sha256Hex(key));
    const response = await this.send(connection, {
      method: 'GET',
      key,
      headers: this.objectHeaders(connection, key, root),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    const hash = createHash('sha256');
    const body = response.body
      ? Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>, { signal: executionSignal() })
      : Readable.from([]);
    const file = await open(path, 'wx', 0o600).catch((error: unknown) => {
      body.destroy();
      throw error;
    });
    try {
      for await (const bytes of body) {
        hash.update(bytes);
        await file.writeFile(bytes);
      }
      const digest = hash.digest('hex');
      const trusted = connection.trustedManifests?.[key];
      if (trusted && trusted.ciphertextSha256 !== digest)
        throw new CloudBackupStoreError('Export snapshot ciphertext mismatch', null, 'ChecksumMismatch');
      await file.sync();
      await flushBuddyDirectory(directory);
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    } finally {
      body.destroy();
      await file.close();
    }
  }

  private async offlineResponse(connection: CloudBackupConnection, request: SignedRequest) {
    if (!request.key || !['GET', 'HEAD'].includes(request.method))
      throw new Error('Offline backup exports are read-only');
    let file: FileHandle;
    try {
      file = await open(
        join(connection.offlineDirectory!, sha256Hex(request.key)),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new CloudBackupStoreError('Exported backup object is missing', 404, 'NoSuchKey');
      throw error;
    }
    const stat = await file.stat();
    if (!stat.isFile()) {
      await file.close();
      throw new Error('Invalid exported backup object');
    }
    if (request.method === 'HEAD') {
      await file.close();
      return new Response(null, { headers: { 'content-length': String(stat.size) } });
    }
    const stream = file.createReadStream({ autoClose: true });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: { 'content-length': String(stat.size) },
    });
  }

  private async saveUpload(path: string, state: ClientUploadState) {
    await writeBuddyFile(path, JSON.stringify(state));
  }

  /** A manifest's completed transport receipt stays durable until its signed history/index commit. */
  async finishClientUpload(connection: CloudBackupConnection, key: string) {
    const stage = this.clientStage(connection, key);
    await rm(`${stage}.json`, { force: true });
    await rm(`${stage}.ciphertext`, { force: true });
    await flushBuddyDirectory(connection.stagingDirectory!);
  }

  private async completedClientObject(connection: CloudBackupConnection, key: string, state: ClientUploadState) {
    const raw = { ...connection, trustedManifests: undefined };
    let head: Response;
    try {
      head = await this.send(raw, { method: 'HEAD', key });
    } catch (error) {
      if (error instanceof CloudBackupStoreError && error.status === 404) return null;
      throw error;
    }
    const versionId = head.headers.get('x-amz-version-id');
    if (key.startsWith('m/v1/') && (!versionId || versionId === 'null')) return null;
    const response = await this.send(raw, {
      method: 'GET',
      key,
      ...(versionId && { query: { versionId } }),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    const hash = createHash('sha256');
    const source = response.body
      ? Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>)
      : Readable.from([]);
    for await (const bytes of source) hash.update(bytes);
    return hash.digest('hex') === state.ciphertextSha256 ? head : null;
  }

  private clientStage(connection: CloudBackupConnection, key: string) {
    if (!connection.stagingDirectory) throw new Error('Client encryption requires durable local staging');
    return join(connection.stagingDirectory, sha256Hex(`${connection.bucket}/${key}`));
  }

  /** Unknown-length manifests are first staged locally (0600); only encrypted bytes leave this server. */
  private async uploadClientStream(
    connection: CloudBackupConnection,
    key: string,
    source: AsyncIterable<Buffer | Uint8Array | string> | Iterable<Buffer | Uint8Array>,
    root: Buffer,
  ) {
    const stage = this.clientStage(connection, key);
    await createBuddyDirectory(connection.stagingDirectory!);
    const plain = `${stage}.${randomUUID()}.plain`;
    try {
      await pipeline(Readable.from(source), createWriteStream(plain, { flags: 'wx', mode: 0o600 }), {
        signal: executionSignal(),
      });
      const hash = createHash('sha256');
      for await (const part of createReadStream(plain)) hash.update(part);
      // A resumed manifest uses its already staged immutable bytes, even if its generated timestamp changed.
      return await this.uploadClientFile(connection, key, plain, root, hash.digest('hex'));
    } finally {
      await rm(plain, { force: true });
    }
  }

  private async uploadClientFile(
    connection: CloudBackupConnection,
    key: string,
    path: string,
    root: Buffer,
    expectedSha256: string,
  ) {
    const context = clientBackupContext(connection.bucket, key, connection.vaultId)!;
    const selected = this.objectRoot(connection, key, root);
    const stage = this.clientStage(connection, key);
    const bytesFile = `${stage}.ciphertext`;
    const stateFile = `${stage}.json`;
    await createBuddyDirectory(connection.stagingDirectory!);
    let state: ClientUploadState | null = await readFile(stateFile, 'utf8')
      .then((value) => {
        if (Buffer.byteLength(value) > 2_000_000) throw new Error('Encrypted upload state is too large');
        return JSON.parse(value) as ClientUploadState;
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
    if (
      state &&
      (state.key !== key ||
        !/^[\da-f]{64}$/.test(state.sha256) ||
        !/^[\da-f]{64}$/.test(state.ciphertextSha256) ||
        !Number.isSafeInteger(state.size) ||
        // eslint-disable-next-line unicorn/no-impossible-length-comparison -- Serialized state is untrusted input.
        state.size < 0 ||
        !Array.isArray(state.parts) ||
        state.parts.length > 10_000 ||
        state.parts.some(
          (part, index) => part.partNumber !== index + 1 || typeof part.etag !== 'string' || part.etag.length > 1024,
        ) ||
        (state.uploadId !== null && (typeof state.uploadId !== 'string' || state.uploadId.length > 1024)) ||
        (context.kind !== 'manifest' && state.sha256 !== expectedSha256))
    )
      throw new Error('Encrypted upload staging identity mismatch');
    if (state?.completed) return { ...state.completed, size: state.size, ciphertextSha256: state.ciphertextSha256 };
    if (!state) {
      const input = await open(path, 'r');
      const temporary = `${stage}.${randomUUID()}.tmp`;
      try {
        const before = await input.stat();
        const digest = createHash('sha256');
        const source = async function* (store: CloudBackupStoreRepository) {
          for (let offset = 0; offset < before.size; offset += CLOUD_BACKUP_PART_BYTES) {
            const part = await store.readExactly(
              input,
              path,
              offset,
              Math.min(CLOUD_BACKUP_PART_BYTES, before.size - offset),
            );
            digest.update(part);
            yield part;
          }
        };
        await pipeline(
          Readable.from(encryptClientBackup(source(this), before.size, selected, context)),
          createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
          { signal: executionSignal() },
        );
        const after = await input.stat();
        if (
          digest.digest('hex') !== expectedSha256 ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new CloudBackupFileChangedError(path);
        const output = await open(temporary, 'r');
        try {
          await output.sync();
        } finally {
          await output.close();
        }
        await rename(temporary, bytesFile);
        const hash = createHash('sha256');
        for await (const part of createReadStream(bytesFile)) hash.update(part);
        state = {
          key,
          sha256: expectedSha256,
          size: before.size,
          ciphertextSha256: hash.digest('hex'),
          uploadId: null,
          parts: [],
        };
        await this.saveUpload(stateFile, state);
      } finally {
        await input.close();
        await rm(temporary, { force: true });
      }
    }
    const ciphertext = await open(bytesFile, 'r');
    try {
      // Verify durable staging on each restart; altered local bytes must not be retried under the saved context.
      const hash = createHash('sha256');
      for await (const part of createReadStream(bytesFile)) hash.update(part);
      if (hash.digest('hex') !== state.ciphertextSha256) throw new Error('Encrypted upload staging is damaged');
      const { size } = await ciphertext.stat();
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2 && !response; attempt++) {
        try {
          if (size <= CLOUD_BACKUP_PART_BYTES) {
            const body = await this.readExactly(ciphertext, bytesFile, 0, size);
            response = await this.send(connection, {
              method: 'PUT',
              key,
              body,
              headers: {
                'content-type': 'application/octet-stream',
                'content-md5': md5Base64(body),
                ...(context.kind === 'manifest' && { 'if-none-match': '*' }),
              },
            });
          } else {
            if (!state.uploadId) {
              const created = await this.send(connection, {
                method: 'POST',
                key,
                query: { uploads: '' },
                headers: { 'content-type': 'application/octet-stream' },
              });
              state.uploadId = xmlValue(await created.text(), 'UploadId');
              if (!state.uploadId)
                throw new CloudBackupStoreError('Provider did not start encrypted upload', created.status, null);
              await this.saveUpload(stateFile, state);
            }
            for (
              let offset = state.parts.length * CLOUD_BACKUP_PART_BYTES;
              offset < size;
              offset += CLOUD_BACKUP_PART_BYTES
            ) {
              const body = await this.readExactly(
                ciphertext,
                bytesFile,
                offset,
                Math.min(CLOUD_BACKUP_PART_BYTES, size - offset),
              );
              const partNumber = state.parts.length + 1;
              const part = await this.send(connection, {
                method: 'PUT',
                key,
                query: { partNumber: String(partNumber), uploadId: state.uploadId },
                body,
                headers: { 'content-md5': md5Base64(body) },
                timeoutMs: PART_TIMEOUT_MS,
              });
              const etag = part.headers.get('etag');
              if (!etag)
                throw new CloudBackupStoreError(
                  'Provider did not confirm encrypted upload part',
                  part.status,
                  'MissingETag',
                );
              state.parts.push({ partNumber, etag });
              await this.saveUpload(stateFile, state);
            }
            const body = Buffer.from(
              `<CompleteMultipartUpload>${state.parts.map(({ partNumber, etag }) => `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`,
            );
            response = await this.send(connection, {
              method: 'POST',
              key,
              query: { uploadId: state.uploadId },
              body,
              headers: {
                'content-type': 'application/xml',
                'content-md5': md5Base64(body),
                ...(context.kind === 'manifest' && { 'if-none-match': '*' }),
              },
              timeoutMs: PART_TIMEOUT_MS,
            });
          }
        } catch (error) {
          if (!(error instanceof CloudBackupStoreError) || (error.code !== 'NoSuchUpload' && error.status !== 412))
            throw error;
          response = (await this.completedClientObject(connection, key, state)) ?? undefined;
          if (!response) {
            if (error.code !== 'NoSuchUpload' || attempt > 0) throw error;
            state.uploadId = null;
            state.parts = [];
            await this.saveUpload(stateFile, state);
          }
        }
      }
      if (!response) throw new Error('Encrypted upload did not complete');
      const answer = await response.text();
      const code = providerErrorCode(xmlValue(answer, 'Code'));
      if (code) throw new CloudBackupStoreError('Provider refused encrypted upload completion', response.status, code);
      const etag = response.headers.get('etag') ?? xmlValue(answer, 'ETag');
      if (!etag)
        throw new CloudBackupStoreError('Provider did not confirm encrypted object', response.status, 'MissingETag');
      const result = {
        etag,
        size: state.size,
        ciphertextSha256: state.ciphertextSha256,
        versionId: response.headers.get('x-amz-version-id') ?? undefined,
      };
      state.completed = { etag: result.etag, ...(result.versionId && { versionId: result.versionId }) };
      await this.saveUpload(stateFile, state);
      if (context.kind !== 'manifest') await this.finishClientUpload(connection, key);
      return result;
    } finally {
      await ciphertext.close();
    }
  }

  /**
   * The capability check behind "Check bucket": the credentials can list the bucket, and the provider
   * accepts and returns a test file encrypted with a customer key (SSE-C), which is then deleted. The
   * throwaway key is random and forgotten. Answers what the bucket holds now.
   */
  async probe(connection: CloudBackupConnection): Promise<{ state: 'empty' | 'claimed' | 'not-empty' }> {
    const { objects } = await this.list(connection, '', { maxKeys: LIST_PAGE });
    const probeKey = `${CLOUD_BACKUP_PROBE_PREFIX}${randomUUID()}`;
    const testKey = randomBytes(32);
    const content = randomBytes(64);
    const { encrypted } = await this.putWithCustomerKey(connection, probeKey, content, testKey);
    try {
      if (!encrypted) {
        throw new CloudBackupClaimError(
          'sse-c-unsupported',
          'This storage provider did not encrypt the test file with a customer-provided key (SSE-C). Frameleaf backups need a provider that supports SSE-C.',
        );
      }
      const back = await this.get(connection, probeKey, testKey);
      if (!back.equals(content)) {
        throw new CloudBackupClaimError(
          'sse-c-unsupported',
          'This storage provider returned a different test file. Frameleaf backups need a provider that supports SSE-C.',
        );
      }
    } finally {
      await this.delete(connection, probeKey).catch((error: unknown) =>
        this.logger.warn(`Could not remove the capability check's test file: ${String(error)}`),
      );
    }

    const others = objects.filter(({ key }) => !key.startsWith(CLOUD_BACKUP_PROBE_PREFIX));
    if (others.some(({ key }) => key === CLOUD_BACKUP_MARKER)) {
      return { state: 'claimed' };
    }
    return { state: others.length === 0 ? 'empty' : 'not-empty' };
  }

  /**
   * Claim the bucket for this server: one bucket per server. An empty bucket gets the root marker with
   * this server's instance id, written with SSE-C (the provider must confirm the encryption) and read
   * back. A bucket already holding this server's marker, readable with this key, is this server's own
   * and stays as it is. Anything else is refused: a marker naming another server, a marker this key
   * cannot read, or any other object.
   */
  async claim(
    connection: CloudBackupConnection,
    bucketKey: Buffer,
    options: { instanceId: string; keyFingerprint: string; now: Date },
  ): Promise<{ existing: boolean; claimedAt: string }> {
    const { objects } = await this.list(connection, '', { maxKeys: LIST_PAGE });
    const keys = objects.map(({ key }) => key).filter((key) => !key.startsWith(CLOUD_BACKUP_PROBE_PREFIX));

    if (keys.includes(CLOUD_BACKUP_MARKER)) {
      const marker = await this.readMarker(connection, bucketKey);
      if (marker.instanceId !== options.instanceId) {
        throw new CloudBackupClaimError(
          'claimed-by-another-server',
          `This bucket already holds ${CLOUD_BACKUP_MARKER} for another Frameleaf server. Each server needs its own bucket.`,
        );
      }
      return { existing: true, claimedAt: marker.claimedAt || options.now.toISOString() };
    }

    if (keys.length > 0) {
      throw new CloudBackupClaimError(
        'not-empty',
        'This bucket already contains other files. Use an empty bucket dedicated to this server.',
      );
    }

    const marker: CloudBackupMarker = {
      format: CLOUD_BACKUP_MARKER_FORMAT,
      version: 1,
      instanceId: options.instanceId,
      keyFingerprint: options.keyFingerprint,
      claimedAt: options.now.toISOString(),
    };
    const { encrypted } = await this.putWithCustomerKey(
      connection,
      CLOUD_BACKUP_MARKER,
      Buffer.from(JSON.stringify(marker)),
      bucketKey,
      'application/json',
    );
    if (!encrypted) {
      // The provider stored it without the customer key: take it away again so the bucket is left as found.
      await this.delete(connection, CLOUD_BACKUP_MARKER).catch(() => false);
      throw new CloudBackupClaimError(
        'sse-c-unsupported',
        'This storage provider does not support customer-provided encryption keys (SSE-C), which Frameleaf backups need.',
      );
    }

    const written = await this.readMarker(connection, bucketKey);
    const after = await this.list(connection, '', { maxKeys: LIST_PAGE });
    const others = after.objects.filter(
      ({ key }) => key !== CLOUD_BACKUP_MARKER && !key.startsWith(CLOUD_BACKUP_PROBE_PREFIX),
    );
    if (written.instanceId !== options.instanceId || others.length > 0) {
      throw new CloudBackupClaimError(
        'not-empty',
        'Something else wrote to this bucket while it was being claimed. Use an empty bucket dedicated to this server.',
      );
    }
    return { existing: false, claimedAt: marker.claimedAt };
  }

  /**
   * The bucket's claim, read with this bucket's key. A marker that is gone (an emptied or recreated
   * bucket) or that this key cannot read is refused, never guessed at.
   */
  async readMarker(connection: CloudBackupConnection, bucketKey: Buffer): Promise<CloudBackupMarker> {
    let body: Buffer;
    try {
      body = await this.get(connection, CLOUD_BACKUP_MARKER, bucketKey);
    } catch (error) {
      if (error instanceof CloudBackupStoreError && error.status === 404) {
        throw new CloudBackupClaimError(
          'claim-missing',
          `This bucket no longer holds ${CLOUD_BACKUP_MARKER}: it was emptied or recreated. Set up cloud backup again to claim it.`,
        );
      }
      if (error instanceof CloudBackupStoreError && error.status !== null && error.status < 500) {
        throw new CloudBackupClaimError(
          'other-key',
          'This bucket was claimed with a different key or by another server. Use the key it was set up with, or an empty bucket.',
        );
      }
      throw error;
    }
    const marker = parseMarker(body);
    if (!marker) {
      throw new CloudBackupClaimError(
        'not-empty',
        `This bucket holds a ${CLOUD_BACKUP_MARKER} that is not a Frameleaf claim. Use an empty bucket dedicated to this server.`,
      );
    }
    return marker;
  }

  /**
   * A PUT with a customer key, the first write a check or a claim makes after listing the bucket. A 403
   * there, with the listing allowed, means the bucket refuses SSE-C (Amazon S3's default for new buckets).
   */
  private async putWithCustomerKey(
    connection: CloudBackupConnection,
    key: string,
    body: Buffer,
    bucketKey: Buffer,
    contentType?: string,
  ) {
    try {
      return await this.put(connection, key, body, bucketKey, contentType);
    } catch (error) {
      if (error instanceof CloudBackupStoreError && error.status === 403) {
        throw new CloudBackupClaimError('sse-c-unsupported', SSE_C_REFUSED_MESSAGE);
      }
      throw error;
    }
  }

  private async readExactly(handle: FileHandle, path: string, offset: number, length: number): Promise<Buffer> {
    const body = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      assertExecutionActive();
      const { bytesRead } = await handle.read(body, read, length - read, offset + read);
      assertExecutionActive();
      advanceExecutionProgress(bytesRead);
      if (bytesRead === 0) {
        throw new CloudBackupFileChangedError(path);
      }
      read += bytesRead;
    }
    return body;
  }

  /** A stream cut into 8 MiB parts (the last one shorter), holding one part in memory at a time. */
  private async *partsOf(
    source: AsyncIterable<Buffer | Uint8Array | string> | Iterable<Buffer | Uint8Array>,
  ): AsyncGenerator<Buffer> {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    for await (const chunk of source) {
      assertExecutionActive();
      let buffer = Buffer.from(chunk);
      while (pendingBytes + buffer.length >= CLOUD_BACKUP_PART_BYTES) {
        const take = CLOUD_BACKUP_PART_BYTES - pendingBytes;
        yield Buffer.concat([...pending, buffer.subarray(0, take)]);
        buffer = buffer.subarray(take);
        pending = [];
        pendingBytes = 0;
      }
      if (buffer.length > 0) {
        pending.push(buffer);
        pendingBytes += buffer.length;
      }
    }
    if (pendingBytes > 0) {
      yield Buffer.concat(pending);
    }
  }

  /**
   * One multipart upload of `parts`, in order, with SSE-C and Content-MD5 on every part. `beforeComplete`
   * may refuse the upload (a file that does not hash to its name); on any failure the upload is aborted,
   * never completed. Answers the object's ETag.
   */
  private async multipart(
    connection: CloudBackupConnection,
    key: string,
    bucketKey: Buffer,
    contentType: string,
    parts: AsyncIterable<Buffer>,
    beforeComplete?: () => void,
  ): Promise<string> {
    const created = await this.send(connection, {
      method: 'POST',
      key,
      query: { uploads: '' },
      headers: { ...sseCustomerHeaders(bucketKey), 'content-type': contentType },
    });
    const uploadId = xmlValue(await created.text(), 'UploadId');
    if (!uploadId) {
      throw new CloudBackupStoreError(`The storage provider did not start an upload for ${key}`, created.status, null);
    }

    try {
      const uploaded: Part[] = [];
      let size = 0;
      for await (const body of parts) {
        const partNumber = uploaded.length + 1;
        const response = await this.send(connection, {
          method: 'PUT',
          key,
          query: { partNumber: String(partNumber), uploadId },
          body,
          headers: { ...sseCustomerHeaders(bucketKey), 'content-md5': md5Base64(body) },
          timeoutMs: PART_TIMEOUT_MS,
        });
        const etag = response.headers.get('etag');
        if (!etag) {
          throw new CloudBackupStoreError(
            `The storage provider did not confirm part ${partNumber} of ${key}`,
            null,
            null,
          );
        }
        advanceExecutionProgress(body.length);
        uploaded.push({ partNumber, etag });
        size += body.length;
      }
      assertExecutionActive();
      beforeComplete?.();
      return await this.complete(connection, key, uploadId, uploaded, bucketKey, size);
    } catch (error) {
      await withExecutionCleanup(() => this.send(connection, { method: 'DELETE', key, query: { uploadId } })).catch(
        (abortError: unknown) =>
          this.logger.warn(`Could not abandon the unfinished upload of ${key}: ${String(abortError)}`),
      );
      throw error;
    }
  }

  /**
   * CompleteMultipartUpload. When a retried completion finds the upload gone (`NoSuchUpload`), the first
   * attempt may have finished with its answer lost: the object is looked at before this counts as a
   * failure, and accepted only when it is there with the size that was uploaded.
   */
  private async complete(
    connection: CloudBackupConnection,
    key: string,
    uploadId: string,
    parts: Part[],
    bucketKey: Buffer,
    size: number,
  ): Promise<string> {
    const manifest = Buffer.from(
      `<CompleteMultipartUpload>${parts
        .map(
          ({ partNumber, etag }) =>
            `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
        )
        .join('')}</CompleteMultipartUpload>`,
    );
    try {
      const completed = await this.send(connection, {
        method: 'POST',
        key,
        query: { uploadId },
        body: manifest,
        headers: {
          ...sseCustomerHeaders(bucketKey),
          'content-type': 'application/xml',
          'content-md5': md5Base64(manifest),
        },
        timeoutMs: PART_TIMEOUT_MS,
      });
      const xml = await completed.text();
      const { status } = completed;
      const etag = xmlValue(xml, 'ETag') ?? completed.headers.get('etag');
      // CompleteMultipartUpload can answer 200 with an error in the body.
      const rawCode = xmlValue(xml, 'Code');
      if (rawCode) {
        const code = providerErrorCode(rawCode);
        throw new CloudBackupStoreError(
          `The storage provider refused to finish ${key}${code ? ` (${code})` : ''}`,
          status,
          code,
        );
      }
      if (!etag) {
        throw new CloudBackupStoreError(`The storage provider did not confirm ${key}`, status, 'MissingETag');
      }
      return etag;
    } catch (error) {
      if (!(error instanceof CloudBackupStoreError) || error.code !== 'NoSuchUpload') {
        throw error;
      }
      const object = await this.head(connection, key, bucketKey);
      if (object?.etag && object.size === size) {
        return object.etag;
      }
      throw error;
    }
  }

  /**
   * Sign and send one request, retrying twice on a network failure, 429 or 5xx. FL-164: with a freshly
   * rotated managed key, a `403 InvalidAccessKeyId` is retried every few seconds until the key is valid or
   * `freshKeyUntil` passes.
   */
  private async send(connection: CloudBackupConnection, request: SignedRequest): Promise<Response> {
    if (connection.offlineDirectory) return this.offlineResponse(connection, request);
    const trusted = request.key && connection.trustedManifests?.[request.key];
    if (trusted && ['GET', 'HEAD'].includes(request.method))
      request = { ...request, query: { ...request.query, versionId: trusted.versionId } };
    while (true) {
      try {
        return await this.sendWithRetries(connection, request);
      } catch (error) {
        const waiting =
          error instanceof CloudBackupStoreError &&
          error.status === 403 &&
          error.code === 'InvalidAccessKeyId' &&
          !!connection.freshKeyUntil &&
          Date.now() + this.freshKeyRetryMs <= connection.freshKeyUntil;
        if (!waiting) {
          throw error;
        }
        await executionDelay(this.freshKeyRetryMs);
      }
    }
  }

  private async sendWithRetries(connection: CloudBackupConnection, request: SignedRequest): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        await executionDelay(this.retryDelaysMs[attempt - 1]);
      }
      try {
        return await this.sendOnce(connection, request);
      } catch (error) {
        assertExecutionActive();
        lastError = error;
        const transient =
          !(error instanceof CloudBackupStoreError) ||
          error.status === null ||
          error.status === 429 ||
          error.status >= 500;
        if (!transient) {
          throw error;
        }
      }
    }
    throw lastError instanceof CloudBackupStoreError
      ? lastError
      : new CloudBackupStoreError(
          `The storage provider could not be reached (${request.method} ${request.key ?? connection.bucket}).`,
          null,
          null,
        );
  }

  private async sendOnce(connection: CloudBackupConnection, request: SignedRequest): Promise<Response> {
    assertExecutionActive();
    const endpoint = new URL(connection.endpoint);
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    const objectPath = request.key
      ? `/${request.key
          .split('/')
          .map((part) => encodeRfc3986(part))
          .join('/')}`
      : '/';
    const canonicalUri = `${basePath}/${encodeRfc3986(connection.bucket)}${objectPath}`;
    const query = Object.entries(request.query ?? {})
      .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
      .toSorted(([a, aValue], [b, bValue]) => compareCodeUnits(a, b) || compareCodeUnits(aValue, bValue))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');

    const sent = signS3Request({
      method: request.method,
      host: endpoint.host,
      canonicalUri,
      query,
      headers: request.headers ?? {},
      body: request.body,
      region: connection.region,
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey,
      now: new Date(),
    });

    const url = `${endpoint.origin}${canonicalUri}${query ? `?${query}` : ''}`;
    const action = `${request.method} ${request.key ?? connection.bucket}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: sent,
        body: request.body ? new Uint8Array(request.body) : undefined,
        // a signed request is never replayed at another address
        redirect: 'manual',
        signal: executionTimeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch {
      assertExecutionActive();
      throw new CloudBackupStoreError(`The storage provider could not be reached (${action}).`, null, null);
    }

    if (!response.ok) {
      const body = request.method === 'HEAD' ? '' : await response.text().catch(() => '');
      const code = providerErrorCode(xmlValue(body, 'Code'));
      throw new CloudBackupStoreError(describeProviderError(response.status, code, action), response.status, code);
    }
    return sanitizeProviderResponse(response, action);
  }
}

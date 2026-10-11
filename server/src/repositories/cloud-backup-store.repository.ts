import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { type FileHandle, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { BackupTransferJournal } from 'src/utils/cloud-backup-transfer.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
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
import { type BackupCredentials, ManagedBackupAuthorizationError } from 'src/utils/managed-backup-session.js';

/**
 * Cloud backup storage (FL-160): the S3 API calls the backup agent makes, signed with AWS Signature
 * Version 4 over Node's own `fetch` and `crypto`. No SDK and no extra binaries are in the image; SSE-C
 * needs the S3 API directly, and every provider the agent supports (Wasabi, and any SSE-C-capable S3
 * store for your own bucket) speaks it.
 *
 * - **SSE-C on every object call.** PUT, GET, HEAD, UploadPart and CompleteMultipartUpload (and
 *   CreateMultipartUpload) carry the customer-key headers; only LIST, DELETE and AbortMultipartUpload,
 *   which never touch an object's contents, go without. The key is never logged: requests are logged by
 *   method and object name only, and a provider's error is reported by its status and code.
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
  sessionToken?: string;
  managedCredentials?: (failedAccessKeyId?: string) => Promise<BackupCredentials>;
  transfer?: BackupTransferJournal;
  /**
   * FL-164, Frameleaf-managed storage: a key rotated moments ago can take a few seconds to become valid, so
   * until this time (epoch ms) a `403 InvalidAccessKeyId` is waited out and retried rather than reported.
   */
  freshKeyUntil?: number;
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
    readonly accessKeyId?: string,
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
  'ExpiredToken',
  'InvalidToken',
  'RequestExpired',
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
  sessionToken?: string;
}): Record<string, string> => {
  const { amzDate, dateStamp } = amzDates(request.now);
  const payloadHash = request.body ? sha256Hex(request.body) : EMPTY_SHA256;
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value])),
    host: request.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(request.sessionToken && { 'x-amz-security-token': request.sessionToken }),
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
  retry?: boolean;
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
      headers: sseCustomerHeaders(bucketKey),
    }).catch((error: unknown) => {
      if (error instanceof CloudBackupStoreError && error.status === 404) {
        return null;
      }
      throw error;
    });
    if (!response) {
      return null;
    }
    return { key, size: Number(response.headers.get('content-length') ?? 0), etag: response.headers.get('etag') };
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
    const response = await this.send(connection, { method: 'GET', key, headers: sseCustomerHeaders(bucketKey) });
    const body = Buffer.from(await response.arrayBuffer());
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
    const response = await this.send(connection, { method: 'GET', key, headers: sseCustomerHeaders(bucketKey) });
    const body = response.body
      ? Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>)
      : Readable.from([]);
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
    if (connection.transfer) return this.downloadResumable(connection, key, bucketKey, destination, expectedSha256);
    const response = await this.send(connection, {
      method: 'GET',
      key,
      headers: sseCustomerHeaders(bucketKey),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    const partial = `${destination}.part-${randomUUID().slice(0, 8)}`;
    try {
      const { size, sha256 } = await this.hashBody(response, createWriteStream(partial, { flags: 'wx' }));
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

  private async downloadResumable(
    connection: CloudBackupConnection,
    key: string,
    bucketKey: Buffer,
    destination: string,
    expectedSha256: string | null,
  ): Promise<{ size: number; sha256: string }> {
    const journal = connection.transfer!;
    const partial = join(
      dirname(destination),
      `.frameleaf-part-${sha256Hex(`${journal.directory}:${key}:${expectedSha256}`)}`,
    );
    const previous = journal.current;
    let state = previous?.kind === 'download' && previous.key === key ? previous : null;
    const object = await this.head(connection, key, bucketKey);
    // eslint-disable-next-line unicorn/no-impossible-length-comparison -- Size comes from an untrusted HTTP header.
    if (!object?.etag || !Number.isSafeInteger(object.size) || object.size < 0)
      throw new CloudBackupStoreError('The backup download has no stable object identity.', 404, 'NoSuchKey');
    if (
      state &&
      (state.partial !== partial ||
        state.etag !== object.etag ||
        state.size !== object.size ||
        state.expectedSha256 !== expectedSha256)
    )
      throw new CloudBackupStoreError('The backup object changed during its download.', null, 'ChecksumMismatch');
    state ??= {
      kind: 'download',
      key,
      partial,
      expectedSha256,
      etag: object.etag,
      size: object.size,
      offset: 0,
      completed: null,
    };
    const hashFile = async (file: FileHandle) => {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== state.size)
        throw new CloudBackupStoreError('The completed download is unavailable.', null, 'ChecksumMismatch');
      const digest = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      for (let offset = 0; offset < state.size;) {
        assertExecutionActive();
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, state.size - offset), offset);
        if (!bytesRead) throw new CloudBackupStoreError('The partial download ended early.', null, 'ChecksumMismatch');
        digest.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      return digest.digest('hex');
    };
    // Persist ownership before creating the file, so a crash cannot strand an unowned partial.
    await journal.save(state);
    let handle: FileHandle;
    try {
      handle = await open(partial, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (state.completed && state.offset === state.size && dirname(state.completed.path) === dirname(destination)) {
        const finished = await open(state.completed.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          },
        );
        if (finished) {
          let sha256: string;
          try {
            sha256 = await hashFile(finished);
          } finally {
            await finished.close();
          }
          if (sha256 !== state.completed.sha256 || (expectedSha256 && sha256 !== expectedSha256))
            throw new CloudBackupStoreError('The completed download changed.', null, 'ChecksumMismatch');
          assertExecutionActive();
          if (state.completed.path !== destination) await rename(state.completed.path, destination);
          await journal.save(null);
          return { size: state.size, sha256 };
        }
        // A restore caller may have cleaned its unpublished stage; replay only this object.
        state.offset = 0;
        state.completed = null;
        await journal.save(state);
      }
      if (state.offset !== 0) throw error;
      handle = await open(
        partial,
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    }
    let ready = false;
    let sha256: string;
    const save = async () => {
      await handle.sync();
      await journal.save(state);
    };
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < state.offset)
        throw new CloudBackupStoreError('The partial backup download is unavailable.', null, 'ChecksumMismatch');
      await handle.truncate(state.offset);
      await save();
      for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
        try {
          if (state.offset < state.size || state.size === 0) {
            const start = state.offset;
            const response = await this.send(connection, {
              method: 'GET',
              key,
              headers: {
                ...sseCustomerHeaders(bucketKey),
                'if-match': state.etag,
                ...(start > 0 && { range: `bytes=${start}-` }),
              },
              timeoutMs: DOWNLOAD_TIMEOUT_MS,
            });
            if (
              start > 0
                ? response.status !== 206 ||
                  response.headers.get('content-range') !== `bytes ${start}-${state.size - 1}/${state.size}`
                : response.status !== 200
            ) {
              await response.body?.cancel();
              throw new CloudBackupStoreError(
                'The storage provider refused a consistent ranged download.',
                null,
                'ChecksumMismatch',
              );
            }
            let savedAt = state.offset;
            const body = response.body
              ? Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>)
              : Readable.from([]);
            for await (const value of body) {
              assertExecutionActive();
              const chunk = Buffer.from(value);
              if (state.offset + chunk.length > state.size)
                throw new CloudBackupStoreError('Backup download size mismatch.', null, 'ChecksumMismatch');
              let written = 0;
              while (written < chunk.length) {
                const { bytesWritten } = await handle.write(chunk, written, chunk.length - written, state.offset);
                if (bytesWritten === 0) throw new Error('Could not write the partial backup download.');
                written += bytesWritten;
                state.offset += bytesWritten;
              }
              if (state.offset - savedAt >= CLOUD_BACKUP_PART_BYTES) {
                await save();
                savedAt = state.offset;
              }
            }
            if (state.offset !== state.size)
              throw new CloudBackupStoreError('The backup download ended early.', null, null);
            await save();
          }
          ready = true;
          break;
        } catch (error) {
          if (!(error instanceof CloudBackupStoreError) || error.status !== null || error.code === 'ChecksumMismatch')
            throw error;
          await save();
          if (attempt === this.retryDelaysMs.length) throw error;
          await executionDelay(this.retryDelaysMs[attempt]);
        }
      }
      sha256 = await hashFile(handle);
      if (expectedSha256 && expectedSha256 !== sha256)
        throw new CloudBackupStoreError('The backup download does not match its checksum.', null, 'ChecksumMismatch');
      state.completed = { path: destination, sha256 };
      await save();
    } catch (error) {
      if (error instanceof CloudBackupStoreError && error.code === 'ChecksumMismatch') {
        await rm(partial, { force: true });
        await journal.save(null);
      }
      throw error;
    } finally {
      await handle.close();
    }
    assertExecutionActive();
    if (!ready) throw new CloudBackupStoreError('The backup download stopped before completion.', null, null);
    await rename(partial, destination);
    await journal.save(null);
    return { size: state.size, sha256 };
  }

  /** FL-164: an object read in full and hashed, never kept: what weekly verification checks. */
  async hashObject(
    connection: CloudBackupConnection,
    key: string,
    bucketKey: Buffer,
  ): Promise<{ size: number; sha256: string }> {
    if (connection.transfer) {
      await mkdir(connection.transfer.directory, { recursive: true, mode: 0o700 });
      const target = join(connection.transfer.directory, `verify-${sha256Hex(key)}`);
      const result = await this.download(connection, key, bucketKey, target, null);
      await rm(target, { force: true });
      return result;
    }
    const response = await this.send(connection, {
      method: 'GET',
      key,
      headers: sseCustomerHeaders(bucketKey),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    return this.hashBody(response, null);
  }

  private async hashBody(response: Response, sink: Writable | null) {
    const digest = createHash('sha256');
    let size = 0;
    const body = response.body
      ? Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>)
      : Readable.from([]);
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
  ): Promise<{ etag: string; size: number }> {
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      const { size } = stat;
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
      const etag = await this.multipart(
        connection,
        key,
        bucketKey,
        'application/octet-stream',
        readParts(this),
        () => {
          if (digest.digest('hex') !== expectedSha256) throw new CloudBackupFileChangedError(path);
        },
        { source: path, sourceStamp: `${stat.dev}:${stat.ino}:${size}:${stat.mtimeMs}`, expectedSha256 },
      );
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
  ): Promise<{ etag: string; size: number }> {
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
   * may refuse the upload (a file that does not hash to its name). Managed transfers retain a receipt
   * after interruption; other failures abort the upload. Answers the object's ETag.
   */
  private async multipart(
    connection: CloudBackupConnection,
    key: string,
    bucketKey: Buffer,
    contentType: string,
    parts: AsyncIterable<Buffer>,
    beforeComplete?: () => void,
    identity?: { source: string | null; sourceStamp: string | null; expectedSha256: string | null },
  ): Promise<string> {
    identity ??= { source: null, sourceStamp: null, expectedSha256: null };
    const journal = connection.transfer;
    let state = journal?.current?.kind === 'upload' ? journal.current : null;
    if (
      state &&
      (state.key !== key ||
        state.sourceStamp !== identity.sourceStamp ||
        state.expectedSha256 !== identity.expectedSha256)
    ) {
      if (state.uploadId)
        await this.send(connection, { method: 'DELETE', key: state.key, query: { uploadId: state.uploadId } });
      await journal!.save(null);
      state = null;
    }
    state ??= { kind: 'upload', key, ...identity, uploadId: null, previousUploads: [], parts: [], completing: false };
    const save = async () => {
      if (journal) await journal.save(state);
    };
    const uploaded: Array<Part & { size: number; sha256: string }> = [];
    try {
      if (!state.uploadId) {
        if (journal) {
          const prior = await this.multipartUploads(connection, key);
          if (journal.current?.kind === 'upload') {
            const candidates = prior.filter((id) => !state!.previousUploads.includes(id));
            if (candidates.length > 1)
              throw new CloudBackupStoreError('An interrupted upload needs reconciliation.', null, null);
            state.uploadId = candidates[0] ?? null;
          } else {
            state.previousUploads = prior;
            await save();
          }
        }
        if (!state.uploadId) {
          try {
            const created = await this.send(connection, {
              method: 'POST',
              key,
              query: { uploads: '' },
              headers: { ...sseCustomerHeaders(bucketKey), 'content-type': contentType },
              retry: !journal,
            });
            state.uploadId = xmlValue(await created.text(), 'UploadId');
          } catch (error) {
            if (!journal || !(error instanceof CloudBackupStoreError) || (error.status !== null && error.status < 500))
              throw error;
            const candidates = (await this.multipartUploads(connection, key)).filter(
              (id) => !state!.previousUploads.includes(id),
            );
            if (candidates.length !== 1) throw error;
            state.uploadId = candidates[0];
          }
          if (!state.uploadId)
            throw new CloudBackupStoreError('The storage provider did not confirm the multipart upload.', null, null);
        }
        await save();
      }
      const uploadId = state.uploadId;
      const found = journal
        ? await this.multipartParts(connection, key, uploadId).catch((error: unknown) => {
            if (state!.completing && error instanceof CloudBackupStoreError && error.code === 'NoSuchUpload')
              return state!.parts;
            throw error;
          })
        : [];
      let size = 0;
      const receipts = state.parts;
      for await (const body of parts) {
        const partNumber = uploaded.length + 1;
        if (partNumber > 10_000)
          throw new CloudBackupStoreError('The backup object exceeds the multipart limit.', null, null);
        const sha256 = sha256Hex(body);
        const saved = receipts[partNumber - 1];
        const remote = found.find((part) => part.partNumber === partNumber);
        let etag: string;
        if (
          saved &&
          remote &&
          saved.etag === remote.etag &&
          saved.size === body.length &&
          remote.size === body.length &&
          saved.sha256 === sha256
        ) {
          etag = saved.etag;
        } else {
          const response = await this.send(connection, {
            method: 'PUT',
            key,
            query: { partNumber: String(partNumber), uploadId },
            body,
            headers: { ...sseCustomerHeaders(bucketKey), 'content-md5': md5Base64(body) },
            timeoutMs: PART_TIMEOUT_MS,
          });
          const confirmed = response.headers.get('etag');
          if (!confirmed)
            throw new CloudBackupStoreError('The storage provider did not confirm an uploaded part.', null, null);
          etag = confirmed;
        }
        uploaded.push({ partNumber, etag, size: body.length, sha256 });
        size += body.length;
        advanceExecutionProgress(body.length);
        state.parts = [...uploaded, ...receipts.slice(uploaded.length)];
        await save();
      }
      assertExecutionActive();
      beforeComplete?.();
      state.completing = true;
      await save();
      const etag = await this.complete(connection, key, uploadId, uploaded, bucketKey, size);
      if (journal) await journal.save(null);
      return etag;
    } catch (error) {
      if ((!journal || error instanceof CloudBackupFileChangedError) && state.uploadId) {
        await withExecutionCleanup(() =>
          this.send(connection, { method: 'DELETE', key, query: { uploadId: state!.uploadId! } }),
        ).catch(() => this.logger.warn('Could not abandon the unfinished upload.'));
        if (journal) await journal.save(null);
      }
      throw error;
    }
  }

  private async multipartUploads(connection: CloudBackupConnection, key: string): Promise<string[]> {
    const response = await this.send(connection, { method: 'GET', query: { uploads: '', prefix: key } });
    const xml = await response.text();
    if (xmlValue(xml, 'IsTruncated') === 'true')
      throw new CloudBackupStoreError('Too many incomplete uploads to reconcile safely.', null, null);
    return xmlValues(xml, 'Upload')
      .filter((entry) => xmlValue(entry, 'Key') === key)
      .flatMap((entry) => xmlValue(entry, 'UploadId') ?? []);
  }

  private async multipartParts(connection: CloudBackupConnection, key: string, uploadId: string) {
    const parts: Array<Part & { size: number }> = [];
    let marker = '';
    do {
      const response = await this.send(connection, {
        method: 'GET',
        key,
        query: { uploadId, ...(marker && { 'part-number-marker': marker }) },
      });
      const xml = await response.text();
      parts.push(
        ...xmlValues(xml, 'Part').map((part) => ({
          partNumber: Number(xmlValue(part, 'PartNumber')),
          size: Number(xmlValue(part, 'Size')),
          etag: xmlValue(part, 'ETag') ?? '',
        })),
      );
      const next = xmlValue(xml, 'IsTruncated') === 'true' ? xmlValue(xml, 'NextPartNumberMarker') : '';
      if ((next === marker && next) || parts.length > 10_000)
        throw new CloudBackupStoreError('Invalid multipart listing.', null, null);
      marker = next ?? '';
    } while (marker);
    return parts;
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
    let renewed = false;
    while (true) {
      try {
        return await this.sendWithRetries(connection, request);
      } catch (error) {
        if (
          connection.managedCredentials &&
          error instanceof CloudBackupStoreError &&
          ['ExpiredToken', 'InvalidToken', 'RequestExpired'].includes(error.code ?? '') &&
          !renewed
        ) {
          renewed = true;
          await connection.managedCredentials(error.accessKeyId ?? connection.accessKeyId);
          continue;
        }
        if (
          connection.managedCredentials &&
          error instanceof CloudBackupStoreError &&
          (error.status === 401 ||
            error.status === 403 ||
            (request.method === 'HEAD' && error.status === 400) ||
            ['ExpiredToken', 'InvalidToken', 'RequestExpired'].includes(error.code ?? ''))
        ) {
          throw new ManagedBackupAuthorizationError('The storage provider refused this backup capability.');
        }
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
    for (let attempt = 0; attempt <= (request.retry === false ? 0 : this.retryDelaysMs.length); attempt++) {
      if (attempt > 0) {
        await executionDelay(this.retryDelaysMs[attempt - 1]);
      }
      try {
        return await this.sendOnce(connection, request);
      } catch (error) {
        assertExecutionActive();
        if (error instanceof ManagedBackupAuthorizationError) throw error;
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

    const credentials = connection.managedCredentials ? await connection.managedCredentials() : connection;
    // The pair kept for legacy callers is replaced together; each signed request captures a full session.
    Object.assign(connection, credentials);
    const sent = signS3Request({
      method: request.method,
      host: endpoint.host,
      canonicalUri,
      query,
      headers: request.headers ?? {},
      body: request.body,
      region: connection.region,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
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
      throw new CloudBackupStoreError(
        describeProviderError(response.status, code, action),
        response.status,
        code,
        credentials.accessKeyId,
      );
    }
    return sanitizeProviderResponse(response, action);
  }
}

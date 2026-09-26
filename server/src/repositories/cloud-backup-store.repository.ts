import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { type FileHandle, open } from 'node:fs/promises';
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
 */

export type CloudBackupConnection = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type CloudBackupObjectInfo = { key: string; size: number; etag: string | null };

export type CloudBackupClaimRefusal = 'claimed-by-another-server' | 'other-key' | 'not-empty' | 'sse-c-unsupported';

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

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const REQUEST_TIMEOUT_MS = 120_000;
const PART_TIMEOUT_MS = 10 * 60_000;
const LIST_PAGE = 1000;

const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const md5Base64 = (data: Buffer) => createHash('md5').update(data).digest('base64');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

const RESERVED: Record<string, string> = { '!': '%21', "'": '%27', '(': '%28', ')': '%29', '*': '%2A' };

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves `!'()*` alone). */
const encodeRfc3986 = (value: string) => encodeURIComponent(value).replaceAll(/[!'()*]/g, (char) => RESERVED[char]);

/** Byte order, which SigV4's canonical request needs (never locale order). */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const decodeXml = (value: string) =>
  value
    .replaceAll(/&#x([\da-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replaceAll(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const xmlValues = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) => decodeXml(match[1]));

const xmlValue = (xml: string, tag: string) => xmlValues(xml, tag)[0] ?? null;

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
  const signedNames = Object.keys(headers).toSorted(byCodeUnit);
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

@Injectable()
export class CloudBackupStoreRepository {
  /** Waits before the second and third attempt of a request that failed for a transient reason. */
  retryDelaysMs = [1000, 4000];

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

  /** Remove one object. Only ever used on what the agent itself wrote: probes and old database dumps. */
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
      const { size } = await handle.stat();
      if (size <= CLOUD_BACKUP_PART_BYTES) {
        const body = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await handle.read(body, offset, size - offset, offset);
          if (bytesRead === 0) {
            throw new CloudBackupFileChangedError(path);
          }
          offset += bytesRead;
        }
        if (sha256Hex(body) !== expectedSha256) {
          throw new CloudBackupFileChangedError(path);
        }
        const { etag } = await this.put(connection, key, body, bucketKey);
        return { etag, size };
      }

      return await this.uploadParts(connection, key, path, handle, size, bucketKey, expectedSha256);
    } finally {
      await handle.close();
    }
  }

  private async uploadParts(
    connection: CloudBackupConnection,
    key: string,
    path: string,
    handle: FileHandle,
    size: number,
    bucketKey: Buffer,
    expectedSha256: string,
  ): Promise<{ etag: string; size: number }> {
    const created = await this.send(connection, {
      method: 'POST',
      key,
      query: { uploads: '' },
      headers: { ...sseCustomerHeaders(bucketKey), 'content-type': 'application/octet-stream' },
    });
    const uploadId = xmlValue(await created.text(), 'UploadId');
    if (!uploadId) {
      throw new CloudBackupStoreError(`The storage provider did not start an upload for ${key}`, created.status, null);
    }

    try {
      const digest = createHash('sha256');
      const parts: Array<{ partNumber: number; etag: string }> = [];
      let offset = 0;
      for (let partNumber = 1; offset < size; partNumber++) {
        const length = Math.min(CLOUD_BACKUP_PART_BYTES, size - offset);
        const body = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(body, read, length - read, offset + read);
          if (bytesRead === 0) {
            throw new CloudBackupFileChangedError(path);
          }
          read += bytesRead;
        }
        digest.update(body);
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
        parts.push({ partNumber, etag });
        offset += length;
      }

      if (digest.digest('hex') !== expectedSha256) {
        throw new CloudBackupFileChangedError(path);
      }

      const manifest = Buffer.from(
        `<CompleteMultipartUpload>${parts
          .map(
            ({ partNumber, etag }) =>
              `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
          )
          .join('')}</CompleteMultipartUpload>`,
      );
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
      // CompleteMultipartUpload can answer 200 with an error in the body.
      const xml = await completed.text();
      const code = xmlValue(xml, 'Code');
      if (code) {
        throw new CloudBackupStoreError(
          `The storage provider refused to finish ${key} (${code})`,
          completed.status,
          code,
        );
      }
      const etag = xmlValue(xml, 'ETag') ?? completed.headers.get('etag');
      if (!etag) {
        throw new CloudBackupStoreError(`The storage provider did not confirm ${key}`, completed.status, 'MissingETag');
      }
      return { etag, size };
    } catch (error) {
      await this.send(connection, { method: 'DELETE', key, query: { uploadId } }).catch((abortError: unknown) =>
        this.logger.warn(`Could not abandon the unfinished upload of ${key}: ${String(abortError)}`),
      );
      throw error;
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
    const { encrypted } = await this.put(connection, probeKey, content, testKey);
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
    const { encrypted } = await this.put(
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

  private async readMarker(connection: CloudBackupConnection, bucketKey: Buffer): Promise<CloudBackupMarker> {
    let body: Buffer;
    try {
      body = await this.get(connection, CLOUD_BACKUP_MARKER, bucketKey);
    } catch (error) {
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

  /** Sign and send one request, retrying twice on a network failure, 429 or 5xx. */
  private async send(connection: CloudBackupConnection, request: SignedRequest): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelaysMs[attempt - 1]));
      }
      try {
        return await this.sendOnce(connection, request);
      } catch (error) {
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
      : new CloudBackupStoreError(`The storage provider could not be reached: ${String(lastError)}`, null, null);
  }

  private async sendOnce(connection: CloudBackupConnection, request: SignedRequest): Promise<Response> {
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
      .toSorted(([a, aValue], [b, bValue]) => byCodeUnit(a, b) || byCodeUnit(aValue, bValue))
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
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: sent,
        body: request.body ? new Uint8Array(request.body) : undefined,
        signal: AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CloudBackupStoreError(
        `The storage provider could not be reached (${request.method} ${request.key ?? connection.bucket}): ${error instanceof Error ? error.message : String(error)}`,
        null,
        null,
      );
    }

    if (!response.ok) {
      const body = request.method === 'HEAD' ? '' : await response.text().catch(() => '');
      const code = xmlValue(body, 'Code');
      throw new CloudBackupStoreError(
        `The storage provider refused ${request.method} ${request.key ?? connection.bucket}: ${response.status}${code ? ` ${code}` : ''}`,
        response.status,
        code,
      );
    }
    return response;
  }
}

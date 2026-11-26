import { type Store, dirStore, s3Store, signS3Request } from '@frameleaf/backup-core';
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type Response as StorageResponse, fetch } from 'undici';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { vaultPrefix } from 'src/utils/cloud-backup-vault.js';
import {
  CLOUD_BACKUP_MARKER,
  CLOUD_BACKUP_MARKER_FORMAT,
  CLOUD_BACKUP_PROBE_PREFIX,
  CloudBackupMarker,
  parseMarker,
} from 'src/utils/cloud-backup.js';
import { compareCodeUnits } from 'src/utils/compare.js';
import {
  advanceExecutionProgress,
  assertExecutionActive,
  executionDelay,
  executionTimeout,
  withExecutionCleanup,
} from 'src/utils/execution-signal.js';
import { type BackupCredentials, ManagedBackupAuthorizationError } from 'src/utils/managed-backup-session.js';

/**
 * Cloud backup's bucket (FL-160, FL-1676). The backups themselves are a repository of the backup engine
 * under `r/v1/<vault id>/`, which the engine reads and writes through `store()`; every object in it is
 * encrypted on this server before it leaves. What this class does itself is the little that sits beside the
 * repository: checking that a bucket can be used, and the claim that ties one bucket to one server
 * (`frameleaf-backup.json`, which names the server and holds nothing secret).
 *
 * - Requests are signed with AWS Signature Version 4 over Undici's `fetch`. No SDK and no extra binaries are
 *   in the image. Requests log method and object name, never keys or payloads.
 * - A bucket must keep object versions (`versioning-off` otherwise): each backup's signed record names the
 *   exact version of what it stored.
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
  /** Frameleaf-managed storage: the session renewed in memory for one operation. */
  managedCredentials?: (failedAccessKeyId?: string) => Promise<BackupCredentials>;
  /**
   * FL-164, Frameleaf-managed storage: a key rotated moments ago can take a few seconds to become valid, so
   * until this time (epoch ms) a `403 InvalidAccessKeyId` is waited out and retried rather than reported.
   */
  freshKeyUntil?: number;
  /**
   * Frameleaf-managed storage, a clean-up only: the session that may delete. The run's own session may
   * write and never delete, and this one may delete and never write, so a clean-up holds both.
   */
  managedDeleteCredentials?: (failedAccessKeyId?: string) => Promise<BackupCredentials>;
  /** Upload speed limit in bytes per second, or null for none. Read as an upload goes. */
  uploadLimit?: () => number | null;
  /** Local encryption and recovery authority below; none of it is ever sent in a storage request. */
  /** The vault: the repository sits under `r/v1/<vaultId>/`. */
  vaultId?: string;
  /** This server's backup roots by version, base64, and the one a new repository is started with. */
  recoveryKeys?: Record<string, string>;
  recoveryKeyVersion?: number;
  /** Each backup this server signed for, by its object name: the stored bytes must hash to this. */
  trustedManifests?: Record<string, { versionId: string; ciphertextSha256: string }>;
  trustedManifestHead?: string;
  /** A copy of the repository in a folder (an offline export), read in place of the bucket. */
  offlineDirectory?: string;
};

export type CloudBackupObjectInfo = { key: string; size: number; etag: string | null };

export type CloudBackupClaimRefusal =
  'claimed-by-another-server' | 'other-key' | 'not-empty' | 'write-refused' | 'versioning-off' | 'claim-missing';

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

/** What an administrator reads when the provider refuses the test write on a bucket it lists. */
export const WRITE_REFUSED_MESSAGE =
  'The storage provider refused a test write: these credentials can list the bucket but can’t write to it. Check that the access key may write to the bucket, then check the bucket again.';

/** Each backup's signed record names the exact version of what it stored, so the bucket must keep versions. */
export const VERSIONING_OFF_MESSAGE =
  'This bucket does not keep object versions. Turn on versioning for the bucket (and a lifecycle rule that removes old versions after a few days), then check the bucket again.';

const REQUEST_TIMEOUT_MS = 120_000;
const LIST_PAGE = 1000;

const md5Base64 = (data: Buffer) => createHash('md5').update(data).digest('base64');

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
export const sanitizeProviderResponse = (response: Response | StorageResponse, action: string): Response => {
  if (!response.body) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
    });
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
    headers: [...response.headers],
  });
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

/** AWS Signature Version 4 for S3, shared with the backup engine. Every header given is signed. */
export { signS3Request } from '@frameleaf/backup-core';

type SignedRequest = {
  method: 'GET' | 'PUT' | 'HEAD' | 'POST' | 'DELETE';
  key?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
  retry?: boolean;
};

@Injectable()
export class CloudBackupStoreRepository {
  /** Waits before the second and third attempt of a request that failed for a transient reason. */
  retryDelaysMs = [1000, 4000];
  /** FL-164: the wait between attempts while a freshly rotated managed key becomes valid. */
  freshKeyRetryMs = 3000;

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(CloudBackupStoreRepository.name);
  }

  /**
   * Where the backup engine keeps this server's repository: `r/v1/<vault id>/` in the bucket. The engine
   * asks for credentials before every request, so a session that lasts minutes serves a run that lasts
   * days, and it renews them once when the provider says they expired.
   */
  store(connection: CloudBackupConnection, vaultId: string): Store {
    if (connection.offlineDirectory) {
      return dirStore(connection.offlineDirectory);
    }
    const session = (managed: CloudBackupConnection['managedCredentials']) => {
      let last: BackupCredentials = connection;
      return s3Store({
        endpoint: connection.endpoint,
        region: connection.region,
        bucket: connection.bucket,
        prefix: vaultPrefix(vaultId),
        credentials: async (renew) => {
          if (managed) {
            last = await managed(renew ? last.accessKeyId : undefined);
          }
          return last;
        },
        uploadLimit: connection.uploadLimit,
        retryDelaysMs: this.retryDelaysMs,
      });
    };
    const store = session(connection.managedCredentials);
    if (!connection.managedDeleteCredentials) {
      return store;
    }
    const deleting = session(connection.managedDeleteCredentials);
    return { ...store, delete: (key) => deleting.delete(key) };
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
    const objects = xmlValues(xml, 'Contents').map((entry) => {
      const size = xmlValue(entry, 'Size')?.trim();
      return {
        key: xmlValue(entry, 'Key') ?? '',
        size: size ? Number(size) : NaN,
        etag: xmlValue(entry, 'ETag'),
      };
    });
    const truncated = xmlValue(xml, 'IsTruncated');
    const nextToken = truncated === 'true' ? xmlValue(xml, 'NextContinuationToken') : null;
    if (
      !['true', 'false'].includes(truncated ?? '') ||
      (truncated === 'true' && (!nextToken || nextToken === options.continuationToken)) ||
      objects.some(({ key, size }) => !key || !Number.isSafeInteger(size) || size < 0)
    )
      throw new CloudBackupStoreError('Invalid backup object listing.', null, 'InvalidListing');
    return {
      objects,
      nextToken,
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
    const seen = new Set<string>();
    do {
      const page = await this.list(connection, prefix, { continuationToken: token });
      if (page.nextToken) {
        if (seen.has(page.nextToken))
          throw new CloudBackupStoreError('Invalid backup object listing.', null, 'InvalidListing');
        seen.add(page.nextToken);
      }
      total += page.objects.length;
      if (page.objects.length > 0) {
        await onPage(page.objects);
      }
      token = page.nextToken;
    } while (token);
    return total;
  }

  /** An object's contents. */
  async get(connection: CloudBackupConnection, key: string): Promise<Buffer> {
    const response = await this.send(connection, { method: 'GET', key });
    return Buffer.from(await response.arrayBuffer());
  }

  /** One object in one request. Answers the provider's ETag and whether it kept a version. */
  async put(
    connection: CloudBackupConnection,
    key: string,
    body: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<{ etag: string; versioned: boolean }> {
    const response = await this.send(connection, {
      method: 'PUT',
      key,
      body,
      headers: { 'content-type': contentType, 'content-md5': md5Base64(body) },
    });
    const etag = response.headers.get('etag');
    if (!etag) {
      throw new CloudBackupStoreError(`The storage provider did not confirm ${key}`, response.status, 'MissingETag');
    }
    const versionId = response.headers.get('x-amz-version-id');
    return { etag, versioned: !!versionId && versionId !== 'null' };
  }

  /** Remove one object. Only ever used on what a check or a claim itself wrote. */
  async delete(connection: CloudBackupConnection, key: string): Promise<void> {
    await this.send(connection, { method: 'DELETE', key });
  }

  /** The first write a check or a claim makes after listing the bucket. A 403 there means it cannot be written to. */
  private async firstPut(connection: CloudBackupConnection, key: string, body: Buffer, contentType?: string) {
    try {
      return await this.put(connection, key, body, contentType);
    } catch (error) {
      if (error instanceof CloudBackupStoreError && error.status === 403) {
        throw new CloudBackupClaimError('write-refused', WRITE_REFUSED_MESSAGE);
      }
      throw error;
    }
  }

  /**
   * What a bucket holds besides this server's own repository and test files. Frameleaf-managed storage
   * is made for one server and its credentials may only list under their own names, so nothing else can
   * be there and nothing is listed.
   */
  private async others(connection: CloudBackupConnection): Promise<string[]> {
    if (connection.managedCredentials) {
      return [];
    }
    const { objects } = await this.list(connection, '', { maxKeys: LIST_PAGE });
    return objects.map(({ key }) => key).filter((key) => !key.startsWith(CLOUD_BACKUP_PROBE_PREFIX));
  }

  /**
   * The capability check behind "Check bucket": the credentials can list the bucket, and the provider
   * accepts and returns a test file and keeps versions. The test file is random and deleted again.
   * Answers what the bucket holds now.
   */
  async probe(connection: CloudBackupConnection): Promise<{ state: 'empty' | 'claimed' | 'not-empty' }> {
    const others = await this.others(connection);
    const probeKey = `${CLOUD_BACKUP_PROBE_PREFIX}${randomUUID()}`;
    const content = randomBytes(64);
    try {
      const { versioned } = await this.firstPut(connection, probeKey, content);
      if (!versioned) throw new CloudBackupClaimError('versioning-off', VERSIONING_OFF_MESSAGE);
      const back = await this.get(connection, probeKey);
      if (!back.equals(content)) {
        throw new CloudBackupClaimError('write-refused', 'This storage provider returned a different test file.');
      }
    } finally {
      await withExecutionCleanup(() => this.delete(connection, probeKey)).catch((error: unknown) =>
        this.logger.warn(`Could not remove the capability check's test file: ${String(error)}`),
      );
    }
    if (others.includes(CLOUD_BACKUP_MARKER)) {
      return { state: 'claimed' };
    }
    return { state: others.length === 0 ? 'empty' : 'not-empty' };
  }

  /**
   * Claim the bucket for this server: one bucket per server. An empty bucket gets the root marker with
   * this server's instance id and its key's fingerprint, and the marker is read back. A bucket already
   * holding this server's marker for this key is this server's own and stays as it is. Anything else is
   * refused: a marker naming another server or another key, or (in your own bucket) any other object than
   * this server's repository.
   */
  async claim(
    connection: CloudBackupConnection,
    options: { instanceId: string; keyFingerprint: string; now: Date },
  ): Promise<{ existing: boolean; claimedAt: string }> {
    const existing = await this.readMarker(connection, options.keyFingerprint).catch((error: unknown) => {
      if (error instanceof CloudBackupClaimError && error.reason === 'claim-missing') {
        return null;
      }
      throw error;
    });
    if (existing) {
      if (existing.instanceId !== options.instanceId) {
        throw new CloudBackupClaimError(
          'claimed-by-another-server',
          `This bucket already holds ${CLOUD_BACKUP_MARKER} for another Frameleaf server. Each server needs its own bucket.`,
        );
      }
      return { existing: true, claimedAt: existing.claimedAt || options.now.toISOString() };
    }

    const foreign = (keys: string[]) => keys.filter((key) => key !== CLOUD_BACKUP_MARKER && !key.startsWith('r/'));
    if (foreign(await this.others(connection)).length > 0) {
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
    const { versioned } = await this.firstPut(
      connection,
      CLOUD_BACKUP_MARKER,
      Buffer.from(JSON.stringify(marker)),
      'application/json',
    );
    if (!versioned) {
      // Leave the bucket as it was found. Managed storage always keeps versions and may not delete the marker.
      await this.delete(connection, CLOUD_BACKUP_MARKER).catch(() => false);
      throw new CloudBackupClaimError('versioning-off', VERSIONING_OFF_MESSAGE);
    }

    const written = await this.readMarker(connection, options.keyFingerprint);
    if (written.instanceId !== options.instanceId || foreign(await this.others(connection)).length > 0) {
      throw new CloudBackupClaimError(
        'not-empty',
        'Something else wrote to this bucket while it was being claimed. Use an empty bucket dedicated to this server.',
      );
    }
    return { existing: false, claimedAt: marker.claimedAt };
  }

  /**
   * The bucket's claim. A marker that is gone (an emptied or recreated bucket), or one made with another
   * key than the one named, is refused, never guessed at. The marker is not secret and proves nothing by
   * itself: what a key can open is decided by the repository, which only the right key unwraps.
   */
  async readMarker(connection: CloudBackupConnection, keyFingerprint?: string): Promise<CloudBackupMarker> {
    let body: Buffer;
    try {
      body = await this.get(connection, CLOUD_BACKUP_MARKER);
    } catch (error) {
      if (error instanceof CloudBackupStoreError && error.status === 404) {
        throw new CloudBackupClaimError(
          'claim-missing',
          `This bucket no longer holds ${CLOUD_BACKUP_MARKER}: it was emptied or recreated. Set up cloud backup again to claim it.`,
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
    if (keyFingerprint && marker.keyFingerprint && marker.keyFingerprint !== keyFingerprint) {
      throw new CloudBackupClaimError(
        'other-key',
        'This bucket was claimed with a different key or by another server. Use the key it was set up with, or an empty bucket.',
      );
    }
    return marker;
  }

  /**
   * Sign and send one request, retrying twice on a network failure, 429 or 5xx. FL-164: with a freshly
   * rotated managed key, a `403 InvalidAccessKeyId` is retried every few seconds until the key is valid or
   * `freshKeyUntil` passes.
   */
  private async send(connection: CloudBackupConnection, request: SignedRequest): Promise<Response> {
    const credentials = connection.managedCredentials;
    let renewed = false;
    while (true) {
      try {
        return await this.sendWithRetries(connection, request);
      } catch (error) {
        if (
          credentials &&
          error instanceof CloudBackupStoreError &&
          ['ExpiredToken', 'InvalidToken', 'RequestExpired', 'InvalidAccessKeyId'].includes(error.code ?? '') &&
          !renewed
        ) {
          renewed = true;
          await credentials(error.accessKeyId ?? connection.accessKeyId);
          continue;
        }
        if (
          credentials &&
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
    let response: StorageResponse;
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

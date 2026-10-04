import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  CloudBackupClaimError,
  CloudBackupConnection,
  CloudBackupFileChangedError,
  CloudBackupStoreError,
  CloudBackupStoreRepository,
  SSE_C_REFUSED_MESSAGE,
  describeProviderError,
  sanitizeProviderResponse,
  signS3Request,
} from 'src/repositories/cloud-backup-store.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { CLOUD_BACKUP_MARKER, CLOUD_BACKUP_PART_BYTES, CLOUD_BACKUP_PROBE_PREFIX } from 'src/utils/cloud-backup.js';
import { withOperationExecution } from 'src/utils/operation-execution.js';

const SSE_HEADERS = [
  'x-amz-server-side-encryption-customer-algorithm',
  'x-amz-server-side-encryption-customer-key',
  'x-amz-server-side-encryption-customer-key-md5',
];

type Stored = { body: Buffer; keyMd5: string | null };
type Seen = { method: string; key: string; query: URLSearchParams; headers: Headers; hasSseC: boolean };

/**
 * An in-memory S3 bucket: ListObjectsV2, PUT/GET/HEAD/DELETE and multipart uploads, path-style. It keeps
 * the customer key's MD5 with every object and refuses a read with another key, as SSE-C providers do.
 * It answers 400 to an object call without the SSE-C headers, so a request that forgets them fails the
 * spec, and every request is recorded for the assertions below.
 */
class FakeS3 {
  objects = new Map<string, Stored>();
  uploads = new Map<string, { key: string; parts: Map<number, Buffer>; keyMd5: string | null }>();
  seen: Seen[] = [];
  /** A provider that ignores SSE-C: stores the body and never echoes the algorithm. */
  ignoresSseC = false;
  /** Answers to give before the next request goes through: a status, or a status with its error code. */
  failures: Array<number | { status: number; code: string }> = [];
  /** A bucket that refuses SSE-C (Amazon S3's default for new buckets): a PUT with a customer key is 403. */
  refusesSseC = false;
  /** CompleteMultipartUpload finishes the object, then its answer is lost (a 500), once. */
  loseCompleteAnswer = false;

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    Promise.resolve(this.respond(input, init));

  private respond(input: string | URL | Request, init?: RequestInit): Response {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const key = url.pathname
      .split('/')
      .slice(2)
      .map((part) => decodeURIComponent(part))
      .join('/');
    const hasSseC = SSE_HEADERS.every((name) => headers.has(name));
    this.seen.push({ method, key, query: url.searchParams, headers, hasSseC });

    const failure = this.failures.shift();
    if (failure) {
      const { status, code } = typeof failure === 'number' ? { status: failure, code: 'SlowDown' } : failure;
      return new Response(`<Error><Code>${code}</Code></Error>`, { status });
    }

    expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    if (body.length > 0) {
      expect(headers.get('x-amz-content-sha256')).toBe(createHash('sha256').update(body).digest('hex'));
      expect(headers.get('content-md5')).toBe(createHash('md5').update(body).digest('base64'));
    }

    const needsKey = ['PUT', 'GET', 'HEAD', 'POST'].includes(method) && key !== '';
    if (needsKey && !hasSseC) {
      return new Response('<Error><Code>InvalidRequest</Code></Error>', { status: 400 });
    }
    if (this.refusesSseC && method === 'PUT' && hasSseC) {
      return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    }
    const keyMd5 = this.ignoresSseC ? null : headers.get('x-amz-server-side-encryption-customer-key-md5');
    const echo: Record<string, string> = this.ignoresSseC
      ? {}
      : { 'x-amz-server-side-encryption-customer-algorithm': 'AES256' };

    if (key === '' && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = this.objects
        .entries()
        .filter(([name]) => name.startsWith(prefix))
        .map(
          ([name, object]) =>
            `<Contents><Key>${name}</Key><Size>${object.body.length}</Size><ETag>"e"</ETag></Contents>`,
        )
        .toArray()
        .join('');
      return new Response(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }

    if (method === 'POST' && url.searchParams.has('uploads')) {
      const uploadId = `upload-${this.uploads.size + 1}`;
      this.uploads.set(uploadId, { key, parts: new Map(), keyMd5 });
      return new Response(
        `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    const uploadId = url.searchParams.get('uploadId');
    if (uploadId) {
      const upload = this.uploads.get(uploadId);
      if (!upload) {
        return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 });
      }
      if (method === 'PUT') {
        upload.parts.set(Number(url.searchParams.get('partNumber')), body);
        return new Response('', { headers: { etag: `"part-${url.searchParams.get('partNumber')}"` } });
      }
      if (method === 'DELETE') {
        this.uploads.delete(uploadId);
        return new Response(null, { status: 204 });
      }
      const numbers = upload.parts
        .keys()
        .toArray()
        .toSorted((a, b) => a - b);
      this.objects.set(upload.key, {
        body: Buffer.concat(numbers.map((n) => upload.parts.get(n)!)),
        keyMd5: upload.keyMd5,
      });
      this.uploads.delete(uploadId);
      if (this.loseCompleteAnswer) {
        this.loseCompleteAnswer = false;
        return new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
      }
      return new Response('<CompleteMultipartUploadResult><ETag>"multi-2"</ETag></CompleteMultipartUploadResult>', {
        headers: echo,
      });
    }

    const object = this.objects.get(key);
    switch (method) {
      case 'PUT': {
        this.objects.set(key, { body, keyMd5 });
        return new Response('', { headers: { etag: '"etag-1"', ...echo } });
      }
      case 'DELETE': {
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      }
      case 'GET':
      case 'HEAD': {
        if (!object) {
          return new Response(method === 'HEAD' ? null : '<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
        }
        if (object.keyMd5 && object.keyMd5 !== keyMd5) {
          return new Response(method === 'HEAD' ? null : '<Error><Code>AccessDenied</Code></Error>', { status: 403 });
        }
        return new Response(method === 'HEAD' ? null : new Uint8Array(object.body), {
          headers: { 'content-length': String(object.body.length), etag: '"etag-1"', ...echo },
        });
      }
      default: {
        return new Response('', { status: 405 });
      }
    }
  }

  /** Every object call (not LIST, DELETE or an abort) carried the customer-key headers. */
  expectSseCOnEveryObjectCall() {
    const objectCalls = this.seen.filter(({ method, key }) => key !== '' && method !== 'DELETE');
    expect(objectCalls.length).toBeGreaterThan(0);
    for (const call of objectCalls) {
      expect(call.hasSseC, `${call.method} ${call.key} without SSE-C headers`).toBe(true);
    }
  }
}

const connection: CloudBackupConnection = {
  endpoint: 'https://s3.eu-central-2.storage.example',
  region: 'eu-central-2',
  bucket: 'family-backup',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret-example',
};

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * The stored object holds exactly these bytes. `toEqual` walks a Buffer element by element (about a
 * second per MiB), which runs an 8 MiB multipart object past the test timeout; `Buffer#equals` is
 * the same exact comparison.
 */
const expectStored = (stored: { body: Buffer } | undefined, expected: Buffer) => {
  expect(stored).toBeDefined();
  expect(stored!.body.length).toBe(expected.length);
  expect(stored!.body.equals(expected)).toBe(true);
};

describe(CloudBackupStoreRepository.name, () => {
  let s3: FakeS3;
  let sut: CloudBackupStoreRepository;
  let logger: LoggingRepository;
  let directory: string;
  const bucketKey = randomBytes(32);

  beforeEach(async () => {
    s3 = new FakeS3();
    vi.stubGlobal('fetch', s3.fetch);
    logger = LoggingRepository.create();
    sut = new CloudBackupStoreRepository(logger);
    sut.retryDelaysMs = [0, 0];
    directory = await mkdtemp(join(tmpdir(), 'cloud-backup-store-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it('signs requests with AWS Signature Version 4 (the published S3 example)', () => {
    const headers = signS3Request({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      canonicalUri: '/test.txt',
      query: '',
      headers: { range: 'bytes=0-9' },
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });

    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers).not.toHaveProperty('host');
  });

  it('bounds preview actual bytes and verifies both size and SHA before returning data', async () => {
    const bytes = Buffer.from('preview');
    const hash = sha256(bytes);
    await sut.put(connection, `o/${hash}`, bytes, bucketKey);
    await expect(sut.getPreview(connection, `o/${hash}`, bucketKey, hash, bytes.length)).resolves.toEqual(bytes);
    await expect(sut.getPreview(connection, `o/${hash}`, bucketKey, hash, bytes.length - 1)).rejects.toThrow(
      'size mismatch',
    );
    await expect(sut.getPreview(connection, `o/${hash}`, bucketKey, hash, bytes.length + 1)).rejects.toThrow(
      'integrity check',
    );
    await expect(sut.getPreview(connection, `o/${hash}`, bucketKey, 'a'.repeat(64), bytes.length)).rejects.toThrow(
      'integrity check',
    );
    await expect(sut.getPreview(connection, `o/${hash}`, bucketKey, hash, 8 * 1024 * 1024 + 1)).rejects.toThrow(
      'limit',
    );
    s3.expectSseCOnEveryObjectCall();
  });

  it('sends the SSE-C headers on PUT, GET and HEAD and verifies a download against its SHA-256', async () => {
    const body = Buffer.from('a photo');
    const { encrypted } = await sut.put(connection, `o/${sha256(body)}`, body, bucketKey);
    expect(encrypted).toBe(true);

    await expect(sut.head(connection, `o/${sha256(body)}`, bucketKey)).resolves.toMatchObject({ size: body.length });
    await expect(sut.get(connection, `o/${sha256(body)}`, bucketKey, sha256(body))).resolves.toEqual(body);
    await expect(sut.get(connection, `o/${sha256(body)}`, bucketKey, sha256(Buffer.from('other')))).rejects.toThrow(
      'does not match its checksum',
    );
    await expect(sut.head(connection, 'o/missing', bucketKey)).resolves.toBeNull();
    // the key is never readable with another key
    await expect(sut.get(connection, `o/${sha256(body)}`, randomBytes(32))).rejects.toBeInstanceOf(
      CloudBackupStoreError,
    );

    s3.expectSseCOnEveryObjectCall();
    const put = s3.seen.find(({ method }) => method === 'PUT')!;
    expect(put.headers.get('x-amz-server-side-encryption-customer-key')).toBe(bucketKey.toString('base64'));
  });

  it('uploads a small file in one PUT under its hash, and refuses a file that does not hash to its name', async () => {
    const content = randomBytes(1000);
    const path = join(directory, 'small.jpg');
    await writeFile(path, content);

    await expect(sut.uploadFile(connection, `o/${sha256(content)}`, path, bucketKey, sha256(content))).resolves.toEqual(
      {
        etag: '"etag-1"',
        size: 1000,
      },
    );
    expectStored(s3.objects.get(`o/${sha256(content)}`), content);

    const wrong = sha256(Buffer.from('something else'));
    await expect(sut.uploadFile(connection, `o/${wrong}`, path, bucketKey, wrong)).rejects.toBeInstanceOf(
      CloudBackupFileChangedError,
    );
    expect(s3.objects.has(`o/${wrong}`)).toBe(false);
    s3.expectSseCOnEveryObjectCall();
  });

  it('uploads a large file in 8 MiB parts with Content-MD5 and SSE-C on every part', async () => {
    const content = randomBytes(CLOUD_BACKUP_PART_BYTES + 4096);
    const path = join(directory, 'large.mov');
    await writeFile(path, content);

    const result = await sut.uploadFile(connection, `o/${sha256(content)}`, path, bucketKey, sha256(content));

    expect(result).toEqual({ etag: '"multi-2"', size: content.length });
    expectStored(s3.objects.get(`o/${sha256(content)}`), content);
    const parts = s3.seen.filter(({ method, query }) => method === 'PUT' && query.has('partNumber'));
    expect(parts.map(({ query }) => query.get('partNumber'))).toEqual(['1', '2']);
    for (const part of parts) {
      expect(part.headers.get('content-md5')).toBeTruthy();
    }
    s3.expectSseCOnEveryObjectCall();
  });

  it('abandons a multipart upload whose file does not hash to its name, and never completes it', async () => {
    const content = randomBytes(CLOUD_BACKUP_PART_BYTES + 10);
    const path = join(directory, 'changed.mov');
    await writeFile(path, content);
    const wrong = sha256(Buffer.from('before it changed'));

    await expect(sut.uploadFile(connection, `o/${wrong}`, path, bucketKey, wrong)).rejects.toBeInstanceOf(
      CloudBackupFileChangedError,
    );

    expect(s3.objects.has(`o/${wrong}`)).toBe(false);
    expect(s3.uploads.size).toBe(0);
    expect(s3.seen.some(({ method, query }) => method === 'DELETE' && query.has('uploadId'))).toBe(true);
  });

  describe('claim', () => {
    const options = { instanceId: 'instance-1', keyFingerprint: 'ABCD-1234', now: new Date('2026-09-26T03:00:00Z') };

    it('claims an empty bucket with an encrypted marker holding the instance id', async () => {
      await expect(sut.claim(connection, bucketKey, options)).resolves.toEqual({
        existing: false,
        claimedAt: '2026-09-26T03:00:00.000Z',
      });

      const marker = JSON.parse(s3.objects.get(CLOUD_BACKUP_MARKER)!.body.toString());
      expect(marker).toMatchObject({
        format: 'frameleaf-backup',
        instanceId: 'instance-1',
        keyFingerprint: 'ABCD-1234',
      });
      expect(JSON.stringify(marker)).not.toContain(bucketKey.toString('base64'));
      s3.expectSseCOnEveryObjectCall();
    });

    it('keeps its own claim, with its backups, when set up again with the same key', async () => {
      await sut.claim(connection, bucketKey, options);
      s3.objects.set('o/abc', { body: Buffer.from('x'), keyMd5: null });

      await expect(sut.claim(connection, bucketKey, { ...options, now: new Date() })).resolves.toEqual({
        existing: true,
        claimedAt: '2026-09-26T03:00:00.000Z',
      });
    });

    it('refuses a bucket another server claimed', async () => {
      await sut.claim(connection, bucketKey, { ...options, instanceId: 'instance-2' });

      await expect(sut.claim(connection, bucketKey, options)).rejects.toMatchObject({
        reason: 'claimed-by-another-server',
      });
    });

    it('refuses a bucket claimed with another key', async () => {
      await sut.claim(connection, randomBytes(32), options);

      await expect(sut.claim(connection, bucketKey, options)).rejects.toMatchObject({ reason: 'other-key' });
    });

    it('refuses a bucket holding other files, and writes nothing to it', async () => {
      s3.objects.set('holiday.jpg', { body: Buffer.from('x'), keyMd5: null });

      await expect(sut.claim(connection, bucketKey, options)).rejects.toMatchObject({ reason: 'not-empty' });
      expect(s3.objects.has(CLOUD_BACKUP_MARKER)).toBe(false);
    });

    it('refuses a provider that does not apply SSE-C and leaves the bucket as it found it', async () => {
      s3.ignoresSseC = true;

      await expect(sut.claim(connection, bucketKey, options)).rejects.toMatchObject({ reason: 'sse-c-unsupported' });
      expect(s3.objects.size).toBe(0);
    });
  });

  describe('probe', () => {
    it('writes, reads back and deletes a test file encrypted with a throwaway key', async () => {
      await expect(sut.probe(connection)).resolves.toEqual({ state: 'empty' });

      const put = s3.seen.find(({ method }) => method === 'PUT')!;
      expect(put.key.startsWith(CLOUD_BACKUP_PROBE_PREFIX)).toBe(true);
      expect(put.hasSseC).toBe(true);
      expect(s3.objects.size).toBe(0);
    });

    it('reports a bucket that is claimed or holds other files', async () => {
      s3.objects.set(CLOUD_BACKUP_MARKER, { body: Buffer.from('{}'), keyMd5: 'x' });
      await expect(sut.probe(connection)).resolves.toEqual({ state: 'claimed' });

      s3.objects.clear();
      s3.objects.set('holiday.jpg', { body: Buffer.from('x'), keyMd5: null });
      await expect(sut.probe(connection)).resolves.toEqual({ state: 'not-empty' });
    });

    it('refuses a provider without SSE-C and removes its test file', async () => {
      s3.ignoresSseC = true;

      await expect(sut.probe(connection)).rejects.toBeInstanceOf(CloudBackupClaimError);
      expect(s3.objects.size).toBe(0);
    });
  });

  it('retries a request the provider was too busy for, and never one it refused', async () => {
    s3.failures = [503];
    await expect(sut.put(connection, 'o/abc', Buffer.from('x'), bucketKey)).resolves.toMatchObject({
      etag: '"etag-1"',
    });

    s3.failures = [403];
    await expect(sut.put(connection, 'o/abc', Buffer.from('x'), bucketKey)).rejects.toMatchObject({ status: 403 });
    expect(s3.seen.filter(({ method }) => method === 'PUT')).toHaveLength(3);
  });

  it('sends no customer key with a listing', async () => {
    await sut.list(connection, 'o/');

    const listing = s3.seen.find(({ key }) => key === '')!;
    expect(listing.hasSseC).toBe(false);
    for (const name of SSE_HEADERS) {
      expect(listing.headers.has(name)).toBe(false);
    }
  });

  it('streams an upload of unknown length: one PUT when it fits in a part, 8 MiB parts when it does not', async () => {
    const small = randomBytes(2000);
    await expect(
      sut.uploadStream(connection, 'm/small.json.gz', [small], bucketKey, 'application/gzip'),
    ).resolves.toEqual({
      etag: '"etag-1"',
      size: 2000,
    });
    expectStored(s3.objects.get('m/small.json.gz'), small);

    const large = randomBytes(CLOUD_BACKUP_PART_BYTES + 5000);
    const chunks = Array.from({ length: Math.ceil(large.length / 65_536) }, (_, i) =>
      large.subarray(i * 65_536, (i + 1) * 65_536),
    );
    await expect(
      sut.uploadStream(connection, 'm/large.json.gz', chunks, bucketKey, 'application/gzip'),
    ).resolves.toEqual({
      etag: '"multi-2"',
      size: large.length,
    });
    expectStored(s3.objects.get('m/large.json.gz'), large);
    const parts = s3.seen.filter(
      ({ method, key, query }) => method === 'PUT' && key === 'm/large.json.gz' && query.has('partNumber'),
    );
    expect(parts).toHaveLength(2);
    s3.expectSseCOnEveryObjectCall();
  });

  it('accepts a completed upload whose answer was lost, once the object is there with the size uploaded', async () => {
    const content = randomBytes(CLOUD_BACKUP_PART_BYTES + 100);
    const path = join(directory, 'lost-answer.mov');
    await writeFile(path, content);
    s3.loseCompleteAnswer = true;

    await expect(sut.uploadFile(connection, `o/${sha256(content)}`, path, bucketKey, sha256(content))).resolves.toEqual(
      {
        etag: '"etag-1"',
        size: content.length,
      },
    );
    expectStored(s3.objects.get(`o/${sha256(content)}`), content);
    expect(s3.seen.some(({ method, key }) => method === 'HEAD' && key === `o/${sha256(content)}`)).toBe(true);
  });

  it('rejects NoSuchUpload recovery when HEAD finds an object with the wrong size', async () => {
    const content = randomBytes(CLOUD_BACKUP_PART_BYTES + 100);
    const path = join(directory, 'wrong-size.mov');
    await writeFile(path, content);
    s3.loseCompleteAnswer = true;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const response = await s3.fetch(input, init);
      if (init?.method === 'HEAD') {
        response.headers.set('content-length', String(content.length + 1));
      }
      return response;
    });

    await expect(
      sut.uploadFile(connection, `o/${sha256(content)}`, path, bucketKey, sha256(content)),
    ).rejects.toMatchObject({
      status: 404,
      code: 'NoSuchUpload',
    });
    expect(s3.seen.some(({ method }) => method === 'HEAD')).toBe(true);
  });

  it('says a bucket refuses SSE-C when a customer-key PUT is refused after the listing was allowed', async () => {
    s3.refusesSseC = true;

    await expect(sut.probe(connection)).rejects.toMatchObject({
      reason: 'sse-c-unsupported',
      message: SSE_C_REFUSED_MESSAGE,
    });
    expect(SSE_C_REFUSED_MESSAGE).toContain('may block customer-provided encryption keys (SSE-C)');
    expect(SSE_C_REFUSED_MESSAGE).toContain('these credentials can’t write to it');
    expect(SSE_C_REFUSED_MESSAGE).toContain('Amazon S3 turns SSE-C off by default on new buckets');
    await expect(
      sut.claim(connection, bucketKey, { instanceId: 'instance-1', keyFingerprint: 'ABCD-1234', now: new Date() }),
    ).rejects.toMatchObject({ reason: 'sse-c-unsupported' });
  });

  it('names the common setup mistakes: a server clock that is off, and a bucket in another region', async () => {
    s3.failures = [{ status: 403, code: 'RequestTimeTooSkewed' }];
    await expect(sut.list(connection, '')).rejects.toThrow('clock is off');

    s3.failures = [{ status: 301, code: 'PermanentRedirect' }];
    await expect(sut.list(connection, '')).rejects.toThrow('regional endpoint');

    s3.failures = [{ status: 307, code: 'TemporaryRedirect' }];
    await expect(sut.list(connection, '')).rejects.toThrow('regional endpoint');
  });

  it('reports a claim that is gone from an emptied or recreated bucket', async () => {
    await expect(sut.readMarker(connection, bucketKey)).rejects.toMatchObject({ reason: 'claim-missing' });
  });

  it('never puts the bucket key or the secret in an error message', async () => {
    s3.failures = [403];

    const error = (await sut.get(connection, 'o/abc', bucketKey).catch((error_: unknown) => error_)) as Error;

    expect(error.message).not.toContain(bucketKey.toString('base64'));
    expect(error.message).not.toContain(connection.secretAccessKey);
  });

  describe('FL-325 provider error privacy', () => {
    const upstreamFailure = `https://s3.eu-central-2.${['wasa', 'bisys'].join('')}.test/?secret=${connection.secretAccessKey}`;

    it.each([
      { name: 'Error', failure: new Error(upstreamFailure) },
      { name: 'thrown text', failure: upstreamFailure },
    ])('keeps network $name text out of customer errors after retries', async ({ failure }) => {
      const fetch = vi.fn().mockRejectedValue(failure);
      vi.stubGlobal('fetch', fetch);

      const error = await sut.get(connection, 'o/abc', bucketKey).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CloudBackupStoreError);
      expect(error).toMatchObject({
        message: 'The storage provider could not be reached (GET o/abc).',
        status: null,
        code: null,
      });
      expect(String(error)).not.toContain(upstreamFailure);
      expect(String(error)).not.toContain(connection.secretAccessKey);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('keeps unexpected request failures out of the retry fallback error', async () => {
      const failingConnection = {
        ...connection,
        get endpoint(): string {
          throw new Error(upstreamFailure);
        },
      };

      const error = await sut.get(failingConnection, 'o/abc', bucketKey).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CloudBackupStoreError);
      expect(error).toMatchObject({
        message: 'The storage provider could not be reached (GET o/abc).',
        status: null,
        code: null,
      });
      expect(String(error)).not.toContain(upstreamFailure);
      expect(String(error)).not.toContain(connection.secretAccessKey);
      expect(s3.seen).toHaveLength(0);
    });

    it.each([
      { name: 'URL and secret', code: upstreamFailure },
      { name: 'credential alone', code: connection.secretAccessKey },
      { name: 'alphanumeric credential alone', code: connection.accessKeyId },
      { name: 'unknown machine code', code: 'Storage_Rate-Limit' },
      { name: 'trailing newline', code: 'AccessDenied\n' },
      { name: 'spaces', code: 'Access Denied' },
      { name: 'overlong code', code: 'X'.repeat(65) },
    ])('omits arbitrary XML Code text: $name', async ({ code }) => {
      s3.failures = [{ status: 403, code }];

      const error = await sut.list(connection, '').catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CloudBackupStoreError);
      expect(error).toMatchObject({
        message: 'The storage provider refused GET family-backup: 403',
        status: 403,
        code: null,
      });
      expect(String(error)).not.toContain(upstreamFailure);
      expect(String(error)).not.toContain(connection.secretAccessKey);
      expect(String(error)).not.toContain(connection.accessKeyId);
      expect(describeProviderError(403, code, 'GET family-backup')).toBe(
        'The storage provider refused GET family-backup: 403',
      );
    });

    it.each(['AccessDenied', 'InvalidRequest'])('keeps the recognized machine code %s', async (code) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(`<Error><Code>${code}</Code><Message>${upstreamFailure}</Message></Error>`, { status: 403 }),
          ),
      );

      await expect(sut.list(connection, '')).rejects.toMatchObject({
        message: `The storage provider refused GET family-backup: 403 ${code}`,
        status: 403,
        code,
      });
    });

    it.each([
      { name: 'URL and secret', code: upstreamFailure },
      { name: 'credential alone', code: connection.secretAccessKey },
      { name: 'alphanumeric credential alone', code: connection.accessKeyId },
    ])('rejects an HTTP-200 completion error without exposing $name', async ({ code }) => {
      vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(input.toString());
        if (init?.method === 'POST' && url.searchParams.has('uploadId')) {
          return Promise.resolve(
            new Response(`<Error><Code>${code}</Code><Message>${upstreamFailure}</Message></Error>`, {
              headers: { etag: '"must-not-accept"' },
            }),
          );
        }
        return s3.fetch(input, init);
      });

      const error = await sut
        .uploadStream(
          connection,
          'm/private.json.gz',
          [Buffer.alloc(CLOUD_BACKUP_PART_BYTES + 1)],
          bucketKey,
          'application/gzip',
        )
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CloudBackupStoreError);
      expect(error).toMatchObject({
        message: 'The storage provider refused to finish m/private.json.gz',
        status: 200,
        code: null,
      });
      expect(String(error)).not.toContain(upstreamFailure);
      expect(String(error)).not.toContain(connection.secretAccessKey);
      expect(String(error)).not.toContain(connection.accessKeyId);
      expect(s3.uploads.size).toBe(0);
      expect(s3.objects.has('m/private.json.gz')).toBe(false);
    });
  });

  describe('FL-325 response-consumption privacy', () => {
    const privateHostname = 'private-backup.storage.internal';
    const bodyFailure = () =>
      new Error(`Read failed at https://${privateHostname}/?key=${connection.secretAccessKey}`, {
        cause: new Error(connection.secretAccessKey),
      });

    const expectSafeReadFailure = (error: unknown, action: string) => {
      expect(error).toBeInstanceOf(CloudBackupStoreError);
      expect(error).toMatchObject({
        message: `The storage response could not be read (${action}).`,
        status: null,
        code: null,
      });
      expect(error).not.toHaveProperty('cause');
      const diagnostic = inspect(error, { depth: 10 });
      expect(diagnostic).not.toContain(privateHostname);
      expect(diagnostic).not.toContain(connection.secretAccessKey);
    };

    const failedResponse = () => {
      let first = true;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (first) {
                first = false;
                controller.enqueue(new Uint8Array([1, 2, 3]));
              } else {
                controller.error(bodyFailure());
              }
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 206 },
      );
    };

    it.each([
      { name: 'get', read: () => sut.get(connection, 'o/private', bucketKey), action: 'GET o/private' },
      { name: 'list', read: () => sut.list(connection, ''), action: 'GET family-backup' },
      { name: 'hash', read: () => sut.hashObject(connection, 'o/private', bucketKey), action: 'GET o/private' },
      {
        name: 'preview',
        read: () => sut.getPreview(connection, 'o/private', bucketKey, 'a'.repeat(64), 100),
        action: 'GET o/private',
      },
      { name: 'marker', read: () => sut.readMarker(connection, bucketKey), action: `GET ${CLOUD_BACKUP_MARKER}` },
    ])('sanitizes a body failure after successful $name headers', async ({ read, action }) => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(failedResponse));

      const error = await read().catch((error_: unknown) => error_);

      expectSafeReadFailure(error, action);
    });

    it('sanitizes streaming download failures, removes the partial file and preserves the destination', async () => {
      const destination = join(directory, 'restored.bin');
      await writeFile(destination, 'already here');
      vi.stubGlobal('fetch', vi.fn().mockImplementation(failedResponse));

      const error = await sut
        .download(connection, 'o/private', bucketKey, destination, null)
        .catch((error_: unknown) => error_);

      expectSafeReadFailure(error, 'GET o/private');
      expect(await readFile(destination, 'utf8')).toBe('already here');
      expect(await readdir(directory)).toEqual(['restored.bin']);
    });

    it('sanitizes completion reads and unfinished-upload log diagnostics, including chained errors', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(input.toString());
        if (url.searchParams.has('uploadId')) {
          if (init?.method === 'POST') {
            return Promise.resolve(failedResponse());
          }
          if (init?.method === 'DELETE') {
            return Promise.reject(bodyFailure());
          }
        }
        return s3.fetch(input, init);
      });

      const error = await sut
        .uploadStream(
          connection,
          'm/private.json.gz',
          [Buffer.alloc(CLOUD_BACKUP_PART_BYTES + 1)],
          bucketKey,
          'application/gzip',
        )
        .catch((error_: unknown) => error_);

      expectSafeReadFailure(error, 'POST m/private.json.gz');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not abandon the unfinished upload'));
      const diagnostic = inspect(warn.mock.calls, { depth: 10 });
      expect(diagnostic).not.toContain(privateHostname);
      expect(diagnostic).not.toContain(connection.secretAccessKey);
    });

    it('preserves response metadata, demand-driven reads and cancellation of the underlying body', async () => {
      const cancel = vi.fn();
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      });
      const original = new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), {
        status: 206,
        statusText: 'Partial Content',
        headers: { etag: '"e"', 'x-amz-server-side-encryption-customer-algorithm': 'AES256' },
      });
      const response = sanitizeProviderResponse(original, 'GET o/private');
      expect(response.status).toBe(original.status);
      expect(response.statusText).toBe(original.statusText);
      expect([...response.headers]).toEqual([...original.headers]);
      await Promise.resolve();
      expect(pull).not.toHaveBeenCalled();
      const reader = response.body!.getReader();
      await expect(reader.read()).resolves.toEqual({ value: new Uint8Array([1, 2, 3]), done: false });
      await Promise.resolve();
      expect(pull).toHaveBeenCalledTimes(1);
      const reason = new Error('preview limit');
      await reader.cancel(reason);
      expect(cancel).toHaveBeenCalledWith(reason);
    });

    it('preserves cancellation while a body read is pending', async () => {
      const cancel = vi.fn();
      const response = sanitizeProviderResponse(
        new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })),
        'GET o/private',
      );
      const reader = response.body!.getReader();
      const pending = reader.read();
      await Promise.resolve();

      await reader.cancel('stop');

      await expect(pending).resolves.toEqual({ value: undefined, done: true });
      expect(cancel).toHaveBeenCalledWith('stop');
    });

    it('sanitizes errors from underlying cancellation without chaining the original', async () => {
      const response = sanitizeProviderResponse(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              throw bodyFailure();
            },
          }),
        ),
        'GET o/private',
      );

      const error = await response.body!.cancel('stop').catch((error_: unknown) => error_);

      expectSafeReadFailure(error, 'GET o/private');
    });

    it('preserves local filesystem failures during a streaming download', async () => {
      const content = Buffer.from('original');
      s3.objects.set('o/local-error', { body: content, keyMd5: null });
      const error = await sut
        .download(connection, 'o/local-error', bucketKey, join(directory, 'missing', 'restored.bin'), null)
        .catch((error_: unknown) => error_);

      expect(error).toMatchObject({ code: 'ENOENT' });
      expect(error).not.toBeInstanceOf(CloudBackupStoreError);
    });
  });

  describe('FL-164', () => {
    it('aborts a stalled response body and removes its partial file before returning', async () => {
      let bodyCancelled = false;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('partial'));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
      );
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      const target = join(directory, 'stalled.bin');
      await expect(
        withOperationExecution({ renew: () => Promise.resolve(true), deadlineMs: 40, idleMs: 40 }, () =>
          sut.download(connection, 'o/stalled', bucketKey, target, null),
        ),
      ).rejects.toThrow();
      expect(bodyCancelled).toBe(true);
      expect(await readdir(directory)).toEqual([]);
    });

    it('downloads an object with the bucket key and moves it into place only when it matches its name', async () => {
      const body = randomBytes(1000);
      const name = sha256(body);
      s3.objects.set(`o/${name}`, { body, keyMd5: createHash('md5').update(bucketKey).digest('base64') });
      const target = join(directory, 'restored.jpg');

      await expect(sut.download(connection, `o/${name}`, bucketKey, target, name)).resolves.toEqual({
        size: 1000,
        sha256: name,
      });
      expect((await readFile(target)).equals(body)).toBe(true);
      s3.expectSseCOnEveryObjectCall();
    });

    it('refuses a download that does not match its name, and leaves nothing behind', async () => {
      const body = randomBytes(100);
      s3.objects.set('o/wrong', { body, keyMd5: createHash('md5').update(bucketKey).digest('base64') });
      const target = join(directory, 'restored.jpg');

      await expect(sut.download(connection, 'o/wrong', bucketKey, target, sha256(randomBytes(8)))).rejects.toThrow(
        'does not match its checksum',
      );
      expect(await readdir(directory)).toEqual([]);
    });

    it('hashes an object without keeping it', async () => {
      const body = randomBytes(500);
      s3.objects.set('o/any', { body, keyMd5: createHash('md5').update(bucketKey).digest('base64') });

      await expect(sut.hashObject(connection, 'o/any', bucketKey)).resolves.toEqual({
        size: 500,
        sha256: sha256(body),
      });
      expect(await readdir(directory)).toEqual([]);
    });

    it('waits for a freshly rotated managed key to become valid, and only for a while', async () => {
      sut.freshKeyRetryMs = 0;
      s3.failures = [
        { status: 403, code: 'InvalidAccessKeyId' },
        { status: 403, code: 'InvalidAccessKeyId' },
      ];

      await expect(sut.list({ ...connection, freshKeyUntil: Date.now() + 30_000 }, '')).resolves.toMatchObject({
        objects: [],
      });

      s3.failures = [{ status: 403, code: 'InvalidAccessKeyId' }];
      await expect(sut.list(connection, '')).rejects.toThrow('refused these credentials');
    });
  });
});

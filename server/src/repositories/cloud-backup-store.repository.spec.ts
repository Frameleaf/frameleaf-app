import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudBackupClaimError,
  CloudBackupConnection,
  CloudBackupFileChangedError,
  CloudBackupStoreError,
  CloudBackupStoreRepository,
  signS3Request,
} from 'src/repositories/cloud-backup-store.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { CLOUD_BACKUP_MARKER, CLOUD_BACKUP_PART_BYTES, CLOUD_BACKUP_PROBE_PREFIX } from 'src/utils/cloud-backup.js';

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
  /** Status codes to answer before the next request goes through. */
  failures: number[] = [];

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
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
      return new Response(`<Error><Code>SlowDown</Code></Error>`, { status: failure });
    }

    expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    if (body.length > 0) {
      expect(headers.get('x-amz-content-sha256')).toBe(createHash('sha256').update(body).digest('hex'));
      expect(headers.get('content-md5')).toBe(createHash('md5').update(body).digest('base64'));
    }

    const needsKey = (method === 'PUT' || method === 'GET' || method === 'HEAD' || method === 'POST') && key !== '';
    if (needsKey && !hasSseC) {
      return new Response('<Error><Code>InvalidRequest</Code></Error>', { status: 400 });
    }
    const keyMd5 = this.ignoresSseC ? null : headers.get('x-amz-server-side-encryption-customer-key-md5');
    const echo: Record<string, string> = this.ignoresSseC
      ? {}
      : { 'x-amz-server-side-encryption-customer-algorithm': 'AES256' };

    if (key === '' && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...this.objects.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(
          ([name, object]) =>
            `<Contents><Key>${name}</Key><Size>${object.body.length}</Size><ETag>"e"</ETag></Contents>`,
        )
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
      const numbers = [...upload.parts.keys()].toSorted((a, b) => a - b);
      this.objects.set(upload.key, {
        body: Buffer.concat(numbers.map((n) => upload.parts.get(n)!)),
        keyMd5: upload.keyMd5,
      });
      this.uploads.delete(uploadId);
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
  };

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
  endpoint: 'https://s3.eu-central-2.wasabisys.test',
  region: 'eu-central-2',
  bucket: 'family-backup',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret-example',
};

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe(CloudBackupStoreRepository.name, () => {
  let s3: FakeS3;
  let sut: CloudBackupStoreRepository;
  let directory: string;
  const bucketKey = randomBytes(32);

  beforeEach(async () => {
    s3 = new FakeS3();
    vi.stubGlobal('fetch', s3.fetch);
    sut = new CloudBackupStoreRepository(LoggingRepository.create());
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
    expect(s3.objects.get(`o/${sha256(content)}`)?.body).toEqual(content);

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
    expect(s3.objects.get(`o/${sha256(content)}`)?.body).toEqual(content);
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

  it('never puts the bucket key or the secret in an error message', async () => {
    s3.failures = [403];

    const error = await sut.get(connection, 'o/abc', bucketKey).catch((error_: unknown) => error_ as Error);

    expect(error.message).not.toContain(bucketKey.toString('base64'));
    expect(error.message).not.toContain(connection.secretAccessKey);
  });
});

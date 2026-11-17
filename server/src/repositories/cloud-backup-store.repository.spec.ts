import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudBackupClaimError,
  CloudBackupConnection,
  CloudBackupStoreError,
  CloudBackupStoreRepository,
  WRITE_REFUSED_MESSAGE,
  describeProviderError,
  signS3Request,
} from 'src/repositories/cloud-backup-store.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { CLOUD_BACKUP_MARKER, CLOUD_BACKUP_PROBE_PREFIX } from 'src/utils/cloud-backup.js';

vi.mock('undici', () => ({ fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));

type Seen = { method: string; key: string; query: URLSearchParams; headers: Headers };

/** An in-memory S3 bucket: ListObjectsV2 and PUT/GET/DELETE, path-style; every request is recorded. */
class FakeS3 {
  objects = new Map<string, Buffer>();
  seen: Seen[] = [];
  /** Answers to give before the next request goes through: a status, or a status with its error code. */
  failures: Array<number | { status: number; code: string }> = [];
  /** A bucket the credentials may list but not write. */
  refusesWrites = false;
  /** A bucket without versioning: a PUT answers no version id. */
  unversioned = false;

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
    this.seen.push({ method, key, query: url.searchParams, headers });
    const failure = this.failures.shift();
    if (failure) {
      const { status, code } = typeof failure === 'number' ? { status: failure, code: 'SlowDown' } : failure;
      return new Response(`<Error><Code>${code}</Code></Error>`, { status });
    }
    expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    // Nothing this server sends asks the provider to encrypt: everything is encrypted before it leaves.
    expect(headers.keys().some((name) => name.startsWith('x-amz-server-side-encryption'))).toBe(false);

    if (key === '' && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = this.objects
        .entries()
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, body]) => `<Contents><Key>${name}</Key><Size>${body.length}</Size><ETag>"e"</ETag></Contents>`)
        .toArray()
        .join('');
      return new Response(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    switch (method) {
      case 'PUT': {
        if (this.refusesWrites) {
          return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
        }
        this.objects.set(key, Buffer.from(init!.body as Uint8Array));
        return new Response('', {
          headers: { etag: '"etag-1"', ...(!this.unversioned && { 'x-amz-version-id': 'version-1' }) },
        });
      }
      case 'DELETE': {
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      }
      case 'GET': {
        const object = this.objects.get(key);
        return object
          ? new Response(new Uint8Array(object))
          : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      }
      default: {
        return new Response('', { status: 405 });
      }
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

describe(CloudBackupStoreRepository.name, () => {
  let s3: FakeS3;
  let sut: CloudBackupStoreRepository;

  beforeEach(() => {
    s3 = new FakeS3();
    vi.stubGlobal('fetch', s3.fetch);
    sut = new CloudBackupStoreRepository(LoggingRepository.create());
    sut.retryDelaysMs = [0, 0];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  describe('claim', () => {
    const options = { instanceId: 'instance-1', keyFingerprint: 'ABCD-1234', now: new Date('2026-09-26T03:00:00Z') };

    it('claims an empty bucket with a marker naming the server and its key, never the key itself', async () => {
      await expect(sut.claim(connection, options)).resolves.toEqual({
        existing: false,
        claimedAt: '2026-09-26T03:00:00.000Z',
      });
      expect(JSON.parse(s3.objects.get(CLOUD_BACKUP_MARKER)!.toString())).toEqual({
        format: 'frameleaf-backup',
        version: 1,
        instanceId: 'instance-1',
        keyFingerprint: 'ABCD-1234',
        claimedAt: '2026-09-26T03:00:00.000Z',
      });
    });

    it('keeps its own claim, with its backups, when set up again with the same key', async () => {
      await sut.claim(connection, options);
      s3.objects.set('r/v1/instance-1/config', Buffer.from('{}'));

      await expect(sut.claim(connection, { ...options, now: new Date() })).resolves.toEqual({
        existing: true,
        claimedAt: '2026-09-26T03:00:00.000Z',
      });
    });

    it('refuses a bucket another server claimed', async () => {
      await sut.claim(connection, { ...options, instanceId: 'instance-2' });
      await expect(sut.claim(connection, options)).rejects.toMatchObject({ reason: 'claimed-by-another-server' });
    });

    it('refuses a bucket claimed with another key', async () => {
      await sut.claim(connection, { ...options, keyFingerprint: 'FFFF-0000' });
      await expect(sut.claim(connection, options)).rejects.toMatchObject({ reason: 'other-key' });
    });

    it('refuses a bucket holding other files, and writes nothing to it', async () => {
      s3.objects.set('holiday.jpg', Buffer.from('x'));
      await expect(sut.claim(connection, options)).rejects.toMatchObject({ reason: 'not-empty' });
      expect(s3.objects.has(CLOUD_BACKUP_MARKER)).toBe(false);
    });

    it('refuses a bucket without versioning and leaves it as it found it', async () => {
      s3.unversioned = true;
      await expect(sut.claim(connection, options)).rejects.toMatchObject({ reason: 'versioning-off' });
      expect(s3.objects.size).toBe(0);
    });

    it('lists nothing in Frameleaf-managed storage, which is made for this one server', async () => {
      const managed = { ...connection, managedCredentials: () => Promise.resolve(connection) };
      await sut.claim(managed, options);
      expect(s3.seen.some(({ method, key }) => method === 'GET' && key === '')).toBe(false);
    });
  });

  describe('probe', () => {
    it('writes, reads back and deletes a test file', async () => {
      await expect(sut.probe(connection)).resolves.toEqual({ state: 'empty' });
      expect(s3.seen.find(({ method }) => method === 'PUT')!.key.startsWith(CLOUD_BACKUP_PROBE_PREFIX)).toBe(true);
      expect(s3.objects.size).toBe(0);
    });

    it('reports a bucket that is claimed or holds other files', async () => {
      s3.objects.set(CLOUD_BACKUP_MARKER, Buffer.from('{}'));
      await expect(sut.probe(connection)).resolves.toEqual({ state: 'claimed' });

      s3.objects.clear();
      s3.objects.set('holiday.jpg', Buffer.from('x'));
      await expect(sut.probe(connection)).resolves.toEqual({ state: 'not-empty' });
    });

    it('refuses a bucket without versioning and removes its test file', async () => {
      s3.unversioned = true;
      await expect(sut.probe(connection)).rejects.toMatchObject({ reason: 'versioning-off' });
      expect(s3.objects.size).toBe(0);
    });

    it('says the credentials cannot write when the test write is refused after the listing was allowed', async () => {
      s3.refusesWrites = true;
      const error = await sut.probe(connection).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(CloudBackupClaimError);
      expect(error).toMatchObject({ reason: 'write-refused', message: WRITE_REFUSED_MESSAGE });
    });
  });

  it('retries a request the provider was too busy for, and never one it refused', async () => {
    s3.failures = [503];
    await expect(sut.put(connection, 'frameleaf-backup-probe/x', Buffer.from('x'))).resolves.toMatchObject({
      etag: '"etag-1"',
    });

    s3.failures = [403];
    await expect(sut.put(connection, 'frameleaf-backup-probe/x', Buffer.from('x'))).rejects.toMatchObject({
      status: 403,
    });
    expect(s3.seen.filter(({ method }) => method === 'PUT')).toHaveLength(3);
  });

  it('names the common setup mistakes: a server clock that is off, and a bucket in another region', async () => {
    s3.failures = [{ status: 403, code: 'RequestTimeTooSkewed' }];
    await expect(sut.list(connection, '')).rejects.toThrow('clock is off');

    s3.failures = [{ status: 301, code: 'PermanentRedirect' }];
    await expect(sut.list(connection, '')).rejects.toThrow('regional endpoint');
  });

  it('reports a claim that is gone from an emptied or recreated bucket', async () => {
    await expect(sut.readMarker(connection)).rejects.toMatchObject({ reason: 'claim-missing' });
  });

  it('keeps provider text and credentials out of its errors', async () => {
    const upstream = `https://s3.example.test/?secret=${connection.secretAccessKey}`;
    s3.failures = [{ status: 403, code: upstream }];
    const error = await sut.list(connection, '').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(CloudBackupStoreError);
    expect(error).toMatchObject({ message: 'The storage provider refused GET family-backup: 403', code: null });
    expect(String(error)).not.toContain(connection.secretAccessKey);
    expect(describeProviderError(403, 'AccessDenied', 'GET x')).toBe(
      'The storage provider refused GET x: 403 AccessDenied',
    );

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(upstream)));
    const unreachable = await sut.get(connection, 'frameleaf-backup.json').catch((error_: unknown) => error_);
    expect(unreachable).toMatchObject({
      message: 'The storage provider could not be reached (GET frameleaf-backup.json).',
    });
    expect(String(unreachable)).not.toContain(upstream);
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

  it('gives the engine a folder for an offline copy, and the bucket under the vault otherwise', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cloud-backup-offline-'));
    try {
      const offline = sut.store({ ...connection, offlineDirectory: folder }, 'vault');
      await offline.put('config', Buffer.from('{}'));
      expect((await offline.list('config')).map(({ key }) => key)).toEqual(['config']);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
    expect(sut.store(connection, 'vault')).toMatchObject({ put: expect.any(Function), delete: expect.any(Function) });
  });
});

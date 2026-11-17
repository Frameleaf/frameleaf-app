import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { type Server, createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Source, Repository, backup, find, prune, readFile, verify } from '../src/index.js';
import { S3Error, s3Store, signS3Request } from '../src/s3.js';

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Enough of S3 to be honest: objects, ranges, paged listing, multipart, and refusals on demand. */
function standIn() {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Buffer[]>();
  const seen: { method: string; path: string; query: string; token: string | undefined }[] = [];
  const forced: { status: number; code: string }[] = [];
  const state = {
    objects,
    uploads,
    seen,
    forced,
    server: undefined as Server | undefined,
    /** Refuses the requests it picks, every time, until cleared. */
    refuseWhen: undefined as ((query: string) => { status: number; code: string } | undefined) | undefined,
  };
  const xml = (response: import('node:http').ServerResponse, status: number, body: string, headers = {}) => {
    response.writeHead(status, { 'content-type': 'application/xml', ...headers });
    response.end(body);
  };
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) {
      parts.push(part as Buffer);
    }
    const body = Buffer.concat(parts);
    const url = new URL(request.url!, 'http://stand-in');
    seen.push({
      method: request.method!,
      path: url.pathname,
      query: url.search,
      token: request.headers['x-amz-security-token'] as string | undefined,
    });
    const refusal = state.refuseWhen?.(url.search) ?? forced.shift();
    if (refusal) {
      return xml(response, refusal.status, `<Error><Code>${refusal.code}</Code></Error>`);
    }
    if (
      !request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=key/') ||
      request.headers['x-amz-content-sha256'] !== sha256(body)
    ) {
      return xml(response, 403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');
    }
    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
    const key = rest.join('/');
    if (bucket !== 'bucket') {
      return xml(response, 404, '<Error><Code>NoSuchBucket</Code></Error>');
    }
    const query = url.searchParams;
    if (request.method === 'GET' && !key) {
      const keys = [...objects.keys()].filter((name) => name.startsWith(query.get('prefix') ?? '')).sort();
      const from = Number(query.get('continuation-token') ?? 0);
      const page = keys.slice(from, from + 2);
      const more = from + 2 < keys.length;
      return xml(
        response,
        200,
        `<ListBucketResult><IsTruncated>${more}</IsTruncated>${page
          .map(
            (name) =>
              `<Contents><Key>${name}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>${objects.get(name)!.length}</Size></Contents>`,
          )
          .join('')}${more ? `<NextContinuationToken>${from + 2}</NextContinuationToken>` : ''}</ListBucketResult>`,
      );
    }
    const uploadId = query.get('uploadId');
    if (request.method === 'POST' && query.has('uploads')) {
      const id = randomBytes(6).toString('hex');
      uploads.set(id, []);
      return xml(
        response,
        200,
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (request.method === 'PUT' && uploadId) {
      uploads.get(uploadId)![Number(query.get('partNumber')) - 1] = body;
      return xml(response, 200, '', { etag: `"${sha256(body).slice(0, 8)}"` });
    }
    if (request.method === 'POST' && uploadId) {
      objects.set(key, Buffer.concat(uploads.get(uploadId)!));
      uploads.delete(uploadId);
      return xml(response, 200, '<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
    }
    if (request.method === 'DELETE' && uploadId) {
      uploads.delete(uploadId);
      return xml(response, 204, '');
    }
    if (request.method === 'PUT') {
      objects.set(key, body);
      return xml(response, 200, '', { etag: '"whole"' });
    }
    if (request.method === 'DELETE') {
      objects.delete(key);
      return xml(response, 204, '');
    }
    const stored = objects.get(key);
    if (!stored) {
      return xml(response, 404, '<Error><Code>NoSuchKey</Code></Error>');
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    const slice = !range
      ? stored
      : range[1] === ''
        ? stored.subarray(Math.max(0, stored.length - Number(range[2])))
        : stored.subarray(Number(range[1]), Number(range[2]) + 1);
    response.writeHead(range ? 206 : 200);
    response.end(slice);
  });
  state.server = server;
  return state as typeof state & { server: Server };
}

let s3: ReturnType<typeof standIn>;
let endpoint: string;
let asked: boolean[];
const open = (extra: Partial<Parameters<typeof s3Store>[0]> = {}) =>
  s3Store({
    endpoint,
    region: 'test-1',
    bucket: 'bucket',
    prefix: 'r/v1/vault/',
    retryDelaysMs: [1, 1],
    credentials: async (renew) => {
      asked.push(renew);
      return { accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: renew ? 'fresh' : 'first' };
    },
    ...extra,
  });

const close = async (server: Server) => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
};

beforeEach(async () => {
  s3 = standIn();
  asked = [];
  s3.server.listen(0, '127.0.0.1');
  await once(s3.server, 'listening');
  const address = s3.server.address();
  endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterEach(() => close(s3.server));

describe('signS3Request', () => {
  it('matches the example in the AWS documentation', () => {
    const headers = signS3Request({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      canonicalUri: '/test.txt',
      query: '',
      headers: { Range: 'bytes=0-9' },
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers.host).toBeUndefined();
  });
});

describe('s3Store', () => {
  it('puts, reads whole and in part, lists across pages and deletes, all under its prefix', async () => {
    const store = open();
    const body = randomBytes(5000);
    for (const key of ['p/aa', 'p/bb', 'p/cc', 'i/dd', 's/000000000001-abcdef01']) {
      await store.put(key, key === 'p/aa' ? body : Buffer.from(key));
    }
    expect([...s3.objects.keys()].every((key) => key.startsWith('r/v1/vault/'))).toBe(true);
    expect(await store.get('p/aa')).toEqual(body);
    expect(await store.get('p/aa', { start: 10, end: 20 })).toEqual(body.subarray(10, 20));
    expect(await store.get('p/aa', { suffix: 12 })).toEqual(body.subarray(4988));
    expect(await store.get('p/aa', { start: 5, end: 5 })).toEqual(Buffer.alloc(0));

    const listed = await store.list('p/');
    expect(listed.map((object) => object.key)).toEqual(['p/aa', 'p/bb', 'p/cc']);
    expect(listed[0]).toMatchObject({ size: 5000, modified: new Date('2026-01-01T00:00:00.000Z') });
    expect(s3.seen.filter((call) => call.query.includes('continuation-token')).length).toBe(1);

    await store.delete('p/bb');
    expect((await store.list('p/')).map((object) => object.key)).toEqual(['p/aa', 'p/cc']);
    expect(s3.seen.every((call) => call.token === 'first')).toBe(true);
    await expect(store.get('p/missing')).rejects.toMatchObject({ status: 404, code: 'NoSuchKey' });
  });

  it('sends a large object in parts, and clears the parts away if it cannot finish', async () => {
    const store = open({ partSize: 1024 });
    const body = randomBytes(3000);
    await store.put('p/large', body);
    expect(s3.objects.get('r/v1/vault/p/large')).toEqual(body);
    expect(s3.seen.filter((call) => call.query.includes('partNumber')).length).toBe(3);

    // The second part is refused in a way that trying again can't fix.
    s3.refuseWhen = (query) => (query.includes('partNumber=2') ? { status: 403, code: 'AccessDenied' } : undefined);
    await expect(store.put('p/broken', body)).rejects.toMatchObject({ status: 403, code: 'AccessDenied' });
    s3.refuseWhen = undefined;
    expect(s3.uploads.size).toBe(0);
    expect(s3.objects.has('r/v1/vault/p/broken')).toBe(false);
  });

  it('tries again after a busy answer, and gives up cleanly when the provider cannot be reached', async () => {
    const store = open();
    s3.forced.push({ status: 503, code: 'SlowDown' }, { status: 429, code: 'TooManyRequests' });
    await store.put('p/aa', Buffer.from('eventually'));
    expect(s3.objects.get('r/v1/vault/p/aa')?.toString()).toBe('eventually');

    s3.forced.push(
      { status: 503, code: 'SlowDown' },
      { status: 503, code: 'SlowDown' },
      { status: 503, code: 'SlowDown' },
    );
    await expect(store.get('p/aa')).rejects.toMatchObject({ status: 503 });

    await close(s3.server);
    const error = await store.get('p/aa').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(S3Error);
    expect(error).toMatchObject({ status: null });
    s3.server.listen(0, '127.0.0.1');
    await once(s3.server, 'listening');
  });

  it('asks for new credentials once when the provider says they expired', async () => {
    const store = open();
    s3.forced.push({ status: 400, code: 'ExpiredToken' });
    await store.put('p/aa', Buffer.from('renewed'));
    expect(asked).toEqual([false, true]);
    expect(s3.seen.at(-1)?.token).toBe('fresh');

    s3.forced.push({ status: 400, code: 'ExpiredToken' }, { status: 400, code: 'ExpiredToken' });
    await expect(store.put('p/bb', Buffer.from('never'))).rejects.toMatchObject({ code: 'ExpiredToken' });
  });

  it('holds an upload to the speed limit', async () => {
    const started = Date.now();
    await open({ uploadLimit: () => 400 * 1024 }).put('p/slow', randomBytes(200 * 1024));
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(s3.objects.get('r/v1/vault/p/slow')?.length).toBe(200 * 1024);
  });

  it('carries a whole repository: back up, restore, prune and verify through S3', async () => {
    const files: Record<string, Buffer> = { 'a.bin': randomBytes(90_000), 'b.txt': Buffer.from('hello '.repeat(5000)) };
    const source = (): Source => ({
      async list() {
        return Object.entries(files).map(([name, body]) => ({
          name,
          type: 'file' as const,
          mode: 0o644,
          uid: 0,
          gid: 0,
          mtime: 0,
          size: body.length,
          key: sha256(body),
        }));
      },
      async *read(path) {
        yield files[path[0]!]!;
      },
    });
    const rootKey = randomBytes(32);
    const options = { packTarget: 32 * 1024 };
    const repository = await Repository.init(open({ partSize: 8 * 1024 }), {
      rootKey,
      chunker: { min: 1024, avg: 4096, max: 16_384 },
    });
    await backup(repository, source(), options);
    files['a.bin'] = randomBytes(40_000);
    const second = await backup(repository, source(), options);
    expect(s3.seen.some((call) => call.query.includes('partNumber'))).toBe(true);

    // Another machine with only the bucket and the key.
    const elsewhere = await Repository.open(open(), { rootKey });
    await prune(elsewhere, {
      policy: { keepLast: 1, keepDays: 0, keepMonthly: 0 },
      minAgeDays: 0,
      packTarget: 32 * 1024,
    });
    expect(await verify(elsewhere, { readPack: () => true })).toMatchObject({
      snapshots: 1,
      missing: [],
      damagedPacks: [],
    });
    const snapshot = await elsewhere.readSnapshot(second.key);
    for (const [name, body] of Object.entries(files)) {
      const parts: Buffer[] = [];
      for await (const chunk of readFile(elsewhere, (await find(elsewhere, snapshot, [name]))!)) {
        parts.push(chunk);
      }
      expect(Buffer.concat(parts).equals(body)).toBe(true);
    }
    expect([...s3.objects.keys()].every((key) => /^r\/v1\/vault\/(config|[pis]\/[\w-]+)$/.test(key))).toBe(true);
  });
});

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudTransferError, FrameleafCloudMlRepository } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  CLOUD_UPLOAD_PART_BYTES,
  CloudOutputDownload,
  CloudUploadTarget,
  jobViewSchema,
} from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

// The fake storage and gateway listen on plain http on this machine, as a development cloud does.

type Seen = { method: string; path: string; headers: IncomingMessage['headers']; body: Buffer };

type FakeStorage = {
  url: string;
  seen: Seen[];
  handle: (request: Seen, response: ServerResponse) => void;
  close: () => Promise<void>;
};

const startFake = async (): Promise<FakeStorage> => {
  const fake: FakeStorage = {
    url: '',
    seen: [],
    handle: (_request, response) => response.end(),
    close: () => Promise.resolve(),
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const seen = {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      fake.seen.push(seen);
      fake.handle(seen, response);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
};

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

const HEADERS = {
  'x-amz-server-side-encryption-customer-algorithm': 'AES256',
  'x-amz-server-side-encryption-customer-key': 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=',
  'x-amz-server-side-encryption-customer-key-md5': 'Qy5a7cDqxXa3k9mBZ0mCFg==',
  'content-type': 'video/mp4',
};

/** Every gateway call carries a DPoP proof (FC-50); the fake storage does not check it. */
const dpop = {
  signer: { kid: 'kid', publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' }, sign: () => 'proof' },
  accessToken: 'token',
} as const;

describe('Frameleaf Cloud job storage and job reads (FL-162, FC-39, FC-42)', () => {
  let fake: FakeStorage;
  let folder: string;
  let cloud: FrameleafCloudRepository;
  let sut: FrameleafCloudMlRepository;

  beforeEach(async () => {
    fake = await startFake();
    folder = await mkdtemp(join(tmpdir(), 'fl162-'));
    const logger = { setContext: () => {}, warn: () => {}, log: () => {} } as unknown as LoggingRepository;
    cloud = new FrameleafCloudRepository(logger);
    sut = new FrameleafCloudMlRepository(cloud);
  });

  afterEach(async () => {
    await fake.close();
    await rm(folder, { recursive: true, force: true });
  });

  describe('long-polled job reads', () => {
    it('sends If-None-Match, answers a 304 as not modified and hands back ETag and Retry-After', async () => {
      const view = cloudContractFixture<unknown>('ml/job-running.json');
      fake.handle = (request, response) => {
        if (request.headers['if-none-match'] === '"v1"') {
          response.writeHead(304, { etag: '"v1"', 'retry-after': '7' }).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json', etag: '"v1"', 'retry-after': '5' });
        response.end(JSON.stringify(view));
      };

      const first = await cloud.requestJsonConditional(jobViewSchema, { url: `${fake.url}/v2/jobs/x`, dpop }, null);
      expect(first).toMatchObject({ notModified: false, etag: '"v1"', retryAfterSeconds: 5 });
      expect(!first.notModified && first.data.status).toBe('running');

      const second = await cloud.requestJsonConditional(jobViewSchema, { url: `${fake.url}/v2/jobs/x`, dpop }, '"v1"');
      expect(second).toEqual({ notModified: true, etag: '"v1"', retryAfterSeconds: 7 });
      expect(fake.seen[0].headers['if-none-match']).toBeUndefined();
      expect(fake.seen[1].headers['if-none-match']).toBe('"v1"');
    });

    it('reads a job answer larger than the gateway limit when the caller allows it', async () => {
      const view = cloudContractFixture<unknown>('ml/job-queued.json');
      fake.handle = (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        // 300 KiB of whitespace keeps the answer valid JSON above the 256 KiB default
        response.end(JSON.stringify(view) + ' '.repeat(300 * 1024));
      };
      await expect(cloud.requestJson(jobViewSchema, { url: `${fake.url}/v2/jobs/x`, dpop })).rejects.toThrow(
        'Frameleaf Cloud response is too large',
      );
      await expect(
        cloud.requestJson(jobViewSchema, { url: `${fake.url}/v2/jobs/x`, dpop, maxBodyBytes: 1024 * 1024 }),
      ).resolves.toMatchObject({ status: 'queued' });
    });
  });

  describe('uploads', () => {
    const target = (overrides: Partial<CloudUploadTarget>): CloudUploadTarget => ({
      inputId: 'v1',
      bytes: 10,
      contentType: 'video/mp4',
      sha256: 'a'.repeat(64),
      method: 'inline',
      headers: HEADERS,
      inline: { url: `${fake.url}/in/v1?X-Amz-Signature=1`, method: 'PUT' },
      multipart: null,
      uploaded: false,
      expiresAt: '2026-09-26T04:16:00.000Z',
      ...overrides,
    });

    it('puts a small input in one request with the target headers exactly', async () => {
      const file = join(folder, 'small.mp4');
      await writeFile(file, Buffer.from('0123456789'));
      await sut.uploadInput({ url: fake.url }, target({}), file);

      expect(fake.seen).toHaveLength(1);
      expect(fake.seen[0]).toMatchObject({ method: 'PUT', path: '/in/v1?X-Amz-Signature=1' });
      expect(fake.seen[0].body.toString()).toBe('0123456789');
      for (const [name, value] of Object.entries(HEADERS)) {
        expect(fake.seen[0].headers[name]).toBe(value);
      }
    });

    it('sends a large input in 8 MiB parts, records each part, completes it, and resumes without the parts it has', async () => {
      const bytes = CLOUD_UPLOAD_PART_BYTES + 5;
      const data = Buffer.alloc(bytes, 7);
      const file = join(folder, 'large.mp4');
      await writeFile(file, data);
      const multipart = target({
        method: 'multipart',
        bytes,
        inline: null,
        multipart: {
          partBytes: CLOUD_UPLOAD_PART_BYTES,
          parts: [
            { partNumber: 1, url: `${fake.url}/in/v1?partNumber=1`, bytes: CLOUD_UPLOAD_PART_BYTES },
            { partNumber: 2, url: `${fake.url}/in/v1?partNumber=2`, bytes: 5 },
          ],
          completeUrl: `${fake.url}/in/v1?uploadId=u1`,
        },
      });
      fake.handle = (request, response) => {
        const number = /partNumber=(\d+)/.exec(request.path)?.[1];
        response.writeHead(200, number ? { etag: `"e${number}"` } : {});
        response.end(number ? '' : '<CompleteMultipartUploadResult/>');
      };

      const recorded: Array<{ partNumber: number; etag: string }> = [];
      await sut.uploadInput({ url: fake.url }, multipart, file, {
        onPart: (part) => {
          recorded.push(part);
          return Promise.resolve(true);
        },
      });
      expect(recorded).toEqual([
        { partNumber: 1, etag: '"e1"' },
        { partNumber: 2, etag: '"e2"' },
      ]);
      expect(fake.seen.map((request) => request.body.length)).toEqual([CLOUD_UPLOAD_PART_BYTES, 5, expect.any(Number)]);
      expect(fake.seen[2].method).toBe('POST');
      expect(fake.seen[2].body.toString()).toBe(
        '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag></Part>' +
          '<Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag></Part></CompleteMultipartUpload>',
      );

      // a resumed upload sends only the part that is missing, then completes with both
      fake.seen.length = 0;
      await sut.uploadInput({ url: fake.url }, multipart, file, { done: [{ partNumber: 1, etag: '"e1"' }] });
      expect(fake.seen.map((request) => request.path)).toEqual(['/in/v1?partNumber=2', '/in/v1?uploadId=u1']);
    });

    it('stops between parts when asked, and refuses a prepared file whose size changed', async () => {
      const bytes = CLOUD_UPLOAD_PART_BYTES + 5;
      const file = join(folder, 'large.mp4');
      await writeFile(file, Buffer.alloc(bytes, 1));
      const multipart = target({
        method: 'multipart',
        bytes,
        inline: null,
        multipart: {
          partBytes: CLOUD_UPLOAD_PART_BYTES,
          parts: [
            { partNumber: 1, url: `${fake.url}/in/v1?partNumber=1`, bytes: CLOUD_UPLOAD_PART_BYTES },
            { partNumber: 2, url: `${fake.url}/in/v1?partNumber=2`, bytes: 5 },
          ],
          completeUrl: `${fake.url}/in/v1?uploadId=u1`,
        },
      });
      fake.handle = (_request, response) => response.writeHead(200, { etag: '"e"' }).end();

      await expect(
        sut.uploadInput({ url: fake.url }, multipart, file, { onPart: () => Promise.resolve(false) }),
      ).rejects.toMatchObject({ failure: 'stopped' });
      expect(fake.seen).toHaveLength(1);

      await expect(sut.uploadInput({ url: fake.url }, { ...multipart, bytes: bytes + 1 }, file)).rejects.toMatchObject({
        failure: 'input-changed',
      });
    });

    it('never sends an input to an address that is not Frameleaf Cloud storage', async () => {
      const file = join(folder, 'small.mp4');
      await writeFile(file, Buffer.from('0123456789'));
      const elsewhere = target({ inline: { url: 'https://storage.example.com/in/v1', method: 'PUT' } });

      await expect(sut.uploadInput({ url: fake.url }, elsewhere, file)).rejects.toBeInstanceOf(CloudTransferError);
      expect(fake.seen).toHaveLength(0);
    });

    it('asks for a new address when storage refuses an expired one', async () => {
      const file = join(folder, 'small.mp4');
      await writeFile(file, Buffer.from('0123456789'));
      fake.handle = (_request, response) => response.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>');

      await expect(sut.uploadInput({ url: fake.url }, target({}), file)).rejects.toMatchObject({
        failure: 'target-expired',
      });
    });
  });

  describe('downloads', () => {
    const body = Buffer.from('restored video bytes');
    const output = (overrides: Partial<CloudOutputDownload> = {}): CloudOutputDownload => ({
      outputId: 'v1',
      url: `${fake.url}/out/v1?X-Amz-Signature=2`,
      sha256: sha256(body),
      bytes: body.length,
      contentType: 'video/mp4',
      ...overrides,
    });

    it('keeps an output only when its size and SHA-256 match, sending the storage headers', async () => {
      fake.handle = (_request, response) => response.writeHead(200).end(body);
      const destination = join(folder, 'out.mp4');

      await sut.downloadOutput({ url: fake.url }, output(), HEADERS, destination);
      expect(await readFile(destination)).toEqual(body);
      const key = 'x-amz-server-side-encryption-customer-key';
      expect(fake.seen[0].headers[key]).toBe(HEADERS[key]);
    });

    it('removes an output that does not match its SHA-256 and refuses it', async () => {
      fake.handle = (_request, response) => response.writeHead(200).end(Buffer.from('tampered video bytes'));
      const destination = join(folder, 'out.mp4');

      await expect(sut.downloadOutput({ url: fake.url }, output(), HEADERS, destination)).rejects.toMatchObject({
        failure: 'sha256-mismatch',
      });
      await expect(stat(destination)).rejects.toThrow();
    });

    it('refuses an output longer than its record without keeping any of it', async () => {
      fake.handle = (_request, response) => response.writeHead(200).end(Buffer.concat([body, body]));
      const destination = join(folder, 'out.mp4');

      await expect(sut.downloadOutput({ url: fake.url }, output(), HEADERS, destination)).rejects.toMatchObject({
        failure: 'sha256-mismatch',
      });
      await expect(stat(destination)).rejects.toThrow();
    });

    it('never writes over an existing file', async () => {
      fake.handle = (_request, response) => response.writeHead(200).end(body);
      const destination = join(folder, 'out.mp4');
      await writeFile(destination, 'original');

      await expect(sut.downloadOutput({ url: fake.url }, output(), HEADERS, destination)).rejects.toThrow();
      expect((await readFile(destination)).toString()).toBe('original');
    });
  });
});

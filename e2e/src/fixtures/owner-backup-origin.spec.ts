import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerBackupOrigin } from './owner-backup-origin.js';

vi.mock('node:https', () => ({ createServer: vi.fn() }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});

const request = () => {
  const key = Buffer.alloc(32, 7);
  // a plain stream stands in for the request: the handler reads only these fields and the body
  return Object.assign(Readable.from([]), {
    method: 'GET',
    url: '/bucket/object',
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=FL234FIXTURE/test, SignedHeaders=host, Signature=${'a'.repeat(64)}`,
      'x-amz-server-side-encryption-customer-algorithm': 'AES256',
      'x-amz-server-side-encryption-customer-key': key.toString('base64'),
      'x-amz-server-side-encryption-customer-key-md5': createHash('md5').update(key).digest('base64'),
    },
  }) as unknown as IncomingMessage;
};

describe('OwnerBackupOrigin stream lifecycle', () => {
  // Exercise the real request handler and file streams without opening a port or using TLS credentials.
  let folder: string;
  let origin: OwnerBackupOrigin;
  let handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'owner-origin-stream-'));
    const certificate = join(folder, 'synthetic-certificate');
    await writeFile(certificate, 'test handler only');
    vi.stubEnv('FL234_S3_TLS_CERT', certificate);
    vi.stubEnv('FL234_S3_TLS_KEY', certificate);
    vi.mocked(createServer).mockImplementation((_options, handler) => {
      handle = handler as typeof handle;
      return {
        listen: (_port: number, _host: string, ready: () => void) => ready(),
        address: () => ({ port: 1 }),
        closeAllConnections: () => {},
        close: (done: () => void) => done(),
      } as never;
    });
    origin = new OwnerBackupOrigin();
    await origin.start();
  });
  afterEach(async () => {
    await origin.close();
    vi.unstubAllEnvs();
    await rm(folder, { recursive: true, force: true });
  });

  class Response extends Writable {
    headersSent = false;
    statusCode = 200;
    readonly chunks: Buffer[] = [];
    constructor(private disconnect = false) {
      super({ highWaterMark: 1 });
    }
    setHeader() {}
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    }
    override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void) {
      this.chunks.push(Buffer.from(chunk));
      if (this.disconnect) {
        this.destroy();
      } else {
        done();
      }
    }
  }

  it('ends a backpressured file read when its client disconnects without recording a provider failure', async () => {
    const path = join(folder, 'object');
    await writeFile(path, Buffer.alloc(128 * 1024));
    origin.files.set('object', { path, size: 128 * 1024 });
    const response = new Response(true);
    let settled = false;
    const serving = (async () => {
      try {
        await handle(request(), response as unknown as ServerResponse);
      } finally {
        settled = true;
      }
    })();
    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 300 });
      expect(vi.mocked(createReadStream).mock.results.at(-1)!.value.destroyed).toBe(true);
      expect(origin.errors).toEqual([]);
    } finally {
      if (!settled) {
        response.emit('error', new Error('Release old drain wait for fixture cleanup'));
      }
      await serving;
    }
  });

  it('still records a real file read failure as a provider fixture failure', async () => {
    origin.files.set('object', { path: join(folder, 'missing'), size: 1 });
    const response = new Response();
    await handle(request(), response as unknown as ServerResponse);
    expect(origin.errors).toEqual([expect.objectContaining({ code: 'ENOENT' })]);
    expect(response.statusCode).toBe(500);
  });

  it('delivers the first file chunk before the authority hook and preserves all bytes', async () => {
    const path = join(folder, 'object');
    const bytes = Buffer.alloc(128 * 1024, 7);
    await writeFile(path, bytes);
    origin.files.set('object', { path, size: bytes.length });
    const response = new Response();
    const hook = vi.fn(() => {
      expect(response.chunks.length).toBeGreaterThan(0);
      return Promise.resolve();
    });
    origin.beforeRead = { key: 'object', run: hook };
    await handle(request(), response as unknown as ServerResponse);
    expect(hook).toHaveBeenCalledOnce();
    expect(origin.beforeRead).toBeNull();
    expect(Buffer.concat(response.chunks)).toEqual(bytes);
    expect(origin.errors).toEqual([]);
  });

  it('keeps a failed authority interleave visible rather than counting it as an app refusal', async () => {
    const path = join(folder, 'object');
    await writeFile(path, Buffer.alloc(128 * 1024));
    origin.files.set('object', { path, size: 128 * 1024 });
    const error = new Error('Authority hook failed');
    origin.beforeRead = { key: 'object', run: () => Promise.reject(error) };
    await handle(request(), new Response() as unknown as ServerResponse);
    expect(origin.errors).toEqual([error]);
  });
});

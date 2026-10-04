import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';

/** Owned TLS provider fixture: plaintext bytes + SSE-C header echo, not provider encryption certification. */
export class OwnerBackupOrigin {
  private server: Server | null = null;
  private customerKey: string | null = null;
  readonly objects = new Map<string, Buffer>();
  readonly files = new Map<string, { path: string; size: number }>();
  readonly seen: Array<{ method: string; key: string; signed: boolean; customerKey: boolean }> = [];
  readonly errors: unknown[] = [];
  beforeRead: { key: string; run: () => Promise<void> } | null = null;

  async start() {
    const cert = process.env.FL234_S3_TLS_CERT;
    const key = process.env.FL234_S3_TLS_KEY;
    assert.ok(cert && key, 'Owned TLS fixture certificate/key paths required; never disable TLS verification');
    this.server = createServer({ cert: await readFile(cert), key: await readFile(key) }, async (req, res) => {
      try {
        const url = new URL(req.url!, 'https://fixture.invalid');
        const objectKey = url.pathname
          .split('/')
          .slice(2)
          .map((part) => decodeURIComponent(part))
          .join('/');
        const authorization = req.headers.authorization ?? '';
        assert.match(authorization, /^AWS4-HMAC-SHA256 Credential=FL234FIXTURE\//);
        assert.match(authorization, /Signature=[a-f\d]{64}$/);
        const signed = /SignedHeaders=[^,]*host/.test(authorization);
        assert.ok(signed);
        const customerKey = req.headers['x-amz-server-side-encryption-customer-key'];
        const encrypted = typeof customerKey === 'string';
        if (objectKey && ['GET', 'PUT', 'HEAD'].includes(req.method!)) {
          assert.equal(req.headers['x-amz-server-side-encryption-customer-algorithm'], 'AES256');
          assert.ok(encrypted);
          assert.equal(
            req.headers['x-amz-server-side-encryption-customer-key-md5'],
            createHash('md5').update(Buffer.from(customerKey!, 'base64')).digest('base64'),
          );
          this.customerKey ??= customerKey!;
          assert.ok(customerKey === this.customerKey, 'Customer key identity must match fixture claim');
          res.setHeader('x-amz-server-side-encryption-customer-algorithm', 'AES256');
        }
        this.seen.push({ method: req.method!, key: objectKey, signed, customerKey: encrypted });
        if (req.method === 'GET' && !objectKey) {
          const prefix = url.searchParams.get('prefix') ?? '';
          res.end(
            `<ListBucketResult>${[...this.objects]
              .filter(([name]) => name.startsWith(prefix))
              .map(
                ([name, body]) =>
                  `<Contents><Key>${name}</Key><Size>${body.length}</Size><ETag>"fixture"</ETag></Contents>`,
              )
              .join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`,
          );
          return;
        }
        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            assert.ok(size <= 9 * 1024 * 1024, 'Owned fixture write ceiling');
            chunks.push(Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks);
          assert.equal(req.headers['x-amz-content-sha256'], createHash('sha256').update(body).digest('hex'));
          assert.equal(req.headers['content-md5'], createHash('md5').update(body).digest('base64'));
          this.objects.set(objectKey, body);
          res.setHeader('etag', '"fixture"');
          res.end();
          return;
        }
        if (req.method === 'DELETE') {
          this.objects.delete(objectKey);
          res.writeHead(204).end();
          return;
        }
        const file = this.files.get(objectKey);
        const body = this.objects.get(objectKey);
        if (!body && !file) {
          res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
          return;
        }
        if (req.method === 'HEAD') {
          res.setHeader('content-length', file?.size ?? body!.length);
          res.end();
          return;
        }
        assert.equal(req.method, 'GET');
        const hook = this.beforeRead?.key === objectKey ? this.beforeRead : null;
        if (hook) {
          this.beforeRead = null;
        }
        if (file) {
          res.setHeader('content-length', file.size);
          let first = true;
          for await (const chunk of createReadStream(file.path)) {
            if (!res.write(chunk)) {
              await once(res, 'drain');
            }
            if (first && hook) {
              await hook.run();
            }
            first = false;
          }
          res.end();
          return;
        }
        // A real chunk reaches the app before the normal-API/DB fixture interleave. No app response interception.
        res.write(body!.subarray(0, 1));
        if (hook) {
          await hook.run();
        }
        res.end(body!.subarray(1));
      } catch (error) {
        this.errors.push(error);
        if (res.headersSent) {
          res.destroy();
        } else {
          res.writeHead(500).end('Owned fixture failed');
        }
      }
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '0.0.0.0', resolve));
    const { port } = this.server.address() as AddressInfo;
    // Fixture cert must name this host; the server container must trust its owned CA through NODE_EXTRA_CA_CERTS.
    return `https://host.docker.internal:${port}`;
  }

  async close() {
    if (!this.server) {
      return;
    }
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server!.close((error) => (error ? reject(error) : resolve())));
  }
}

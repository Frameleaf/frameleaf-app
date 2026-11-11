import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, get } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { selfSignedCertificateArguments } from '../src/tls-certificate.js';

test('generated certificate verifies the configured host after explicit trust', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-generated-tls-'));
  const key = join(directory, 'tls.key'), cert = join(directory, 'tls.crt');
  let server: ReturnType<typeof createServer> | undefined;
  try {
    execFileSync('openssl', selfSignedCertificateArguments('https://127.0.0.1', key, cert), { stdio: 'ignore' });
    const certificate = await readFile(cert);
    const parsed = new X509Certificate(certificate);
    assert.equal(parsed.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(parsed.publicKey.asymmetricKeyDetails?.modulusLength, 3072);
    assert.ok(parsed.verify(parsed.publicKey));
    server = createServer({ key: await readFile(key), cert: certificate }, (_request, response) => response.end('trusted'));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (ca?: Buffer) => new Promise<string>((resolve, reject) => {
      get(url, { ca }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (data) => body += data);
        response.on('end', () => resolve(body));
      }).on('error', reject);
    });
    await assert.rejects(request(), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    assert.equal(await request(certificate), 'trusted');
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

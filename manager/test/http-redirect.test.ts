// FL-462: typing IP:9443 makes browsers try http://; Manager answered with an empty reply.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createHttps, request as httpsRequest } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sharePortWithRedirect } from '../src/http-redirect.js';

const get = (send: typeof httpRequest, port: number, host: string) =>
  new Promise<{ status?: number; location?: string; body: string }>((resolve, reject) => {
    const request = send(
      { port, host: '127.0.0.1', path: '/manager-api/status', headers: { host }, rejectUnauthorized: false } as never,
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });

test('plain HTTP on the Manager port redirects to HTTPS on the same host and port; TLS is unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-redirect-'));
  const key = join(directory, 'tls.key'),
    cert = join(directory, 'tls.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const https = createHttps({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => {
    response.end('manager');
  });
  const front = sharePortWithRedirect(https);
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  const { port } = front.address() as AddressInfo;
  try {
    const plain = await get(httpRequest, port, `192.168.1.20:${port}`);
    assert.equal(plain.status, 308);
    assert.equal(plain.location, `https://192.168.1.20:${port}/`);
    const secure = await get(httpsRequest, port, `192.168.1.20:${port}`);
    assert.equal(secure.status, 200);
    assert.equal(secure.body, 'manager');
    // A Host header is echoed into Location only when it is a plain host[:port].
    const raw = await new Promise<string>((resolve, reject) => {
      let reply = '';
      const socket = connect(port, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: evil example/x\r\n\r\n'));
      socket.on('data', (chunk) => (reply += chunk));
      socket.on('end', () => resolve(reply));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400 /);
    assert.doesNotMatch(raw, /Location/i);
  } finally {
    front.close();
    https.close();
    await rm(directory, { recursive: true });
  }
});

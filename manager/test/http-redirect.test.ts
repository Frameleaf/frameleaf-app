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
    // Review L10: the Host line may arrive in a later TCP segment than the request line.
    const exchange = (segments: string[], gapMs = 30) =>
      new Promise<string>((resolve, reject) => {
        let reply = '';
        const socket = connect(port, '127.0.0.1', async () => {
          for (const segment of segments) {
            socket.write(segment);
            await new Promise((pause) => setTimeout(pause, gapMs));
          }
        });
        socket.on('data', (chunk) => (reply += chunk));
        socket.on('end', () => resolve(reply));
        socket.on('error', reject);
      });
    const slow = await exchange(['GET / HTTP/1.1\r\n', `Host: 192.168.1.20:${port}\r\nUser-Agent: slow\r\n`, '\r\n']);
    assert.match(slow, /^HTTP\/1\.1 308 /);
    assert.match(slow, new RegExp(`Location: https://192\\.168\\.1\\.20:${port}/`));
    const bare = await exchange(['GET / HTTP/1.1\n', 'Host: tower.local\n\n']);
    assert.match(bare, /Location: https:\/\/tower\.local\//);
    // A head that never ends is answered once 8 KiB have arrived, not held forever.
    const oversized = await exchange(['GET / HTTP/1.1\r\n', `X-Padding: ${'a'.repeat(9000)}\r\n`]);
    assert.match(oversized, /^HTTP\/1\.1 400 /);
    // A Host line after the blank line belongs to the body, not the head.
    const body = await exchange(['GET / HTTP/1.1\r\nContent-Length: 20\r\n\r\n', 'Host: evil.test\r\n']);
    assert.match(body, /^HTTP\/1\.1 400 /);
  } finally {
    front.close();
    https.close();
    await rm(directory, { recursive: true });
  }
});

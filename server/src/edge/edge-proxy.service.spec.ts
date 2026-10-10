import http, { type IncomingHttpHeaders } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { EdgeArrival, EdgeProxyService, downstreamHeaders, upstreamHeaders } from 'src/edge/edge-proxy.service.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MAX_CONNECTIONS_PER_ADDRESS, REQUEST_TIMEOUT_MS } from 'src/utils/frameleaf-remote-access.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';

const SECRET = 'edge-secret-0123456789abcdef';
const arrival: EdgeArrival = { via: 'wan', clientIp: '203.0.113.9', host: 'r.u225vlzhsdlhwh4l.frameleaf.net' };

const listen = (server: net.Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe(EdgeProxyService.name, () => {
  describe('headers', () => {
    it('adds the via contract and drops what a visitor may not claim', () => {
      const headers = upstreamHeaders(
        {
          host: 'r.u225vlzhsdlhwh4l.frameleaf.net',
          cookie: 'immich_access_token=abc',
          range: 'bytes=0-99',
          connection: 'keep-alive, x-custom-hop',
          'x-custom-hop': 'dropped',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
          'x-forwarded-for': '10.0.0.1',
          'x-forwarded-proto': 'http',
          'x-forwarded-host': 'evil.example',
          forwarded: 'for=10.0.0.1',
          'x-real-ip': '10.0.0.1',
          'x-frameleaf-via': 'lan',
          'x-frameleaf-via-auth': 'guess',
          'x-frameleaf-anything': 'dropped',
          'x-frameleaf-worker-session': 'kept',
        },
        arrival,
        SECRET,
      );
      expect(headers).toEqual({
        host: 'r.u225vlzhsdlhwh4l.frameleaf.net',
        cookie: 'immich_access_token=abc',
        range: 'bytes=0-99',
        'x-frameleaf-worker-session': 'kept',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'r.u225vlzhsdlhwh4l.frameleaf.net',
        'x-frameleaf-via': 'wan',
        'x-frameleaf-via-auth': SECRET,
      });
    });

    it('keeps an upgrade and sets HSTS on every answer', () => {
      const headers = upstreamHeaders({ upgrade: 'websocket', connection: 'Upgrade' }, arrival, SECRET, 'websocket');
      expect(headers).toMatchObject({ connection: 'upgrade', upgrade: 'websocket' });
      expect(downstreamHeaders({ 'content-type': 'text/plain', connection: 'keep-alive' })).toEqual({
        'content-type': 'text/plain',
        'strict-transport-security': 'max-age=31536000',
      });
    });
  });

  describe('proxying', () => {
    let upstream: http.Server;
    let front: net.Server;
    let frontPort: number;
    let seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: string }>;
    let sut: EdgeProxyService;
    let secret: string | null;

    beforeEach(async () => {
      seen = [];
      secret = SECRET;
      upstream = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.on('end', () => {
          seen.push({
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: Buffer.concat(chunks).toString(),
          });
          if (request.headers.range === 'bytes=2-4') {
            response.writeHead(206, { 'content-range': 'bytes 2-4/10', 'content-length': '3' });
            response.end('234');
            return;
          }
          response.writeHead(200, { 'content-type': 'text/plain', connection: 'keep-alive' });
          response.end('0123456789');
        });
      });
      upstream.on('upgrade', (_request, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        socket.pipe(socket);
      });
      const upstreamPort = await listen(upstream);

      const config = {
        getEnv: () =>
          mockEnvData({
            port: upstreamPort,
            frameleafCloud: {
              ...mockEnvData({}).frameleafCloud,
              edge: { port: 2443, bind: '0.0.0.0', secret, acmeDirectoryUrl: null },
            },
          }),
      } as unknown as ConfigRepository;
      const logger = { setContext: vi.fn(), warn: vi.fn() } as unknown as LoggingRepository;
      sut = new EdgeProxyService(logger, config);
      // a plain TCP front stands in for the TLS listener
      front = net.createServer((socket) => sut.accept(socket, arrival));
      frontPort = await listen(front);
    });

    afterEach(async () => {
      sut.destroy();
      await close(front);
      await close(upstream);
    });

    const request = (options: http.RequestOptions, body?: string[]) =>
      new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const outgoing = http.request({ host: '127.0.0.1', port: frontPort, agent: false, ...options }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text });
          });
        });
        outgoing.on('error', reject);
        for (const chunk of body ?? []) {
          outgoing.write(chunk);
        }
        outgoing.end();
      });

    it('proxies to the API with the via contract and HSTS', async () => {
      const response = await request({
        path: '/api/server/ping',
        headers: { host: 'r.u225vlzhsdlhwh4l.frameleaf.net', 'x-frameleaf-via': 'lan' },
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe('0123456789');
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
      expect(seen[0].headers).toMatchObject({
        'x-frameleaf-via': 'wan',
        'x-frameleaf-via-auth': SECRET,
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-proto': 'https',
      });
    });

    it('restricts recovery SNI before proxying and forwards only its trusted host', async () => {
      const host = 'recovery.u225vlzhsdlhwh4l.frameleaf.net';
      const vaultId = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';
      const path = `/api/buddy/v1/vaults/${vaultId}/snapshots`;
      sut.configureRecovery({
        host,
        vaultId,
        pairId: '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e54',
        sourceInstanceId: '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e55',
        readUntil: null,
      });
      front.removeAllListeners('connection');
      front.on('connection', (socket) => sut.accept(socket, { ...arrival, host, buddyRecovery: true }));
      for (const options of [
        { path: '/api/server/ping' },
        { path: path + '?ignored=1' },
        { path, method: 'POST' },
        { path, headers: { host: 'ordinary.example' } },
        { path, headers: { host, upgrade: 'websocket', connection: 'Upgrade' } },
      ]) {
        expect((await request({ headers: { host }, ...options })).status).toBe(403);
      }
      expect(seen).toHaveLength(0);
      expect(
        (
          await request({
            path,
            headers: { host, 'x-forwarded-host': 'ordinary.example', dpop: 'proof', authorization: 'DPoP grant' },
          })
        ).status,
      ).toBe(200);
      expect(seen[0].headers).toMatchObject({
        'x-forwarded-host': host,
        'x-frameleaf-via-auth': SECRET,
        dpop: 'proof',
        authorization: 'DPoP grant',
      });
      sut.configureRecovery(null);
      expect((await request({ path, headers: { host } })).status).toBe(403);
      expect(seen).toHaveLength(1);
    });

    it('restricts every paid Buddy-only arrival, including direct ports, while ordinary access is off', async () => {
      const vaultId = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';
      const path = `/api/buddy/v1/vaults/${vaultId}/snapshots`;
      const access = {
        host: 'recovery.u225vlzhsdlhwh4l.frameleaf.net',
        vaultId,
        pairId: '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e54',
        sourceInstanceId: '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e55',
        readUntil: null,
        backupEnabled: true as const,
        writeAllowed: true as const,
      };
      sut.configureRecovery(access, true);
      const host = arrival.host! + ':2443';
      expect((await request({ path: '/api/server/ping', headers: { host } })).status).toBe(403);
      expect((await request({ path, method: 'POST', headers: { host } }, ['snapshot'])).status).toBe(200);
      expect(seen[0].headers['x-forwarded-host']).toBe(host);
      expect((await request({ path, method: 'POST', headers: { host: 'evil.example' } })).status).toBe(403);
      sut.configureRecovery({ ...access, writeAllowed: undefined }, true);
      expect((await request({ path, method: 'POST', headers: { host } })).status).toBe(403);
      expect((await request({ path, headers: { host } })).status).toBe(200);
      expect(seen).toHaveLength(2);
    });

    it('streams a chunked upload and passes ranges through', async () => {
      const chunked = { method: 'POST', path: '/api/assets', headers: { 'transfer-encoding': 'chunked' } };
      const upload = await request(chunked, ['part-1;', 'part-2;', 'part-3']);
      expect(upload.status).toBe(200);
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/assets', body: 'part-1;part-2;part-3' });
      expect(seen[0].headers['transfer-encoding']).toBe('chunked');

      const range = await request({ path: '/api/assets/1/original', headers: { range: 'bytes=2-4' } });
      expect(range).toMatchObject({ status: 206, body: '234' });
      expect(range.headers['content-range']).toBe('bytes 2-4/10');
    });

    it.each(['wan', 'relay'] as const)('forwards informational upload responses on %s arrivals', async (via) => {
      front.removeAllListeners('connection');
      front.on('connection', (socket) => sut.accept(socket, { ...arrival, via }));
      upstream.removeAllListeners('request');
      upstream.on('request', (_request, response) => {
        // Node24.18 added this public API; the pinned Node type package predates it.
        (
          response as http.ServerResponse & {
            writeInformation(statusCode: number, headers: http.OutgoingHttpHeaders): void;
          }
        ).writeInformation(104, {
          location: '/api/uploads/owned-resource',
          'upload-draft-interop-version': '9',
          'upload-offset': '0',
          connection: 'keep-alive',
        });
        response.writeEarlyHints({ link: '</assets/app.css>; rel=preload; as=style' });
        response.end('completed');
      });
      const information: Array<{ status: number; headers: IncomingHttpHeaders }> = [];
      const final = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = http.request({ host: '127.0.0.1', port: frontPort, agent: false, path: '/api/uploads' });
        outgoing.on('information', (answer) => {
          information.push({ status: answer.statusCode, headers: answer.headers });
        });
        outgoing.on('response', (answer) => {
          const chunks: Buffer[] = [];
          answer.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          answer.on('end', () => resolve({ status: answer.statusCode!, body: Buffer.concat(chunks).toString() }));
          answer.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.end();
      });
      expect(final).toEqual({ status: 200, body: 'completed' });
      expect(information.map(({ status }) => status)).toEqual([104, 103]);
      expect(information[0].headers).toMatchObject({
        location: '/api/uploads/owned-resource',
        'upload-draft-interop-version': '9',
        'upload-offset': '0',
        'strict-transport-security': 'max-age=31536000',
      });
      expect(information[0].headers.connection).toBeUndefined();
    });

    it('sends only one 100 Continue before the final upload response', async () => {
      const information: number[] = [];
      const result = await new Promise<number>((resolve, reject) => {
        const outgoing = http.request({
          host: '127.0.0.1',
          port: frontPort,
          agent: false,
          method: 'POST',
          path: '/api/assets',
          headers: { expect: '100-continue' },
        });
        outgoing.on('information', (answer) => {
          information.push(answer.statusCode);
        });
        outgoing.once('continue', () => outgoing.end('ordinary upload'));
        outgoing.on('response', (answer) => {
          answer.resume();
          answer.on('end', () => resolve(answer.statusCode!));
          answer.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.flushHeaders();
      });
      expect(result).toBe(200);
      expect(information).toEqual([100]);
      expect(seen[0].body).toBe('ordinary upload');
    });

    it('forwards a websocket upgrade and splices it', async () => {
      const echoed = await new Promise<string>((resolve, reject) => {
        const outgoing = http.request({
          host: '127.0.0.1',
          port: frontPort,
          path: '/api/socket.io/?EIO=4&transport=websocket',
          headers: { connection: 'Upgrade', upgrade: 'websocket' },
        });
        outgoing.on('upgrade', (response, socket) => {
          expect(response.statusCode).toBe(101);
          socket.once('data', (data: Buffer) => {
            resolve(data.toString());
            socket.destroy();
          });
          socket.write('ping');
        });
        outgoing.on('error', reject);
        outgoing.end();
      });
      expect(echoed).toBe('ping');
    });

    it('fails closed without the edge secret', async () => {
      secret = null;
      const response = await request({ path: '/api/server/ping' });
      expect(response.status).toBe(503);
      expect(seen).toHaveLength(0);
    });

    it('gives a request up to 24 hours', () => {
      expect((sut as unknown as { server: http.Server }).server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    });
  });

  describe('connection caps', () => {
    it('takes at most 64 connections per address and frees them on close', () => {
      const config = { getEnv: () => mockEnvData({}) } as unknown as ConfigRepository;
      const logger = { setContext: vi.fn(), warn: vi.fn() } as unknown as LoggingRepository;
      const sut = new EdgeProxyService(logger, config);
      (sut as unknown as { server: { emit: () => void } }).server.emit = vi.fn();

      const sockets = Array.from({ length: MAX_CONNECTIONS_PER_ADDRESS }, () => new PassThrough());
      for (const socket of sockets) {
        expect(sut.accept(socket, arrival)).toBe(true);
      }
      const refused = new PassThrough();
      expect(sut.accept(refused, arrival)).toBe(false);
      expect(refused.destroyed).toBe(true);
      // another address is counted on its own
      expect(sut.accept(new PassThrough(), { ...arrival, clientIp: '198.51.100.4' })).toBe(true);
      // one IPv6 household (a /64) counts as one address
      const home = { ...arrival, clientIp: '2001:db8:1:2::10' };
      expect(sut.accept(new PassThrough(), home)).toBe(true);
      expect(sut.connectionCount).toBe(MAX_CONNECTIONS_PER_ADDRESS + 2);

      sockets[0].destroy();
      return new Promise<void>((resolve) =>
        setImmediate(() => {
          expect(sut.accept(new PassThrough(), arrival)).toBe(true);
          resolve();
        }),
      );
    });
  });
});

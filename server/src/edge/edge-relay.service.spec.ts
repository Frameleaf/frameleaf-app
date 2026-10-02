import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import http, { type IncomingHttpHeaders } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import type { FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { EdgeRelayService, type EdgeRelayTarget } from 'src/edge/edge-relay.service.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { FakeRelay, type FakeTunnel, relayFixture } from 'test/fixtures/relay.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';

const INSTANCE_ID = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';
const LABEL = 'u225vlzhsdlhwh4l';
const DOMAIN = 'frameleaf.net';
const API = 'https://api.frameleaf.cloud.test';
const SECRET = 'edge-secret-0123456789abcdef';
const RELAY_NAME = `r.${LABEL}.${DOMAIN}`;
const MARKER = 'plaintext-marker-7f3a9c';

const until = async (check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const signerFor = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  return {
    kid: 'kid-1',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x },
    sign: () => 'unused',
    signBytes: (data: Buffer) => sign(null, data, privateKey),
  } satisfies FrameleafKeySigner;
};

describe(EdgeRelayService.name, () => {
  let relay: FakeRelay;
  let upstream: http.Server;
  let seen: Array<{ url?: string; headers: IncomingHttpHeaders }>;
  let proxy: EdgeProxyService;
  let cloud: FrameleafCloudRepository;
  let sut: EdgeRelayService;
  let signer: FrameleafKeySigner;
  let calls: Array<{ url: string; body: unknown }>;
  let tokenAnswer: () => unknown;
  let target: EdgeRelayTarget;

  beforeEach(async () => {
    relay = await new FakeRelay().listen();
    seen = [];
    calls = [];
    upstream = http.createServer((request, response) => {
      seen.push({ url: request.url, headers: request.headers });
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(`answer ${MARKER}`);
      });
    });
    upstream.on('upgrade', (request, socket) => {
      seen.push({ url: request.url, headers: request.headers });
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.pipe(socket);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const config = {
      getEnv: () =>
        mockEnvData({
          port: (upstream.address() as AddressInfo).port,
          frameleafCloud: {
            ...mockEnvData({}).frameleafCloud,
            edge: { port: 2443, bind: '0.0.0.0', secret: SECRET, acmeDirectoryUrl: null },
          },
        }),
    } as unknown as ConfigRepository;
    const logger = { setContext: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() } as unknown as LoggingRepository;
    proxy = new EdgeProxyService(logger, config);

    signer = signerFor();
    tokenAnswer = () =>
      relay.tokenAnswer(
        relay.issueToken({
          instanceId: INSTANCE_ID,
          label: LABEL,
          domain: DOMAIN,
          publicKeyX: signer.publicJwk.x,
          hosts: ['photos.example.com'],
        }),
      );
    cloud = {
      requestJson: vi.fn((schema: any, request: any) => {
        calls.push({ url: request.url, body: request.body });
        if (request.url === `${API}/v1/remote/relays/candidates`) {
          return schema.parse({
            candidates: [
              { id: relay.relayId, host: relay.host, region: 'eu', pingHost: `ping.${relay.host}`, port: 443 },
            ],
            selected: relay.relayId,
          });
        }
        if (request.url === `${API}/v1/remote/relays/select`) {
          return schema.parse({
            relay: { id: relay.relayId, host: relay.host, region: 'eu', pingHost: `ping.${relay.host}`, port: 443 },
            changed: false,
          });
        }
        if (request.url === `${API}/v1/remote/relay-token` || request.url === `${API}/v1/buddy/recovery-relay-token`) {
          return schema.parse(tokenAnswer());
        }
        throw new Error(`unexpected ${request.url}`);
      }),
    } as unknown as FrameleafCloudRepository;

    sut = new EdgeRelayService(logger, cloud, proxy);
    // every relay name resolves to the fake relay on loopback; its certificate is from a test CA
    sut.dial = (options) => tls.connect({ ...options, host: '127.0.0.1', port: relay.port });
    sut.ca = relay.ca;
    sut.configure({
      contexts: {
        wildcard: { certificate: relayFixture('wildcard.cert.pem'), key: relayFixture('wildcard.key.pem') },
        custom: {
          host: 'photos.example.com',
          certificate: relayFixture('custom.cert.pem'),
          key: relayFixture('custom.key.pem'),
        },
      },
      enrollment: { label: LABEL, domain: DOMAIN },
    });
    target = {
      instanceId: INSTANCE_ID,
      linkKey: 'link-1',
      enrollment: { label: LABEL, domain: DOMAIN },
      cloud: () => Promise.resolve({ document: { api: API } as never, token: { accessToken: 'at', signer } }),
    };
  });

  afterEach(async () => {
    await sut.stop();
    proxy.destroy();
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  /** A visitor's HTTPS request through the relay: TLS with the name, inside one CONNECT stream. */
  const visit = async (
    tunnel: FakeTunnel,
    input: { sni?: string; servername?: string; path?: string; clientIp?: string | null; authority?: string } = {},
  ) => {
    const sni = input.sni ?? RELAY_NAME;
    const stream = await tunnel.visit({ sni, clientIp: input.clientIp, authority: input.authority });
    const socket = tls.connect({
      socket: stream,
      servername: input.servername ?? sni,
      ca: relayFixture('ca.cert.pem'),
      ALPNProtocols: ['http/1.1'],
    });
    try {
      await once(socket, 'secureConnect');
    } catch (error) {
      socket.destroy();
      stream.destroy();
      throw error;
    }
    const certificate = socket.getPeerCertificate();
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(
        { createConnection: () => socket as never, path: input.path ?? `/api/${MARKER}`, headers: { host: sni } },
        (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => (body += chunk.toString()));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on('error', reject);
      request.end();
    });
    socket.destroy();
    return { ...answer, certificate };
  };

  it('completes the handshake with the relay token and a proof by this server’s key', async () => {
    const connected = relay.nextTunnel();
    await sut.ensure(target);
    const tunnel = await connected;
    expect(relay.handshakes).toEqual([{ ok: true }]);
    expect(tunnel.claims).toMatchObject({ sub: INSTANCE_ID, sni: `${LABEL}.${DOMAIN}`, relay: 'eu1' });
    await until(() => sut.status().connected);
    expect(sut.status()).toMatchObject({ connected: true, relayId: 'eu1', host: relay.host, revoked: false });
    // a round trip was measured and the relay confirmed before the token was asked for
    const select = calls.find((call) => call.url.endsWith('/relays/select'));
    expect(select?.body).toEqual({ measurements: [{ relayId: 'eu1', rttMs: expect.any(Number), ok: true }] });
    expect(calls.map((call) => call.url.replace(API, ''))).toEqual([
      '/v1/remote/relays/candidates',
      '/v1/remote/relays/select',
      '/v1/remote/relay-token',
    ]);
  });

  it('proxies a visitor’s HTTPS request as via relay, from the address the relay saw, and never shows the relay plaintext', async () => {
    const connected = relay.nextTunnel();
    await sut.ensure(target);
    const tunnel = await connected;

    const answer = await visit(tunnel, { clientIp: '198.51.100.23' });
    expect(answer).toMatchObject({ status: 200, body: `answer ${MARKER}` });
    expect(answer.certificate.subject.CN).toBe(`*.${LABEL}.${DOMAIN}`);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`/api/${MARKER}`);
    expect(seen[0].headers).toMatchObject({
      'x-frameleaf-via': 'relay',
      'x-frameleaf-via-auth': SECRET,
      'x-forwarded-for': '198.51.100.23',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': RELAY_NAME,
    });
    // the relay carried the visitor's TLS records both ways, and could read neither the request nor the answer
    const carried = Buffer.concat(tunnel.spliced);
    expect(carried.length).toBeGreaterThan(500);
    expect(carried.includes(MARKER)).toBe(false);
    expect(carried.includes('HTTP/1.1')).toBe(false);
    await until(() => (sut.status().bytesIn ?? 0) > 0 && (sut.status().bytesOut ?? 0) > 0);
  });

  it('serves the verified custom hostname with its own certificate', async () => {
    const connected = relay.nextTunnel();
    await sut.ensure(target);
    const answer = await visit(await connected, { sni: 'photos.example.com' });
    expect(answer.status).toBe(200);
    expect(answer.certificate.subject.CN).toBe('photos.example.com');
    expect(seen[0].headers['x-forwarded-host']).toBe('photos.example.com');
  });

  describe('Buddy recovery tunnel', () => {
    const host = `recovery.${LABEL}.${DOMAIN}`;
    const recovery = {
      pairId: '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e54',
      vaultId: '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e55',
      sourceInstanceId: '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e56',
      readUntil: null,
    };
    const answer = (lifetimeSec = 300) => {
      const iat = Math.floor(Date.now() / 1000);
      const token = relay.issueToken({
        instanceId: INSTANCE_ID,
        label: LABEL,
        domain: DOMAIN,
        publicKeyX: signer.publicJwk.x,
        iat,
        lifetimeSec,
        recovery,
      });
      return {
        ...relay.tokenAnswer(token),
        expiresAt: new Date((iat + lifetimeSec) * 1000).toISOString(),
        recoveryHost: host,
        limits: { conns: 2 },
        refreshAfterSec: Math.max(1, Math.floor(lifetimeSec / 2)),
      };
    };

    it('replaces the ordinary tunnel and serves only the recovery hostname and vault reads', async () => {
      const first = relay.nextTunnel();
      await sut.ensure(target);
      const ordinary = await first;
      const closed = ordinary.closed.catch((error: NodeJS.ErrnoException) => {
        // Replacing the tunnel intentionally resets its HTTP/2 session.
        if (error.code !== 'ECONNRESET') {
          throw error;
        }
      });
      calls.length = 0;
      tokenAnswer = answer;
      proxy.configureRecovery({ ...recovery, host });
      const connected = relay.nextTunnel();
      await sut.ensure({ ...target, recovery });
      const tunnel = await connected;
      await closed;
      expect(tunnel.claims).toMatchObject({ purpose: 'buddy-recovery', vaultId: recovery.vaultId, lim: { conns: 2 } });
      expect(calls).toEqual([
        {
          url: `${API}/v1/buddy/recovery-relay-token`,
          body: {
            version: 1,
            pairId: recovery.pairId,
            vaultId: recovery.vaultId,
          },
        },
      ]);
      await expect(tunnel.visit({ sni: RELAY_NAME })).rejects.toThrow('403');
      await expect(tunnel.visit({ sni: 'photos.example.com' })).rejects.toThrow('403');
      expect((await visit(tunnel, { sni: host, path: '/api/server/ping' })).status).toBe(403);
      expect(
        (await visit(tunnel, { sni: host, path: `/api/buddy/v1/vaults/${recovery.vaultId}/snapshots` })).status,
      ).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].headers['x-forwarded-host']).toBe(host);
    });

    it.each(['offline', 'ordinary'] as const)('never extends recovery expiry after an %s refresh', async (failure) => {
      let issued = false;
      tokenAnswer = () => {
        if (!issued) {
          issued = true;
          return answer(3);
        }
        if (failure === 'offline') {
          throw new Error('Cloud unavailable');
        }
        return relay.tokenAnswer(
          relay.issueToken({
            instanceId: INSTANCE_ID,
            label: LABEL,
            domain: DOMAIN,
            publicKeyX: signer.publicJwk.x,
          }),
        );
      };
      const connected = relay.nextTunnel();
      await sut.ensure({ ...target, recovery });
      const tunnel = await connected;
      await tunnel.closed;
      expect(tunnel.refreshes).toHaveLength(0);
      expect(sut.status().connected).toBe(false);
      expect(relay.handshakes).toHaveLength(1);
    });

    it('closes immediately on a learned recovery revocation', async () => {
      let issued = false;
      tokenAnswer = () => {
        if (issued) {
          throw new FrameleafCloudError('other' as never, 403, 'blocked', { code: 'forbidden' } as never);
        }
        issued = true;
        return { ...answer(), refreshAfterSec: 1 };
      };
      const connected = relay.nextTunnel();
      await sut.ensure({ ...target, recovery });
      const tunnel = await connected;
      await tunnel.closed;
      await until(() => !!sut.status().revoked);
      expect(sut.status().connected).toBe(false);
      expect(relay.handshakes).toHaveLength(1);
    });
  });

  it('carries a WebSocket through the tunnel', async () => {
    const connected = relay.nextTunnel();
    await sut.ensure(target);
    const tunnel = await connected;
    const stream = await tunnel.visit({ sni: RELAY_NAME });
    const socket = tls.connect({ socket: stream, servername: RELAY_NAME, ca: relay.ca });
    await once(socket, 'secureConnect');
    socket.write(
      `GET /api/socket.io HTTP/1.1\r\nHost: ${RELAY_NAME}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${createHash('sha1').update('k').digest('base64')}\r\n\r\n`,
    );
    let received = '';
    socket.on('data', (chunk: Buffer) => (received += chunk.toString()));
    await until(() => received.includes('\r\n\r\n'));
    expect(received).toMatch(/^HTTP\/1\.1 101 /);
    socket.write(`frame-${MARKER}`);
    await until(() => received.includes(`frame-${MARKER}`));
    expect(seen[0].headers['x-frameleaf-via']).toBe('relay');
    expect(Buffer.concat(tunnel.spliced).includes(MARKER)).toBe(false);
    socket.destroy();
  });

  describe('refuses to become an open proxy', () => {
    let tunnel: FakeTunnel;

    beforeEach(async () => {
      const connected = relay.nextTunnel();
      await sut.ensure(target);
      tunnel = await connected;
    });

    it.each(['evil.example.com', `r.aaaaaaaaaaaaaaaa.${DOMAIN}`, `a.b.${LABEL}.${DOMAIN}`, ''])(
      'refuses a visitor for %j',
      async (sni) => {
        await expect(tunnel.visit({ sni })).rejects.toThrow('403');
        expect(seen).toHaveLength(0);
      },
    );

    it('refuses a visitor without the client address', async () => {
      await expect(tunnel.visit({ sni: RELAY_NAME, clientIp: null })).rejects.toThrow('403');
      await expect(tunnel.visit({ sni: RELAY_NAME, clientIp: 'not-an-address' })).rejects.toThrow('403');
      // a relay can never make a visitor look like one at home
      await expect(tunnel.visit({ sni: RELAY_NAME, clientIp: '192.168.1.20' })).rejects.toThrow('403');
    });

    it('refuses a TLS name other than the one the relay routed by', async () => {
      await expect(visit(tunnel, { sni: RELAY_NAME, servername: 'photos.example.com' })).rejects.toThrow();
      await expect(visit(tunnel, { sni: RELAY_NAME, servername: 'other.example.org' })).rejects.toThrow();
      expect(seen).toHaveLength(0);
    });

    it('never dials the CONNECT authority: every visitor reaches this server only', async () => {
      const answer = await visit(tunnel, { authority: 'internal.example:22' });
      expect(answer.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].headers['x-frameleaf-via']).toBe('relay');
    });

    it('answers nothing but visitor streams and the control stream', async () => {
      const stream = tunnel.session.request({ ':method': 'GET', ':path': '/api/server/ping' });
      const [headers] = (await once(stream, 'response')) as [http.IncomingHttpHeaders];
      expect(headers[':status']).toBe(404);
      expect(seen).toHaveLength(0);
    });
  });

  it('never sends the token to a relay whose certificate is not for its tunnel name', async () => {
    await relay.close();
    relay = await new FakeRelay({ cert: relayFixture('other.cert.pem'), key: relayFixture('other.key.pem') }).listen();
    sut.wait = () => new Promise((resolve) => setTimeout(resolve, 5));
    await sut.ensure(target);
    await until(() => (sut.status().lastError ?? '').length > 0);
    expect(sut.status().connected).toBe(false);
    expect(relay.handshakes).toEqual([]);
  });

  it('does not dial with a token bound to another key', async () => {
    const other = signerFor();
    tokenAnswer = () =>
      relay.tokenAnswer(
        relay.issueToken({ instanceId: INSTANCE_ID, label: LABEL, domain: DOMAIN, publicKeyX: other.publicJwk.x }),
      );
    sut.wait = () => new Promise((resolve) => setTimeout(resolve, 5));
    await sut.ensure(target);
    await until(() => (sut.status().lastError ?? '').includes('another key'));
    expect(relay.handshakes).toEqual([]);
  });

  it('is refused by the relay when the proof is not by the token’s key', async () => {
    const other = signerFor();
    target = {
      ...target,
      cloud: () =>
        Promise.resolve({
          document: { api: API } as never,
          token: { accessToken: 'at', signer: { ...signer, signBytes: other.signBytes } },
        }),
    };
    sut.wait = () => new Promise((resolve) => setTimeout(resolve, 5));
    await sut.ensure(target);
    await until(() => relay.handshakes.length > 0);
    expect(relay.handshakes[0]).toEqual({ ok: false, code: 'bad_proof' });
    await until(() => (sut.status().lastError ?? '').includes('bad_proof'));
    expect(sut.status().connected).toBe(false);
  });

  it('stops for good when the relay revokes the tunnel, until the server is linked again', async () => {
    let connected = relay.nextTunnel();
    sut.wait = () => new Promise((resolve) => setTimeout(resolve, 5));
    await sut.ensure(target);
    await connected;
    relay.revoke(INSTANCE_ID);
    await until(() => !!sut.status().revoked);
    expect(sut.status().connected).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(relay.handshakes).toEqual([{ ok: true }]);

    // linked again (and no longer denylisted): a new tunnel
    relay.denylist.clear();
    connected = relay.nextTunnel();
    await sut.ensure({ ...target, linkKey: 'link-2' });
    await connected;
    expect(sut.status().revoked).toBe(false);
  });

  it('stays stopped when Frameleaf Cloud says the enrolment is suspended', async () => {
    tokenAnswer = () => {
      throw new FrameleafCloudError('other' as never, 403, 'suspended', { code: 'enrollment-suspended' } as never);
    };
    sut.wait = () => new Promise((resolve) => setTimeout(resolve, 5));
    await sut.ensure(target);
    await until(() => !!sut.status().revoked);
    const asked = calls.filter((call) => call.url.endsWith('/relay-token')).length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.filter((call) => call.url.endsWith('/relay-token'))).toHaveLength(asked);
  });

  it('refreshes the token in-band at half its life', async () => {
    tokenAnswer = () =>
      relay.tokenAnswer(
        relay.issueToken({
          instanceId: INSTANCE_ID,
          label: LABEL,
          domain: DOMAIN,
          publicKeyX: signer.publicJwk.x,
          lifetimeSec: 4,
        }),
      );
    const connected = relay.nextTunnel();
    await sut.ensure(target);
    const tunnel = await connected;
    await until(() => tunnel.refreshes.length > 0, 6000);
    expect(tunnel.refreshes[0]).toEqual({ ok: true });
    expect(relay.handshakes).toHaveLength(1);
  });

  it('reconnects when three PINGs go unanswered', async () => {
    relay.keepaliveSec = 1;
    sut.wait = () => new Promise((resolve) => setTimeout(resolve, 5));
    // the first tunnel runs through a forwarder that can stop carrying the relay's answers
    let stalled = false;
    const held: net.Socket[] = [];
    const forwarder = net.createServer((inbound) => {
      const outbound = net.connect(relay.port, '127.0.0.1');
      held.push(inbound, outbound);
      inbound.pipe(outbound);
      outbound.on('data', (chunk: Buffer) => stalled || inbound.write(chunk));
      inbound.on('error', () => outbound.destroy());
      outbound.on('error', () => inbound.destroy());
      inbound.on('close', () => outbound.destroy());
    });
    forwarder.listen(0, '127.0.0.1');
    await once(forwarder, 'listening');
    let dials = 0;
    sut.dial = (options) =>
      tls.connect({
        ...options,
        host: '127.0.0.1',
        port:
          options.servername?.startsWith('tun.') && dials++ === 0
            ? (forwarder.address() as AddressInfo).port
            : relay.port,
      });
    let connected = relay.nextTunnel();
    await sut.ensure(target);
    await connected;
    await until(() => sut.status().connected);
    connected = relay.nextTunnel();
    stalled = true;
    await connected;
    for (const socket of held) {
      socket.destroy();
    }
    forwarder.close();
    expect(relay.handshakes.filter((handshake) => handshake.ok)).toHaveLength(2);
    expect(sut.status().lastError).toContain('stopped answering');
  }, 15_000);

  describe('reconnects', () => {
    let delays: number[];

    beforeEach(() => {
      delays = [];
      sut.random = () => 0.5;
      sut.wait = (ms) => {
        delays.push(ms);
        return new Promise((resolve) => setTimeout(resolve, 1));
      };
    });

    const selects = () => calls.filter((call) => call.url.endsWith('/relays/select')).length;

    it('with full-jitter backoff, re-selecting the relay after three failures in a row', async () => {
      relay.refuseWith = 'internal';
      await sut.ensure(target);
      await until(() => relay.handshakes.length >= 7).catch((error) => {
        throw new Error(
          `${error.message}: ${JSON.stringify({ handshakes: relay.handshakes, status: sut.status(), delays, calls: calls.length })}`,
        );
      });
      await sut.stop();
      expect(delays.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 8000, 16_000]);
      // at start, after failures 1-3, and after 4-6
      expect(selects()).toBeGreaterThanOrEqual(3);
      expect(sut.status().lastError).toContain('internal');
    });

    it('re-selects at once when the relay drains', async () => {
      relay.refuseWith = 'draining';
      await sut.ensure(target);
      await until(() => relay.handshakes.length >= 2);
      await sut.stop();
      expect(selects()).toBeGreaterThanOrEqual(2);
    });

    it('re-selects when Frameleaf Cloud says the relay is unavailable', async () => {
      let refused = 0;
      tokenAnswer = () => {
        refused++;
        throw new FrameleafCloudError('other' as never, 503, 'no relay', { code: 'relay-unavailable' } as never);
      };
      await sut.ensure(target);
      await until(() => refused >= 2);
      await sut.stop();
      expect(selects()).toBeGreaterThanOrEqual(2);
    });

    it('keeps the relay while it has not loaded its denylist yet', async () => {
      relay.refuseWith = 'unavailable';
      await sut.ensure(target);
      await until(() => relay.handshakes.length >= 4);
      await sut.stop();
      expect(selects()).toBe(1);
    });

    it('from the shortest wait again after a tunnel that was up', async () => {
      let connected = relay.nextTunnel();
      await sut.ensure(target);
      const tunnel = await connected;
      connected = relay.nextTunnel();
      tunnel.goaway('replaced');
      await connected;
      expect(delays).toEqual([500]);
      expect(selects()).toBe(1);
    });
  });

  it('stop closes the tunnel and every visitor on it', async () => {
    const connected = relay.nextTunnel();
    await sut.ensure(target);
    const tunnel = await connected;
    const stream = await tunnel.visit({ sni: RELAY_NAME });
    await sut.stop();
    await tunnel.closed;
    expect(stream.stream.destroyed || stream.stream.closed).toBe(true);
    expect(sut.status()).toMatchObject({ connected: false });
  });

  it('measures a relay by the fastest of three requests on one TLS connection', async () => {
    const measurement = await sut.measure({
      id: 'eu1',
      host: relay.host,
      region: 'eu',
      pingHost: `ping.${relay.host}`,
      port: 443,
    });
    expect(measurement).toEqual({ relayId: 'eu1', rttMs: expect.any(Number), ok: true });
    expect(relay.pings).toBe(3);
    const failed = await sut.measure({ id: 'us1', host: 'x.test', region: 'na', pingHost: 'ping.x.test', port: 443 });
    expect(failed).toEqual({ relayId: 'us1', rttMs: 0, ok: false });
  });
});

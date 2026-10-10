import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import http, { type IncomingHttpHeaders } from 'node:http';
import { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { promisify } from 'node:util';
import postgres from 'postgres';
import type { FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { EdgeRelayService } from 'src/edge/edge-relay.service.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type FakeCloud, startFakeCloud, tokenAnswer } from 'test/fake-frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { FakeRelay, type FakeTunnel, relayFixture } from 'test/fixtures/relay.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';

// Deliberately outside unit discovery. This fixture requires an isolated, empty, real API/PostgreSQL stack.
const base = new URL(process.env.FL225_API_URL ?? 'http://127.0.0.1:0');
const secret = process.env.FL225_EDGE_SECRET;
const pgUrl = process.env.FL225_PG_URL;
const label = 'u225vlzhsdlhwh4l';
const domain = 'frameleaf.net';
const name = `r.${label}.${domain}`;
const linkingOrigin = process.env.FL225_CLOUD_URL;
const cloudApi = 'https://api.frameleaf.cloud.test';
// First genuine PNG from e2e makeRandomImage/createPNG: RGBA(0,0,0,255), pngjs synchronous writer.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWMAgv8AAQQBAP8H9UQAAAAASUVORK5CYII=',
  'base64',
);
type Answer = { status: number; headers: IncomingHttpHeaders; data: unknown; raw: Buffer; information: number[] };
type Route = 'relay' | 'stripped';

describe('FL-225 actual API over relay and 1xx-stripping proxy', () => {
  let relay: FakeRelay;
  let linking: FakeCloud;
  let instanceId: string;
  let tunnel: FakeTunnel;
  let edge: EdgeRelayService;
  let proxy: EdgeProxyService;
  let stripping: http.Server;
  let strippingPort: number;
  let db: ReturnType<typeof postgres>;
  let ownerToken: string;
  let foreignToken: string;
  let ownerId: string;
  let originalConfig: Record<string, unknown>;
  let strippedInformation = 0;

  const direct = async (path: string, method = 'GET', token?: string, body?: unknown) => {
    const response = await fetch(new URL('/api' + path, base), {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, data: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };

  const through = async (
    route: Route,
    path: string,
    token: string,
    method = 'GET',
    headers: Record<string, string> = {},
    bytes?: Buffer,
  ): Promise<Answer> => {
    let socket: tls.TLSSocket | undefined;
    if (route === 'relay') {
      const stream = await tunnel.visit({ sni: name, clientIp: '198.51.100.23' });
      socket = tls.connect({
        socket: stream,
        servername: name,
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
    }
    try {
      return await new Promise<Answer>((resolve, reject) => {
        const information: number[] = [];
        const request = http.request(
          {
            ...(socket
              ? { createConnection: () => socket! }
              : { host: '127.0.0.1', port: strippingPort, agent: false }),
            path: '/api' + path,
            method,
            headers: {
              host: name,
              Authorization: `Bearer ${token}`,
              ...headers,
              ...(bytes && { 'content-length': String(bytes.length) }),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('error', reject);
            response.on('data', (chunk: Buffer) => {
              chunks.push(chunk);
            });
            response.on('end', () => {
              const raw = Buffer.concat(chunks);
              const isJson = response.headers['content-type']?.split(';', 1)[0].trim() === 'application/json';
              resolve({
                status: response.statusCode!,
                headers: response.headers,
                data: isJson && raw.length > 0 ? (JSON.parse(raw.toString()) as unknown) : null,
                raw,
                information,
              });
            });
          },
        );
        request.on('information', (response) => {
          information.push(response.statusCode);
        });
        request.on('error', reject);
        request.end(bytes);
      });
    } finally {
      socket?.destroy();
    }
  };

  beforeAll(async () => {
    if (!secret || !pgUrl || base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.port === '0') {
      throw new Error('Explicit loopback FL225_API_URL, FL225_PG_URL and matching FL225_EDGE_SECRET are required');
    }
    if (!linkingOrigin) throw new Error('Explicit API-bootstrap FL225_CLOUD_URL is required');
    const origin = new URL(linkingOrigin);
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== 'host.docker.internal' ||
      !origin.port ||
      origin.pathname !== '/'
    ) {
      throw new Error('FL225_CLOUD_URL must be the explicit host.docker.internal HTTP test origin');
    }
    linking = await startFakeCloud({
      listenHost: '0.0.0.0',
      listenPort: Number(origin.port),
      advertisedHost: origin.hostname,
    });
    expect(linking.url).toBe(origin.origin);
    linking.on('POST /id/device/auth', () => ({
      status: 200,
      body: {
        device_code: 'fl225-device-code',
        user_code: 'BCDF-GHJK',
        verification_uri: `${linking.url}/link`,
        verification_uri_complete: `${linking.url}/link?code=BCDF-GHJK`,
        expires_in: 600,
        interval: 1,
      },
    }));
    linking.on('POST /id/token', (request) =>
      request.form().get('grant_type') === 'client_credentials'
        ? tokenAnswer(request)
        : { status: 200, body: { access_token: 'fl225-approved-link-token', expires_in: 600 } },
    );
    linking.on('POST /api/v1/instances', (request) => {
      const registration = request.json() as { instanceId: string };
      instanceId = registration.instanceId;
      const answer = cloudContractFixture('instance/register-response.json');
      return {
        status: 200,
        body: { ...answer, instanceId, oidc: { ...answer.oidc, issuer: `${linking.url}/id`, clientId: instanceId } },
      };
    });
    linking.on('DELETE /api/v1/instance', () => ({ status: 204 }));
    db = postgres(pgUrl, { max: 2 });
    const password = 'FL225-relay-fixture-password-24!';
    const account = { email: 'relay-owner@example.test', password, name: 'Relay Upload Owner' };
    // FL-292: the e2e server pins its setup code
    const setupCode = process.env.FRAMELEAF_SETUP_CODE ?? 'E2ESETUP';
    expect((await direct('/auth/admin-sign-up', 'POST', undefined, { ...account, setupCode })).status).toBe(201);
    const login = await direct('/auth/login', 'POST', undefined, { email: account.email, password });
    expect(login.status).toBe(201);
    ownerToken = login.data.accessToken as string;
    const pinCode = '123456';
    expect((await direct('/auth/pin-code', 'POST', ownerToken, { pinCode })).status).toBe(204);
    expect((await direct('/auth/session/unlock', 'POST', ownerToken, { pinCode })).status).toBe(204);
    ownerId = (await direct('/users/me', 'GET', ownerToken)).data.id as string;
    expect(
      (
        await direct('/admin/users', 'POST', ownerToken, {
          email: 'relay-foreign@example.test',
          password,
          name: 'Foreign',
          shouldChangePassword: false,
        })
      ).status,
    ).toBe(201);
    foreignToken = (await direct('/auth/login', 'POST', undefined, { email: 'relay-foreign@example.test', password }))
      .data.accessToken as string;
    originalConfig = (await direct('/admin/config', 'GET', ownerToken)).data;
    const started = await direct('/admin/cloud/link', 'POST', ownerToken);
    expect(started.status).toBe(201);
    expect(started.data).toMatchObject({ state: 'pending' });
    // Respect the normal device-flow interval; no stored-link/poll-time injection.
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    const linked = await direct('/admin/cloud/link', 'GET', ownerToken);
    expect(linked.status).toBe(200);
    expect(linked.data).toMatchObject({ state: 'linked', instanceId });
    expect(instanceId).toBeTruthy();

    relay = await new FakeRelay().listen();
    const logger = LoggingRepository.create('FL225 transport fixture');
    const config = {
      getEnv: () =>
        mockEnvData({
          port: Number(base.port),
          frameleafCloud: {
            ...mockEnvData({}).frameleafCloud,
            edge: { port: 2443, bind: '0.0.0.0', secret, acmeDirectoryUrl: null },
          },
        }),
    } as ConfigRepository;
    proxy = new EdgeProxyService(logger, config);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const x = publicKey.export({ format: 'jwk' }).x!;
    const signer = {
      kid: 'fixture',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x },
      sign: () => 'unused',
      signBytes: (data: Buffer) => sign(null, data, privateKey),
    } satisfies FrameleafKeySigner;
    // Only external tunnel discovery/admission is simulated; upload and authentication never are.
    const cloud = {
      requestJson: async (schema: { parse: (input: unknown) => unknown }, request: { url: string }) => {
        await Promise.resolve();
        const candidate = {
          id: relay.relayId,
          host: relay.host,
          region: 'eu',
          pingHost: `ping.${relay.host}`,
          port: 443,
        };
        if (request.url.endsWith('/relays/candidates'))
          return schema.parse({ candidates: [candidate], selected: relay.relayId });
        if (request.url.endsWith('/relays/select')) return schema.parse({ relay: candidate, changed: false });
        if (request.url.endsWith('/relay-token'))
          return schema.parse(relay.tokenAnswer(relay.issueToken({ instanceId, label, domain, publicKeyX: x })));
        throw new Error(`Unexpected external fixture request ${request.url}`);
      },
    } as FrameleafCloudRepository;
    edge = new EdgeRelayService(logger, cloud, proxy);
    edge.dial = (options) => tls.connect({ ...options, host: '127.0.0.1', port: relay.port });
    edge.ca = relay.ca;
    edge.configure({
      contexts: { wildcard: { certificate: relayFixture('wildcard.cert.pem'), key: relayFixture('wildcard.key.pem') } },
      enrollment: { label, domain },
    });
    const connected = relay.nextTunnel();
    await edge.ensure({
      instanceId,
      linkKey: 'fixture-link',
      enrollment: { label, domain },
      cloud: () =>
        Promise.resolve({
          document: { api: cloudApi } as never,
          token: { accessToken: 'fixture-discovery-token', signer },
        }),
    });
    tunnel = await connected;

    // The proxy still streams actual bodies to the real API; it intentionally omits all 1xx.
    stripping = http.createServer((request, response) => {
      const upstream = http.request(
        new URL(request.url!, base),
        { method: request.method, headers: request.headers },
        (answer) => {
          response.writeHead(answer.statusCode!, answer.headers);
          answer.pipe(response);
          answer.on('error', () => response.destroy());
        },
      );
      upstream.on('information', () => strippedInformation++);
      upstream.on('error', () => response.destroy());
      request.pipe(upstream);
      request.on('error', () => upstream.destroy());
      response.on('close', () => {
        if (!response.writableFinished) upstream.destroy();
      });
    });
    stripping.listen(0, '127.0.0.1');
    await once(stripping, 'listening');
    strippingPort = (stripping.address() as AddressInfo).port;
  });

  afterAll(async () => {
    try {
      if (originalConfig && ownerToken)
        expect((await direct('/admin/config', 'PUT', ownerToken, originalConfig)).status).toBe(200);
    } finally {
      await edge?.stop();
      proxy?.destroy();
      await relay?.close();
      try {
        if (ownerToken && instanceId)
          expect((await direct('/admin/cloud/link', 'DELETE', ownerToken)).status).toBe(200);
      } finally {
        await linking?.close();
      }
      if (stripping) await new Promise<void>((resolve) => stripping.close(() => resolve()));
      await db?.end();
    }
  });

  it('denies an ordinary password session through relay until the administrator opts in', async () => {
    expect(
      (originalConfig.frameleafCloud as { remoteAccess: { allowPasswordOverRelay: boolean } }).remoteAccess
        .allowPasswordOverRelay,
    ).toBe(false);
    expect((await through('relay', '/assets/uploads', ownerToken, 'OPTIONS')).status).toBe(403);
    const cloud = originalConfig.frameleafCloud as { remoteAccess: Record<string, unknown> };
    expect(
      (
        await direct('/admin/config', 'PUT', ownerToken, {
          ...originalConfig,
          frameleafCloud: { ...cloud, remoteAccess: { ...cloud.remoteAccess, allowPasswordOverRelay: true } },
        })
      ).status,
    ).toBe(200);
    expect((await through('relay', '/assets/uploads', ownerToken, 'OPTIONS')).status).toBe(204);
  });

  for (const route of ['relay', 'stripped'] as const) {
    it(`${route}: 201 Location resumes by HEAD/PATCH, publishes once and refuses a foreign owner`, async () => {
      const bytes = Buffer.concat([png, Buffer.from(randomUUID())]);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const metadata = Buffer.from(
        JSON.stringify({
          filename: randomUUID() + '.png',
          fileCreatedAt: new Date().toISOString(),
          fileModifiedAt: new Date().toISOString(),
        }),
      ).toString('base64url');
      const headers = {
        'content-type': 'image/png',
        'upload-draft-interop-version': '9',
        'upload-complete': '?0',
        'upload-length': String(bytes.length),
        'repr-digest': `sha-256=:${Buffer.from(sha256, 'hex').toString('base64')}:`,
        'asset-metadata': metadata,
      };
      const before = await db`select "quotaUsageInBytes" from "user" where id=${ownerId}`;
      const count = await db`select count(*)::int as count from asset where "ownerId"=${ownerId}`;
      const create = await through(route, '/assets/uploads', ownerToken, 'POST', headers, bytes.subarray(0, 7));
      expect(create.status).toBe(201);
      expect(create.information).toEqual(route === 'relay' ? [104] : []);
      const location = create.headers.location!.replace('/api', '');
      if (process.env.FL285_RESTART_OWNED_FIXTURE === 'true') {
        // Recreate only the owned e2e API, preserving its PostgreSQL and anonymous media volume.
        await promisify(execFile)(
          'docker',
          [
            'compose',
            '-f',
            'docker-compose.yml',
            '-f',
            'docker-compose.upload-transport.yml',
            'up',
            '-d',
            '--no-build',
            '--no-deps',
            '--force-recreate',
            '--wait',
            '--wait-timeout',
            '90',
            'frameleaf-server',
          ],
          { cwd: new URL('../../../e2e', import.meta.url), timeout: 100_000 },
        );
        console.log(`PASS FL-285 ${route}: owned API recreated with incomplete resource ${location.split('/').at(-1)}`);
      }
      expect((await through(route, location, foreignToken, 'HEAD')).status).toBe(404);
      expect((await through(route, location, ownerToken, 'HEAD')).headers['upload-offset']).toBe('7');
      const append = {
        'content-type': 'application/partial-upload',
        'upload-draft-interop-version': '9',
        'upload-complete': '?1',
        'upload-offset': '7',
      };
      const result = await through(route, location, ownerToken, 'PATCH', append, bytes.subarray(7));
      expect(result.status).toBe(200);
      const asset = result.data as { id: string; sha256: string };
      expect(asset.sha256).toBe(sha256);
      if (route === 'relay') {
        expect((await through(route, `/assets/${asset.id}/original`, ownerToken)).status).toBe(403);
        const cloud = originalConfig.frameleafCloud as { remoteAccess: Record<string, unknown> };
        expect(
          (
            await direct('/admin/config', 'PUT', ownerToken, {
              ...originalConfig,
              frameleafCloud: {
                ...cloud,
                remoteAccess: { ...cloud.remoteAccess, allowPasswordOverRelay: true, allowOriginalsOverRelay: true },
              },
            })
          ).status,
        ).toBe(200);
      }
      const stored = await through(route, `/assets/${asset.id}/original`, ownerToken);
      expect(stored.status).toBe(200);
      expect(createHash('sha256').update(stored.raw).digest('hex')).toBe(sha256);
      expect(stored.raw.length).toBe(bytes.length);
      const retry = await through(
        route,
        location,
        ownerToken,
        'PATCH',
        { ...append, 'upload-offset': String(bytes.length) },
        Buffer.alloc(0),
      );
      expect(retry.status).toBe(200);
      expect(retry.data).toMatchObject({ id: asset.id, sha256 });
      expect((await db`select count(*)::int as count from asset where "ownerId"=${ownerId}`)[0].count).toBe(
        count[0].count + 1,
      );
      expect(Number((await db`select "quotaUsageInBytes" from "user" where id=${ownerId}`)[0].quotaUsageInBytes)).toBe(
        Number(before[0].quotaUsageInBytes) + bytes.length,
      );
      const mismatch = await through(
        route,
        '/assets/uploads',
        ownerToken,
        'POST',
        { ...headers, 'upload-complete': '?1', 'repr-digest': `sha-256=:${Buffer.alloc(32).toString('base64')}:` },
        bytes,
      );
      expect(mismatch.status).toBe(400);
      expect(Number((await db`select "quotaUsageInBytes" from "user" where id=${ownerId}`)[0].quotaUsageInBytes)).toBe(
        Number(before[0].quotaUsageInBytes) + bytes.length,
      );
      expect((await db`select count(*)::int as count from asset where "ownerId"=${ownerId}`)[0].count).toBe(
        count[0].count + 1,
      );
    });

    it(`${route}: accepts exactly the advertised 64MiB part without a transport cap`, async () => {
      const limits = await through(route, '/assets/uploads', ownerToken, 'OPTIONS');
      expect(limits.status).toBe(204);
      expect(limits.headers['upload-limit']).toContain('max-append-size=67108864');
      const bytes = Buffer.alloc(64 * 1024 * 1024);
      png.copy(bytes);
      Buffer.from(randomUUID()).copy(bytes, bytes.length - 36);
      const digest = createHash('sha256').update(bytes).digest('base64');
      const metadata = Buffer.from(
        JSON.stringify({
          filename: randomUUID() + '.png',
          fileCreatedAt: new Date().toISOString(),
          fileModifiedAt: new Date().toISOString(),
        }),
      ).toString('base64url');
      const created = await through(
        route,
        '/assets/uploads',
        ownerToken,
        'POST',
        {
          'content-type': 'image/png',
          'upload-draft-interop-version': '9',
          'upload-complete': '?0',
          'upload-length': String(bytes.length),
          'repr-digest': `sha-256=:${digest}:`,
          'asset-metadata': metadata,
        },
        bytes,
      );
      expect(created.status).toBe(201);
      const location = created.headers.location!.replace('/api', '');
      expect((await through(route, location, ownerToken, 'HEAD')).headers['upload-offset']).toBe(String(bytes.length));
      // This case measures admission/durable bytes, not a padded PNG's decoder throughput.
      expect((await through(route, location, ownerToken, 'DELETE')).status).toBe(204);
      if (route === 'stripped') expect(strippedInformation).toBeGreaterThan(0);
    });
  }
});

import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { readBuddyRecovery } from 'src/edge/buddy-recovery.js';
import { EdgeDirectService } from 'src/edge/edge-direct.service.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type BuddySide, buddyHost, buddyPort } from 'test/fixtures/buddy-cloud.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';

/** Real TLS/direct/proxy code. Enrollment/EdgeState is substituted, never app auth or peer services. */
export const startBuddyTransport = async (root: string, side: BuddySide, instanceId: string) => {
  const apiPort = side === 'a' ? 3285 : 3286;
  const metrics = { objectReads: 0, objectWrites: 0, commits: 0, changedProofUrlStatus: null as number | null };
  let checkedProof = false;
  const failures: string[] = [];
  const [ca, certificate, key] = await Promise.all([
    readFile(join(root, 'tls', 'ca.crt'), 'utf8'),
    readFile(join(root, 'tls', `${side}.crt`), 'utf8'),
    readFile(join(root, 'tls', `${side}.key`), 'utf8'),
  ]);
  const meter = http.createServer((request, response) => {
    const forward = () => {
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: apiPort,
          method: request.method,
          path: request.url,
          headers: request.headers,
        },
        (answer) => {
          response.writeHead(answer.statusCode!, answer.headers);
          answer.pipe(response);
          answer.once('error', () => response.destroy());
          answer.once('end', () => {
            if (answer.statusCode! < 200 || answer.statusCode! >= 300) {
              return;
            }
            if (/\/objects\/[a-f\d]{64}$/.test(request.url ?? '')) {
              if (request.method === 'GET') {
                metrics.objectReads++;
              }
              if (request.method === 'PUT') {
                metrics.objectWrites++;
              }
            }
            if (request.method === 'POST' && request.url?.endsWith('/snapshots')) {
              metrics.commits++;
            }
          });
        },
      );
      upstream.once('error', () => {
        failures.push('API forwarding failed');
        response.destroy();
      });
      request.pipe(upstream);
      request.once('aborted', () => upstream.destroy());
    };
    // Hold one fresh, nonce-bearing proof BEFORE the genuine request is admitted. Reusing an already
    // admitted proof would only test replay rejection and could hide a missing htu check.
    const proof = request.headers.dpop;
    let claims: { nonce?: string } | null = null;
    try {
      if (typeof proof === 'string') {
        claims = JSON.parse(Buffer.from(proof.split('.')[1], 'base64url').toString());
      }
    } catch {
      failures.push('Unreadable proof from real peer');
      response.destroy();
      return;
    }
    if (
      !checkedProof &&
      request.method === 'GET' &&
      /\/objects\/[a-f\d]{64}$/.test(request.url ?? '') &&
      claims?.nonce
    ) {
      checkedProof = true;
      const altered = http.request(
        {
          host: '127.0.0.1',
          port: apiPort,
          method: 'GET',
          path: request.url!.replace(/objects\/[a-f\d]{64}$/, 'snapshots'),
          headers: request.headers,
          timeout: 10_000,
        },
        (answer) => {
          answer.resume();
          answer.once('error', () => response.destroy());
          answer.once('end', () => {
            metrics.changedProofUrlStatus = answer.statusCode!;
            forward();
          });
        },
      );
      altered.once('timeout', () => altered.destroy(new Error('Proof-bound request timed out')));
      altered.once('error', () => {
        failures.push('Proof URL check failed');
        response.destroy();
      });
      altered.end();
    } else {
      forward();
    }
  });
  meter.listen(0, '127.0.0.1');
  await once(meter, 'listening');
  const port = (meter.address() as AddressInfo).port;
  const logger = LoggingRepository.create(`FL310 ${side} direct fixture`);
  const config = {
    getEnv: () =>
      mockEnvData({
        port,
        frameleafCloud: {
          ...mockEnvData({}).frameleafCloud,
          edge: {
            bind: '0.0.0.0',
            port: buddyPort(side),
            secret: `fl310-buddy-${side}-test-only`,
            acmeDirectoryUrl: null,
          },
        },
      }),
  } as ConfigRepository;
  const proxy = new EdgeProxyService(logger, config);
  const direct = new EdgeDirectService(logger, config, proxy);
  const refresh = async () => {
    const access = await readBuddyRecovery(join(root, side, 'identity'), instanceId, Date.now());
    if (!access?.backupEnabled || !access.writeAllowed) {
      throw new Error('Real persisted pairing must admit paid Buddy writes');
    }
    proxy.configureRecovery({ ...access, host: `recovery.buddyfixture${side.repeat(4)}.buddy.test` }, true);
    return access;
  };
  const close = async () => {
    await direct.stop();
    proxy.destroy();
    meter.closeAllConnections();
    await new Promise<void>((resolve) => meter.close(() => resolve()));
  };
  try {
    await refresh();
    direct.configure({
      contexts: { wildcard: { certificate, key } },
      enrollment: { label: `buddyfixture${side.repeat(4)}`, domain: 'buddy.test' },
      allowWan: true,
      advertised: [],
    });
    await direct.start();
  } catch (error) {
    await close();
    throw error;
  }
  const request = (path: string, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const request = https.request(
        {
          hostname: '127.0.0.1',
          port: buddyPort(side),
          servername: buddyHost(side),
          ca,
          method: 'GET',
          path,
          headers: { host: `${buddyHost(side)}:${buddyPort(side)}`, ...headers },
          agent: false,
          timeout: 10_000,
        },
        (response) => {
          response.resume();
          response.once('error', reject);
          response.once('end', () => resolve(response.statusCode!));
        },
      );
      request.once('timeout', () => request.destroy(new Error('Fixture TLS request timed out')));
      request.once('error', reject);
      request.end();
    });
  return { metrics, failures, refresh, request, close };
};

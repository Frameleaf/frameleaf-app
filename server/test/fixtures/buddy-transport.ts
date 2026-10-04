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

// Only fixed categories and booleans enter the artifact. Never retain URLs, IDs, headers or errors.
export const buddyForwardingDiagnostic = (
  method: string | undefined,
  url: string | undefined,
  code: unknown,
  phase: unknown,
  admittedPhase: unknown,
  state: { reusedSocket: boolean; requestAborted: boolean; responseDestroyed: boolean; responseFinished: boolean },
) => {
  const path = (url ?? '').split('?', 1)[0];
  const prefix = /^\/api\/buddy\/v1\/vaults\/[^/]+\//;
  const route = prefix.test(path) ? path.replace(prefix, '') : '';
  const category =
    route === 'handshake'
      ? 'handshake'
      : route === 'reservations'
        ? 'reservations'
        : /^objects\/[a-f\d]{64}$/.test(route)
          ? 'object'
          : route === 'snapshots'
            ? 'snapshots'
            : /^snapshots\/[^/]+$/.test(route)
              ? 'snapshot'
              : 'other';
  const phases = new Set([
    'setup',
    'backup',
    'committed-ciphertext-and-real-dump',
    'delete-restart-and-restore',
    'delete-before-restart',
    'owned-compose-restart',
    'awaiting-both-peer-apis',
    'restore-after-peer-readiness',
    'no-hosted-buddy-photo-access',
    'complete',
  ]);
  const codes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    'ERR_STREAM_PREMATURE_CLOSE',
    'ENOTFOUND',
    'EAI_AGAIN',
  ]);
  return {
    timestamp: new Date().toISOString(),
    method: method && ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'].includes(method) ? method : 'OTHER',
    category,
    code: typeof code === 'string' && codes.has(code) ? code : 'UNKNOWN',
    phase: typeof phase === 'string' && phases.has(phase) ? phase : 'unknown',
    admittedPhase: typeof admittedPhase === 'string' && phases.has(admittedPhase) ? admittedPhase : 'unknown',
    reusedSocket: state.reusedSocket,
    requestAborted: state.requestAborted,
    responseDestroyed: state.responseDestroyed,
    responseFinished: state.responseFinished,
  };
};

/** Real TLS/direct/proxy code. Enrollment/EdgeState is substituted, never app auth or peer services. */
export const startBuddyTransport = async (root: string, side: BuddySide, instanceId: string, phase: () => unknown) => {
  const apiPort = side === 'a' ? 3285 : 3286;
  const metrics = { objectReads: 0, objectWrites: 0, commits: 0, changedProofUrlStatus: null as number | null };
  let checkedProof = false;
  const failures: string[] = [];
  const diagnostics: Array<ReturnType<typeof buddyForwardingDiagnostic>> = [];
  // A bounded conformance outage is explicit HTTP unavailability, never a hidden forwarding error.
  let unavailable = false;
  let unavailableStatus: 429 | 503 = 503;
  const outages: Array<{ timestamp: string; method: string; category: string; status: number }> = [];
  const [ca, certificate, key] = await Promise.all([
    readFile(join(root, 'tls', 'ca.crt'), 'utf8'),
    readFile(join(root, 'tls', `${side}.crt`), 'utf8'),
    readFile(join(root, 'tls', `${side}.key`), 'utf8'),
  ]);
  const meter = http.createServer((request, response) => {
    const admittedPhase = phase();
    if (unavailable) {
      const diagnostic = buddyForwardingDiagnostic(request.method, request.url, undefined, undefined, undefined, {
        reusedSocket: false,
        requestAborted: request.aborted,
        responseDestroyed: response.destroyed,
        responseFinished: response.writableFinished,
      });
      outages.push({
        timestamp: diagnostic.timestamp,
        method: diagnostic.method,
        category: diagnostic.category,
        status: unavailableStatus,
      });
      request.resume();
      response.writeHead(unavailableStatus, { 'content-length': '0', connection: 'close' });
      response.end();
      return;
    }
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
              } else if (request.method === 'PUT') {
                metrics.objectWrites++;
              }
            }
            if (request.method === 'POST' && request.url?.endsWith('/snapshots')) {
              metrics.commits++;
            }
          });
        },
      );
      upstream.once('error', (error) => {
        failures.push('API forwarding failed');
        diagnostics.push(
          buddyForwardingDiagnostic(
            request.method,
            request.url,
            (error as NodeJS.ErrnoException).code,
            phase(),
            admittedPhase,
            {
              reusedSocket: upstream.reusedSocket,
              requestAborted: request.aborted,
              responseDestroyed: response.destroyed,
              responseFinished: response.writableFinished,
            },
          ),
        );
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
        claims = JSON.parse(Buffer.from(proof.split('.', 2)[1], 'base64url').toString());
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
      altered.once('error', (error) => {
        failures.push('Proof URL check failed');
        diagnostics.push(
          buddyForwardingDiagnostic(
            'GET',
            request.url?.replace(/objects\/[a-f\d]{64}$/, 'snapshots'),
            (error as NodeJS.ErrnoException).code,
            phase(),
            admittedPhase,
            {
              reusedSocket: altered.reusedSocket,
              requestAborted: request.aborted,
              responseDestroyed: response.destroyed,
              responseFinished: response.writableFinished,
            },
          ),
        );
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
  return {
    metrics,
    failures,
    diagnostics,
    outages,
    setUnavailable: (value: boolean, status: 429 | 503 = 503) => {
      unavailableStatus = status;
      unavailable = value;
    },
    refresh,
    request,
    close,
  };
};

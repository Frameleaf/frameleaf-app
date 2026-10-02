import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { EdgeDirectService } from 'src/edge/edge-direct.service.js';
import type { EdgeRelayService } from 'src/edge/edge-relay.service.js';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { EdgeStateService } from 'src/edge/edge-state.service.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';

// Certificate issuance and router discovery are outside this teardown boundary.
vi.mock('src/edge/edge-certificate.repository.js', () => ({ EdgeCertificateRepository: class {} }));
vi.mock('src/edge/edge-port-mapping.service.js', () => ({ EdgePortMappingService: class {} }));

const HOST = 'r.u225vlzhsdlhwh4l.frameleaf.net';
const VAULT = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';

describe('Buddy-only edge teardown', () => {
  it.each(['stopServing', 'idle'] as const)(
    '%s refuses ordinary HTTP and upgrades while direct shutdown is pending',
    async (transition) => {
      const seen: string[] = [];
      const upstream = http.createServer((request, response) => {
        seen.push(request.url!);
        request.resume();
        response.end('upstream');
      });
      upstream.on('upgrade', (request, socket) => {
        seen.push(request.url!);
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      });
      upstream.listen(0, '127.0.0.1');
      await once(upstream, 'listening');
      const config = {
        getEnv: () =>
          mockEnvData({
            port: (upstream.address() as AddressInfo).port,
            frameleafCloud: {
              ...mockEnvData({}).frameleafCloud,
              edge: { port: 2443, bind: '0.0.0.0', secret: 'edge-secret', acmeDirectoryUrl: null },
            },
          }),
      } as ConfigRepository;
      const logger = { setContext: vi.fn() } as unknown as LoggingRepository;
      const proxy = new EdgeProxyService(logger, config);
      proxy.configureRecovery(
        {
          pairId: VAULT,
          vaultId: VAULT,
          sourceInstanceId: VAULT,
          host: 'recovery.u225vlzhsdlhwh4l.frameleaf.net',
          readUntil: null,
          backupEnabled: true,
          writeAllowed: true,
        },
        true,
      );
      // Decrypted normal-SNI relay arrivals, including a handshake that finishes during teardown.
      const front = net.createServer((socket) =>
        proxy.accept(socket, { via: 'relay', host: HOST, clientIp: '203.0.113.9' }),
      );
      front.listen(0, '127.0.0.1');
      await once(front, 'listening');
      const directClosing = Promise.withResolvers<void>();
      const directClosed = Promise.withResolvers<void>();
      let relayStopped = false;
      const direct = {
        listening: true,
        stop: async () => {
          directClosing.resolve();
          await directClosed.promise;
        },
      } as unknown as EdgeDirectService;
      const relay = {
        stop: () => {
          relayStopped = true;
          return Promise.resolve();
        },
      } as unknown as EdgeRelayService;
      const state = new EdgeStateService(
        logger,
        config,
        {} as never,
        { set: async () => {} } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        direct,
        proxy,
        relay,
        { release: async () => {} } as never,
      );
      const request = (path: string, upgrade = false) =>
        new Promise<number>((resolve, reject) => {
          const outgoing = http.request({
            host: '127.0.0.1',
            port: (front.address() as AddressInfo).port,
            agent: false,
            path,
            headers: { host: HOST, ...(upgrade && { connection: 'Upgrade', upgrade: 'websocket' }) },
          });
          outgoing.on('response', (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode!));
          });
          outgoing.on('upgrade', (response, socket) => {
            socket.destroy();
            resolve(response.statusCode!);
          });
          outgoing.on('error', reject);
          outgoing.end();
        });
      let teardown: Promise<void> | undefined;
      try {
        expect(await request(`/api/buddy/v1/vaults/${VAULT}/snapshots`)).toBe(200);
        seen.length = 0;
        teardown =
          transition === 'idle'
            ? state['idle'](
                { serve: false, status: 'off', reason: 'Buddy pair blocked', removeCertificates: false, link: null },
                null,
                Date.now(),
              )
            : state['stopServing']();
        await directClosing.promise;

        // The listener's close callback is still pending. Late arrivals cannot gain ordinary access.
        const httpStatus = await request('/api/server/ping');
        const upgradeStatus = await request('/api/socket.io/', true);
        expect([httpStatus, upgradeStatus]).toEqual([403, 403]);
        expect(seen).toEqual([]);
        expect(relayStopped).toBe(true);

        directClosed.resolve();
        await teardown;
        expect(await request('/api/server/ping')).toBe(403);
        expect(seen).toEqual([]);
      } finally {
        directClosed.resolve();
        await teardown;
        proxy.destroy();
        await new Promise<void>((resolve) => front.close(() => resolve()));
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    },
  );
});

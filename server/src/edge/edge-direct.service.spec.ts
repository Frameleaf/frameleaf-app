import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { EdgeDirectService } from 'src/edge/edge-direct.service.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { automock } from 'test/utils.js';

/** Test-only self-signed certificates and keys (openssl, P-256), never used anywhere else. */
const FIXTURES = join(import.meta.dirname, '../../test/fixtures/frameleaf-edge');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');

const enrollment = { label: 'u225vlzhsdlhwh4l', domain: 'frameleaf-direct.net' };
const LAN_NAME = '192-168-1-10.u225vlzhsdlhwh4l.frameleaf-direct.net';
const RELAY_NAME = 'r.u225vlzhsdlhwh4l.frameleaf-direct.net';

describe(EdgeDirectService.name, () => {
  let sut: EdgeDirectService;
  let proxy: { accept: ReturnType<typeof vi.fn>; closeAll: ReturnType<typeof vi.fn> };
  let port: number;

  const connect = (servername: string) =>
    new Promise<{ subject: string; closedByServer: boolean }>((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false }, () => {
        const subject = socket.getPeerCertificate().subject?.CN ?? '';
        socket.once('close', () => resolve({ subject, closedByServer: true }));
        setTimeout(() => {
          socket.destroy();
          resolve({ subject, closedByServer: false });
        }, 200);
      });
      socket.on('error', reject);
    });

  beforeEach(async () => {
    const config = {
      getEnv: () =>
        mockEnvData({
          frameleafCloud: {
            ...mockEnvData({}).frameleafCloud,
            edge: { port: 0, bind: '127.0.0.1', secret: 'secret-0123456789abcdef', acmeDirectoryUrl: null },
            trustedLanCidrs: [],
          },
        }),
    } as unknown as ConfigRepository;
    proxy = {
      accept: vi.fn((socket: tls.TLSSocket) => {
        socket.end();
        return true;
      }),
      closeAll: vi.fn(() => Promise.resolve()),
    };
    const logger = automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false });
    sut = new EdgeDirectService(logger, config, proxy as unknown as EdgeProxyService);
    sut.configure({
      contexts: {
        wildcard: { certificate: await fixture('wildcard.cert.pem'), key: await fixture('wildcard.key.pem') },
        custom: {
          host: 'photos.example.com',
          certificate: await fixture('custom.cert.pem'),
          key: await fixture('custom.key.pem'),
        },
      },
      enrollment,
      allowWan: false,
    });
    await sut.start();
    port = ((sut as unknown as { server: tls.Server }).server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await sut.stop();
  });

  it('serves the wildcard certificate and tags a home peer on a LAN name as lan', async () => {
    const result = await connect(LAN_NAME);
    expect(result.subject).toBe('u225vlzhsdlhwh4l.frameleaf-direct.net');
    expect(proxy.accept).toHaveBeenCalledWith(expect.anything(), {
      via: 'lan',
      clientIp: '127.0.0.1',
      host: LAN_NAME,
    });
  });

  it('serves the custom hostname’s certificate by SNI', async () => {
    const result = await connect('photos.example.com');
    expect(result.subject).toBe('photos.example.com');
  });

  it('closes connections from outside the home in "Relay only" mode', async () => {
    const result = await connect(RELAY_NAME);
    expect(result.closedByServer).toBe(true);
    expect(proxy.accept).not.toHaveBeenCalled();
  });

  it('proxies wan connections in "Relay and direct" mode', async () => {
    sut.configure({
      contexts: {
        wildcard: { certificate: await fixture('wildcard.cert.pem'), key: await fixture('wildcard.key.pem') },
      },
      enrollment,
      allowWan: true,
    });
    await connect(RELAY_NAME);
    expect(proxy.accept).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ via: 'wan' }));
  });

  it('stops listening and closes every connection within 5 seconds', async () => {
    proxy.accept.mockImplementation(() => true);
    const socket = tls.connect({ host: '127.0.0.1', port, servername: LAN_NAME, rejectUnauthorized: false });
    await new Promise<void>((resolve) => socket.once('secureConnect', () => resolve()));
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    const started = Date.now();
    await sut.stop(1000);
    await closed;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(sut.listening).toBe(false);
    expect(proxy.closeAll).toHaveBeenCalledWith(1000);
  });
});

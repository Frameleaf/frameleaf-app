import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { EdgeDirectService } from 'src/edge/edge-direct.service.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';

/** Test-only self-signed certificates and keys (openssl, P-256), never used anywhere else. */
const FIXTURES = join(import.meta.dirname, '../../test/fixtures/frameleaf-edge');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');

const enrollment = { label: 'u225vlzhsdlhwh4l', domain: 'frameleaf.net' };
const LAN_NAME = '192-168-1-10.u225vlzhsdlhwh4l.frameleaf.net';
const RELAY_NAME = 'r.u225vlzhsdlhwh4l.frameleaf.net';
/** Serial numbers of `wildcard.cert.pem` and of `wildcard-renewed.cert.pem` (the same names, reissued). */
const WILDCARD_SERIAL = '330510F67D50B8376B7ABFE68031E0498A9387B7';
const RENEWED_WILDCARD_SERIAL = '36E8100F80EF7EBC0D092F1E66A123B91B26B3DD';

describe(EdgeDirectService.name, () => {
  let sut: EdgeDirectService;
  let proxy: { accept: ReturnType<typeof vi.fn>; closeAll: ReturnType<typeof vi.fn> };
  let port: number;

  const connect = (servername: string) =>
    new Promise<{ subject: string; serial: string; closedByServer: boolean }>((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false }, () => {
        const certificate = socket.getPeerCertificate();
        const cn = certificate.subject?.CN;
        const peer = { subject: (Array.isArray(cn) ? cn[0] : cn) ?? '', serial: certificate.serialNumber };
        socket.once('close', () => resolve({ ...peer, closedByServer: true }));
        setTimeout(() => {
          socket.destroy();
          resolve({ ...peer, closedByServer: false });
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
    const logger = { setContext: vi.fn(), log: vi.fn(), error: vi.fn() } as unknown as LoggingRepository;
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
      advertised: ['192.168.1.10'],
    });
    await sut.start();
    port = ((sut as unknown as { server: tls.Server }).server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await sut.stop();
  });

  it('serves the wildcard certificate, and a loopback peer (the self-check) as wan even in "Relay only"', async () => {
    const result = await connect(LAN_NAME);
    expect(result.subject).toBe('u225vlzhsdlhwh4l.frameleaf.net');
    expect(proxy.accept).toHaveBeenCalledWith(expect.anything(), {
      via: 'wan',
      clientIp: '127.0.0.1',
      host: LAN_NAME,
    });
  });

  /**
   * A decrypted connection as the listener sees it, from any address: the parts of a `TLSSocket` the
   * listener and the proxy mock touch (`secureConnection` hands over the TLS socket itself).
   */
  const arrive = (remoteAddress: string, servername: string) => {
    const socket = { remoteAddress, servername, destroy: vi.fn(), end: vi.fn() };
    (sut as unknown as { onSecureConnection: (socket: unknown) => void }).onSecureConnection(socket);
    return socket;
  };

  it("tags a peer on the advertised LAN address's subnet as lan", () => {
    arrive('192.168.1.20', LAN_NAME);
    expect(proxy.accept).toHaveBeenCalledWith(expect.anything(), {
      via: 'lan',
      clientIp: '192.168.1.20',
      host: LAN_NAME,
    });
  });

  it('serves the custom hostname’s certificate by SNI', async () => {
    const result = await connect('photos.example.com');
    expect(result.subject).toBe('photos.example.com');
  });

  it('marks recovery SNI for the same restricted proxy boundary on a paid direct listener', async () => {
    const host = `recovery.${enrollment.label}.${enrollment.domain}`;
    await connect(host);
    expect(proxy.accept).toHaveBeenCalledWith(expect.anything(), {
      via: 'wan',
      clientIp: '127.0.0.1',
      host,
      buddyRecovery: true,
    });
  });

  it('serves the wildcard certificate to a ClientHello with no SNI at all (FL-229: connecting by IP literal)', async () => {
    // An empty `servername` is node:tls's own way to omit the SNI extension from the ClientHello -
    // this is what an app connecting straight to a LAN IP (no hostname to send) looks like on the
    // wire, e.g. under DNS rebinding protection that refuses to resolve a public name to a private
    // address.
    const result = await connect('');
    expect(result.subject).toBe('u225vlzhsdlhwh4l.frameleaf.net');
    expect(result.serial).toBe(WILDCARD_SERIAL);
    // the connection is served like any other: no name, so it is never `lan`
    expect(proxy.accept).toHaveBeenCalledWith(expect.anything(), { via: 'wan', clientIp: '127.0.0.1', host: null });
  });

  it('serves the wildcard certificate with no SNI when there is no custom hostname certificate', async () => {
    sut.configure({
      contexts: {
        wildcard: { certificate: await fixture('wildcard.cert.pem'), key: await fixture('wildcard.key.pem') },
      },
      enrollment,
      allowWan: false,
      advertised: ['192.168.1.10'],
    });
    expect((await connect('')).serial).toBe(WILDCARD_SERIAL);
  });

  it('serves the renewed wildcard certificate with no SNI once a renewal swaps it in (FL-288)', async () => {
    expect((await connect('')).serial).toBe(WILDCARD_SERIAL);
    // a renewal: the same names, a new certificate and key, swapped in while listening
    sut.configure({
      contexts: {
        wildcard: {
          certificate: await fixture('wildcard-renewed.cert.pem'),
          key: await fixture('wildcard-renewed.key.pem'),
        },
        custom: {
          host: 'photos.example.com',
          certificate: await fixture('custom.cert.pem'),
          key: await fixture('custom.key.pem'),
        },
      },
      enrollment,
      allowWan: false,
      advertised: ['192.168.1.10'],
    });
    const unnamed = await connect('');
    expect(unnamed.subject).toBe('u225vlzhsdlhwh4l.frameleaf.net');
    expect(unnamed.serial).toBe(RENEWED_WILDCARD_SERIAL);
    // and the names keep their certificates: the renewed wildcard by name, the custom one untouched
    expect((await connect(LAN_NAME)).serial).toBe(RENEWED_WILDCARD_SERIAL);
    expect((await connect('photos.example.com')).subject).toBe('photos.example.com');
  });

  it('keeps serving the wildcard certificate for a name it does not know', async () => {
    const result = await connect('elsewhere.example.org');
    expect(result.serial).toBe(WILDCARD_SERIAL);
  });

  it('does not listen before it has a certificate, so there is nothing for a no-SNI connection to reach', async () => {
    await sut.stop();
    await expect(sut.start()).rejects.toThrow('The direct listener has no certificate yet');
    expect(sut.listening).toBe(false);
    await expect(connect('')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('closes connections from outside the home in "Relay only" mode', () => {
    const outside = arrive('203.0.113.9', LAN_NAME);
    expect(outside.destroy).toHaveBeenCalled();
    // a home peer that did not ask for an advertised LAN name counts as outside too
    const unnamed = arrive('192.168.1.20', RELAY_NAME);
    expect(unnamed.destroy).toHaveBeenCalled();
    expect(proxy.accept).not.toHaveBeenCalled();
  });

  it('proxies wan connections in "Relay and direct" mode', async () => {
    sut.configure({
      contexts: {
        wildcard: { certificate: await fixture('wildcard.cert.pem'), key: await fixture('wildcard.key.pem') },
      },
      enrollment,
      allowWan: true,
      advertised: ['192.168.1.10'],
    });
    arrive('203.0.113.9', RELAY_NAME);
    expect(proxy.accept).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ via: 'wan' }));
  });

  it('stops listening and closes every connection within 5 seconds', async () => {
    proxy.accept.mockImplementation(() => true);
    const socket = tls.connect({ host: '127.0.0.1', port, servername: LAN_NAME, rejectUnauthorized: false });
    // the listener destroys the connection on stop, so the client may see a reset; that is the point
    socket.on('error', () => {});
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

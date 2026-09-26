import { Injectable } from '@nestjs/common';
import type { Socket } from 'node:net';
import tls, { type SecureContext, type TLSSocket } from 'node:tls';
import type { FrameleafRemoteEnrollment } from 'src/types.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TEARDOWN_MS, classifyArrival } from 'src/utils/frameleaf-remote-access.js';

/** The certificates the listener serves: the wildcard, and the custom hostname's when there is one. */
export type EdgeContexts = {
  wildcard: { certificate: string; key: string };
  custom?: { host: string; certificate: string; key: string } | null;
};

type LoadedContexts = { wildcard: SecureContext; custom: { host: string; context: SecureContext } | null };

/** The TLS handshake must finish within this long. */
const HANDSHAKE_TIMEOUT_MS = 10 * 1000;

/**
 * The edge worker's direct HTTPS listener (FL-165, CLD-102) on `FRAMELEAF_EDGE_BIND:FRAMELEAF_EDGE_PORT`
 * (default `0.0.0.0:2443`), serving the wildcard certificate, or the custom hostname's certificate
 * when a visitor asks for that name. Each connection is tagged `lan` or `wan` (`classifyArrival`) and
 * handed to the proxy core, which applies the connection caps and the via contract.
 *
 * In "Relay only" mode nothing from outside the home network is served here: such connections are
 * closed, and only the LAN names answer. Certificates are swapped in place on renewal; open
 * connections keep the one they started with.
 */
@Injectable()
export class EdgeDirectService {
  private server: tls.Server | null = null;
  private contexts: LoadedContexts | null = null;
  private enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'> | null = null;
  private allowWan = false;
  private raw = new Set<Socket>();
  private listeningOn: { bind: string; port: number } | null = null;

  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private proxy: EdgeProxyService,
  ) {
    this.logger.setContext(EdgeDirectService.name);
  }

  get listening() {
    return this.server?.listening ?? false;
  }

  /** Replace the certificates, names and mode; takes effect for the next connection. */
  configure(input: {
    contexts: EdgeContexts;
    enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'>;
    allowWan: boolean;
  }) {
    const { contexts } = input;
    this.contexts = {
      wildcard: tls.createSecureContext({ cert: contexts.wildcard.certificate, key: contexts.wildcard.key }),
      custom: contexts.custom
        ? {
            host: contexts.custom.host,
            context: tls.createSecureContext({ cert: contexts.custom.certificate, key: contexts.custom.key }),
          }
        : null,
    };
    this.enrollment = input.enrollment;
    this.allowWan = input.allowWan;
  }

  /** Listen on the configured address, once the certificates are configured. Resolves once listening. */
  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    if (!this.contexts) {
      throw new Error('The direct listener has no certificate yet');
    }
    const { bind, port } = this.configRepository.getEnv().frameleafCloud.edge;
    const server = tls.createServer({
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      ALPNProtocols: ['http/1.1'],
      minVersion: 'TLSv1.2',
      SNICallback: (servername, callback) => callback(null, this.contextFor(servername)),
    });
    server.on('connection', (socket: Socket) => {
      this.raw.add(socket);
      socket.once('close', () => this.raw.delete(socket));
    });
    server.on('secureConnection', (socket) => this.onSecureConnection(socket));
    server.on('tlsClientError', () => {
      // a visitor that never finished the handshake; nothing to log per connection
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      throw error;
    }
    server.on('error', (error) => this.logger.error(`The direct listener failed: ${error}`));
    this.listeningOn = { bind, port };
    this.logger.log(`Remote access direct listener on ${bind}:${port}`);
  }

  /** Stop listening and close every connection within `TEARDOWN_MS`. */
  async stop(timeoutMs = TEARDOWN_MS): Promise<void> {
    const server = this.server;
    this.server = null;
    this.contexts = null;
    if (!server) {
      return;
    }
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const force = setTimeout(() => {
      for (const socket of this.raw) {
        socket.destroy();
      }
    }, Math.max(0, timeoutMs - 250));
    force.unref();
    await this.proxy.closeAll(timeoutMs);
    for (const socket of this.raw) {
      socket.destroy();
    }
    await closed;
    clearTimeout(force);
    if (this.listeningOn) {
      this.logger.log(`Remote access direct listener on ${this.listeningOn.bind}:${this.listeningOn.port} closed`);
      this.listeningOn = null;
    }
  }

  private contextFor(servername: string): SecureContext | undefined {
    const contexts = this.contexts;
    if (!contexts) {
      return;
    }
    const name = servername.toLowerCase().replace(/\.$/, '');
    return contexts.custom && name === contexts.custom.host ? contexts.custom.context : contexts.wildcard;
  }

  private onSecureConnection(socket: TLSSocket) {
    const enrollment = this.enrollment;
    if (!enrollment) {
      socket.destroy();
      return;
    }
    const servername = typeof socket.servername === 'string' ? socket.servername : null;
    const via = classifyArrival({
      peer: socket.remoteAddress,
      servername,
      enrollment,
      trustedLanCidrs: this.configRepository.getEnv().frameleafCloud.trustedLanCidrs,
    });
    if (via === 'wan' && !this.allowWan) {
      // "Relay only": direct connections from outside the home are not served
      socket.destroy();
      return;
    }
    this.proxy.accept(socket, {
      via,
      clientIp: (socket.remoteAddress ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, ''),
      host: servername,
    });
  }
}

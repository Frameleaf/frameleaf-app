import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import tls, { type SecureContext, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';
import type { FrameleafRemoteEnrollment } from 'src/types.js';
import { buddyRecoveryHost } from 'src/edge/buddy-recovery.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TEARDOWN_MS, classifyArrival, isLoopbackPeer } from 'src/utils/frameleaf-remote-access.js';

/** The certificates the listener serves: the wildcard, and the custom hostname's when there is one. */
export type EdgeContexts = {
  wildcard: { certificate: string; key: string };
  custom?: { host: string; certificate: string; key: string } | null;
};

type LoadedContexts = { wildcard: SecureContext; custom: { host: string; context: SecureContext } | null };
type WildcardPem = { cert: string; key: string };

/** The TLS handshake must finish within this long. */
const HANDSHAKE_TIMEOUT_MS = 10 * 1000;

/**
 * The edge worker's direct HTTPS listener (FL-165, CLD-102) on `FRAMELEAF_EDGE_BIND:FRAMELEAF_EDGE_PORT`
 * (default `0.0.0.0:2443`), serving the wildcard certificate, or the custom hostname's certificate
 * when a visitor asks for that name. Each connection is tagged `lan` or `wan` (`classifyArrival`) and
 * handed to the proxy core, which applies the connection caps and the via contract.
 *
 * Which certificate a ClientHello gets (Frameleaf Cloud's contract S7 for the native apps):
 * - no SNI at all (an app connecting to an IP literal): the wildcard, also right after a renewal;
 * - the verified custom hostname: that hostname's certificate;
 * - any other name, known or not: the wildcard.
 * Before the wildcard is issued there is no listener at all, so nothing is presented.
 *
 * In "Relay only" mode nothing from outside the home network is served here: such connections are
 * closed, and only the LAN names answer. Certificates are swapped in place on renewal; open
 * connections keep the one they started with.
 */
@Injectable()
export class EdgeDirectService {
  private server: tls.Server | null = null;
  private contexts: LoadedContexts | null = null;
  /** Kept alongside `contexts.wildcard` so the listener has a default cert for a ClientHello with
   * no SNI at all (FL-229) - node:tls only consults `SNICallback` once a default is set. */
  private wildcardPem: WildcardPem | null = null;
  private enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'> | null = null;
  private allowWan = false;
  private advertised: string[] = [];
  private gateways: string[] = [];
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
    /** The LAN addresses this edge worker publishes names for; only those can make an arrival `lan`. */
    advertised: string[];
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
    this.wildcardPem = { cert: contexts.wildcard.certificate, key: contexts.wildcard.key };
    // A renewal while already listening: node:tls only reads the constructor's cert/key once, so the
    // default used for a ClientHello with no SNI needs updating in place too (SNICallback is always
    // re-consulted per connection, so the per-name contexts need no equivalent call).
    this.server?.setSecureContext(this.wildcardPem);
    this.enrollment = input.enrollment;
    this.allowWan = input.allowWan;
    this.advertised = input.advertised;
    this.gateways = defaultGateways();
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
      // The default context: what's served for a ClientHello with no SNI at all (FL-229 - an app
      // connecting by IP literal, with no hostname to send, e.g. under DNS rebinding protection).
      // node:tls does not invoke SNICallback for that case; only a configured default is used.
      ...this.wildcardPem,
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
    const force = setTimeout(
      () => {
        for (const socket of this.raw) {
          socket.destroy();
        }
      },
      Math.max(0, timeoutMs - 250),
    );
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

  /** A peer at the listener's own bind address: this host (the self-check with a specific bind). */
  private isListenAddress(address: string | undefined) {
    const bind = this.listeningOn?.bind;
    return !!bind && !!address && address.replace(/^::ffff:/i, '') === bind;
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
      advertised: this.advertised,
      gateways: this.gateways,
    });
    // "Relay only": direct connections from outside the home are not served. A peer on this host
    // (loopback or the bind address: the self-check) is served, tagged `wan`, so it still signs in.
    const self = isLoopbackPeer(socket.remoteAddress) || this.isListenAddress(socket.remoteAddress);
    if (via === 'wan' && !this.allowWan && !self) {
      socket.destroy();
      return;
    }
    this.proxy.accept(socket, {
      via,
      clientIp: (socket.remoteAddress ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, ''),
      host: servername,
      ...(servername?.toLowerCase().replace(/\.$/, '') === buddyRecoveryHost(enrollment) && { buddyRecovery: true }),
    });
  }
}

const hexIpv4 = (hex: string) =>
  [3, 2, 1, 0].map((index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)).join('.');

/**
 * This container's default gateways (Linux `/proc/net/route` and `/proc/net/ipv6_route`): the address
 * every visitor appears to come from behind Docker's userland proxy or slirp4netns. Empty elsewhere.
 */
export const defaultGateways = (read: (file: string) => string = (file) => readFileSync(file, 'utf8')) => {
  const gateways: string[] = [];
  try {
    for (const line of read('/proc/net/route').split('\n').slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/, 3);
      if (destination === '00000000' && gateway && gateway !== '00000000') {
        gateways.push(hexIpv4(gateway));
      }
    }
  } catch {
    // not Linux, or no IPv4 routes
  }
  try {
    for (const line of read('/proc/net/ipv6_route').split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] === '0'.repeat(32) && fields[1] === '00' && fields[4] && /[1-9a-f]/.test(fields[4])) {
        gateways.push(
          fields[4]
            .match(/.{4}/g)!
            .join(':')
            .replaceAll(/(^|:)0{1,3}/g, '$1'),
        );
      }
    }
  } catch {
    // no IPv6 routes
  }
  return gateways;
};

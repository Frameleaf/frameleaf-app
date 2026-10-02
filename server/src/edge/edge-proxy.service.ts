import { Injectable } from '@nestjs/common';
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import {
  type BuddyRecoveryAccess,
  buddyAuthorityMatches,
  buddyBackupRequestAllowed,
  buddyRecoveryRequestAllowed,
} from 'src/edge/buddy-recovery.js';
import { ImmichHeader } from 'src/enum.js';
import { stripFrameleafHeaders } from 'src/middleware/frameleaf-via.middleware.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  HSTS_HEADER,
  MAX_CONNECTIONS,
  MAX_CONNECTIONS_PER_ADDRESS,
  REQUEST_TIMEOUT_MS,
  TEARDOWN_MS,
  addressBucket,
} from 'src/utils/frameleaf-remote-access.js';
import { type FrameleafVia } from 'src/utils/frameleaf-sign-in.js';

/** How one connection reached the edge worker: the via tag and the visitor's own address. */
export type EdgeArrival = { via: FrameleafVia; clientIp: string; host: string | null; buddyRecovery?: boolean };

/** Hop-by-hop headers (RFC 9110 section 7.6.1), never forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Forwarding headers a visitor may send; the edge worker sets its own instead. */
const FORWARDING = new Set(['forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip']);

/** The API's address on this host: `FRAMELEAF_HOST` when it names one, else loopback. */
export const upstreamHost = (host: string | undefined) =>
  !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

/**
 * The headers a request reaches the API with: the visitor's own, minus hop-by-hop and connection-named
 * headers, every forwarding header and every `X-Frameleaf-*` header it sent (except the credentials
 * this server issued), plus the edge worker's own `X-Forwarded-For/Proto/Host`, `X-Frameleaf-Via`
 * and `X-Frameleaf-Via-Auth`.
 */
export const upstreamHeaders = (
  headers: IncomingHttpHeaders,
  arrival: EdgeArrival,
  secret: string,
  upgrade?: string,
): OutgoingHttpHeaders => {
  const connectionNamed = new Set(
    (headers.connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const copy: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lower) || FORWARDING.has(lower) || connectionNamed.has(lower)) {
      continue;
    }
    copy[lower] = value;
  }
  stripFrameleafHeaders(copy);
  const host = arrival.buddyRecovery
    ? arrival.host
    : typeof headers.host === 'string' && headers.host
      ? headers.host
      : arrival.host;
  return {
    ...copy,
    ...(upgrade && { connection: 'upgrade', upgrade }),
    'x-forwarded-for': arrival.clientIp,
    'x-forwarded-proto': 'https',
    ...(host && { 'x-forwarded-host': host }),
    [ImmichHeader.FrameleafVia]: arrival.via,
    [ImmichHeader.FrameleafViaAuth]: secret,
  };
};

/** The API's answer as the visitor gets it: without hop-by-hop headers, with HSTS. */
export const downstreamHeaders = (headers: IncomingHttpHeaders): OutgoingHttpHeaders => {
  const copy: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) {
      copy[name] = value;
    }
  }
  copy['strict-transport-security'] = HSTS_HEADER;
  return copy;
};

/**
 * The edge worker's proxy core (FL-165, CLD-102): every remote-access request, from the direct
 * listener and (CLD-103) the relay tunnel, is proxied to the API over loopback with the via contract.
 *
 * - Bodies stream both ways, never buffered: an upload or a video can run for up to 24 h, chunked or
 *   not; `Range` requests and `206` answers pass through untouched.
 * - WebSocket (and any other `Upgrade`) handshakes are forwarded and then spliced.
 * - Every answer carries HSTS; hop-by-hop headers never cross.
 * - At most 512 connections at once, 64 per visitor address (an IPv6 visitor by its /64).
 * - Without the per-boot `FRAMELEAF_EDGE_SECRET` nothing is proxied (503): a request the API could not
 *   verify would be refused there anyway, and the edge worker never pretends a remote visitor is home.
 */
@Injectable()
export class EdgeProxyService {
  private server: http.Server;
  private agent = new http.Agent({ keepAlive: true, maxSockets: MAX_CONNECTIONS });
  private arrivals = new WeakMap<Duplex, EdgeArrival>();
  private sockets = new Set<Duplex>();
  private perAddress = new Map<string, number>();
  private recovery: BuddyRecoveryAccess | null = null;
  private buddyOnly = false;

  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
  ) {
    this.logger.setContext(EdgeProxyService.name);
    this.server = http.createServer({ requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: 60 * 1000 });
    this.server.keepAliveTimeout = 65 * 1000;
    // the 24 h request timeout bounds a request; an idle socket between requests closes on keep-alive
    this.server.timeout = 0;
    this.server.on('request', (request, response) => this.onRequest(request, response));
    this.server.on('upgrade', (request, socket, head) => this.onUpgrade(request, socket, head));
    this.server.on('clientError', (error, socket) => {
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      }
      socket.destroy();
    });
  }

  /** Connections open right now (for the self-check and specs). */
  get connectionCount() {
    return this.sockets.size;
  }

  /** A learned block, unlink, expiry or rebind also closes already-open recovery connections. */
  configureRecovery(access: BuddyRecoveryAccess | null, buddyOnly = false) {
    if (JSON.stringify(access) !== JSON.stringify(this.recovery) || buddyOnly !== this.buddyOnly) {
      for (const socket of this.sockets) {
        const arrival = this.arrivals.get(socket);
        if (buddyOnly || buddyOnly !== this.buddyOnly || arrival?.buddyRecovery) {
          socket.destroy();
        }
      }
    }
    this.recovery = access;
    this.buddyOnly = buddyOnly;
  }

  /**
   * Take a connection a visitor opened (decrypted by the caller), or refuse it when the caps are
   * reached. Returns whether it was taken; a refused connection is destroyed.
   */
  accept(socket: Duplex, arrival: EdgeArrival): boolean {
    const address = addressBucket(arrival.clientIp);
    const count = this.perAddress.get(address) ?? 0;
    if (this.sockets.size >= MAX_CONNECTIONS || count >= MAX_CONNECTIONS_PER_ADDRESS) {
      socket.destroy();
      return false;
    }
    this.sockets.add(socket);
    this.perAddress.set(address, count + 1);
    this.arrivals.set(socket, arrival);
    // a visitor's connection failing (reset, TLS error) closes it; it never reaches the process
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      this.sockets.delete(socket);
      const left = (this.perAddress.get(address) ?? 1) - 1;
      if (left > 0) {
        this.perAddress.set(address, left);
      } else {
        this.perAddress.delete(address);
      }
    });
    this.server.emit('connection', socket);
    return true;
  }

  /** Close every connection: politely first, then by force within `TEARDOWN_MS`. */
  async closeAll(timeoutMs = TEARDOWN_MS): Promise<void> {
    if (this.sockets.size === 0) {
      return;
    }
    this.server.closeIdleConnections();
    const deadline = setTimeout(
      () => {
        for (const socket of this.sockets) {
          socket.destroy();
        }
      },
      Math.max(0, timeoutMs - 250),
    );
    deadline.unref();
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.sockets.size > 0) {
          return;
        }

        clearInterval(check);
        resolve();
      }, 50);
      check.unref();
    });
    clearTimeout(deadline);
  }

  destroy() {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.agent.destroy();
  }

  private arrivalOf(socket: Duplex): EdgeArrival | undefined {
    return this.arrivals.get(socket);
  }

  private upstream() {
    const { host, port, frameleafCloud } = this.configRepository.getEnv();
    return { host: upstreamHost(host), port, secret: frameleafCloud.edge.secret };
  }

  private onRequest(request: IncomingMessage, response: ServerResponse) {
    const arrival = this.arrivalOf(request.socket);
    const { host, port, secret } = this.upstream();
    if (!arrival || !secret) {
      this.refuse(response, 503, 'Remote access is not available on this server right now.');
      return;
    }
    if (
      arrival.buddyRecovery &&
      (arrival.host !== this.recovery?.host ||
        !buddyRecoveryRequestAllowed(this.recovery, request.method, request.url, request.headers.host))
    ) {
      this.refuse(response, 403, 'This recovery address only serves reads from its Buddy vault.');
      return;
    }
    if (
      this.buddyOnly &&
      !arrival.buddyRecovery &&
      (!buddyAuthorityMatches(request.headers.host, arrival.host) ||
        !buddyBackupRequestAllowed(this.recovery, request.method, request.url))
    ) {
      this.refuse(response, 403, 'This address only serves its Buddy vault.');
      return;
    }
    const outgoing = http.request({
      host,
      port,
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request.headers, arrival, secret),
      agent: this.agent,
    });
    outgoing.on('information', (answer) => {
      // The edge HTTP server already sends 100 Continue; 101 uses the upgrade path.
      if (answer.statusCode < 102 || response.destroyed || response.headersSent) {
        return;
      }
      // Public in Node24.18; the pinned Node type package predates this method.
      (
        response as ServerResponse & {
          writeInformation(statusCode: number, headers: OutgoingHttpHeaders): void;
        }
      ).writeInformation(answer.statusCode, downstreamHeaders(answer.headers));
    });
    outgoing.on('response', (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.statusMessage, downstreamHeaders(answer.headers));
      answer.pipe(response);
      answer.on('error', () => response.destroy());
    });
    outgoing.on('error', (error) => {
      this.logger.warn(`The API did not answer a remote-access request: ${error.message}`);
      if (response.headersSent) {
        response.destroy();
      } else {
        this.refuse(response, 502, 'This server did not answer. Try again in a moment.');
      }
    });
    // the visitor went away: stop the API's work on it too
    response.on('close', () => {
      if (!response.writableFinished) {
        outgoing.destroy();
      }
    });
    request.pipe(outgoing);
    request.on('error', () => outgoing.destroy());
  }

  private onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const arrival = this.arrivalOf(socket);
    const { host, port, secret } = this.upstream();
    const upgrade = typeof request.headers.upgrade === 'string' ? request.headers.upgrade : undefined;
    if (arrival?.buddyRecovery || this.buddyOnly) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (!arrival || !secret || !upgrade) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const outgoing = http.request({
      host,
      port,
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request.headers, arrival, secret, upgrade),
      // an upgraded connection is spliced for its whole life, never pooled
      agent: false,
    });
    outgoing.on('upgrade', (answer, upstream, upstreamHead) => {
      const lines = [`HTTP/1.1 ${answer.statusCode ?? 101} ${answer.statusMessage ?? 'Switching Protocols'}`];
      for (let index = 0; index < answer.rawHeaders.length; index += 2) {
        lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length > 0) {
        socket.write(upstreamHead);
      }
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(socket);
      socket.pipe(upstream);
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
    });
    outgoing.on('response', (answer) => {
      // the API refused the upgrade: pass its answer on and close
      const lines = [`HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ''}`];
      for (const [name, value] of Object.entries(downstreamHeaders(answer.headers))) {
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
      }
      lines.push('connection: close');
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      answer.pipe(socket);
    });
    outgoing.on('error', () => {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    outgoing.end();
  }

  private refuse(response: ServerResponse, status: number, message: string) {
    const body = JSON.stringify({ message, statusCode: status });
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'strict-transport-security': HSTS_HEADER,
      connection: 'close',
    });
    response.end(body);
  }
}

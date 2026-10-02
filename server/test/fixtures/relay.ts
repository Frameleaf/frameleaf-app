import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http2, { type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import net, { type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import tls, { type TLSSocket } from 'node:tls';
import {
  FrameReader,
  TUNNEL_ALPN,
  TUNNEL_CONTROL_PATH,
  TUNNEL_HEADER_CLIENT_IP,
  TUNNEL_HEADER_SNI,
  encodeFrame,
  proofMessage,
} from 'src/utils/frameleaf-relay.js';

/**
 * A fake Frameleaf relay for specs (FL-166): the relay side of the tunnel protocol that Frameleaf
 * Cloud's Go relay (`apps/relay`, FC-30) implements, in Node, over real TLS and HTTP/2 on loopback.
 *
 * - `tun.<host>` terminates TLS with a test certificate (ALPN `fl-tunnel/1`), reads `AUTH`, verifies
 *   the relay token it issued (`issueToken`) and the denylist, sends `CHALLENGE`, verifies the
 *   `PROOF` against the token's `cnf.jwk`, answers `READY` and becomes the HTTP/2 client.
 * - It opens the control stream (`POST /fl-tunnel/control`) and answers in-band `AUTH` refreshes.
 * - `visit()` opens one visitor `CONNECT` stream with `x-fl-client-ip` and `x-fl-sni`, as the relay
 *   does for each visitor connection, and records every byte it splices, so a spec can check the
 *   relay only ever carried ciphertext.
 * - `ping.<host>` answers `204` to any HTTP/1.1 request (the round-trip probe).
 */

const FIXTURES = join(import.meta.dirname, 'frameleaf-relay');
export const relayFixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export type FakeTunnel = {
  label: string;
  claims: Record<string, any>;
  session: ClientHttp2Session;
  socket: TLSSocket;
  /** In-band AUTH frames received on the control stream, and what was answered. */
  refreshes: Array<{ ok: boolean; code?: string }>;
  /** Every byte spliced through visitor streams, both directions. */
  spliced: Buffer[];
  /** A visitor connection through the tunnel: a loopback TCP socket spliced to its CONNECT stream. */
  visit: (input: {
    sni: string;
    clientIp?: string | null;
    authority?: string;
  }) => Promise<Socket & { stream: ClientHttp2Stream }>;
  goaway: (reason: string) => void;
  closed: Promise<void>;
};

export class FakeRelay {
  readonly relayId: string;
  readonly host: string;
  readonly ca = relayFixture('ca.cert.pem');
  port = 0;
  /** Instance ids whose tunnels are refused (`ERROR revoked`) and closed (`GOAWAY revoked`). */
  denylist = new Set<string>();
  /** Answer every handshake with `ERROR {code}` instead. */
  refuseWith: string | null = null;
  /** Answer in-band refreshes with `ERROR {code}` instead. */
  refuseRefreshWith: string | null = null;
  keepaliveSec = 30;
  handshakes: Array<{ ok: boolean; code?: string }> = [];
  tunnels: FakeTunnel[] = [];
  pings = 0;
  private server: tls.Server;
  private tokenKey = generateKeyPairSync('ed25519');
  private waiters: Array<(tunnel: FakeTunnel) => void> = [];
  private sockets = new Set<Socket>();
  private pairs = net.createServer();
  private pairWaiters: Array<(socket: Socket) => void> = [];

  constructor(options: { relayId?: string; host?: string; cert?: string; key?: string } = {}) {
    this.relayId = options.relayId ?? 'eu1';
    this.host = options.host ?? 'eu1.relays.frameleaf.test';
    this.server = tls.createServer({
      cert: options.cert ?? relayFixture('tun.cert.pem'),
      key: options.key ?? relayFixture('tun.key.pem'),
      ALPNProtocols: [TUNNEL_ALPN, 'http/1.1'],
      minVersion: 'TLSv1.2',
    });
    this.server.on('secureConnection', (socket) => {
      socket.on('error', () => socket.destroy());
      if (socket.servername === `ping.${this.host}`) {
        this.ping(socket);
      } else if (socket.servername === `tun.${this.host}` && socket.alpnProtocol === TUNNEL_ALPN) {
        void this.handshake(socket).catch(() => socket.destroy());
      } else {
        socket.destroy();
      }
    });
    this.server.on('tlsClientError', () => {});
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }

  async listen() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.port = (this.server.address() as AddressInfo).port;
    this.pairs.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      this.pairWaiters.shift()?.(socket);
    });
    this.pairs.listen(0, '127.0.0.1');
    await once(this.pairs, 'listening');
    return this;
  }

  async close() {
    for (const tunnel of this.tunnels) {
      tunnel.session.destroy();
      tunnel.socket.destroy();
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await new Promise<void>((resolve) => this.pairs.close(() => resolve()));
  }

  /** Two connected loopback sockets: the visitor's end and the relay's. */
  private async pair(): Promise<[Socket, Socket]> {
    const inner = new Promise<Socket>((resolve) => {
      this.pairWaiters.push(resolve);
    });
    const visitor = net.connect((this.pairs.address() as AddressInfo).port, '127.0.0.1');
    visitor.on('error', () => visitor.destroy());
    this.sockets.add(visitor);
    visitor.once('close', () => this.sockets.delete(visitor));
    await once(visitor, 'connect');
    return [visitor, await inner];
  }

  /** A relay token as Frameleaf Cloud issues it (JWS `relay+jwt`, EdDSA), for `publicKeyX`'s key. */
  issueToken(input: {
    instanceId: string;
    label: string;
    domain: string;
    publicKeyX: string;
    hosts?: string[];
    relay?: string;
    lifetimeSec?: number;
    iat?: number;
    recovery?: { pairId: string; vaultId: string; sourceInstanceId: string };
  }): string {
    const iat = input.iat ?? Math.floor(Date.now() / 1000);
    const claims = {
      iss: 'https://api.frameleaf.cloud.test',
      sub: input.instanceId,
      sni: `${input.label}.${input.domain}`,
      hosts: input.hosts ?? [],
      relay: input.relay ?? this.relayId,
      cnf: { jwk: { kty: 'OKP', crv: 'Ed25519', x: input.publicKeyX } },
      thr: { bps: 8_000_000, burst: 4_194_304 },
      lim: { conns: input.recovery ? 2 : 500 },
      iat,
      exp: iat + (input.lifetimeSec ?? (input.recovery ? 300 : 4 * 3600)),
      jti: randomUUID(),
      ...(input.recovery && { purpose: 'buddy-recovery', ...input.recovery }),
    };
    const signingInput = `${b64({ alg: 'EdDSA', typ: 'relay+jwt', kid: 'relay-test' })}.${b64(claims)}`;
    return `${signingInput}.${sign(null, Buffer.from(signingInput), this.tokenKey.privateKey).toString('base64url')}`;
  }

  /** The `POST /v1/remote/relay-token` answer carrying `token`. */
  tokenAnswer(token: string) {
    return {
      token,
      expiresAt: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
      relay: { id: this.relayId, host: this.host, port: 443, sni: `tun.${this.host}`, alpn: TUNNEL_ALPN },
      refreshAfterSec: 7200,
      throttling: { bps: 8_000_000, burst: 4_194_304 },
      limits: { conns: 500 },
      keepaliveSec: this.keepaliveSec,
    };
  }

  /** The next tunnel that reaches READY (or the live one). */
  nextTunnel(): Promise<FakeTunnel> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Close every tunnel of a server that was revoked, as the relay does at its denylist poll. */
  revoke(instanceId: string) {
    this.denylist.add(instanceId);
    for (const tunnel of this.tunnels) {
      if (tunnel.claims.sub === instanceId) {
        tunnel.goaway('revoked');
      }
    }
  }

  /** Verify a token: signature, relay, expiry and denylist. Returns its claims or an error code. */
  private check(token: unknown): { claims: Record<string, any> } | { code: string } {
    if (typeof token !== 'string') {
      return { code: 'bad_frame' };
    }
    const [header, payload, signature] = token.split('.', 3);
    if (
      !header ||
      !payload ||
      !signature ||
      !verify(null, Buffer.from(`${header}.${payload}`), this.tokenKey.publicKey, Buffer.from(signature, 'base64url'))
    ) {
      return { code: 'invalid_token' };
    }
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, any>;
    if (claims.relay !== this.relayId) {
      return { code: 'wrong_relay' };
    }
    if (claims.exp * 1000 <= Date.now()) {
      return { code: 'token_expired' };
    }
    if (this.denylist.has(claims.sub)) {
      return { code: 'revoked' };
    }
    return { claims };
  }

  private ping(socket: TLSSocket) {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      while (buffer.includes('\r\n\r\n')) {
        buffer = buffer.slice(buffer.indexOf('\r\n\r\n') + 4);
        this.pings++;
        socket.write('HTTP/1.1 204 No Content\r\n\r\n');
      }
    });
  }

  private async handshake(socket: TLSSocket) {
    const reader = new FrameReader(socket);
    const fail = (code: string) => {
      this.handshakes.push({ ok: false, code });
      socket.end(encodeFrame({ type: 'ERROR', code }));
    };
    const auth = await reader.next();
    if (auth.type !== 'AUTH') {
      fail('unexpected_frame');
      return;
    }
    if (this.refuseWith) {
      fail(this.refuseWith);
      return;
    }
    const checked = this.check(auth.token);
    if ('code' in checked) {
      fail(checked.code);
      return;
    }
    const nonce = randomBytes(32);
    socket.write(encodeFrame({ type: 'CHALLENGE', nonce: nonce.toString('base64url') }));
    const proof = await reader.next();
    const signature = typeof proof.sig === 'string' ? Buffer.from(proof.sig, 'base64url') : Buffer.alloc(0);
    const key = createPublicKey({ key: checked.claims.cnf.jwk, format: 'jwk' });
    if (
      proof.type !== 'PROOF' ||
      signature.length !== 64 ||
      !verify(null, proofMessage(nonce, this.relayId), key, signature)
    ) {
      fail('bad_proof');
      return;
    }
    const rest = reader.detach();
    await new Promise<void>((resolve) =>
      socket.write(
        encodeFrame({
          type: 'READY',
          keepaliveSec: this.keepaliveSec,
          limits: { bps: 8_000_000, burstBytes: 4_194_304, conns: 500 },
        }),
        () => resolve(),
      ),
    );
    this.handshakes.push({ ok: true });
    if (rest.length > 0) {
      socket.unshift(rest);
    }
    // a second READY for the same label replaces the first
    for (const old of this.tunnels) {
      if (old.label === checked.claims.sni) {
        old.goaway('replaced');
      }
    }
    this.tunnel(socket, checked.claims);
  }

  private tunnel(socket: TLSSocket, claims: Record<string, any>) {
    const session = http2.connect(`https://tun.${this.host}`, { createConnection: () => socket });
    session.on('error', () => {});
    let current = claims;
    const tunnel: FakeTunnel = {
      label: claims.sni,
      claims,
      session,
      socket,
      refreshes: [],
      spliced: [],
      closed: once(session, 'close').then(() => {}),
      visit: async ({ sni, clientIp = '203.0.113.9', authority }) => {
        const headers: http2.OutgoingHttpHeaders = {
          ':method': 'CONNECT',
          ':authority': authority ?? `${sni}:443`,
          [TUNNEL_HEADER_SNI]: sni,
        };
        if (clientIp !== null) {
          headers[TUNNEL_HEADER_CLIENT_IP] = clientIp;
        }
        const stream = session.request(headers);
        const [response] = (await once(stream, 'response')) as [http2.IncomingHttpHeaders];
        if (Number(response[':status']) !== 200) {
          stream.destroy();
          throw new Error(`the instance answered ${response[':status']}`);
        }
        // the visitor gets a real TCP socket, spliced to the stream as the relay splices the visitor's connection
        const [visitor, inner] = await this.pair();
        stream.on('data', (chunk: Buffer) => {
          tunnel.spliced.push(Buffer.from(chunk));
          inner.write(chunk);
        });
        inner.on('data', (chunk: Buffer) => {
          tunnel.spliced.push(Buffer.from(chunk));
          stream.write(chunk);
        });
        stream.on('end', () => inner.end());
        inner.on('end', () => stream.end());
        stream.on('close', () => inner.destroy());
        inner.on('close', () => stream.destroy());
        inner.on('error', () => stream.destroy());
        stream.on('error', () => inner.destroy());
        return Object.assign(visitor, { stream });
      },
      goaway: (reason: string) => {
        if (session.destroyed) {
          return;
        }

        // GOAWAY with the reason as debug data; the connection closes once it was sent
        session.goaway(http2.constants.NGHTTP2_NO_ERROR, 0, Buffer.from(reason));
        setTimeout(() => {
          session.destroy();
          socket.destroy();
        }, 100).unref();
      },
    };
    session.on('ping', () => this.pings++);
    this.tunnels.push(tunnel);
    session.once('close', () => {
      this.tunnels = this.tunnels.filter((entry) => entry !== tunnel);
    });

    // the control stream, where in-band refreshes arrive
    const control = session.request(
      { ':method': 'POST', ':path': TUNNEL_CONTROL_PATH, ':authority': `tun.${this.host}` },
      { endStream: false },
    );
    control.on('error', () => {});
    control.once('response', () => {
      const reader = new FrameReader(control);
      const next = async () => {
        const frame = await reader.next();
        if (frame.type !== 'AUTH') {
          control.write(encodeFrame({ type: 'ERROR', code: 'unexpected_frame' }));
        } else if (this.refuseRefreshWith) {
          tunnel.refreshes.push({ ok: false, code: this.refuseRefreshWith });
          control.write(encodeFrame({ type: 'ERROR', code: this.refuseRefreshWith }));
        } else {
          const checked = this.check(frame.token);
          const code =
            'code' in checked
              ? checked.code
              : checked.claims.sub !== current.sub || checked.claims.cnf.jwk.x !== current.cnf.jwk.x
                ? 'key_mismatch'
                : null;
          if (code) {
            tunnel.refreshes.push({ ok: false, code });
            control.write(encodeFrame({ type: 'ERROR', code }));
          } else {
            current = (checked as { claims: Record<string, any> }).claims;
            tunnel.claims = current;
            tunnel.refreshes.push({ ok: true });
            control.write(encodeFrame({ type: 'READY', keepaliveSec: this.keepaliveSec, limits: { conns: 500 } }));
          }
        }
        await next();
      };
      next().catch(() => {});
    });

    const waiters = [...this.waiters];
    this.waiters.length = 0;
    for (const waiter of waiters) {
      waiter(tunnel);
    }
  }
}

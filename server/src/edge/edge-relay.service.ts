import { Injectable } from '@nestjs/common';
import { once } from 'node:events';
import http2, { type IncomingHttpHeaders, type ServerHttp2Session, type ServerHttp2Stream } from 'node:http2';
import { setTimeout as sleep } from 'node:timers/promises';
import tls, { type SecureContext, type TLSSocket } from 'node:tls';
import type { EdgeContexts } from 'src/edge/edge-direct.service.js';
import type { FrameleafRemoteAccess, FrameleafRemoteEnrollment } from 'src/types.js';
import {
  type BuddyRecoveryScope,
  buddyRecoveryHost,
  buddyRecoveryRelayResponseSchema,
  buddyRelayPurposeProblem,
} from 'src/edge/buddy-recovery.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FrameleafCloudError, FrameleafDiscoveryDocument, cloudErrorCode } from 'src/utils/frameleaf-cloud.js';
import { FrameleafInstanceToken } from 'src/utils/frameleaf-dpop.js';
import {
  type ControlFrame,
  FrameReader,
  RELAY_PING_TIMEOUT_MS,
  RELAY_RESELECT_AFTER_FAILURES,
  type RelayCandidate,
  type RelayMeasurement,
  type RelayTokenResponse,
  TUNNEL_ALPN,
  TUNNEL_CONTROL_PATH,
  TUNNEL_DRAINING,
  TUNNEL_HANDSHAKE_TIMEOUT_MS,
  TUNNEL_HEADER_CLIENT_IP,
  TUNNEL_HEADER_SNI,
  TUNNEL_PING_MISSES,
  TUNNEL_REVOKED,
  TunnelFrame,
  TunnelRefusedError,
  VISITOR_HANDSHAKE_TIMEOUT_MS,
  backoffDelayMs,
  challengeNonce,
  encodeFrame,
  expectFrame,
  proofMessage,
  refreshDelayMs,
  relayCandidatesResponseSchema,
  relayClientIp,
  relaySelectResponseSchema,
  relayTokenProblem,
  relayTokenResponseSchema,
  relayVisitorNameAllowed,
} from 'src/utils/frameleaf-relay.js';
import { TEARDOWN_MS, remoteEndpoints } from 'src/utils/frameleaf-remote-access.js';

/** Discovery and a DPoP-bound instance token, fetched only when a call needs the cloud. */
export type EdgeCloudSession = { document: FrameleafDiscoveryDocument; token: FrameleafInstanceToken };

/** What the tunnel is for: this link's server, its enrolment, and how to reach Frameleaf Cloud. */
export type EdgeRelayTarget = {
  instanceId: string;
  /** Changes when the server is linked again: a revoked tunnel is retried at once then. */
  linkKey: string;
  enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'>;
  cloud: () => Promise<EdgeCloudSession>;
  /** Present only when the one tunnel for this label must serve recovery instead of paid remote access. */
  recovery?: BuddyRecoveryScope;
  buddyOnly?: boolean;
};

type Contexts = { wildcard: SecureContext; custom: { host: string; context: SecureContext } | null };

/** How one tunnel ended, after READY. */
type TunnelEnd = { reason: string; goaway: string | null };

/** A revoked or suspended server waits this long before it asks again, unless it is linked again first. */
const REVOKED_RETRY_MS = 60 * 60 * 1000;
/** An in-band refresh the relay refused is tried again after this long (it keeps the tunnel until `exp`). */
const REFRESH_RETRY_MS = 60 * 1000;
/** The relay must answer an in-band AUTH within this long. */
const REFRESH_ANSWER_MS = 10 * 1000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The edge worker's blind relay tunnel (FL-166, CLD-103), the instance side of Frameleaf Cloud's
 * relay protocol (docs/remote-access.md, "Handshake and tunnel protocol"):
 *
 * - It asks Frameleaf Cloud for a relay token (`POST /v1/remote/relay-token`), bound to this server's
 *   identity key, after picking the relay with the lowest round trip (`GET /v1/remote/relays/candidates`,
 *   `POST /v1/remote/relays/select`) at start and whenever the current relay keeps failing or drains.
 * - It dials `tun.<relay>` over TLS 1.3 (ALPN `fl-tunnel/1`, the relay's certificate verified against
 *   the public roots), sends `AUTH {token}`, signs the relay's nonce (`PROOF`, Ed25519 over
 *   `fl-relay-v1` ‖ nonce ‖ relayId) and waits for `READY`.
 * - Then it runs an HTTP/2 server over that socket, the relay being the client. Each visitor arrives
 *   as one `CONNECT` stream carrying `x-fl-client-ip` and `x-fl-sni`; this server terminates the
 *   visitor's TLS inside the stream with its own certificate (whose key never leaves it) and hands
 *   the decrypted connection to the proxy core tagged `via: relay`. The relay only ever carries TLS
 *   records it cannot read. Only this server's own names are served; `:authority` is never dialled.
 * - PING every `keepaliveSec` (30 s); three unanswered PINGs reconnect. Reconnects wait a full-jitter
 *   backoff from 1 s to 5 min; three failures in a row re-select the relay. The token is refreshed
 *   in-band at half its life. A revoked or suspended server stops until it is linked again, remote
 *   access is turned off and on, or an hour passes.
 */
@Injectable()
export class EdgeRelayService {
  private contexts: Contexts | null = null;
  private enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'> | null = null;
  private customHost: string | null = null;
  private target: EdgeRelayTarget | null = null;
  private loop: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private tunnel: { socket: TLSSocket; session: ServerHttp2Session | null; close: (reason: string) => void } | null =
    null;
  private streams = new Set<ServerHttp2Stream>();
  private failures = 0;
  private attempt = 0;
  private reselect = true;
  private revoked: { linkKey: string; until: number } | null = null;
  private relayStatus: FrameleafRemoteAccess['relay'] = { connected: false };
  private bytesBefore = { in: 0, out: 0 };
  private disconnectedSince: number | null = null;

  /** Specs replace these seams. */
  dial = (options: tls.ConnectionOptions): TLSSocket => tls.connect(options);
  random = () => Math.random();
  /** Extra certificate authorities for the relay's certificate (the public roots otherwise). */
  ca: string | undefined = undefined;
  wait = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => {});

  constructor(
    private logger: LoggingRepository,
    private frameleafCloudRepository: FrameleafCloudRepository,
    private proxy: EdgeProxyService,
  ) {
    this.logger.setContext(EdgeRelayService.name);
  }

  /** The certificates visitors are served with, and the names that may be served. Applies to the next visitor. */
  configure(input: { contexts: EdgeContexts; enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'> }) {
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
    this.customHost = contexts.custom?.host ?? null;
  }

  /**
   * Keep a tunnel up for `target` (called on every pass while remote access serves). A different
   * server or link replaces the running tunnel.
   */
  async ensure(target: EdgeRelayTarget, now = Date.now()): Promise<void> {
    const previous = this.target;
    if (
      previous &&
      (previous.instanceId !== target.instanceId ||
        previous.linkKey !== target.linkKey ||
        previous.buddyOnly !== target.buddyOnly ||
        JSON.stringify(previous.recovery) !== JSON.stringify(target.recovery))
    ) {
      await this.stop();
    }
    this.target = target;
    if (this.loop) {
      return;
    }
    if (this.revoked && this.revoked.linkKey !== target.linkKey) {
      this.revoked = null;
    }
    this.disconnectedSince ??= now;
    const abort = new AbortController();
    this.abort = abort;
    this.loop = this.run(abort.signal)
      .catch((error: unknown) => this.logger.error(`The relay tunnel stopped: ${message(error)}`))
      .finally(() => {
        if (this.abort !== abort) {
          return;
        }

        this.loop = null;
        this.abort = null;
      });
  }

  /**
   * Close the tunnel and every visitor on it; nothing is retried until `ensure` again. Turning remote
   * access off and on again (which stops the tunnel) also asks Frameleaf Cloud again after a revocation.
   */
  async stop(timeoutMs = TEARDOWN_MS): Promise<void> {
    this.abort?.abort();
    this.tunnel?.close('stopped');
    for (const stream of this.streams) {
      stream.destroy();
    }
    // a cloud call in flight is not waited for past the deadline; the aborted loop ends after it
    await Promise.race([this.loop, sleep(timeoutMs, undefined, { ref: false })]);
    this.loop = null;
    this.abort = null;
    this.target = null;
    this.reselect = true;
    this.failures = 0;
    this.attempt = 0;
    this.disconnectedSince = null;
    this.revoked = null;
    this.relayStatus = { ...this.relayStatus, connected: false };
  }

  /** What the status panel shows: the relay, round trip, since when, bytes and the last problem. */
  status(): FrameleafRemoteAccess['relay'] {
    const socket = this.tunnel?.socket;
    const connected = !!this.tunnel?.session && this.relayStatus.connected;
    return {
      ...this.relayStatus,
      connected,
      bytesIn: this.bytesBefore.in + (connected && socket ? socket.bytesRead : 0),
      bytesOut: this.bytesBefore.out + (connected && socket ? socket.bytesWritten : 0),
      disconnectedSince:
        connected || this.disconnectedSince === null ? null : new Date(this.disconnectedSince).toISOString(),
      revoked: !!this.revoked,
    };
  }

  // ------------------------------------------------------------------ the loop

  private async run(signal: AbortSignal) {
    while (!signal.aborted) {
      const target = this.target!;
      if (this.revoked && this.revoked.linkKey === target.linkKey && this.revoked.until > Date.now()) {
        await this.wait(this.revoked.until - Date.now(), signal);
        continue;
      }
      this.revoked = null;
      let end: TunnelEnd | null = null;
      try {
        if (this.reselect && !target.recovery) {
          await this.select(target).catch((error: unknown) => {
            // the enrolment's relay stays in use
            this.logger.warn(`No other relay could be selected: ${message(error)}`);
          });
          this.reselect = false;
          this.failures = 0;
        }
        const grant = await this.token(target);
        end = await this.connect(target, grant, signal);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        this.failed(target, error);
      }
      if (signal.aborted) {
        return;
      }
      if (end) {
        // it was up: start over from the shortest wait, on the same relay unless it drains
        this.failures = 0;
        this.attempt = 0;
        this.ended(target, end);
      }
      await this.wait(backoffDelayMs(this.attempt++, this.random), signal);
    }
  }

  private failed(target: EdgeRelayTarget, error: unknown) {
    const code =
      error instanceof TunnelRefusedError
        ? error.code
        : error instanceof FrameleafCloudError
          ? cloudErrorCode(error)
          : null;
    this.note(message(error));
    if (
      (target.recovery && error instanceof FrameleafCloudError && [401, 403, 404, 409].includes(error.status ?? 0)) ||
      (code !== null && [TUNNEL_REVOKED, 'enrollment-suspended', 'instance_revoked'].includes(code))
    ) {
      this.stopUntilLinked(target);
      return;
    }
    if (code === TUNNEL_DRAINING || code === 'relay-unavailable') {
      this.reselect = true;
      return;
    }
    if (code === 'unavailable') {
      // the relay has not loaded its denylist yet: the same relay, after a wait
      return;
    }
    this.failures++;
    if (this.failures >= RELAY_RESELECT_AFTER_FAILURES) {
      this.reselect = true;
    }
  }

  private ended(target: EdgeRelayTarget, end: TunnelEnd) {
    this.note(end.goaway ? `The relay closed the tunnel (${end.goaway})` : `The tunnel closed: ${end.reason}`);
    if (end.goaway === TUNNEL_REVOKED) {
      this.stopUntilLinked(target);
    } else if (end.goaway === TUNNEL_DRAINING) {
      this.reselect = true;
    }
  }

  private stopUntilLinked(target: EdgeRelayTarget) {
    this.revoked = { linkKey: target.linkKey, until: Date.now() + REVOKED_RETRY_MS };
    this.logger.warn('Frameleaf Cloud does not allow this server a relay tunnel; it is tried again once relinked');
  }

  private note(problem: string) {
    this.relayStatus = { ...this.relayStatus, lastError: problem.slice(0, 300), lastErrorAt: new Date().toISOString() };
    this.logger.warn(`Relay tunnel: ${problem}`);
  }

  // ------------------------------------------------------------------ control plane

  /** Measure the candidates' round trips and let Frameleaf Cloud pick the relay. */
  private async select(target: EdgeRelayTarget) {
    const { document, token } = await target.cloud();
    const endpoints = remoteEndpoints(document);
    const { candidates } = await this.frameleafCloudRepository.requestJson(relayCandidatesResponseSchema, {
      url: endpoints.relayCandidates,
      dpop: token,
    });
    if (candidates.length === 0) {
      return;
    }
    const measurements = await Promise.all(candidates.slice(0, 10).map((candidate) => this.measure(candidate)));
    const { relay, changed } = await this.frameleafCloudRepository.requestJson(relaySelectResponseSchema, {
      method: 'POST',
      url: endpoints.relaySelect,
      dpop: token,
      body: { measurements },
    });
    if (changed) {
      this.logger.log(`Selected the Frameleaf relay ${relay.id}`);
    }
  }

  /**
   * One relay's round trip: TLS to `ping.<relay>`, then the fastest of three `HEAD /` requests on
   * that connection (the handshake is not counted). Any failure is `ok: false`.
   */
  measure(candidate: RelayCandidate): Promise<RelayMeasurement> {
    return new Promise<RelayMeasurement>((resolve) => {
      const socket = this.dial({
        host: candidate.pingHost,
        port: candidate.port,
        servername: candidate.pingHost,
        ALPNProtocols: ['http/1.1'],
        minVersion: 'TLSv1.2',
        ...(this.ca && { ca: this.ca }),
      });
      const failed = { relayId: candidate.id, rttMs: 0, ok: false };
      let settled = false;
      const done = (result: RelayMeasurement) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => done(failed), RELAY_PING_TIMEOUT_MS);
      socket.once('error', () => done(failed));
      const times: number[] = [];
      let answer = '';
      let started = 0;
      const ask = () => {
        answer = '';
        started = performance.now();
        socket.write(`HEAD / HTTP/1.1\r\nHost: ${candidate.pingHost}\r\n\r\n`);
      };
      socket.once('secureConnect', ask);
      socket.on('data', (chunk: Buffer) => {
        answer += chunk.toString('latin1');
        if (!answer.includes('\r\n\r\n')) {
          if (answer.length > 4096) {
            done(failed);
          }
          return;
        }
        if (!/^HTTP\/1\.1 204 /.test(answer)) {
          done(failed);
          return;
        }
        times.push(performance.now() - started);
        if (times.length < 3) {
          ask();
          return;
        }
        done({ relayId: candidate.id, rttMs: Math.min(60_000, Math.round(Math.min(...times) * 10) / 10), ok: true });
      });
      socket.once('end', () => done(failed));
    });
  }

  /** A relay token for this server, checked before it is used. */
  private async token(target: EdgeRelayTarget): Promise<{ answer: RelayTokenResponse; token: FrameleafInstanceToken }> {
    const { document, token } = await target.cloud();
    const answer = await this.frameleafCloudRepository.requestJson(
      target.recovery ? buddyRecoveryRelayResponseSchema : relayTokenResponseSchema,
      {
        method: 'POST',
        url: target.recovery ? `${document.api}/v1/buddy/recovery-relay-token` : remoteEndpoints(document).relayToken,
        dpop: token,
        body: target.recovery ? { version: 1, pairId: target.recovery.pairId, vaultId: target.recovery.vaultId } : {},
      },
    );
    const problem = relayTokenProblem(answer, {
      instanceId: target.instanceId,
      enrollment: target.enrollment,
      publicKeyX: token.signer.publicJwk.x,
      now: Date.now(),
    });
    const purposeProblem = buddyRelayPurposeProblem(
      answer,
      target.recovery,
      buddyRecoveryHost(target.enrollment),
      document.api,
      Date.now(),
    );
    if (problem || purposeProblem) {
      throw new Error(
        `Frameleaf Cloud answered with a relay token this server cannot use: ${problem ?? purposeProblem}`,
      );
    }
    return { answer, token };
  }

  // ------------------------------------------------------------------ the tunnel

  /** Handshake, then serve until the tunnel closes. Resolves with how it ended; throws when it never got READY. */
  private async connect(
    target: EdgeRelayTarget,
    grant: { answer: RelayTokenResponse; token: FrameleafInstanceToken },
    signal: AbortSignal,
  ): Promise<TunnelEnd> {
    const { answer, token } = grant;
    const { signer } = token;
    if (!signer.signBytes) {
      throw new Error('The identity key cannot sign the relay proof');
    }
    const socket = this.dial({
      host: answer.relay.host,
      port: answer.relay.port,
      servername: answer.relay.sni,
      ALPNProtocols: [TUNNEL_ALPN],
      minVersion: 'TLSv1.3',
      ...(this.ca && { ca: this.ca }),
    });
    socket.on('error', () => {});
    const onAbort = () => socket.destroy();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => socket.destroy(new Error('The relay handshake timed out')),
      TUNNEL_HANDSHAKE_TIMEOUT_MS,
    );
    let ready: ControlFrame;
    try {
      await once(socket, 'secureConnect', { signal });
      if (socket.alpnProtocol !== TUNNEL_ALPN) {
        throw new Error(`The relay did not speak ${TUNNEL_ALPN}`);
      }
      const reader = new FrameReader(socket);
      await write(socket, encodeFrame({ type: TunnelFrame.AUTH, token: answer.token }));
      const nonce = challengeNonce(expectFrame(await reader.next(), TunnelFrame.CHALLENGE));
      const sig = signer.signBytes(proofMessage(nonce, answer.relay.id));
      // every handshake write completes before HTTP/2 takes the socket over
      await write(socket, encodeFrame({ type: TunnelFrame.PROOF, sig: sig.toString('base64url') }));
      ready = expectFrame(await reader.next(), TunnelFrame.READY);
      const rest = reader.detach();
      if (rest.length > 0) {
        socket.unshift(rest);
      }
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) {
      socket.destroy();
      throw new Error('stopped');
    }
    const keepaliveSec =
      typeof ready.keepaliveSec === 'number' && ready.keepaliveSec >= 1 && ready.keepaliveSec <= 3600
        ? ready.keepaliveSec
        : answer.keepaliveSec;
    return this.serve(target, answer, socket, keepaliveSec, signal);
  }

  private serve(
    target: EdgeRelayTarget,
    first: RelayTokenResponse,
    socket: TLSSocket,
    keepaliveSec: number,
    signal: AbortSignal,
  ): Promise<TunnelEnd> {
    return new Promise<TunnelEnd>((resolve) => {
      const server = http2.createServer({
        settings: { enablePush: false, maxConcurrentStreams: 1000 },
        maxSessionMemory: 64,
      });
      let goaway: string | null = null;
      let control: { stream: ServerHttp2Stream; reader: FrameReader } | null = null;
      let pingsOut = 0;
      let refreshTimer: NodeJS.Timeout | undefined;
      let expiryTimer: NodeJS.Timeout | undefined;
      let closed = false;

      const close = (reason: string) => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(keepalive);
        clearTimeout(refreshTimer);
        clearTimeout(expiryTimer);
        signal.removeEventListener('abort', onAbort);
        this.bytesBefore = {
          in: this.bytesBefore.in + socket.bytesRead,
          out: this.bytesBefore.out + socket.bytesWritten,
        };
        this.relayStatus = { ...this.relayStatus, connected: false };
        this.disconnectedSince = Date.now();
        this.tunnel = null;
        session?.destroy();
        socket.destroy();
        resolve({ reason, goaway });
      };
      const onAbort = () => close('stopped');
      signal.addEventListener('abort', onAbort, { once: true });

      let session: ServerHttp2Session | null = null;
      this.tunnel = { socket, session: null, close };
      server.on('session', (created) => {
        session = created;
        this.tunnel = { socket, session: created, close };
        created.on('goaway', (_code: number, _last: number, data?: Buffer) => {
          goaway = data && data.length > 0 ? data.toString('utf8').slice(0, 64) : 'goaway';
          // open visitors finish; the relay closes the connection when they did
        });
        created.on('close', () => close('the relay closed the connection'));
        created.on('error', (error: Error) => close(`the tunnel failed: ${error.message}`));
      });
      server.on('stream', (stream, headers) => {
        stream.on('error', () => stream.destroy());
        const method = headers[':method'];
        if (method === 'CONNECT') {
          this.visitor(stream, headers, target);
        } else if (method === 'POST' && headers[':path'] === TUNNEL_CONTROL_PATH && !control) {
          stream.respond({ ':status': 200 });
          // a control stream that breaks or floods ends the tunnel; it reconnects
          control = {
            stream,
            reader: new FrameReader(stream, (error) => close(`the control stream failed: ${error.message}`)),
          };
        } else {
          stream.respond({ ':status': 404 }, { endStream: true });
        }
      });
      socket.on('close', () => close('the connection to the relay closed'));

      // three PINGs without an answer: the relay is gone
      const keepalive = setInterval(() => {
        if (!session || session.destroyed) {
          return;
        }
        if (pingsOut >= TUNNEL_PING_MISSES) {
          close('the relay stopped answering');
          return;
        }
        pingsOut++;
        session.ping((error, duration) => {
          if (error) {
            return;
          }

          pingsOut = 0;
          this.relayStatus = { ...this.relayStatus, latencyMs: Math.round(duration) };
        });
      }, keepaliveSec * 1000);
      keepalive.unref();

      // in-band refresh at half the token's life; a token for another relay means reconnecting there
      const refresh = async () => {
        try {
          const next = await this.token(target);
          if (closed) {
            return;
          }
          if (next.answer.relay.id !== first.relay.id || next.answer.relay.host !== first.relay.host) {
            close('Frameleaf Cloud moved this server to another relay');
            return;
          }
          if (!control) {
            throw new Error('the relay opened no control stream');
          }
          control.stream.write(encodeFrame({ type: TunnelFrame.AUTH, token: next.answer.token }));
          let reply: ControlFrame;
          try {
            reply = await control.reader.next(REFRESH_ANSWER_MS);
          } catch (error) {
            // no answer: the control exchange is out of step, so start a fresh tunnel
            close(`the relay did not answer the token refresh: ${message(error)}`);
            return;
          }
          expectFrame(reply, TunnelFrame.READY);
          if (target.recovery) {
            expire(next.answer);
          }
          schedule(refreshDelayMs(next.answer, Date.now()));
        } catch (error) {
          if (closed) {
            return;
          }
          if (
            (error instanceof TunnelRefusedError && error.code === TUNNEL_REVOKED) ||
            (target.recovery &&
              error instanceof FrameleafCloudError &&
              [401, 403, 404, 409].includes(error.status ?? 0))
          ) {
            goaway = TUNNEL_REVOKED;
            close('revoked');
            return;
          }
          // the tunnel lasts until the old token expires; try again meanwhile
          this.note(`The relay token could not be refreshed: ${message(error)}`);
          schedule(REFRESH_RETRY_MS);
        }
      };
      const schedule = (delay: number) => {
        clearTimeout(refreshTimer);
        if (!closed) {
          refreshTimer = setTimeout(() => void refresh(), delay);
          refreshTimer.unref();
        }
      };
      const expire = (answer: RelayTokenResponse) => {
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(
          () => close('the relay token expired'),
          Math.max(0, Date.parse(answer.expiresAt) - Date.now()),
        );
        expiryTimer.unref();
      };
      if (target.recovery) {
        expire(first);
      }
      schedule(refreshDelayMs(first, Date.now()));

      this.relayStatus = {
        ...this.relayStatus,
        connected: true,
        relayId: first.relay.id,
        host: first.relay.host,
        connectedAt: new Date().toISOString(),
      };
      this.disconnectedSince = null;
      this.logger.log(`Connected to the Frameleaf relay ${first.relay.id}`);
      // bytes the relay sent right after READY were put back on the socket; the session reads them first
      server.emit('connection', socket);
    });
  }

  /**
   * One visitor: the stream carries the visitor's TLS records. Only this server's own names are
   * accepted; the TLS name the visitor asks for must be the one the relay routed by; the connection
   * is decrypted here and proxied as `via: relay` from the address the relay saw.
   */
  private visitor(stream: ServerHttp2Stream, headers: IncomingHttpHeaders, target: EdgeRelayTarget) {
    const enrollment = this.enrollment;
    const contexts = this.contexts;
    const clientIp = relayClientIp(headers[TUNNEL_HEADER_CLIENT_IP]);
    const sniHeader = headers[TUNNEL_HEADER_SNI];
    const sni = typeof sniHeader === 'string' ? sniHeader.toLowerCase().replace(/\.$/, '') : null;
    if (
      !enrollment ||
      !contexts ||
      !clientIp ||
      !relayVisitorNameAllowed(sni, enrollment, this.customHost) ||
      (target.recovery && sni !== buddyRecoveryHost(target.enrollment))
    ) {
      stream.respond({ ':status': 403 }, { endStream: true });
      return;
    }
    stream.respond({ ':status': 200 });
    this.streams.add(stream);
    stream.once('close', () => this.streams.delete(stream));

    const socket = new tls.TLSSocket(stream, {
      isServer: true,
      ALPNProtocols: ['http/1.1'],
      minVersion: 'TLSv1.2',
      SNICallback: (servername, callback) => {
        const name = servername.toLowerCase().replace(/\.$/, '');
        if (name !== sni || !relayVisitorNameAllowed(name, enrollment, this.customHost)) {
          callback(new Error('not a name this server serves'), undefined);
          return;
        }
        callback(null, contexts.custom && name === contexts.custom.host ? contexts.custom.context : contexts.wildcard);
      },
    });
    const timer = setTimeout(() => socket.destroy(), VISITOR_HANDSHAKE_TIMEOUT_MS);
    socket.on('error', () => {
      clearTimeout(timer);
      socket.destroy();
      stream.destroy();
    });
    socket.once('close', () => stream.destroy());
    socket.once('secure', () => {
      clearTimeout(timer);
      // a ClientHello without SNI never reaches SNICallback
      const servername = typeof socket.servername === 'string' ? socket.servername.toLowerCase() : null;
      if (servername !== sni) {
        socket.destroy();
        return;
      }
      this.proxy.accept(socket, {
        via: 'relay',
        clientIp,
        host: servername,
        ...(servername === buddyRecoveryHost(enrollment) && { buddyRecovery: true }),
      });
    });
  }
}

const write = (socket: TLSSocket, data: Buffer) =>
  new Promise<void>((resolve, reject) => socket.write(data, (error) => (error ? reject(error) : resolve())));

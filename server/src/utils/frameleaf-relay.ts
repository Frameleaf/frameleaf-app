import { isIP } from 'node:net';
import z from 'zod';
import type { Duplex } from 'node:stream';
import type { FrameleafRemoteEnrollment } from 'src/types.js';
import { isHomeAddress } from 'src/utils/frameleaf-sign-in.js';

/**
 * The relay tunnel protocol (FL-166, CLD-103), as Frameleaf Cloud's contracts define it
 * (`packages/contracts/src/tunnel.ts` and `remote/relay.ts`, docs/remote-access.md "Handshake and
 * tunnel protocol"). Changing a constant here is a protocol version bump on both sides.
 */

export const TUNNEL_ALPN = 'fl-tunnel/1';
/** Domain separator of the PROOF signature: Ed25519 over `fl-relay-v1` ‖ nonce ‖ relayId. */
export const TUNNEL_PROOF_CONTEXT = 'fl-relay-v1';
/** Control frames before HTTP/2: a 4-byte big-endian length, then UTF-8 JSON of at most 64 KiB. */
export const TUNNEL_FRAME_HEADER_BYTES = 4;
export const TUNNEL_MAX_CONTROL_FRAME_BYTES = 64 * 1024;
/** CHALLENGE carries 32 random bytes (base64url); PROOF a 64-byte signature (base64url). */
export const TUNNEL_NONCE_BYTES = 32;
/** The relay's stream 1: `POST` to this path, where in-band token refreshes are exchanged. */
export const TUNNEL_CONTROL_PATH = '/fl-tunnel/control';
/** Headers the relay sets on every visitor `CONNECT` stream. */
export const TUNNEL_HEADER_CLIENT_IP = 'x-fl-client-ip';
export const TUNNEL_HEADER_SNI = 'x-fl-sni';
/** The whole handshake (TLS, AUTH, CHALLENGE, PROOF, READY) is bounded to 10 seconds. */
export const TUNNEL_HANDSHAKE_TIMEOUT_MS = 10 * 1000;
export const TUNNEL_KEEPALIVE_SEC = 30;
/** Three unanswered PINGs close the tunnel, which then reconnects. */
export const TUNNEL_PING_MISSES = 3;
/** Reconnects wait a full-jitter backoff from 1 second up to 5 minutes. */
export const RELAY_BACKOFF_FIRST_MS = 1000;
export const RELAY_BACKOFF_MAX_MS = 5 * 60 * 1000;
/** After this many failures in a row on one relay, another relay is selected. */
export const RELAY_RESELECT_AFTER_FAILURES = 3;
/** Administrators hear about a missing tunnel after 15 minutes (the notice is deduplicated for 24 hours). */
export const RELAY_NOTICE_AFTER_MS = 15 * 60 * 1000;
/** A visitor's TLS handshake inside its stream must finish within this long. */
export const VISITOR_HANDSHAKE_TIMEOUT_MS = 10 * 1000;
/** One relay's ping (TLS to `ping.<relay>` and a `204` answer) is given this long. */
export const RELAY_PING_TIMEOUT_MS = 5 * 1000;

export const TunnelFrame = {
  AUTH: 'AUTH',
  CHALLENGE: 'CHALLENGE',
  PROOF: 'PROOF',
  READY: 'READY',
  ERROR: 'ERROR',
} as const;
export type TunnelFrame = (typeof TunnelFrame)[keyof typeof TunnelFrame];

/** `ERROR {code}` values that mean this server may not hold a tunnel at all until it is linked again. */
export const TUNNEL_REVOKED = 'revoked';
/** `ERROR {code}` and `GOAWAY` reasons that ask for another relay. */
export const TUNNEL_DRAINING = 'draining';

export type ControlFrame = { type: string; [key: string]: unknown };

/** Encode a control frame: 4-byte big-endian length, then UTF-8 JSON. */
export const encodeFrame = (frame: ControlFrame): Buffer => {
  const body = Buffer.from(JSON.stringify(frame), 'utf8');
  if (body.length > TUNNEL_MAX_CONTROL_FRAME_BYTES) {
    throw new RangeError(`A control frame of ${body.length} bytes is too large`);
  }
  const header = Buffer.alloc(TUNNEL_FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};

/**
 * Decode one frame from the front of `buffer`, or null until all of it arrived. A frame that is too
 * large, is not JSON or has no string `type` throws.
 */
export const decodeFrame = (buffer: Buffer): { frame: ControlFrame; rest: Buffer } | null => {
  if (buffer.length < TUNNEL_FRAME_HEADER_BYTES) {
    return null;
  }
  const length = buffer.readUInt32BE(0);
  if (length > TUNNEL_MAX_CONTROL_FRAME_BYTES) {
    throw new RangeError(`A control frame of ${length} bytes is too large`);
  }
  const end = TUNNEL_FRAME_HEADER_BYTES + length;
  if (buffer.length < end) {
    return null;
  }
  const frame = JSON.parse(buffer.subarray(TUNNEL_FRAME_HEADER_BYTES, end).toString('utf8')) as unknown;
  if (!frame || typeof frame !== 'object' || typeof (frame as ControlFrame).type !== 'string') {
    throw new TypeError('A control frame has no type');
  }
  return { frame: frame as ControlFrame, rest: buffer.subarray(end) };
};

/**
 * Reads control frames from a stream. Bytes after the last frame asked for (the relay's HTTP/2
 * preface right after READY) are kept: `detach()` stops reading and hands them back for `unshift`.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private waiting: { resolve: (frame: ControlFrame) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer) => {
    if (this.failure) {
      // a failed reader keeps nothing
      return;
    }
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > TUNNEL_FRAME_HEADER_BYTES + TUNNEL_MAX_CONTROL_FRAME_BYTES && !this.waiting) {
      // nobody asked for a frame and the peer keeps sending: never buffer without bound
      this.fail(new RangeError('Too many unread control bytes'));
      return;
    }
    this.pump();
  };
  private readonly onEnd = () => this.fail(new Error('The stream ended during the control exchange'));
  private readonly onClose = () => this.fail(new Error('The stream closed during the control exchange'));
  private readonly onError = (error: Error) => this.fail(error);

  constructor(
    private readonly stream: Duplex,
    /** Called once when the reader fails (the stream ended or broke, or sent too much). */
    private readonly onFail?: (error: Error) => void,
  ) {
    stream.on('data', this.onData);
    stream.on('end', this.onEnd);
    stream.on('close', this.onClose);
    stream.on('error', this.onError);
  }

  /** The next frame; with `timeoutMs`, a frame that does not come in time rejects and is no longer awaited. */
  next(timeoutMs?: number): Promise<ControlFrame> {
    if (this.waiting) {
      return Promise.reject(new Error('A control frame is already awaited'));
    }
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (this.waiting?.resolve !== done) {
                return;
              }

              this.waiting = null;
              reject(new Error('The control frame did not come in time'));
            }, timeoutMs);
      timer?.unref();
      const done = (frame: ControlFrame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiting = {
        resolve: done,
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.pump();
    });
  }

  /** Stop reading; returns the unread bytes and leaves the stream paused. */
  detach(): Buffer {
    this.stream.pause();
    this.stream.off('data', this.onData);
    this.stream.off('end', this.onEnd);
    this.stream.off('close', this.onClose);
    this.stream.off('error', this.onError);
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }

  private fail(error: Error) {
    if (this.failure) {
      return;
    }
    this.failure = error;
    this.pump();
    this.buffer = Buffer.alloc(0);
    this.onFail?.(error);
  }

  private pump() {
    const waiting = this.waiting;
    if (!waiting) {
      return;
    }
    let decoded: ReturnType<typeof decodeFrame>;
    try {
      decoded = this.failure && this.buffer.length === 0 ? null : decodeFrame(this.buffer);
    } catch (error) {
      this.waiting = null;
      waiting.reject(error as Error);
      return;
    }
    if (decoded) {
      this.buffer = decoded.rest;
      this.waiting = null;
      waiting.resolve(decoded.frame);
    } else if (this.failure) {
      this.waiting = null;
      waiting.reject(this.failure);
    }
  }
}

/** The relay refused the tunnel or a refresh with `ERROR {code}`. */
export class TunnelRefusedError extends Error {
  constructor(readonly code: string) {
    super(`The relay refused the tunnel: ${code}`);
  }
}

/** The frame expected next, or a `TunnelRefusedError` for `ERROR`, or an error for anything else. */
export const expectFrame = (frame: ControlFrame, type: TunnelFrame): ControlFrame => {
  if (frame.type === TunnelFrame.ERROR) {
    throw new TunnelRefusedError(typeof frame.code === 'string' ? frame.code.slice(0, 64) : 'unknown');
  }
  if (frame.type !== type) {
    throw new Error(`The relay sent ${frame.type.slice(0, 32)} where ${type} was expected`);
  }
  return frame;
};

/** The CHALLENGE's nonce: exactly 32 bytes of unpadded base64url. */
export const challengeNonce = (frame: ControlFrame): Buffer => {
  const value = typeof frame.nonce === 'string' ? frame.nonce : '';
  const nonce = /^[\w-]+$/.test(value) ? Buffer.from(value, 'base64url') : Buffer.alloc(0);
  if (nonce.length !== TUNNEL_NONCE_BYTES) {
    throw new Error('The relay sent a malformed challenge');
  }
  return nonce;
};

/** What the PROOF signs: `fl-relay-v1` ‖ nonce ‖ relayId, so a proof is good for one relay and one nonce only. */
export const proofMessage = (nonce: Buffer, relayId: string): Buffer =>
  Buffer.concat([Buffer.from(TUNNEL_PROOF_CONTEXT, 'utf8'), nonce, Buffer.from(relayId, 'utf8')]);

/** Full-jitter backoff before the `attempt`-th reconnect (0 first): uniform in [0, min(5 min, 1 s × 2^attempt)). */
export const backoffDelayMs = (attempt: number, random: () => number = Math.random): number =>
  Math.floor(random() * Math.min(RELAY_BACKOFF_MAX_MS, RELAY_BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt)));

// ------------------------------------------------------------------ control plane

const relayHost = z
  .string()
  .max(253)
  .regex(/^(?:[\da-z](?:[\da-z-]{0,61}[\da-z])?\.)+[\da-z](?:[\da-z-]{0,61}[\da-z])?$/);
const relayId = z.string().regex(/^[\da-z-]{1,40}$/);
const relayThrottle = z.object({ bps: z.number().int().positive(), burst: z.number().int().positive() });

/** `POST /v1/remote/relay-token` answer (contract `remote/relay.ts` `RelayTokenResponse`). */
export const relayTokenResponseSchema = z.object({
  token: z.string().min(1).max(8192),
  expiresAt: z.string(),
  relay: z.object({
    id: relayId,
    host: relayHost,
    port: z.literal(443),
    sni: relayHost,
    alpn: z.literal(TUNNEL_ALPN),
  }),
  refreshAfterSec: z.number().int().positive(),
  throttling: relayThrottle,
  limits: z.object({ conns: z.number().int().positive() }),
  keepaliveSec: z.number().int().positive(),
});
export type RelayTokenResponse = z.infer<typeof relayTokenResponseSchema>;

const relayCandidateSchema = z.object({
  id: relayId,
  host: relayHost,
  region: z.string().max(8),
  pingHost: relayHost,
  port: z.literal(443),
});
export type RelayCandidate = z.infer<typeof relayCandidateSchema>;

/** `GET /v1/remote/relays/candidates` answer. */
export const relayCandidatesResponseSchema = z.object({
  candidates: z.array(relayCandidateSchema).max(10),
  selected: relayId.nullable(),
});

/** `POST /v1/remote/relays/select` answer. */
export const relaySelectResponseSchema = z.object({ relay: relayCandidateSchema, changed: z.boolean() });

export type RelayMeasurement = { relayId: string; rttMs: number; ok: boolean };

/** `POST /v1/remote/wan-probe` answer (FL-167): whether the cloud reached this server's WAN name. */
export const wanProbeResponseSchema = z.object({
  verified: z.boolean(),
  uri: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .nullable(),
  reason: z.enum(['unreachable', 'timeout', 'certificate', 'not_public']).nullable().catch('unreachable'),
});

/** The relay token's claims this server checks before it dials (never its signature: the relay checks that). */
const relayTokenClaimsSchema = z.object({
  sub: z.string(),
  sni: z.string(),
  relay: z.string(),
  cnf: z.object({ jwk: z.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string() }) }),
  iat: z.number(),
  exp: z.number(),
});
export type RelayTokenClaims = z.infer<typeof relayTokenClaimsSchema>;

export const relayTokenClaims = (token: string): RelayTokenClaims => {
  const payload = token.split('.', 2)[1] ?? '';
  return relayTokenClaimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
};

/**
 * Why a relay token must not be used, or null. It must be for this server, its label's name, the relay
 * it names, and the key that will sign the PROOF; the tunnel's TLS name must be that relay's
 * `tun.` name, so the relay's own certificate for exactly that name is what TLS verifies.
 */
export const relayTokenProblem = (
  answer: RelayTokenResponse,
  expected: {
    instanceId: string;
    enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'>;
    publicKeyX: string;
    now: number;
  },
): string | null => {
  let claims: RelayTokenClaims;
  try {
    claims = relayTokenClaims(answer.token);
  } catch {
    return 'the relay token cannot be read';
  }
  if (answer.relay.sni !== `tun.${answer.relay.host}`) {
    return 'the relay token names another tunnel host';
  }
  if (claims.relay !== answer.relay.id) {
    return 'the relay token is for another relay';
  }
  if (
    claims.sub !== expected.instanceId ||
    claims.sni !== `${expected.enrollment.label}.${expected.enrollment.domain}`
  ) {
    return 'the relay token is for another server';
  }
  if (claims.cnf.jwk.x !== expected.publicKeyX) {
    return 'the relay token is bound to another key';
  }
  if (claims.exp * 1000 <= expected.now) {
    return 'the relay token has expired';
  }
  return null;
};

/** When to refresh in-band: `refreshAfterSec` from now, at most half of the token's remaining life. */
export const refreshDelayMs = (answer: Pick<RelayTokenResponse, 'refreshAfterSec' | 'token'>, now: number): number => {
  const { exp } = relayTokenClaims(answer.token);
  return Math.max(1000, Math.min(answer.refreshAfterSec * 1000, (exp * 1000 - now) / 2));
};

// ------------------------------------------------------------------ visitors

/**
 * Whether a visitor's name is one this server serves through the relay: its own `<label>.<domain>`,
 * one label under it, or the verified custom hostname. Anything else is refused, so the relay can
 * never make this server answer for a name that is not its own.
 */
export const relayVisitorNameAllowed = (
  name: string | null | undefined,
  enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'>,
  customHost: string | null,
): boolean => {
  const value = (name ?? '').toLowerCase().replace(/\.$/, '');
  if (!value || value.length > 253) {
    return false;
  }
  const base = `${enrollment.label}.${enrollment.domain}`;
  if (value === base || (customHost !== null && value === customHost)) {
    return true;
  }
  if (!value.endsWith(`.${base}`)) {
    return false;
  }
  const sub = value.slice(0, -base.length - 1);
  return /^[\da-z](?:[\da-z-]{0,61}[\da-z])?$/.test(sub);
};

/**
 * The visitor's address as the relay reported it, or null when it is not a public IP address. Every
 * relayed visitor comes from the internet, so a home-network or loopback address can only be a relay
 * that lies, which must never make a remote visitor look like one at home.
 */
export const relayClientIp = (value: string | string[] | undefined): string | null => {
  const address = (Array.isArray(value) ? '' : (value ?? '')).trim();
  if (!isIP(address) || isHomeAddress(address, []) || /^(?:169\.254\.|0\.)|^fe[89ab][\da-f]:|^::$/i.test(address)) {
    return null;
  }
  return address;
};

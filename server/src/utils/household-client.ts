import z from 'zod';
import type { HouseholdGrantResponse } from 'src/utils/frameleaf-household.js';
import { type FrameleafKeySigner, createDpopProof } from 'src/utils/frameleaf-dpop.js';
import {
  HOUSEHOLD_BODY_CONTENT_TYPE,
  HOUSEHOLD_BODY_HEADER,
  signHouseholdBody,
  verifyHouseholdResponse,
} from 'src/utils/household-protocol.js';

/** The other household's server answered, but not with a usable signed reply. */
export class HouseholdPeerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Cloud now names another server or key for this link than the one stored at pairing. */
export class HouseholdKeyChanged extends HouseholdPeerError {}

/** Largest JSON reply read from a peer: a manifest page is capped at 2 MiB (design section 8). */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
const REFRESH_BEFORE_MS = 60_000;
const envelope = z.strictObject({ data: z.unknown(), proof: z.string().max(8192) });

type GrantResponse = z.infer<typeof HouseholdGrantResponse>;

/**
 * Calls one linked household (FL-952). It only ever calls addresses from the Cloud grant, never one a peer
 * supplied, follows no redirect, and accepts a reply only when the key stored for the peer at pairing signed it.
 */
export class HouseholdClient {
  /** The kind of address that answered last (`local`, `wan`, `ipv6`, `relay`). */
  connection: string | null = null;
  /** The addresses Cloud listed with the grant in use. */
  connections: GrantResponse['connections'] = [];
  private grant?: GrantResponse;

  constructor(
    private link: { cloudLinkId: string; peerInstanceId: string; peerPublicKey: string },
    private issue: () => Promise<GrantResponse>,
    private signer: () => FrameleafKeySigner,
  ) {}

  /** The grant in use, replaced when fewer than 60 s of it remain. A refusal by Cloud is thrown as Cloud's error. */
  private async current() {
    if (!this.grant || this.grant.claims.exp * 1000 - Date.now() < REFRESH_BEFORE_MS) {
      this.grant = undefined;
      const grant = await this.issue();
      const { claims } = grant;
      if (
        claims.destinationInstanceId !== this.link.peerInstanceId ||
        claims.destinationKey.x !== this.link.peerPublicKey
      )
        throw new HouseholdKeyChanged(403, 'The household grant names another server or key than the one linked');
      if (
        claims.linkId !== this.link.cloudLinkId ||
        claims.cnf.jwk.x !== this.signer().publicJwk.x ||
        claims.exp * 1000 <= Date.now()
      )
        throw new HouseholdPeerError(403, 'The household grant does not match this link');
      this.grant = grant;
      this.connections = grant.connections;
    }
    return this.grant;
  }

  /** A signed JSON read. `query` holds plain values, so a route can still never leave this link. */
  get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return this.call('GET', path, query, (response, grant, requestId) =>
      this.signedReply<T>(response, grant, requestId),
    );
  }

  /** A signed JSON call without a body (FL-994: accept and leave). */
  post<T>(path: string): Promise<T> {
    return this.call('POST', path, undefined, (response, grant, requestId) =>
      this.signedReply<T>(response, grant, requestId),
    );
  }

  /** FL-1012: a signed JSON call with a body, bound to this request by its own signature. */
  send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown): Promise<T> {
    const raw = JSON.stringify(body);
    return this.call(
      method,
      path,
      undefined,
      (response, grant, requestId) => this.signedReply<T>(response, grant, requestId),
      {},
      undefined,
      raw,
    );
  }

  /**
   * An original, from byte `start`. The reply is unsigned: the caller limits what it reads and verifies the
   * checksum before it trusts a byte. The body is the caller's to read or cancel.
   */
  original(path: string, query: Record<string, string>, start: number, signal: AbortSignal): Promise<Response> {
    return this.call(
      'GET',
      path,
      query,
      (response) => Promise.resolve(response),
      { ...(start > 0 && { Range: `bytes=${start}-` }) },
      signal,
    );
  }

  private async signedReply<T>(response: Response, grant: GrantResponse, requestId: string): Promise<T> {
    if (!response.body) throw new HouseholdPeerError(502, 'The other household sent an empty reply');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > MAX_REPLY_BYTES) throw new HouseholdPeerError(502, 'The reply exceeds the protocol limit');
      chunks.push(Buffer.from(chunk));
    }
    const reply = envelope.parse(JSON.parse(Buffer.concat(chunks).toString()));
    verifyHouseholdResponse(reply.proof, grant.claims, this.link.peerPublicKey, reply.data, requestId);
    return reply.data as T;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    query: Record<string, string> | undefined,
    read: (response: Response, grant: GrantResponse, requestId: string) => Promise<T>,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
    body?: string,
  ): Promise<T> {
    // every route is fixed words and ids, so the path can never leave this link's routes
    if (!/^[\w-]+(?:\/[\w-]+)*$/.test(path)) throw new Error('Invalid household route');
    const search = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : '';
    const grant = await this.current();
    let failure: unknown = new HouseholdPeerError(503, 'The other household is offline');
    for (const candidate of grant.connections) {
      let origin: URL;
      try {
        origin = new URL(candidate.uri);
      } catch {
        continue;
      }
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) continue;
      const url = new URL(`/api/household/v1/links/${grant.claims.linkId}/${path}`, origin).href;
      try {
        const remaining = grant.claims.exp * 1000 - Date.now();
        if (remaining <= 0) throw new HouseholdPeerError(401, 'The household grant expired');
        // the proof signs the address without its query, as the destination checks it
        const proof = createDpopProof(this.signer(), { htm: method, htu: url, accessToken: grant.token });
        const requestId = (JSON.parse(Buffer.from(proof.split('.', 2)[1], 'base64url').toString()) as { jti: string })
          .jti;
        // the limit covers a whole JSON reply, but only the headers of a stream, whose reader sets its own limits
        const limit = new AbortController();
        const timer = setTimeout(
          () => limit.abort(new HouseholdPeerError(504, 'The other household did not answer')),
          Math.min(remaining, 30_000),
        );
        try {
          const response = await fetch(`${url}${search}`, {
            method,
            headers: {
              Authorization: `DPoP ${grant.token}`,
              DPoP: proof,
              ...headers,
              ...(body !== undefined && {
                'Content-Type': HOUSEHOLD_BODY_CONTENT_TYPE,
                [HOUSEHOLD_BODY_HEADER]: signHouseholdBody(this.signer(), requestId, body),
              }),
            },
            ...(body !== undefined && { body }),
            redirect: 'error',
            signal: signal ? AbortSignal.any([signal, limit.signal]) : limit.signal,
          });
          if (signal) {
            clearTimeout(timer);
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new HouseholdPeerError(response.status, 'The other household refused the request');
          }
          const result = await read(response, grant, requestId);
          this.connection = candidate.kind;
          return result;
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        // An address is only a candidate: whatever answers there without the peer's signature (another device
        // on this network, a captive portal, a redirect) is not the peer, so the next address is tried.
        failure = error;
      }
    }
    this.connection = null;
    throw failure;
  }
}

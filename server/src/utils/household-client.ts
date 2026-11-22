import z from 'zod';
import type { HouseholdGrantResponse } from 'src/utils/frameleaf-household.js';
import { type FrameleafKeySigner, createDpopProof } from 'src/utils/frameleaf-dpop.js';
import { verifyHouseholdResponse } from 'src/utils/household-protocol.js';

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
 * Only GET exists so far; the routes with a body arrive with FL-979.
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

  async get<T>(path: string): Promise<T> {
    // every route is fixed words and ids, so the path can never leave this link's routes
    if (!/^[\w-]+(?:\/[\w-]+)*$/.test(path)) throw new Error('Invalid household route');
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
        const proof = createDpopProof(this.signer(), { htm: 'GET', htu: url, accessToken: grant.token });
        const requestId = (JSON.parse(Buffer.from(proof.split('.', 2)[1], 'base64url').toString()) as { jti: string })
          .jti;
        const response = await fetch(url, {
          headers: { Authorization: `DPoP ${grant.token}`, DPoP: proof },
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(remaining, 30_000)),
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new HouseholdPeerError(response.status, 'The other household refused the request');
        }
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > MAX_REPLY_BYTES) throw new HouseholdPeerError(502, 'The reply exceeds the protocol limit');
          chunks.push(Buffer.from(chunk));
        }
        const reply = envelope.parse(JSON.parse(Buffer.concat(chunks).toString()));
        verifyHouseholdResponse(reply.proof, grant.claims, this.link.peerPublicKey, reply.data, requestId);
        this.connection = candidate.kind;
        return reply.data as T;
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

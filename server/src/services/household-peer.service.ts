import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  PayloadTooLargeException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import z from 'zod';
import type { Request } from 'express';
import type { Selectable } from 'kysely';
import type { HouseholdLinkTable } from 'src/schema/tables/household-link.table.js';
import { type FrameleafRequest, requestSecurityAddress } from 'src/middleware/frameleaf-via.middleware.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { HouseholdLinkRepository } from 'src/repositories/household-link.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getConfig } from 'src/utils/config.js';
import { loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { type HouseholdGrantClaims, HouseholdVerifyResponse } from 'src/utils/frameleaf-household.js';
import {
  HOUSEHOLD_BODY_CONTENT_TYPE,
  HOUSEHOLD_BODY_HEADER,
  HOUSEHOLD_MAX_ORIGINAL_BYTES,
  HOUSEHOLD_PROTOCOL_VERSION,
  HouseholdJwks,
  isHouseholdBodyValid,
  signHouseholdResponse,
  verifyHouseholdGrant,
  verifyHouseholdProof,
} from 'src/utils/household-protocol.js';

export type HouseholdPeerAccess = {
  link: Selectable<HouseholdLinkTable>;
  grant: HouseholdGrantClaims;
  requestId: string;
};

/** Design section 8. */
const REQUESTS_PER_MINUTE = 120;
const REFUSALS_PER_MINUTE = 30;
const MAX_BODY_BYTES = 64 * 1024;
/** Cloud serves its grant keys with `max-age=300`. */
const KEYS_MAX_AGE_MS = 300_000;
/** How long a grant Cloud confirmed is trusted before Cloud is asked again. */
const VERIFIED_FOR_MS = 60_000;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/**
 * Linked Households (FL-952): admits requests from another household's server. That server belongs to another
 * family and is outside this server's control, so every request proves itself from nothing each time.
 */
@Injectable()
export class HouseholdPeerService {
  // ponytail: kept in memory, not on disk as Buddy's are. After a restart during a Cloud outage peers are
  // refused until Cloud answers, and a grant Cloud refused is asked about again by another API worker.
  private keys?: { issuer: string; jwks: z.infer<typeof HouseholdJwks>; at: number };
  private revoked = new Map<string, number>();
  private verified = new Map<string, number>();
  private blocked = new Map<string, number>();

  constructor(
    private links: HouseholdLinkRepository,
    private configRepository: ConfigRepository,
    private databaseRepository: DatabaseRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private instanceIdentityRepository: InstanceIdentityRepository,
    private frameleafCloudRepository: FrameleafCloudRepository,
    private rates: RateLimitRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(HouseholdPeerService.name);
  }

  private deps() {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    };
  }

  identity() {
    return loadInstanceIdentity(this.deps());
  }
  signer() {
    return this.instanceIdentityRepository.currentSigner();
  }

  /** Linked to Frameleaf Cloud, and Cloud does not suspect a copy of this server. */
  async linked() {
    const { linked, link } = await readCloudLink(this.deps());
    return linked && !!link && !link.heartbeat?.cloneSuspected;
  }

  async cloudTarget() {
    const { linked, link, cloudUrl } = await readCloudLink(this.deps());
    if (!linked || !cloudUrl || !link?.instanceId || link.heartbeat?.cloneSuspected)
      throw new ForbiddenException('Link this Frameleaf server to Frameleaf Cloud before linking households.');
    const document = await this.frameleafCloudRepository.discovery(cloudUrl);
    await this.identity();
    return {
      api: document.api,
      token: await this.frameleafCloudRepository.accessToken(document, link.instanceId, document.api, this.signer()),
    };
  }

  async cloud<T extends z.ZodType>(schema: T, path: string, body?: unknown) {
    const target = await this.cloudTarget();
    return this.frameleafCloudRepository.requestJson(schema, {
      url: new URL(`/v1/households/${path}`, target.api).href,
      method: body === undefined ? 'GET' : 'POST',
      dpop: target.token,
      ...(body !== undefined && { body }),
    });
  }

  /** Only a transport outage (no answer, or a 5xx) may fall back to checks made here. */
  private outage(error: unknown) {
    return error instanceof FrameleafCloudError && (error.status === null || error.status >= 500);
  }

  private async cloudKeys() {
    const cached = this.keys;
    if (cached && Date.now() - cached.at < KEYS_MAX_AGE_MS) return cached;
    try {
      const target = await this.cloudTarget();
      const jwks = await this.frameleafCloudRepository.requestJson(HouseholdJwks, {
        url: new URL('/v1/households/jwks', target.api).href,
        dpop: target.token,
      });
      return (this.keys = { issuer: target.api, jwks, at: Date.now() });
    } catch (error) {
      if (!cached || !this.outage(error)) throw error;
      return cached;
    }
  }

  /**
   * The checks of design section 2, in that order. Refusals count against the caller's address, and an
   * address with too many is answered 429 before anything else is looked at.
   */
  async authorize(request: Request, linkId: string): Promise<HouseholdPeerAccess> {
    const address = requestSecurityAddress(request as FrameleafRequest) ?? 'unknown';
    if ((this.blocked.get(address) ?? 0) > Date.now())
      throw new HttpException('Too many refused household requests', 429);
    try {
      return await this.admit(request, linkId);
    } catch (error) {
      if (error instanceof HttpException && [401, 403].includes(error.getStatus())) {
        const hit = await this.rates.hit(`household:refused:${address}`, 60);
        if (hit.count >= REFUSALS_PER_MINUTE) {
          for (const [key, until] of this.blocked) if (until <= Date.now()) this.blocked.delete(key);
          this.blocked.set(address, Date.now() + hit.resetSeconds * 1000);
        }
      }
      throw error;
    }
  }

  private async admit(request: Request, linkId: string): Promise<HouseholdPeerAccess> {
    // 1. A link this server holds and has not paused or ended. Nothing below runs for anyone else.
    const link = UUID.test(linkId) ? await this.links.getByCloudLinkId(linkId) : undefined;
    if (!link || link.state !== 'active' || !(await this.linked()))
      throw new ForbiddenException('Household access is unavailable');

    // 2. The grant, signed by Cloud.
    const authorization = request.headers.authorization;
    const proof = request.headers.dpop;
    if (!authorization?.startsWith('DPoP ') || typeof proof !== 'string')
      throw new UnauthorizedException('Household grant and proof required');
    const token = authorization.slice(5);
    const keys = await this.cloudKeys();
    let grant: HouseholdGrantClaims;
    try {
      grant = verifyHouseholdGrant(token, keys.jwks, keys.issuer);
    } catch {
      throw new UnauthorizedException('Household grant rejected');
    }

    // 3. The grant is for this link, this server and the key stored for the peer at pairing.
    const identity = await this.identity();
    if (
      grant.linkId !== link.cloudLinkId ||
      grant.destinationInstanceId !== identity.instanceId ||
      grant.destinationKey.x !== identity.publicJwk.x ||
      grant.sourceInstanceId !== link.peerInstanceId ||
      grant.cnf.jwk.x !== link.peerPublicKey
    ) {
      this.logger.warn(`Refused a request on household link ${link.id}: its grant names another link, server or key`);
      throw new ForbiddenException('Household grant does not authorize this link');
    }

    // 4. The request itself, signed with that key for this method and address.
    const forwarded = (request as FrameleafRequest).frameleafForwarded;
    const uri = `${forwarded?.proto ?? request.protocol}://${forwarded?.host ?? request.get('host')}${request.originalUrl}`;
    let requestId: string;
    try {
      requestId = verifyHouseholdProof(proof, token, grant, request.method, uri).jti;
    } catch {
      this.logger.warn(`Refused a request on household link ${link.id}: its proof was not signed for this request`);
      throw new UnauthorizedException('Household request proof rejected');
    }

    // 5. The link's request budget. Counted only for a request the peer's own key signed, so someone who
    // merely learns a link id cannot spend it; unsigned attempts are held by the per-address refusal limit.
    if ((await this.rates.hit(`household:${link.id}`, 60)).count > REQUESTS_PER_MINUTE)
      throw new HttpException('Household request rate limit reached', 429);

    // 6. Cloud still honours the grant. A refusal is remembered until the grant would have expired.
    // ponytail: a yes is remembered for a minute, so Cloud is asked about a grant at most five times, not
    // once a request (its per-server limit is 300 a minute). A revoked grant is honoured at most that long.
    const now = Date.now();
    for (const [jti, until] of this.revoked) if (until <= now) this.revoked.delete(jti);
    for (const [jti, until] of this.verified) if (until <= now) this.verified.delete(jti);
    if (this.revoked.has(grant.jti)) throw new ForbiddenException('Household grant was revoked');
    try {
      if (!this.verified.has(grant.jti)) {
        const verified = await this.cloud(HouseholdVerifyResponse, 'grants/verify', { version: 1, token });
        if (verified.claims.jti !== grant.jti) throw new Error('Frameleaf Cloud verified another grant');
        this.verified.set(grant.jti, Math.min(now + VERIFIED_FOR_MS, grant.exp * 1000));
      }
    } catch (error) {
      if (!this.outage(error)) {
        this.revoked.set(grant.jti, grant.exp * 1000);
        this.logger.warn(`Refused a request on household link ${link.id}: Frameleaf Cloud no longer honours its grant`);
        throw new ForbiddenException('Household grant was revoked');
      }
    }
    if (grant.exp * 1000 <= Date.now()) throw new UnauthorizedException('Household grant expired');

    // 7. Each proof is admitted once.
    if (!(await this.links.admit(requestId, link.id, new Date(grant.exp * 1000))))
      throw new UnauthorizedException('Household request was already used');
    return { link, grant, requestId };
  }

  /**
   * FL-1012: a JSON body, read only after `authorize`. The private content type keeps it away from the app's general
   * JSON parser, so it is capped here at 64 KiB and must carry this request's signature over its exact bytes.
   */
  async readBody(request: Request, access: HouseholdPeerAccess): Promise<unknown> {
    if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== HOUSEHOLD_BODY_CONTENT_TYPE) {
      throw new UnsupportedMediaTypeException();
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const part = Buffer.from(chunk as Uint8Array);
      length += part.length;
      if (length > MAX_BODY_BYTES) {
        throw new PayloadTooLargeException();
      }
      chunks.push(part);
    }
    const raw = Buffer.concat(chunks);
    const signature = request.headers[HOUSEHOLD_BODY_HEADER];
    if (
      typeof signature !== 'string' ||
      !isHouseholdBodyValid(signature, access.link.peerPublicKey, access.requestId, raw)
    ) {
      this.logger.warn(`Refused a request on household link ${access.link.id}: its body was not signed for it`);
      throw new UnauthorizedException('Household request body rejected');
    }
    try {
      return JSON.parse(raw.toString()) as unknown;
    } catch {
      throw new BadRequestException('Invalid body');
    }
  }

  /** Replies are signed with this server's key, so nothing between the two servers can alter one. */
  signed(access: HouseholdPeerAccess, data: unknown) {
    return signHouseholdResponse(this.signer(), access.grant, access.requestId, data);
  }

  async handshake() {
    const config = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );
    return {
      version: HOUSEHOLD_PROTOCOL_VERSION,
      name: config.server.name?.trim() || 'Frameleaf server',
      maxOriginalBytes: HOUSEHOLD_MAX_ORIGINAL_BYTES,
    };
  }
}

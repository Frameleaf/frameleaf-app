import { ForbiddenException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
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
  HOUSEHOLD_MAX_ORIGINAL_BYTES,
  HOUSEHOLD_PROTOCOL_VERSION,
  HouseholdJwks,
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
/** Cloud serves its grant keys with `max-age=300`. */
const KEYS_MAX_AGE_MS = 300_000;
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

    // 2. The link's request budget.
    if ((await this.rates.hit(`household:${link.id}`, 60)).count > REQUESTS_PER_MINUTE)
      throw new HttpException('Household request rate limit reached', 429);

    // 3. The grant, signed by Cloud.
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

    // 4. The grant is for this link, this server and the key stored for the peer at pairing.
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

    // 5. The request itself, signed with that key for this method and address.
    const forwarded = (request as FrameleafRequest).frameleafForwarded;
    const uri = `${forwarded?.proto ?? request.protocol}://${forwarded?.host ?? request.get('host')}${request.originalUrl}`;
    let requestId: string;
    try {
      requestId = verifyHouseholdProof(proof, token, grant, request.method, uri).jti;
    } catch {
      this.logger.warn(`Refused a request on household link ${link.id}: its proof was not signed for this request`);
      throw new UnauthorizedException('Household request proof rejected');
    }

    // 6. Cloud still honours the grant. A refusal is remembered until the grant would have expired.
    for (const [jti, until] of this.revoked) if (until <= Date.now()) this.revoked.delete(jti);
    if (this.revoked.has(grant.jti)) throw new ForbiddenException('Household grant was revoked');
    try {
      const verified = await this.cloud(HouseholdVerifyResponse, 'grants/verify', { version: 1, token });
      if (verified.claims.jti !== grant.jti) throw new Error('Frameleaf Cloud verified another grant');
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

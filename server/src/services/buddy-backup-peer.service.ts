import {
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import z from 'zod';
import type { Request, Response } from 'express';
import type { Transaction } from 'kysely';
import type { FrameleafRequest } from 'src/middleware/frameleaf-via.middleware.js';
import type { DB } from 'src/schema/index.js';
import type { BuddyReceipt, BuddySignedSnapshot } from 'src/utils/buddy-backup-vault.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { BUDDY_BLOCK_BYTES, BUDDY_SEALED_OVERHEAD } from 'src/utils/buddy-backup-crypto.js';
import { BuddyJwks, verifyBuddyGrant, verifyBuddyProof } from 'src/utils/buddy-backup-protocol.js';
import { BuddyVault, buddyDigest, writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { BuddyGrantClaims, BuddyGrantResponse, BuddyPairing } from 'src/utils/frameleaf-buddy.js';
import { loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';

export type BuddyPeerAccess = {
  grant: BuddyGrantClaims;
  requestId: string;
  vault: BuddyVault;
  quotaBytes: number;
  uploadMbps: number;
  downloadMbps: number;
  sourceKey: { kty: 'OKP'; crv: 'Ed25519'; x: string };
};

@Injectable()
export class BuddyBackupPeerService {
  constructor(
    private state: BuddyBackupRepository,
    private configRepository: ConfigRepository,
    private databaseRepository: DatabaseRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private instanceIdentityRepository: InstanceIdentityRepository,
    private frameleafCloudRepository: FrameleafCloudRepository,
    private rates: RateLimitRepository,
  ) {}

  private deps() {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    };
  }

  async identity() {
    return loadInstanceIdentity(this.deps());
  }
  signer() {
    return this.instanceIdentityRepository.currentSigner();
  }

  async cloudTarget() {
    const { linked, link, cloudUrl } = await readCloudLink(this.deps());
    if (!linked || !cloudUrl || !link?.instanceId || link.heartbeat?.cloneSuspected)
      throw new ForbiddenException('Link this Frameleaf server to Cloud before using Buddy Backup.');
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
      url: new URL(`/v1/buddy/${path}`, target.api).href,
      method: body === undefined ? 'GET' : 'POST',
      dpop: target.token,
      ...(body !== undefined && { body }),
    });
  }

  async pairing() {
    const pairing = await this.cloud(BuddyPairing.nullable(), 'pairing');
    await this.state.locked('peer-access', (trx) =>
      this.state.update(
        (state) => ({
          ...state,
          pairing,
          ...(state.pairing?.pairId !== pairing?.pairId && {
            recoveryVerified: false,
            probeVerified: false,
            nextScheduledAt: null,
            lastCompleteAt: null,
            lastVerifiedAt: null,
            lastSequence: 0,
            protectionStartedAt: null,
            run: null,
          }),
        }),
        trx,
      ),
    );
    return pairing;
  }

  async grant(scope: 'read' | 'write') {
    if (scope === 'write' && process.env.FRAMELEAF_BUDDY_BACKUP !== 'true')
      throw new ServiceUnavailableException('New Buddy backups are paused. Recovery remains available.');
    const pairing = await this.pairing();
    const identity = await this.identity();
    const vault = pairing?.vaults.find((vault) => vault.sourceInstanceId === identity.instanceId);
    if (!pairing || !vault) throw new ForbiddenException('No Buddy pairing is configured.');
    return this.cloud(BuddyGrantResponse, 'grants', {
      version: 1,
      pairId: pairing.pairId,
      vaultId: vault.vaultId,
      scope,
    });
  }

  /** Only transport outages may fall back to a locally checked, still-live signed grant. */
  private outage(error: unknown) {
    return error instanceof FrameleafCloudError && (error.status === null || error.status >= 500);
  }

  async authorize(
    request: Request,
    response: Response,
    vaultId: string,
    scope: 'read' | 'write',
    handshake = false,
  ): Promise<BuddyPeerAccess> {
    if ((await this.rates.hit('buddy:requests', 60)).count > 120)
      throw new HttpException('Buddy request rate limit reached', 429);
    const authorization = request.headers.authorization;
    const proof = request.headers.dpop;
    if (!authorization?.startsWith('DPoP ') || typeof proof !== 'string')
      throw new UnauthorizedException('Buddy capability and proof required');
    const token = authorization.slice(5);
    const state = await this.state.state();
    const identity = await this.identity();
    const direction = state.pairing?.vaults.find(
      (vault) => vault.vaultId === vaultId && vault.destinationInstanceId === identity.instanceId,
    );
    const { linked, link } = await readCloudLink(this.deps());
    if (
      !linked ||
      !link ||
      link.heartbeat?.cloneSuspected ||
      !state.settings ||
      !state.pairing ||
      !direction ||
      state.pairing.state === 'blocked' ||
      state.pairing.state === 'pending' ||
      (state.pairing.state === 'ended' &&
        (!state.pairing.readUntil || Date.parse(state.pairing.readUntil) <= Date.now()))
    )
      throw new ForbiddenException('Buddy access is unavailable');
    if (
      scope === 'write' &&
      (process.env.FRAMELEAF_BUDDY_BACKUP !== 'true' ||
        state.settings.pausedReceiving ||
        state.pairing.state !== 'active')
    )
      throw new ServiceUnavailableException('Receiving Buddy backups is paused');

    const keysPath = join(this.state.root(), 'cloud-keys.json');
    let keys: { issuer: string; jwks: z.infer<typeof BuddyJwks> };
    try {
      const target = await this.cloudTarget();
      const jwks = await this.frameleafCloudRepository.requestJson(BuddyJwks, {
        url: new URL('/v1/buddy/jwks', target.api).href,
        dpop: target.token,
      });
      keys = { issuer: target.api, jwks };
      await this.state.locked('cloud-keys', () => writeBuddyFile(keysPath, JSON.stringify(keys)));
    } catch (error) {
      if (!this.outage(error)) throw error;
      keys = JSON.parse(await readFile(keysPath, 'utf8'));
      BuddyJwks.parse(keys.jwks);
    }
    const grant = verifyBuddyGrant(token, keys.jwks, keys.issuer);
    if (
      grant.vaultId !== vaultId ||
      grant.pairId !== state.pairing.pairId ||
      grant.destinationInstanceId !== identity.instanceId ||
      grant.destinationKey.x !== identity.publicJwk.x ||
      grant.sourceInstanceId !== direction.sourceInstanceId ||
      grant.cnf.jwk.x !== direction.sourceKey.x ||
      (scope === 'write' && grant.scope !== 'write')
    )
      throw new ForbiddenException('Buddy capability does not authorize this vault');
    const forwarded = (request as FrameleafRequest).frameleafForwarded;
    if (forwarded?.host?.startsWith('recovery.') && grant.scope !== 'read')
      throw new ForbiddenException('Recovery connections require a read-only Buddy capability');
    const uri = `${forwarded?.proto ?? request.protocol}://${forwarded?.host ?? request.get('host')}${request.originalUrl}`;
    const claims = verifyBuddyProof(proof, token, grant, request.method, uri);

    const deniedPath = join(this.state.root(), 'revoked-grants.json');
    const denied = await this.revoked();
    if (denied[grant.jti]) throw new ForbiddenException('Buddy capability was revoked');
    try {
      await this.cloud(z.object({ version: z.literal(1), claims: BuddyGrantClaims }), 'grants/verify', {
        version: 1,
        token,
      });
    } catch (error) {
      if (!this.outage(error)) {
        await this.state.locked('peer-access', async () => {
          const previous = await this.revoked();
          await writeBuddyFile(
            deniedPath,
            JSON.stringify({
              ...Object.fromEntries(Object.entries(previous).filter(([, exp]) => exp > Date.now())),
              [grant.jti]: grant.exp * 1000,
            }),
          );
        });
        throw error;
      }
    }
    if (grant.exp * 1000 <= Date.now()) throw new UnauthorizedException('Buddy capability expired');
    const admitted = await this.state.admit(claims.jti, claims.nonce, grant.exp * 1000, handshake);
    response.setHeader('DPoP-Nonce', admitted.nonce);
    if (!admitted.allowed) throw new UnauthorizedException({ error: 'use_dpop_nonce' });
    return {
      grant,
      requestId: claims.jti,
      vault: new BuddyVault(state.settings.directory, vaultId),
      quotaBytes: Math.min(state.settings.quotaBytes, direction.quotaBytes),
      uploadMbps: state.settings.uploadMbps,
      downloadMbps: state.settings.downloadMbps,
      sourceKey: direction.sourceKey,
    };
  }

  private revoked(): Promise<Record<string, number>> {
    return readFile(join(this.state.root(), 'revoked-grants.json'), 'utf8')
      .then((value) => JSON.parse(value))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return {};
      });
  }

  /** Recheck at dispatch and after every wait; an admitted request is not a lasting authorization. */
  async assertAccess(access: BuddyPeerAccess, scope: 'read' | 'write', trx?: Transaction<DB>) {
    if (access.grant.exp * 1000 <= Date.now()) throw new UnauthorizedException('Buddy capability expired');
    const state = await this.state.state();
    const { linked, link } = await readCloudLink({
      configRepository: this.configRepository,
      systemMetadataRepository: trx ? new SystemMetadataRepository(trx) : this.systemMetadataRepository,
    });
    const direction = state.pairing?.vaults.find((vault) => vault.vaultId === access.grant.vaultId);
    if (
      !linked ||
      !link ||
      link.heartbeat?.cloneSuspected ||
      !state.settings ||
      !direction ||
      state.pairing?.pairId !== access.grant.pairId ||
      state.pairing.state === 'blocked' ||
      state.pairing.state === 'pending' ||
      (state.pairing.state === 'ended' &&
        (!state.pairing.readUntil || Date.parse(state.pairing.readUntil) <= Date.now())) ||
      direction.sourceInstanceId !== access.grant.sourceInstanceId ||
      direction.destinationInstanceId !== link.instanceId ||
      direction.sourceKey.x !== access.grant.cnf.jwk.x ||
      direction.destinationKey.x !== access.grant.destinationKey.x ||
      (await this.revoked())[access.grant.jti]
    )
      throw new ForbiddenException('Buddy capability was revoked');
    if (
      scope === 'write' &&
      (access.grant.scope !== 'write' ||
        state.pairing.state !== 'active' ||
        process.env.FRAMELEAF_BUDDY_BACKUP !== 'true' ||
        state.settings.pausedReceiving)
    )
      throw new ServiceUnavailableException('Receiving Buddy backups is paused');
    access.quotaBytes = Math.min(state.settings.quotaBytes, direction.quotaBytes);
    access.uploadMbps = state.settings.uploadMbps;
    access.downloadMbps = state.settings.downloadMbps;
  }

  // ponytail: one reciprocal buddy in v1; split this lock by vault if multiple buddies are introduced.
  async dispatch<T>(access: BuddyPeerAccess, scope: 'read' | 'write', action: (trx: Transaction<DB>) => Promise<T>) {
    return this.state.locked('peer-access', async (trx) => {
      await this.assertAccess(access, scope, trx);
      return this.state.locked(access.grant.vaultId, action, trx);
    });
  }

  async streamSlot(direction: 'upload' | 'download') {
    const token = randomUUID();
    for (let slot = 0; slot < 2; slot++) {
      const key = `buddy:${direction}:${slot}`;
      if (await this.rates.claimUploadStream(key, token)) return () => this.rates.releaseUploadStream(key, token);
    }
    throw new ServiceUnavailableException('Buddy transfer concurrency reached');
  }

  private async throttle(access: BuddyPeerAccess, bytes: number, scope: 'read' | 'write') {
    const direction = scope === 'write' ? 'download' : 'upload';
    const mbps = scope === 'write' ? access.downloadMbps : access.uploadMbps;
    for (let count = 0; count < Math.ceil(bytes / (64 * 1024)); count++) {
      const hit = await this.rates.hit(`buddy:bandwidth:${direction}`, 1);
      if (hit.count > Math.max(1, Math.floor((mbps * 1_000_000) / (8 * 64 * 1024)))) {
        const until = Date.now() + hit.resetSeconds * 1000;
        while (Date.now() < until) {
          await sleep(Math.min(100, until - Date.now()));
          await this.assertAccess(access, scope);
        }
      }
    }
  }

  signed(access: BuddyPeerAccess, data: unknown) {
    return {
      data,
      proof: this.signer().sign(
        { typ: 'buddy-response+jwt', alg: 'EdDSA' },
        {
          vaultId: access.grant.vaultId,
          grantId: access.grant.jti,
          requestId: access.requestId,
          digest: buddyDigest(Buffer.from(JSON.stringify(data))),
          iat: Math.floor(Date.now() / 1000),
          exp: access.grant.exp,
        },
      ),
    };
  }

  private async capacity(access: BuddyPeerAccess) {
    const filesystem = await statfs((await this.state.state()).settings!.directory);
    return {
      quotaBytes: access.quotaBytes,
      freeBytes: filesystem.bavail * filesystem.bsize,
      totalBytes: filesystem.blocks * filesystem.bsize,
    };
  }

  async reserve(access: BuddyPeerAccess, receipt: BuddyReceipt) {
    return this.dispatch(access, 'write', async (trx) =>
      access.vault.reserve(receipt, await this.capacity(access), () => this.assertAccess(access, 'write', trx)),
    );
  }

  async upload(access: BuddyPeerAccess, request: Request, id: string) {
    const release = await this.streamSlot('download');
    const expires = setTimeout(
      () => request.destroy(new Error('Buddy capability expired')),
      Math.max(1, access.grant.exp * 1000 - Date.now()),
    );
    try {
      const maximum = BUDDY_BLOCK_BYTES + BUDDY_SEALED_OVERHEAD;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > maximum || Date.now() >= access.grant.exp * 1000)
          throw new ForbiddenException('Buddy block limit or capability expired');
        chunks.push(Buffer.from(chunk));
        await this.throttle(access, chunk.length, 'write');
        await this.assertAccess(access, 'write');
      }
      const buffer = Buffer.concat(chunks);
      const receipt = BuddyVault.receipt(id, buffer);
      return await this.dispatch(access, 'write', async (trx) =>
        access.vault.put(receipt, buffer, await this.capacity(access), () => this.assertAccess(access, 'write', trx)),
      );
    } finally {
      clearTimeout(expires);
      await release();
    }
  }

  async download(access: BuddyPeerAccess, response: Response, id: string) {
    const release = await this.streamSlot('upload');
    const expires = setTimeout(
      () => response.destroy(new Error('Buddy capability expired')),
      Math.max(1, access.grant.exp * 1000 - Date.now()),
    );
    try {
      const bytes = await this.dispatch(access, 'read', () => access.vault.read(id));
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', bytes.length);
      response.setHeader('Buddy-Proof', this.signed(access, BuddyVault.receipt(id, bytes)).proof);
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        if (response.destroyed) return;
        const chunk = bytes.subarray(offset, offset + 64 * 1024);
        await this.throttle(access, chunk.length, 'read');
        const writable = await this.dispatch(access, 'read', () => Promise.resolve(response.write(chunk)));
        if (!writable)
          await once(response, 'drain', {
            signal: AbortSignal.timeout(Math.max(1, access.grant.exp * 1000 - Date.now())),
          });
      }
      response.end();
    } finally {
      clearTimeout(expires);
      await release();
    }
  }

  async commit(access: BuddyPeerAccess, envelope: BuddySignedSnapshot) {
    return this.dispatch(access, 'write', async (trx) =>
      access.vault.commit(envelope, access.sourceKey, Date.now(), await this.capacity(access), () =>
        this.assertAccess(access, 'write', trx),
      ),
    );
  }
}

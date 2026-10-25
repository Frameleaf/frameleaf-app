import { Injectable } from '@nestjs/common';
import { Kysely, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { DB } from 'src/schema/index.js';
import { ChecksumAlgorithm } from 'src/enum.js';
import { SourceResourceGrant, SourceResourceRepository } from 'src/repositories/source-resource.repository.js';
import { lockSourceAuthorities } from 'src/utils/source-authority-lock.js';
import { parseSourceOriginalPath, sourceOriginalPath } from 'src/utils/source-original.js';
import { sourceReadHasInterest } from 'src/utils/source-read-interest.js';

type Original = {
  assetId: string;
  resourceId: string;
  sourceId: string;
  ownerId: string;
  deviceId: string;
  scopeFingerprint: string;
  authorizationEpoch: number;
  resourceKey: string;
  version: string;
  sha256: string;
  bytes: number;
};
type SnapshotRow = Omit<Original, 'bytes'> & { bytes: string; originalPath: string };
const active = ['pending', 'claimed', 'delivering'] as const;

@Injectable()
export class SourceResourceReadRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private grants: SourceResourceRepository,
  ) {}

  private async original(
    tx: Transaction<DB>,
    assetId: string,
    expected?: Pick<SourceResourceGrant, 'sourceId' | 'ownerId'>,
  ): Promise<Original | undefined> {
    const hint = await tx
      .selectFrom('asset')
      .select(['ownerId', 'originalPath'])
      .where('id', '=', assetId)
      .executeTakeFirst();
    if (!hint) return;
    let identity;
    try {
      identity = parseSourceOriginalPath(hint.originalPath);
    } catch {
      return;
    }
    if (!identity || (expected && (expected.sourceId !== identity.sourceId || expected.ownerId !== hint.ownerId)))
      return;
    if (!(await lockSourceAuthorities(tx, [{ sourceId: identity.sourceId, ownerId: hint.ownerId }]))) return;
    const { rows } = await sql<SnapshotRow>`SELECT a.id AS "assetId", r.id AS "resourceId",
      s.id AS "sourceId", s."ownerId", s."deviceId", s."scopeFingerprint", d."authorizationEpoch",
      r."resourceKey", r.version, encode(r.checksum,'hex') AS sha256, r.bytes, a."originalPath"
      FROM asset a JOIN source_original b ON b."assetId"=a.id
      JOIN photo_source_resource r ON r.id=b."resourceId" AND r."assetId"=a.id
      JOIN photo_source_run run ON run.id=r."runId" JOIN photo_source s ON s.id=run."sourceId"
      JOIN library l ON l.id=a."libraryId" AND l."ownerId"=s."ownerId"
      JOIN desktop_device d ON d.id=s."deviceId" AND d."userId"=s."ownerId"
      JOIN session photo ON photo.id=s."photoSessionId" AND photo."userId"=s."ownerId"
      JOIN "user" owner ON owner.id=s."ownerId"
      WHERE a.id=${assetId}::uuid AND s.id=${identity.sourceId}::uuid
        AND a."originalPath"=${hint.originalPath} AND a."ownerId"=${hint.ownerId}::uuid AND a."ownerId"=s."ownerId" AND a."isExternal"
        AND a."checksumAlgorithm"=${ChecksumAlgorithm.sha1Path} AND a."deletedAt" IS NULL
        AND l."readOnly" AND l."deletedAt" IS NULL AND r.state='verified' AND r."verifiedAt" IS NOT NULL
        AND s.mode='reference' AND s."revokedAt" IS NULL AND owner."deletedAt" IS NULL
        AND b."scopeFingerprint"=s."scopeFingerprint" AND b."authorizationEpoch"=d."authorizationEpoch"
        AND d."revokedAt" IS NULL AND d.state NOT IN ('paused','revoked')
        AND (photo."expiresAt" IS NULL OR photo."expiresAt">clock_timestamp())
      FOR SHARE OF a,b,r,run,l,d,photo,owner FOR UPDATE OF s`.execute(tx);
    const row = rows[0];
    if (!row) return;
    const { originalPath, ...snapshot } = row;
    const bytes = Number(row.bytes);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(row.version) ||
      !/^[a-f0-9]{64}$/u.test(row.sha256)
    )
      return;
    try {
      if (originalPath !== sourceOriginalPath(row)) return;
    } catch {
      return;
    }
    return { ...snapshot, bytes };
  }

  private async expire(
    tx: Transaction<DB>,
    source: Pick<Original, 'sourceId' | 'scopeFingerprint' | 'authorizationEpoch' | 'ownerId' | 'deviceId'>,
  ) {
    await tx
      .updateTable('source_resource_read')
      .set({ state: 'unavailable', leaseUntil: null })
      .where('sourceId', '=', source.sourceId)
      .where('state', 'in', active)
      .where((eb) =>
        eb.or([
          eb('deadline', '<=', sql<Date>`clock_timestamp()`),
          eb.not(sourceReadHasInterest),
          eb('scopeFingerprint', '!=', source.scopeFingerprint),
          eb('authorizationEpoch', '!=', source.authorizationEpoch),
          eb('ownerId', '!=', source.ownerId),
          eb('deviceId', '!=', source.deviceId),
        ]),
      )
      .execute();
  }

  enqueue(assetId: string) {
    return this.db.transaction().execute(async (tx) => {
      const original = await this.original(tx, assetId);
      if (!original) return;
      await this.expire(tx, original);
      const existing = await tx
        .selectFrom('source_resource_read')
        .select(['id', 'deadline'])
        .where('assetId', '=', assetId)
        .where('resourceId', '=', original.resourceId)
        .where('scopeFingerprint', '=', original.scopeFingerprint)
        .where('authorizationEpoch', '=', original.authorizationEpoch)
        .where('state', 'in', active)
        .executeTakeFirst();
      if (existing) return existing;
      const usage = await tx
        .selectFrom('source_resource_read')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('sourceId', '=', original.sourceId)
        .where('state', 'in', active)
        .executeTakeFirstOrThrow();
      if (Number(usage.count) >= 16) return;
      const { sourceId, resourceId, ownerId, deviceId, scopeFingerprint, authorizationEpoch } = original;
      return tx
        .insertInto('source_resource_read')
        .values({
          assetId,
          sourceId,
          resourceId,
          ownerId,
          deviceId,
          scopeFingerprint,
          authorizationEpoch,
          deadline: sql`clock_timestamp()+interval '10 minutes'`,
        })
        .returning(['id', 'deadline'])
        .executeTakeFirst();
    });
  }

  async claim(grant: SourceResourceGrant, tokenHash: Buffer, maxBytes: number) {
    if (tokenHash.length !== 32 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return;
    return this.grants.withGrant(grant, async (tx) => {
      await this.expire(tx, grant);
      await tx
        .updateTable('source_resource_read')
        .set({
          state: 'pending',
          leaseUntil: null,
          claimTokenHash: null,
          claimCredentialHash: null,
        })
        .where('sourceId', '=', grant.sourceId)
        .where('state', 'in', ['claimed', 'delivering'])
        .where('leaseUntil', '<=', sql<Date>`clock_timestamp()`)
        .execute();
      const busy = await tx
        .selectFrom('source_resource_read')
        .select('id')
        .where('sourceId', '=', grant.sourceId)
        .where('state', 'in', ['claimed', 'delivering'])
        .where('leaseUntil', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (busy) return;
      const requests = await tx
        .selectFrom('source_resource_read')
        .select(['id', 'assetId', 'resourceId', 'claimFence'])
        .where('sourceId', '=', grant.sourceId)
        .where('ownerId', '=', grant.ownerId)
        .where('deviceId', '=', grant.deviceId)
        .where('scopeFingerprint', '=', grant.scopeFingerprint)
        .where('authorizationEpoch', '=', grant.authorizationEpoch)
        .where('deadline', '>', sql<Date>`clock_timestamp()`)
        .where(sourceReadHasInterest)
        .where('state', 'in', active)
        .orderBy('createdAt')
        .orderBy('id')
        .limit(16)
        .execute();
      for (const request of requests) {
        const original = await this.original(tx, request.assetId);
        if (!original || !this.matches(original, grant, request.resourceId)) {
          await tx
            .updateTable('source_resource_read')
            .set({ state: 'unavailable', leaseUntil: null })
            .where('id', '=', request.id)
            .execute();
          continue;
        }
        if (original.bytes > maxBytes || request.claimFence >= 2_147_483_647) continue;
        const row = await tx
          .updateTable('source_resource_read')
          .set({
            state: 'claimed',
            claimFence: request.claimFence + 1,
            claimTokenHash: tokenHash,
            claimCredentialHash: grant.credentialHash,
            leaseUntil: sql`least(deadline,clock_timestamp()+interval '120 seconds')`,
          })
          .where('id', '=', request.id)
          .where('claimFence', '=', request.claimFence)
          .where('state', '=', 'pending')
          .where('deadline', '>', sql<Date>`clock_timestamp()`)
          .where(sourceReadHasInterest)
          .returning(['id', 'claimFence', 'leaseUntil', 'deadline'])
          .executeTakeFirst();
        if (row)
          return { ...original, ...row, leaseUntil: new Date(row.leaseUntil!), deadline: new Date(row.deadline) };
      }
    });
  }

  private matches(original: Original, grant: SourceResourceGrant, resourceId: string) {
    return (
      original.resourceId === resourceId &&
      original.sourceId === grant.sourceId &&
      original.ownerId === grant.ownerId &&
      original.deviceId === grant.deviceId &&
      original.scopeFingerprint === grant.scopeFingerprint &&
      original.authorizationEpoch === grant.authorizationEpoch
    );
  }

  private async lease(grant: SourceResourceGrant, id: string, fence: number, tokenHash: Buffer, delivery: boolean) {
    if (tokenHash.length !== 32 || !Number.isSafeInteger(fence) || fence < 1) return;
    return this.grants.withGrant(grant, async (tx) => {
      const request = await tx
        .selectFrom('source_resource_read')
        .select(['assetId', 'resourceId'])
        .where('id', '=', id)
        .where('sourceId', '=', grant.sourceId)
        .where('ownerId', '=', grant.ownerId)
        .where('deviceId', '=', grant.deviceId)
        .where('scopeFingerprint', '=', grant.scopeFingerprint)
        .where('authorizationEpoch', '=', grant.authorizationEpoch)
        .where('claimFence', '=', fence)
        .where('claimTokenHash', '=', tokenHash)
        .where('claimCredentialHash', '=', grant.credentialHash)
        .where('state', 'in', delivery ? ['claimed'] : ['claimed', 'delivering'])
        .where('deadline', '>', sql<Date>`clock_timestamp()`)
        .where(sourceReadHasInterest)
        .where('leaseUntil', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (!request) return;
      const original = await this.original(tx, request.assetId);
      if (!original || !this.matches(original, grant, request.resourceId)) return;
      const row = await tx
        .updateTable('source_resource_read')
        .set({
          ...(delivery ? { state: 'delivering' as const } : {}),
          leaseUntil: sql`least(deadline,clock_timestamp()+interval '120 seconds')`,
        })
        .where('id', '=', id)
        .where('claimFence', '=', fence)
        .where('claimTokenHash', '=', tokenHash)
        .where('claimCredentialHash', '=', grant.credentialHash)
        .where('state', 'in', delivery ? ['claimed'] : ['claimed', 'delivering'])
        .where('deadline', '>', sql<Date>`clock_timestamp()`)
        .where(sourceReadHasInterest)
        .where('leaseUntil', '>', sql<Date>`clock_timestamp()`)
        .returning(['id', 'claimFence', 'leaseUntil', 'deadline'])
        .executeTakeFirst();
      if (row) return { ...original, ...row, leaseUntil: new Date(row.leaseUntil!), deadline: new Date(row.deadline) };
    });
  }

  heartbeat(grant: SourceResourceGrant, id: string, fence: number, tokenHash: Buffer) {
    return this.lease(grant, id, fence, tokenHash, false);
  }

  beginDelivery(grant: SourceResourceGrant, id: string, fence: number, tokenHash: Buffer) {
    return this.lease(grant, id, fence, tokenHash, true);
  }
  async completeDelivery(
    grant: SourceResourceGrant,
    id: string,
    fence: number,
    tokenHash: Buffer,
    expected: Pick<Original, 'resourceKey' | 'version' | 'sha256' | 'bytes'>,
    publish: (tx: Transaction<DB>) => Promise<boolean>,
  ) {
    if (tokenHash.length !== 32 || !Number.isSafeInteger(fence) || fence < 1) return;
    const rejected = new Error('source_delivery_invalid');
    return this.grants
      .withGrant(grant, async (tx) => {
        await this.expire(tx, grant);
        const request = await tx
          .selectFrom('source_resource_read')
          .select(['assetId', 'resourceId'])
          .where('id', '=', id)
          .where('sourceId', '=', grant.sourceId)
          .where('ownerId', '=', grant.ownerId)
          .where('deviceId', '=', grant.deviceId)
          .where('scopeFingerprint', '=', grant.scopeFingerprint)
          .where('authorizationEpoch', '=', grant.authorizationEpoch)
          .where('claimFence', '=', fence)
          .where('claimTokenHash', '=', tokenHash)
          .where('claimCredentialHash', '=', grant.credentialHash)
          .where('state', '=', 'delivering')
          .where('deadline', '>', sql<Date>`clock_timestamp()`)
          .where('leaseUntil', '>', sql<Date>`clock_timestamp()`)
          .forUpdate()
          .executeTakeFirst();
        if (!request) return;
        const original = await this.original(tx, request.assetId, grant);
        if (
          !original ||
          !this.matches(original, grant, request.resourceId) ||
          original.resourceKey !== expected.resourceKey ||
          original.version !== expected.version ||
          original.sha256 !== expected.sha256 ||
          original.bytes !== expected.bytes
        )
          return;
        // Database-only publication: the receiver must already have closed and independently verified its file.
        if (!(await publish(tx))) throw rejected;
        const completed = await tx
          .updateTable('source_resource_read')
          .set({ state: 'ready', leaseUntil: null, claimTokenHash: null, claimCredentialHash: null })
          .where('id', '=', id)
          .where('state', '=', 'delivering')
          .where('claimFence', '=', fence)
          .where('claimTokenHash', '=', tokenHash)
          .where('claimCredentialHash', '=', grant.credentialHash)
          .where('deadline', '>', sql<Date>`clock_timestamp()`)
          .where('leaseUntil', '>', sql<Date>`clock_timestamp()`)
          .where(sourceReadHasInterest)
          .returning('id')
          .executeTakeFirst();
        // Expiry after a lock wait must also undo the cache write.
        if (!completed) throw rejected;
        return true;
      })
      .catch((error) => {
        if (error !== rejected) throw error;
        return;
      });
  }
}

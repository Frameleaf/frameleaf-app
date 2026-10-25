import { Injectable } from '@nestjs/common';
import { Kysely, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { DB } from 'src/schema/index.js';
import { AssetStatus, ChecksumAlgorithm } from 'src/enum.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import {
  type SourceCacheReader,
  SourceResourceCacheRepository,
} from 'src/repositories/source-resource-cache.repository.js';
import { SourceResourceGrant, SourceResourceRepository } from 'src/repositories/source-resource.repository.js';
import { lockSourceAuthorities } from 'src/utils/source-authority-lock.js';
import { type SourceBackupRead, sourceBackupReadAuthority } from 'src/utils/source-backup-read.js';
import { parseSourceOriginalPath, sourceOriginalPath } from 'src/utils/source-original.js';
import { sourceReadHasInterest } from 'src/utils/source-read-interest.js';

export type { SourceBackupRead } from 'src/utils/source-backup-read.js';
const requestBackup = (row: {
  backupOperationId: string | null;
  backupClaimTokenHash: Buffer | null;
}): SourceBackupRead | undefined =>
  row.backupOperationId && row.backupClaimTokenHash
    ? { operationId: row.backupOperationId, claimTokenHash: row.backupClaimTokenHash }
    : undefined;

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
    private cache: SourceResourceCacheRepository,
  ) {
    this.db = publicationDatabase(this.db);
  }

  private async original(
    tx: Transaction<DB>,
    assetId: string,
    expected?: Pick<SourceResourceGrant, 'sourceId' | 'ownerId'>,
    backup?: SourceBackupRead,
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
    const authority = backup ? sourceBackupReadAuthority(backup) : sql<boolean>`true`;
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
        AND a."checksumAlgorithm"=${ChecksumAlgorithm.sha1Path}
        AND ((a."deletedAt" IS NULL AND a.status=${AssetStatus.Active}) OR (a.status=${AssetStatus.Trashed} AND ${!!backup}))
        AND ${authority}
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
          eb('scopeFingerprint', '!=', source.scopeFingerprint),
          eb('authorizationEpoch', '!=', source.authorizationEpoch),
          eb('ownerId', '!=', source.ownerId),
          eb('deviceId', '!=', source.deviceId),
          eb.not(sourceReadHasInterest),
        ]),
      )
      .execute();
  }

  enqueue(assetId: string, maxBytes = Number.MAX_SAFE_INTEGER, reader?: SourceCacheReader, backup?: SourceBackupRead) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return Promise.resolve(undefined);
    return this.db.transaction().execute(async (tx) => {
      const original = await this.original(tx, assetId, undefined, backup);
      if (!original || original.bytes > maxBytes) return;
      await this.expire(tx, original);
      const existing = await tx
        .selectFrom('source_resource_read')
        .select(['id', 'deadline'])
        .where('assetId', '=', assetId)
        .where('resourceId', '=', original.resourceId)
        .where('scopeFingerprint', '=', original.scopeFingerprint)
        .where('authorizationEpoch', '=', original.authorizationEpoch)
        .where('state', 'in', active)
        .where('backupOperationId', backup ? '=' : 'is', backup?.operationId ?? null)
        .where('backupClaimTokenHash', backup ? '=' : 'is', backup?.claimTokenHash ?? null)
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        if (!(await this.addConsumer(tx, existing.id, reader))) return;
        return existing;
      }
      const usage = await tx
        .selectFrom('source_resource_read')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('sourceId', '=', original.sourceId)
        .where('state', 'in', active)
        .executeTakeFirstOrThrow();
      if (Number(usage.count) >= 16) return;
      const { sourceId, resourceId, ownerId, deviceId, scopeFingerprint, authorizationEpoch } = original;
      const request = await tx
        .insertInto('source_resource_read')
        .values({
          assetId,
          sourceId,
          resourceId,
          ownerId,
          deviceId,
          scopeFingerprint,
          authorizationEpoch,
          consumerManaged: !!reader,
          backupOperationId: backup?.operationId ?? null,
          backupClaimTokenHash: backup?.claimTokenHash ?? null,
          deadline: sql`clock_timestamp()+interval '10 minutes'`,
        })
        .returning(['id', 'deadline'])
        .executeTakeFirstOrThrow();
      await this.addConsumer(tx, request.id, reader);
      return request;
    });
  }

  private async addConsumer(tx: Transaction<DB>, readId: string, reader?: SourceCacheReader) {
    if (!reader) {
      // Older callers own an untracked interest through the original bounded deadline.
      await tx.updateTable('source_resource_read').set({ consumerManaged: false }).where('id', '=', readId).execute();
      return true;
    }
    await tx
      .deleteFrom('source_resource_read_consumer')
      .where('readId', '=', readId)
      .where('expiresAt', '<=', sql<Date>`clock_timestamp()`)
      .execute();
    const consumers = await tx
      .selectFrom('source_resource_read_consumer')
      .selectAll()
      .where('readId', '=', readId)
      .execute();
    const existing = consumers.find((value) => value.readerId === reader.readerId);
    if (existing) return existing.readerOwnerId === reader.ownerId;
    if (consumers.length >= 64) return false;
    await tx
      .insertInto('source_resource_read_consumer')
      .values({
        readId,
        readerId: reader.readerId,
        readerOwnerId: reader.ownerId,
        expiresAt: sql`least((SELECT deadline FROM source_resource_read WHERE id=${readId}::uuid),clock_timestamp()+interval '120 seconds')`,
      })
      .execute();
    return true;
  }

  /** Relinquish only this caller's waiting interest; no file or producer lifetime is inferred. */
  releaseConsumer(readId: string, reader: Pick<SourceCacheReader, 'readerId' | 'ownerId'>) {
    return this.db.transaction().execute(async (tx) => {
      const request = await tx
        .selectFrom('source_resource_read')
        .select(['id', 'consumerManaged', 'state'])
        .where('id', '=', readId)
        .forUpdate()
        .executeTakeFirst();
      if (!request) return;
      await tx
        .deleteFrom('source_resource_read_consumer')
        .where('readId', '=', readId)
        .where('readerId', '=', reader.readerId)
        .where('readerOwnerId', '=', reader.ownerId)
        .execute();
      if (request.state === 'ready') {
        return (
          await tx
            .selectFrom('source_resource_cache')
            .select('id')
            .where('readId', '=', readId)
            .where('state', '=', 'ready')
            .executeTakeFirst()
        )?.id;
      }
      if (!request.consumerManaged) return;
      await tx
        .updateTable('source_resource_read')
        .set({ state: 'unavailable', leaseUntil: null })
        .where('id', '=', readId)
        .where('state', 'in', active)
        .where(sql<boolean>`NOT ${sourceReadHasInterest}`)
        .execute();
    });
  }

  /** Renew only a still-live waiting consumer; an expired nonce cannot revive a request. */
  renewConsumer(readId: string, reader: Pick<SourceCacheReader, 'readerId' | 'ownerId'>) {
    return this.db.transaction().execute(async (tx) => {
      const request = await tx
        .selectFrom('source_resource_read')
        .select('deadline')
        .where('id', '=', readId)
        .where('state', 'in', [...active, 'ready'])
        .where('deadline', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (!request) return false;
      const renewed = await tx
        .updateTable('source_resource_read_consumer')
        .set({ expiresAt: sql`least(${request.deadline}::timestamptz,clock_timestamp()+interval '120 seconds')` })
        .where('readId', '=', readId)
        .where('readerId', '=', reader.readerId)
        .where('readerOwnerId', '=', reader.ownerId)
        .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<Date>`clock_timestamp()`)]))
        .where(sql<boolean>`${request.deadline}::timestamptz > clock_timestamp()`)
        .returning('id')
        .executeTakeFirst();
      return !!renewed;
    });
  }

  /** Caller must separately authorize the asset. A new read never reuses an old ready request. */
  async pinReady(assetId: string, readId: string, reader: SourceCacheReader, backup?: SourceBackupRead) {
    const rejected = new Error('source_original_unavailable');
    return this.db
      .transaction()
      .execute(async (tx) => {
        const original = await this.original(tx, assetId, undefined, backup);
        if (!original) return;
        const request = await tx
          .selectFrom('source_resource_read')
          .select('consumerManaged')
          .where('id', '=', readId)
          .executeTakeFirst();
        if (!request) return;
        const consumer = await tx
          .selectFrom('source_resource_read_consumer')
          .select('readerOwnerId')
          .select(sql<boolean>`("expiresAt" IS NULL OR "expiresAt">clock_timestamp())`.as('live'))
          .where('readId', '=', readId)
          .where('readerId', '=', reader.readerId)
          .executeTakeFirst();
        if (
          (request.consumerManaged && !consumer) ||
          (consumer && (!consumer.live || consumer.readerOwnerId !== reader.ownerId))
        )
          throw rejected;
        const ready = this.ready(tx, original, readId);
        const entry = await ready.executeTakeFirst();
        if (!entry?.fileName || !/^[a-f0-9-]{36}[.]artifact$/u.test(entry.fileName)) return;
        const lease = await this.cache.pinInTransaction(tx, entry.id, reader);
        if (!lease) return;
        // Recheck time-sensitive authority after the cache lock wait; failure rolls back the pin.
        const current = await this.original(tx, assetId, undefined, backup);
        const live = await ready.executeTakeFirst();
        if (!current || !live || live.id !== entry.id) throw rejected;
        const detached = await tx
          .deleteFrom('source_resource_read_consumer')
          .where('readId', '=', readId)
          .where('readerId', '=', reader.readerId)
          .where('readerOwnerId', '=', reader.ownerId)
          .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<Date>`clock_timestamp()`)]))
          .returning('id')
          .executeTakeFirst();
        if ((request.consumerManaged || consumer) && !detached) throw rejected;
        return { ...original, cacheId: entry.id, fileName: entry.fileName, leaseId: lease.id };
      })
      .catch((error) => {
        if (error !== rejected) throw error;
        return;
      });
  }

  private ready(tx: Transaction<DB>, original: Original, readId: string) {
    return tx
      .selectFrom('source_resource_cache as c')
      .innerJoin('source_resource_read as r', 'r.id', 'c.readId')
      .select(['c.id', 'c.fileName'])
      .where('r.id', '=', readId)
      .where('r.assetId', '=', original.assetId)
      .where('r.state', '=', 'ready')
      .where('r.deadline', '>', sql<Date>`clock_timestamp()`)
      .whereRef('r.claimFence', '=', 'c.claimFence')
      .whereRef('r.resourceId', '=', 'c.resourceId')
      .whereRef('r.sourceId', '=', 'c.sourceId')
      .whereRef('r.ownerId', '=', 'c.ownerId')
      .whereRef('r.deviceId', '=', 'c.deviceId')
      .whereRef('r.scopeFingerprint', '=', 'c.scopeFingerprint')
      .whereRef('r.authorizationEpoch', '=', 'c.authorizationEpoch')
      .where('c.assetId', '=', original.assetId)
      .where('c.resourceId', '=', original.resourceId)
      .where('c.sourceId', '=', original.sourceId)
      .where('c.ownerId', '=', original.ownerId)
      .where('c.deviceId', '=', original.deviceId)
      .where('c.scopeFingerprint', '=', original.scopeFingerprint)
      .where('c.authorizationEpoch', '=', original.authorizationEpoch)
      .where('c.resourceKey', '=', original.resourceKey)
      .where('c.version', '=', original.version)
      .where('c.sha256', '=', Buffer.from(original.sha256, 'hex'))
      .where('c.bytes', '=', original.bytes)
      .where('c.state', '=', 'ready')
      .where('c.restoreHeld', '=', false)
      .where('c.writerStoppedAt', 'is not', null)
      .forUpdate('c');
  }

  async checkPinned(
    assetId: string,
    readId: string,
    cacheId: string,
    leaseId: string,
    reader: SourceCacheReader,
    backup?: SourceBackupRead,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const original = await this.original(tx, assetId, undefined, backup);
      if (!original) return false;
      const ready = this.ready(tx, original, readId)
        .where('c.id', '=', cacheId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('source_resource_cache_lease')
              .select('id')
              .where('id', '=', leaseId)
              .where('cacheId', '=', cacheId)
              .where('readerId', '=', reader.readerId)
              .where('readerOwnerId', '=', reader.ownerId)
              .where('readerStoppedAt', 'is', null),
          ),
        );
      const entry = await ready.executeTakeFirst();
      return !!entry && !!(await this.original(tx, assetId, undefined, backup)) && !!(await ready.executeTakeFirst());
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
        .select(['id', 'assetId', 'resourceId', 'claimFence', 'backupOperationId', 'backupClaimTokenHash'])
        .where('sourceId', '=', grant.sourceId)
        .where('ownerId', '=', grant.ownerId)
        .where('deviceId', '=', grant.deviceId)
        .where('scopeFingerprint', '=', grant.scopeFingerprint)
        .where('authorizationEpoch', '=', grant.authorizationEpoch)
        .where('deadline', '>', sql<Date>`clock_timestamp()`)
        .where('state', 'in', active)
        .orderBy('createdAt')
        .orderBy('id')
        .limit(16)
        .execute();
      for (const request of requests) {
        const original = await this.original(tx, request.assetId, grant, requestBackup(request));
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
      await this.expire(tx, grant);
      const request = await tx
        .selectFrom('source_resource_read')
        .select(['assetId', 'resourceId', 'backupOperationId', 'backupClaimTokenHash'])
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
        .where('leaseUntil', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (!request) return;
      const original = await this.original(tx, request.assetId, grant, requestBackup(request));
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
        .where('leaseUntil', '>', sql<Date>`clock_timestamp()`)
        .where(sourceReadHasInterest)
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
          .select(['assetId', 'resourceId', 'backupOperationId', 'backupClaimTokenHash'])
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
        const original = await this.original(tx, request.assetId, grant, requestBackup(request));
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
        if (!(await publish(tx)) || !(await this.original(tx, request.assetId, grant, requestBackup(request))))
          throw rejected;
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

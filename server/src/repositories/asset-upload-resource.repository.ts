import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Kysely, Selectable, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ICloudEditAuthorityRepository } from 'src/repositories/icloud-edit-authority.repository.js';
import { hasEditConfiguration, withICloudPublicationTransaction } from 'src/repositories/icloud-edit-transaction.js';
import { DB } from 'src/schema/index.js';
import { AssetUploadResourceTable } from 'src/schema/tables/asset-upload-resource.table.js';
import { ASSET_UPLOAD_LIMITS } from 'src/utils/asset-upload-resource.js';

export type AssetUploadResource = Selectable<AssetUploadResourceTable>;
@Injectable()
export class AssetUploadResourceRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  private async ready(db: Kysely<DB>) {
    const result = await sql<{
      ready: boolean;
    }>`SELECT to_regclass('public.asset_upload_resource') IS NOT NULL AND to_regclass('public.asset_upload_part') IS NOT NULL AS ready`.execute(
      db,
    );
    if (!result.rows[0]?.ready) {
      throw new ServiceUnavailableException('Resumable uploads require the upload-resource migration');
    }
  }
  /** Post-commit wake only; the durable owner stream is recovered again at bootstrap. */
  async enqueueLocalEffects() {
    return new AssetLocalEffectRepository(this.db).enqueuePending();
  }
  async create(
    id: string,
    ownerId: string,
    input: {
      metadata: AssetUploadResource['metadata'];
      checksum: Buffer;
      contentType: string;
      size?: number;
      maxSize?: number;
    },
  ) {
    return this.db.transaction().execute(async (tx) => {
      await this.ready(tx);
      const owner = await tx
        .selectFrom('user')
        .select('id')
        .where('id', '=', ownerId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!owner) {
        throw new NotFoundException('Owner unavailable');
      }
      const count = await tx
        .selectFrom('asset_upload_resource')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('ownerId', '=', ownerId)
        .where('expiresAt', '>', new Date())
        .where('ingested', '=', false)
        .where('state', 'not in', ['cancelled', 'rejected'])
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= ASSET_UPLOAD_LIMITS.maxActive) {
        throw new HttpException('Too many incomplete uploads', 429);
      }
      return tx
        .insertInto('asset_upload_resource')
        .values({
          id,
          ownerId,
          metadata: input.metadata,
          state: input.metadata.publication === 'live-photo' ? 'pair-receiving' : 'receiving',
          expectedChecksum: input.checksum,
          contentType: input.contentType,
          expectedSize: input.size ?? null,
          maxSize: input.maxSize ?? ASSET_UPLOAD_LIMITS.maxSize,
          maxAppendSize: Math.min(ASSET_UPLOAD_LIMITS.maxAppendSize, input.maxSize ?? ASSET_UPLOAD_LIMITS.maxSize),
          expiresAt: new Date(Date.now() + ASSET_UPLOAD_LIMITS.maxAge * 1000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  async get(id: string, ownerId: string) {
    await this.ready(this.db);
    const row = await this.db
      .selectFrom('asset_upload_resource')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .where('expiresAt', '>', new Date())
      .where('state', '!=', 'cancelled')
      .executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Upload unavailable');
    }
    return row;
  }
  /** The transaction and its file attempt are never reused after lock/connection loss. */
  async locked<T>(
    id: string,
    ownerId: string,
    callback: (tx: Transaction<DB>, resource: AssetUploadResource) => Promise<T>,
    allowExpiredPublished = false,
  ) {
    return this.lockedMany([id], ownerId, (tx, rows) => callback(tx, rows[0]), allowExpiredPublished);
  }
  /** All resource locks share one transaction and a deterministic acquisition order. */
  async lockedMany<T>(
    ids: string[],
    ownerId: string,
    callback: (tx: Transaction<DB>, resources: AssetUploadResource[]) => Promise<T>,
    allowExpiredPublished = false,
  ) {
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new ConflictException('Distinct upload resources are required');
    }
    return withICloudPublicationTransaction(
      this.db,
      ownerId,
      ids.map((id) => ({ channel: 'device', id })),
      async (tx) => {
        await this.ready(tx);
        const rows: AssetUploadResource[] = [];
        for (const id of [...ids].sort()) {
          const row = await tx
            .selectFrom('asset_upload_resource')
            .selectAll()
            .where('id', '=', id)
            .where('ownerId', '=', ownerId)
            .where((eb) =>
              allowExpiredPublished
                ? eb.or([eb('expiresAt', '>', new Date()), eb('state', '=', 'published')])
                : eb('expiresAt', '>', new Date()),
            )
            .where('state', '!=', 'cancelled')
            .executeTakeFirst();
          if (!row) {
            throw new NotFoundException('Upload unavailable');
          }
          // A losing writer is refused immediately rather than consuming a second pooled connection.
          const lock = await sql<{
            acquired: boolean;
          }>`SELECT pg_try_advisory_xact_lock(-225, hashtext(${id})::int) AS acquired`.execute(tx);
          if (!lock.rows[0]?.acquired) {
            throw new ConflictException('Upload has an active request');
          }
          const current = await tx
            .selectFrom('asset_upload_resource')
            .selectAll()
            .where('id', '=', id)
            .where('ownerId', '=', ownerId)
            .where((eb) =>
              allowExpiredPublished
                ? eb.or([eb('expiresAt', '>', new Date()), eb('state', '=', 'published')])
                : eb('expiresAt', '>', new Date()),
            )
            .where('state', '!=', 'cancelled')
            .forUpdate()
            .executeTakeFirst();
          if (!current) {
            throw new NotFoundException('Upload unavailable');
          }
          rows.push(current);
        }
        const owner = await tx
          .selectFrom('user')
          .select('id')
          .where('id', '=', ownerId)
          .where('deletedAt', 'is', null)
          .$if(ids.length > 1 || hasEditConfiguration(tx), (qb) => qb.forUpdate())
          .$if(ids.length === 1 && !hasEditConfiguration(tx), (qb) => qb.forShare())
          .executeTakeFirst();
        if (!owner) {
          throw new NotFoundException('Upload owner unavailable');
        }
        return callback(tx, rows);
      },
    );
  }
  parts(tx: Transaction<DB> | undefined, id: string) {
    return (tx ?? this.db)
      .selectFrom('asset_upload_part')
      .selectAll()
      .where('resourceId', '=', id)
      .orderBy('offset', 'asc')
      .execute();
  }
  private pendingCreatedOrigin(tx: Transaction<DB>, ownerId: string, assetId: string, checksum: Buffer) {
    return tx
      .selectFrom('asset_upload_resource')
      .select('id')
      .where('ownerId', '=', ownerId)
      .where('resultAssetId', '=', assetId)
      .where('verifiedChecksum', '=', checksum)
      .where('resultStatus', '=', AssetMediaStatus.CREATED)
      .where('state', '=', 'published')
      .where('ingested', '=', false)
      .forShare()
      .executeTakeFirst();
  }
  async completeDuplicate(id: string, ownerId: string) {
    return this.locked(id, ownerId, async (tx, resource) => {
      if (resource.state !== 'published' || resource.resultStatus !== AssetMediaStatus.DUPLICATE || resource.ingested) {
        return;
      }
      const asset = await tx
        .selectFrom('asset')
        .select('id')
        .where('id', '=', resource.resultAssetId!)
        .where('ownerId', '=', ownerId)
        .where('checksum', '=', resource.verifiedChecksum!)
        .where('deletedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      if (!asset) {
        throw new NotFoundException('Upload result unavailable');
      }
      if (await this.pendingCreatedOrigin(tx, ownerId, asset.id, resource.verifiedChecksum!)) {
        return;
      }
      return tx
        .updateTable('asset_upload_resource')
        .set({ ingested: true })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  /** Asset, initial privacy/enrichment, quota, checksum evidence and upload result commit together. */
  async publish(
    tx: Transaction<DB>,
    resource: AssetUploadResource,
    prepared: {
      asset: Parameters<AssetRepository['create']>[0];
      lock: Parameters<AssetRepository['create']>[1];
    },
    options: {
      rejectDuplicate?: boolean;
      quotaCharged?: boolean;
    } = {},
  ) {
    if (
      resource.resultAssetId ||
      resource.state !== (options.rejectDuplicate ? 'pair-verified' : 'verified') ||
      !resource.ownerId ||
      !resource.finalPath ||
      !resource.verifiedChecksum ||
      !resource.legacyChecksum
    ) {
      throw new ConflictException('Upload is not ready for publication');
    }
    const editAuthority = new ICloudEditAuthorityRepository(tx);
    const edit = await editAuthority.publication(tx, resource.ownerId, 'device', resource.id);
    const assets = new AssetRepository(tx);
    const duplicateId =
      edit?.existingAssetId ??
      (options.rejectDuplicate
        ? (
            await tx
              .selectFrom('asset')
              .select('id')
              .where('ownerId', '=', resource.ownerId)
              .where('checksum', '=', resource.verifiedChecksum)
              .where('libraryId', 'is', null)
              .executeTakeFirst()
          )?.id
        : await assets.getUploadAssetIdByChecksum(resource.ownerId, resource.verifiedChecksum, {
            lockedOwnerId: resource.ownerId,
          }));
    if (edit && duplicateId && edit.existingAssetId !== duplicateId) {
      throw new ConflictException('edit_bound_asset_required');
    }
    if (duplicateId && options.rejectDuplicate) {
      throw new ConflictException('Live Photo resources cannot reuse an existing asset');
    }
    const duplicatePending = duplicateId
      ? await this.pendingCreatedOrigin(tx, resource.ownerId, duplicateId, resource.verifiedChecksum)
      : undefined;
    let assetId = duplicateId;
    if (!assetId) {
      if (!options.quotaCharged) {
        const quota = await tx
          .updateTable('user')
          .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${resource.offset}` })
          .where('id', '=', resource.ownerId)
          .where('deletedAt', 'is', null)
          .where(
            sql<boolean>`("quotaSizeInBytes" IS NULL OR "quotaUsageInBytes" + ${resource.offset} <= "quotaSizeInBytes")`,
          )
          .returning('id')
          .executeTakeFirst();
        if (!quota) {
          throw new BadRequestException('Quota has been exceeded');
        }
      }
      const asset = await assets.create(prepared.asset, prepared.lock, tx);
      assetId = asset.id;
      if (resource.metadata.metadata?.length) {
        await assets.upsertMetadata(assetId, resource.metadata.metadata, tx);
      }
      await assets.upsertExif({
        exif: { assetId, fileSizeInByte: resource.offset },
        lockedPropertiesBehavior: 'override',
      });
      await new AssetChecksumRepository(tx).recordAssetChecksums({
        assetId,
        sha1: resource.legacyChecksum,
        sha256: resource.verifiedChecksum,
        sizeInBytes: resource.offset,
        path: resource.finalPath,
        source: 'upload',
      });
    }
    if (edit) {
      await editAuthority.published(tx, resource.ownerId, edit, assetId, !duplicateId);
    }
    return tx
      .updateTable('asset_upload_resource')
      .set({
        resultAssetId: assetId,
        resultStatus: duplicateId ? AssetMediaStatus.DUPLICATE : AssetMediaStatus.CREATED,
        state: 'published',
        ingested: !!duplicateId && !duplicatePending,
      })
      .where('id', '=', resource.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  /** Both assets, checksum evidence, metadata, results and the combined quota debit commit atomically. */
  async publishLivePhoto(
    tx: Transaction<DB>,
    still: AssetUploadResource,
    video: AssetUploadResource,
    prepared?: {
      still: Parameters<AssetUploadResourceRepository['publish']>[2];
      video: Parameters<AssetUploadResourceRepository['publish']>[2];
    },
  ) {
    if (
      still.id === video.id ||
      !still.ownerId ||
      still.ownerId !== video.ownerId ||
      still.metadata.publication !== 'live-photo' ||
      video.metadata.publication !== 'live-photo' ||
      !still.verifiedChecksum?.equals(still.expectedChecksum) ||
      !video.verifiedChecksum?.equals(video.expectedChecksum)
    ) {
      throw new ConflictException('Live Photo resources are not verified');
    }
    if (still.state === 'published' && video.state === 'published') {
      const pair = await tx
        .selectFrom('asset')
        .select('id')
        .where('id', '=', still.resultAssetId!)
        .where('ownerId', '=', still.ownerId)
        .where('type', '=', AssetType.Image)
        .where('livePhotoVideoId', '=', video.resultAssetId!)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      const motion = await tx
        .selectFrom('asset')
        .select('id')
        .where('id', '=', video.resultAssetId!)
        .where('ownerId', '=', still.ownerId)
        .where('type', '=', AssetType.Video)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (
        !pair ||
        !motion ||
        still.resultStatus !== AssetMediaStatus.CREATED ||
        video.resultStatus !== AssetMediaStatus.CREATED
      ) {
        throw new ConflictException('Upload resources do not identify this Live Photo pair');
      }
      return { still, video };
    }
    if (
      !prepared ||
      still.state !== 'pair-verified' ||
      video.state !== 'pair-verified' ||
      prepared.still.asset.type !== AssetType.Image ||
      prepared.video.asset.type !== AssetType.Video ||
      prepared.still.asset.ownerId !== still.ownerId ||
      prepared.video.asset.ownerId !== video.ownerId ||
      prepared.still.asset.originalPath !== still.finalPath ||
      prepared.video.asset.originalPath !== video.finalPath ||
      !Buffer.from(prepared.still.asset.checksum).equals(still.verifiedChecksum) ||
      !Buffer.from(prepared.video.asset.checksum).equals(video.verifiedChecksum) ||
      prepared.still.asset.livePhotoVideoId ||
      prepared.video.asset.livePhotoVideoId ||
      (prepared.still.lock && prepared.still.lock.lockedBy !== still.ownerId) ||
      prepared.still.lock?.reason !== prepared.video.lock?.reason ||
      prepared.still.lock?.lockedBy !== prepared.video.lock?.lockedBy
    ) {
      throw new ConflictException('Live Photo types, publication or privacy are incompatible');
    }
    const quota = await tx
      .updateTable('user')
      .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${still.offset + video.offset}` })
      .where('id', '=', still.ownerId)
      .where('deletedAt', 'is', null)
      .where(
        sql<boolean>`("quotaSizeInBytes" IS NULL OR "quotaUsageInBytes" + ${still.offset + video.offset} <= "quotaSizeInBytes")`,
      )
      .returning('id')
      .executeTakeFirst();
    if (!quota) {
      throw new BadRequestException('Quota has been exceeded');
    }
    const publishedVideo = await this.publish(
      tx,
      video,
      {
        ...prepared.video,
        asset: { ...prepared.video.asset, visibility: AssetVisibility.Hidden },
      },
      { rejectDuplicate: true, quotaCharged: true },
    );
    const publishedStill = await this.publish(
      tx,
      still,
      {
        ...prepared.still,
        asset: { ...prepared.still.asset, livePhotoVideoId: publishedVideo.resultAssetId },
      },
      { rejectDuplicate: true, quotaCharged: true },
    );
    return { still: publishedStill, video: publishedVideo };
  }
  /** A declared half cannot acknowledge completion until its current committed sibling is ingested too. */
  async livePhotoPairIngested(resource: AssetUploadResource) {
    if (resource.state !== 'published' || !resource.ingested || !resource.ownerId || !resource.resultAssetId) {
      return false;
    }
    const pair = await this.db
      .selectFrom('asset as still')
      .innerJoin('asset as video', 'video.id', 'still.livePhotoVideoId')
      .innerJoin('asset_upload_resource as stillUpload', 'stillUpload.resultAssetId', 'still.id')
      .innerJoin('asset_upload_resource as videoUpload', 'videoUpload.resultAssetId', 'video.id')
      .select('still.id')
      .where('still.ownerId', '=', resource.ownerId)
      .where('video.ownerId', '=', resource.ownerId)
      .where('stillUpload.ownerId', '=', resource.ownerId)
      .where('videoUpload.ownerId', '=', resource.ownerId)
      .where('still.type', '=', AssetType.Image)
      .where('video.type', '=', AssetType.Video)
      .where('still.deletedAt', 'is', null)
      .where('video.deletedAt', 'is', null)
      .where('stillUpload.state', '=', 'published')
      .where('videoUpload.state', '=', 'published')
      .where('stillUpload.ingested', '=', true)
      .where('videoUpload.ingested', '=', true)
      .where('stillUpload.resultStatus', '=', AssetMediaStatus.CREATED)
      .where('videoUpload.resultStatus', '=', AssetMediaStatus.CREATED)
      .where(
        sql<boolean>`"stillUpload".metadata ->> 'publication' = 'live-photo' AND "videoUpload".metadata ->> 'publication' = 'live-photo'`,
      )
      .where((eb) => eb.or([eb('stillUpload.id', '=', resource.id), eb('videoUpload.id', '=', resource.id)]))
      .executeTakeFirst();
    return !!pair;
  }
  async claimIngestion(id: string, ownerId: string, token: string) {
    return this.locked(
      id,
      ownerId,
      async (tx, resource) => {
        if (
          resource.state !== 'published' ||
          resource.ingested ||
          (resource.ingestionLeaseExpiresAt && new Date(resource.ingestionLeaseExpiresAt).getTime() > Date.now())
        ) {
          return;
        }
        return tx
          .updateTable('asset_upload_resource')
          .set({ ingestionToken: token, ingestionLeaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000) })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
      },
      true,
    );
  }
  async checkIngestion(id: string, ownerId: string, token: string) {
    const resource = await this.db
      .selectFrom('asset_upload_resource')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
    if (!resource) {
      throw new NotFoundException('Upload unavailable');
    }
    if (
      resource.state !== 'published' ||
      resource.ingested ||
      resource.ingestionToken !== token ||
      !resource.ingestionLeaseExpiresAt ||
      new Date(resource.ingestionLeaseExpiresAt).getTime() <= Date.now()
    ) {
      throw new ConflictException('Upload ingestion claim expired');
    }
    const owner = await this.db
      .selectFrom('user')
      .select('id')
      .where('id', '=', ownerId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    const asset = await this.db
      .selectFrom('asset')
      .select('id')
      .where('id', '=', resource.resultAssetId!)
      .where('ownerId', '=', ownerId)
      .where('checksum', '=', resource.verifiedChecksum!)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!owner || !asset) {
      throw new NotFoundException('Upload result unavailable');
    }
    return resource;
  }
  async completeIngestion(id: string, ownerId: string, token: string) {
    return this.locked(
      id,
      ownerId,
      async (tx, resource) => {
        if (
          resource.ingestionToken !== token ||
          !resource.ingestionLeaseExpiresAt ||
          new Date(resource.ingestionLeaseExpiresAt).getTime() <= Date.now()
        ) {
          throw new ConflictException('Upload ingestion claim expired');
        }
        const asset = await tx
          .selectFrom('asset')
          .select(['id', 'originalPath'])
          .where('id', '=', resource.resultAssetId!)
          .where('ownerId', '=', ownerId)
          .where('checksum', '=', resource.verifiedChecksum!)
          .where('deletedAt', 'is', null)
          .forShare()
          .executeTakeFirst();
        if (!asset) {
          throw new NotFoundException('Upload result unavailable');
        }
        const evidence =
          await sql`UPDATE public.asset_checksum SET "verifiedPaths" = ARRAY[${asset.originalPath}]::text[], "updatedAt" = now() WHERE "assetId" = ${asset.id}::uuid AND sha256 = ${resource.verifiedChecksum}`.execute(
            tx,
          );
        if (evidence.numAffectedRows !== 1n) {
          throw new ConflictException('Upload checksum evidence changed');
        }
        return tx
          .updateTable('asset_upload_resource')
          .set({ ingested: true, ingestionToken: null, ingestionLeaseExpiresAt: null })
          .where('id', '=', id)
          .where('ingestionToken', '=', token)
          .returningAll()
          .executeTakeFirstOrThrow();
      },
      true,
    );
  }
  async cleanupCandidates() {
    await this.ready(this.db);
    return this.db
      .selectFrom('asset_upload_resource')
      .selectAll()
      .where((eb) =>
        eb.or([eb('expiresAt', '<=', new Date()), eb.and([eb('state', '!=', 'cancelled'), eb('ownerId', 'is', null)])]),
      )
      .where((eb) =>
        eb.not(
          eb.and([
            eb('state', '=', 'published'),
            eb('ingested', '=', false),
            eb.exists(
              eb
                .selectFrom('user')
                .select('id')
                .whereRef('user.id', '=', 'asset_upload_resource.ownerId')
                .where('user.deletedAt', 'is', null),
            ),
            eb.exists(
              eb
                .selectFrom('asset')
                .select('id')
                .whereRef('asset.id', '=', 'asset_upload_resource.resultAssetId')
                .whereRef('asset.ownerId', '=', 'asset_upload_resource.ownerId')
                .whereRef('asset.checksum', '=', 'asset_upload_resource.verifiedChecksum')
                .where('asset.deletedAt', 'is', null),
            ),
          ]),
        ),
      )
      .orderBy('expiresAt', 'asc')
      .limit(100)
      .execute();
  }
  async owner(id: string) {
    return this.db
      .selectFrom('user')
      .selectAll()
      .where('id', '=', id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }
  async recoverable() {
    await this.ready(this.db);
    return this.db
      .selectFrom('asset_upload_resource')
      .selectAll()
      .where('ownerId', 'is not', null)
      .where((eb) =>
        eb.or([
          eb.and([eb('state', 'in', ['finalizing', 'pair-finalizing', 'verified']), eb('expiresAt', '>', new Date())]),
          eb.and([eb('state', '=', 'published'), eb('ingested', '=', false)]),
        ]),
      )
      .limit(100)
      .execute();
  }
  async cleanup(id: string, removeFiles: () => Promise<void>) {
    const claimed = await this.db.transaction().execute(async (tx) => {
      await this.ready(tx);
      const lock = await sql<{
        acquired: boolean;
      }>`SELECT pg_try_advisory_xact_lock(-225, hashtext(${id})::int) AS acquired`.execute(tx);
      if (!lock.rows[0]?.acquired) {
        return false;
      }
      const row = await tx
        .selectFrom('asset_upload_resource')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) {
        return false;
      }
      const owner = row.ownerId
        ? await tx
            .selectFrom('user')
            .select('id')
            .where('id', '=', row.ownerId)
            .where('deletedAt', 'is', null)
            .forShare()
            .executeTakeFirst()
        : undefined;
      if (owner && row.state === 'published' && !row.ingested) {
        const retained = await tx
          .selectFrom('asset')
          .select('id')
          .where('id', '=', row.resultAssetId!)
          .where('ownerId', '=', row.ownerId!)
          .where('checksum', '=', row.verifiedChecksum!)
          .where('deletedAt', 'is', null)
          .forShare()
          .executeTakeFirst();
        if (retained) {
          return false;
        }
      }
      if (owner && row.expiresAt > new Date() && row.state !== 'cancelled') {
        return false;
      }
      await tx
        .updateTable('asset_upload_resource')
        .set({
          state: 'cancelled',
          ingestionToken: null,
          ingestionLeaseExpiresAt: null,
          expiresAt: new Date(Date.now() + (row.state === 'cancelled' ? 86_400 : 600) * 1000),
        })
        .where('id', '=', id)
        .execute();
      return true;
    });
    // ponytail: retain private denied tombstones indefinitely in this prerequisite; full metadata GC remains open.
    // Terminal expiresAt becomes the next cleanup time: one late-attempt grace sweep, then daily.
    // Keep the tombstone and manifest: disconnected attempts can leave private scratch later.
    // No database connection is held while reference-aware filesystem cleanup runs.
    if (claimed) {
      await removeFiles();
    }
  }
}

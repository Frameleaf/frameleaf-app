import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { IPartnerBackfillJob, IPartnerCopyAssetJob, IPartnerPropagateJob, JobItem } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AssetStatus, AssetVisibility, ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import {
  AssetOriginField,
  PartnerBackfillState,
  PartnerOriginRepository,
} from 'src/repositories/partner-origin.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { upsertTags } from 'src/utils/tag.js';

/** Assets copied per backfill batch before the job re-queues itself (and records its cursor). */
export const PARTNER_BACKFILL_BATCH_SIZE = 100;

type BackfillRepositories = { partnerOrigin: PartnerOriginRepository; job: JobRepository };

/** Start copying a new partnership's library (spec §4.7). */
export const startPartnerBackfill = async (
  { partnerOrigin, job }: BackfillRepositories,
  sharedById: string,
  sharedWithId: string,
) => {
  const total = await partnerOrigin.countOwnerAssets(sharedById);
  await partnerOrigin.startBackfill(sharedById, sharedWithId, total);
  await job.queue({ name: JobName.PartnerBackfill, data: { sharedById, sharedWithId } });
};

/** A partnership ended (spec §4.7): no more copies, and everything received stops following. */
export const stopPartnerSharing = async (
  { partnerOrigin }: Pick<BackfillRepositories, 'partnerOrigin'>,
  sharedById: string,
  sharedWithId: string,
) => {
  await partnerOrigin.stopBackfill(sharedById, sharedWithId);
  await partnerOrigin.stopFollowing(sharedById, sharedWithId);
};

const TRACKED_ASSET_FIELDS = new Set<string>(Object.values(AssetOriginField));

/** The followed fields an asset edit touches (spec §4.2). Favorites and trash are never among them. */
export const getAssetEditFields = (dto: {
  description?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  city?: unknown;
  state?: unknown;
  country?: unknown;
  dateTimeOriginal?: unknown;
  dateTimeRelative?: unknown;
  timeZone?: unknown;
  rating?: unknown;
  visibility?: unknown;
}): AssetOriginField[] => {
  const touched = (...values: unknown[]) => values.some((value) => value !== undefined);
  return [
    ...(touched(dto.description) ? [AssetOriginField.Description] : []),
    ...(touched(dto.latitude, dto.longitude, dto.city, dto.state, dto.country) ? [AssetOriginField.Location] : []),
    ...(touched(dto.dateTimeOriginal, dto.dateTimeRelative, dto.timeZone) ? [AssetOriginField.DateTimeOriginal] : []),
    ...(touched(dto.rating) ? [AssetOriginField.Rating] : []),
    ...(touched(dto.visibility) ? [AssetOriginField.Visibility] : []),
  ];
};

/**
 * An owner edited these fields of their items (spec §4.6): on their copies the fields become theirs
 * (no longer followed), and every copy that follows one of the items receives the change.
 */
export const recordAssetEdit = async (
  { partnerOrigin, job }: BackfillRepositories,
  ownerId: string,
  assetIds: string[],
  fields: string[],
) => {
  const tracked = fields.filter((field) => TRACKED_ASSET_FIELDS.has(field));
  if (tracked.length === 0 || assetIds.length === 0) {
    return;
  }
  await partnerOrigin.markOverridden('asset', assetIds, tracked, ownerId);
  const sources = await partnerOrigin.getIdsWithFollowers('asset', assetIds);
  if (sources.length > 0) {
    await job.queueAll(
      sources.map((sourceId) => ({
        name: JobName.PartnerPropagate as const,
        data: { kind: 'asset' as const, sourceId, fields: tracked },
      })),
    );
  }
};

/**
 * Partner sharing v2 (FL-326, spec §4.3, §4.7): a partner receives their own copy of every item the
 * sharing user holds. A copy is an ordinary row of the recipient's, linked to the same stored file,
 * with the source's metadata, search embedding, OCR and tags, so nothing is uploaded or analysed again.
 * Its `asset_origin` row records where it came from, for propagation and the "from partner" label.
 */
@Injectable()
export class PartnerCopyService extends BaseService {
  protected backfillBatchSize = PARTNER_BACKFILL_BATCH_SIZE;

  /**
   * Copy one source asset into `targetOwnerId`'s library. Returns the copy's id, or undefined when it
   * is skipped: the one-copy rule (the library already holds this content, live or trashed), a target
   * that is the item's own or original owner, an external-library or Hidden item, or (until Task 13)
   * a Locked or sensitive one.
   */
  async copyAsset(
    sourceAssetId: string,
    targetOwnerId: string,
    partnerSharedById: string,
  ): Promise<string | undefined> {
    const source = await this.assetRepository.getById(sourceAssetId);
    if (!source || source.deletedAt || source.status !== AssetStatus.Active || source.ownerId === targetOwnerId) {
      return;
    }
    // external-library files are never linked (spec §3.2); the motion part of a Live Photo is Hidden
    // and follows its still, which is copied unpaired for now
    if (source.libraryId || source.isExternal || source.isOffline || source.visibility === AssetVisibility.Hidden) {
      return;
    }

    const origin = await this.partnerOriginRepository.getOrigin('asset', source.id);
    const rootOwnerId = origin?.rootOwnerId ?? source.ownerId;
    if (rootOwnerId === targetOwnerId) {
      return;
    }

    if (await this.isWithheldFromCopy(source.id, source.visibility)) {
      return;
    }

    if (await this.partnerOriginRepository.libraryHasChecksum(targetOwnerId, source.checksum)) {
      return;
    }

    const original = await this.resolvePhysicalOriginal(source.id);
    if (!original) {
      this.logger.warn(`Partner copy of ${source.id} skipped: its original has no stored file to link`);
      return;
    }

    const copyId = await this.partnerOriginRepository.insertAssetCopy({
      sourceAssetId: source.id,
      ownerId: targetOwnerId,
      rootOwnerId,
      partnerSharedById,
      original: { id: original.id, path: original.path },
    });
    if (!copyId) {
      return;
    }

    await this.copyTags(source.id, copyId, targetOwnerId);
    await this.copyFaces(source.id, copyId, targetOwnerId);
    return copyId;
  }

  /**
   * TASK 13 (partner-people-locked) removes this skip: Locked and sensitive items are not copied yet
   * (spec §8 step 6). This is the only place it is applied.
   */
  private async isWithheldFromCopy(assetId: string, visibility: AssetVisibility): Promise<boolean> {
    if (visibility === AssetVisibility.Locked) {
      return true;
    }
    const { locked, sensitive } = await this.partnerOriginRepository.getCopyBlockers(assetId);
    return locked || sensitive;
  }

  /**
   * The stored original a copy links to: the source's own `physical_file`, registered now if it has
   * none yet. INTEGRATION (storage-core file trash): a source whose original went to the file trash
   * must be taken back out of it here (`PhysicalFileTrashRepository.findByChecksum` + `untrash`) before
   * linking, never duplicated. This is the single call site to wire.
   */
  private resolvePhysicalOriginal(sourceAssetId: string) {
    return this.physicalFileRepository.ensureOriginalPhysicalFile(sourceAssetId);
  }

  /** Tags by name, reusing the library's own tag of that name (owner decision 2026-09-27). */
  private async copyTags(sourceAssetId: string, copyId: string, targetOwnerId: string) {
    const values = await this.getTagValues(sourceAssetId);
    const tags = values.length > 0 ? await upsertTags(this.tagRepository, { userId: targetOwnerId, tags: values }) : [];
    await this.tagRepository.replaceAssetTags(
      copyId,
      tags.map(({ id }) => id),
    );
  }

  protected async getTagValues(assetId: string): Promise<string[]> {
    const asset = await this.assetRepository.getById(assetId, { tags: true });
    return (asset?.tags ?? []).map(({ value }) => value);
  }

  /**
   * TASK 12 (partner-people-locked): copy the source's faces (exact boxes, `face_search` embeddings)
   * mapped to the target library's people. Faces are not copied until then.
   */
  protected copyFaces(_sourceAssetId: string, _copyId: string, _targetOwnerId: string): Promise<void> {
    return Promise.resolve();
  }

  /** The partners `ownerId` shares their library with. */
  private async getRecipients(ownerId: string): Promise<string[]> {
    const partners = await this.partnerRepository.getAll(ownerId);
    return partners
      .filter((partner) => partner.sharedById === ownerId && partner.sharedWithId !== ownerId)
      .map((partner) => partner.sharedWithId);
  }

  /** Queue copies of these assets of `ownerId`'s to everyone `ownerId` shares with. */
  private async queueOnward(ownerId: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }
    const recipients = await this.getRecipients(ownerId);
    const jobs: JobItem[] = recipients.flatMap((targetOwnerId) =>
      assetIds.map((sourceAssetId) => ({
        name: JobName.PartnerCopyAsset as const,
        data: { sourceAssetId, targetOwnerId, partnerSharedById: ownerId },
      })),
    );
    if (jobs.length > 0) {
      await this.jobRepository.queueAll(jobs);
    }
  }

  @OnJob({ name: JobName.PartnerCopyAsset, queue: QueueName.BackgroundTask })
  async handleCopyAsset({ sourceAssetId, targetOwnerId, partnerSharedById }: IPartnerCopyAssetJob): Promise<JobStatus> {
    // the partnership may have ended since the job was queued
    const partner = await this.partnerRepository.get({ sharedById: partnerSharedById, sharedWithId: targetOwnerId });
    if (!partner) {
      return JobStatus.Skipped;
    }
    const copyId = await this.copyAsset(sourceAssetId, targetOwnerId, partnerSharedById);
    if (!copyId) {
      return JobStatus.Skipped;
    }
    // A→B→C (spec §1): what B receives goes on to everyone B shares with
    await this.queueOnward(targetOwnerId, [copyId]);
    return JobStatus.Success;
  }

  /** Spec §4.6: a new item of a sharing user's is copied to every partner, once its metadata is read. */
  @OnEvent({ name: 'AssetMetadataExtracted', workers: [ImmichWorker.Microservices] })
  async onAssetMetadataExtracted({ assetId, userId }: ArgOf<'AssetMetadataExtracted'>) {
    await this.queueOnward(userId, [assetId]);
  }

  /**
   * Push a source's changed fields into each copy that still follows it, skipping every field the
   * copy's owner has changed, then on to the copies of those copies (A→B→C). Copies form a tree (each
   * has one source and the one-copy rule never revisits a library), so this always ends.
   */
  @OnJob({ name: JobName.PartnerPropagate, queue: QueueName.BackgroundTask })
  async handlePropagate({ kind, sourceId, fields }: IPartnerPropagateJob): Promise<JobStatus> {
    if (kind === 'album') {
      return this.propagateAlbum(sourceId, fields);
    }
    const followers = await this.partnerOriginRepository.getFollowers('asset', sourceId);
    const onward: JobItem[] = [];
    for (const follower of followers) {
      const apply = fields.filter((field) => !follower.overriddenFields.includes(field));
      if (apply.length === 0) {
        continue;
      }
      await this.partnerOriginRepository.applyAssetFields(sourceId, follower.id, apply);
      if (apply.includes(AssetOriginField.Tags)) {
        await this.copyTags(sourceId, follower.id, follower.ownerId);
      }
      onward.push({ name: JobName.PartnerPropagate, data: { kind, sourceId: follower.id, fields: apply } });
    }
    if (onward.length > 0) {
      await this.jobRepository.queueAll(onward);
    }
    return followers.length > 0 ? JobStatus.Success : JobStatus.Skipped;
  }

  /** Album propagation (Task 11). */
  protected propagateAlbum(_sourceId: string, _fields: string[]): Promise<JobStatus> {
    return Promise.resolve(JobStatus.Skipped);
  }

  @OnJob({ name: JobName.PartnerBackfill, queue: QueueName.BackgroundTask })
  async handleBackfill({ sharedById, sharedWithId }: IPartnerBackfillJob): Promise<JobStatus> {
    const backfill = await this.partnerOriginRepository.getBackfill(sharedById, sharedWithId);
    if (!backfill || backfill.state === PartnerBackfillState.Done || backfill.state === PartnerBackfillState.Stopped) {
      return JobStatus.Skipped;
    }
    const partner = await this.partnerRepository.get({ sharedById, sharedWithId });
    if (!partner) {
      await this.partnerOriginRepository.stopBackfill(sharedById, sharedWithId);
      return JobStatus.Skipped;
    }

    const ids = await this.partnerOriginRepository.getOwnerAssetIdsAfter(
      sharedById,
      backfill.cursor,
      this.backfillBatchSize,
    );
    const copies: string[] = [];
    for (const id of ids) {
      const copyId = await this.copyAsset(id, sharedWithId, sharedById);
      if (copyId) {
        copies.push(copyId);
      }
    }
    await this.queueOnward(sharedWithId, copies);

    const finished = ids.length < this.backfillBatchSize;
    if (finished) {
      await this.onAssetsBackfilled(sharedById, sharedWithId);
    }
    await this.partnerOriginRepository.advanceBackfill(sharedById, sharedWithId, {
      cursor: ids.at(-1) ?? null,
      processed: ids.length,
      state: finished ? PartnerBackfillState.Done : PartnerBackfillState.Running,
    });
    if (!finished) {
      await this.jobRepository.queue({ name: JobName.PartnerBackfill, data: { sharedById, sharedWithId } });
    }
    return JobStatus.Success;
  }

  /** After the assets: albums (Task 11), then people (Task 12). */
  protected onAssetsBackfilled(_sharedById: string, _sharedWithId: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Existing partnerships at upgrade (spec §4.7): each is backfilled once, after the universal-storage
   * migration is done. INTEGRATION (storage-migration): call this when that migration reaches `done`;
   * at boot it runs when the migration has nothing left to do.
   */
  async queueUpgradeBackfills(): Promise<number> {
    const partnerships = await this.partnerOriginRepository.getPartnershipsWithoutBackfill();
    for (const { sharedById, sharedWithId } of partnerships) {
      await startPartnerBackfill(
        { partnerOrigin: this.partnerOriginRepository, job: this.jobRepository },
        sharedById,
        sharedWithId,
      );
    }
    return partnerships.length;
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    if (!(await this.isStorageMigrationDone())) {
      return;
    }
    const queued = await this.queueUpgradeBackfills();
    if (queued > 0) {
      this.logger.log(`Queued the partner sharing backfill of ${queued} existing partnership(s)`);
    }
  }

  /**
   * INTEGRATION (storage-migration): whether the universal-storage migration is done. This branch has
   * no such migration, so there is nothing to wait for.
   */
  protected isStorageMigrationDone(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

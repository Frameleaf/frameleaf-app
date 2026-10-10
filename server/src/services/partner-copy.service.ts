import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type {
  IPartnerBackfillJob,
  IPartnerCopyAlbumJob,
  IPartnerCopyAssetJob,
  IPartnerPropagateJob,
  JobItem,
} from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  AlbumKind,
  AlbumUserRole,
  AssetFileType,
  AssetLockReason,
  AssetStatus,
  AssetVisibility,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
} from 'src/enum.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import {
  AlbumOriginField,
  AssetOriginField,
  PartnerBackfillState,
  PartnerOriginRepository,
} from 'src/repositories/partner-origin.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { PartnerLockService } from 'src/services/partner-lock.service.js';
import { PartnerPeopleService } from 'src/services/partner-people.service.js';
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

/** Edits that can lock or unlock an item: its lock itself, and the tags and faces Locked rules match. */
const LOCK_RELEVANT_FIELDS: string[] = [
  AssetOriginField.Visibility,
  AssetOriginField.Sensitive,
  AssetOriginField.Tags,
  AssetOriginField.Faces,
];

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

const TRACKED_ALBUM_FIELDS = new Set<string>(Object.values(AlbumOriginField));

/** The followed fields an album edit touches (spec §4.4). */
export const getAlbumEditFields = (dto: {
  albumName?: unknown;
  description?: unknown;
  albumThumbnailAssetId?: unknown;
}): AlbumOriginField[] => [
  ...(dto.albumName === undefined ? [] : [AlbumOriginField.Title]),
  ...(dto.description === undefined ? [] : [AlbumOriginField.Description]),
  ...(dto.albumThumbnailAssetId === undefined ? [] : [AlbumOriginField.Cover]),
];

/**
 * These fields of these albums were edited (spec §4.4, §4.6): on album copies the fields become the
 * copy's own, and every album copy that follows one of these albums receives the change.
 */
export const recordAlbumEdit = async (
  { partnerOrigin, job }: BackfillRepositories,
  albumIds: string[],
  fields: string[],
) => {
  const tracked = fields.filter((field) => TRACKED_ALBUM_FIELDS.has(field));
  if (tracked.length === 0 || albumIds.length === 0) {
    return;
  }
  // any member's edit of an album copy makes that field the copy's own (an album may have editors)
  await partnerOrigin.markOverridden('album', albumIds, tracked);
  const sources = await partnerOrigin.getIdsWithFollowers('album', albumIds);
  if (sources.length > 0) {
    await job.queueAll(
      sources.map((sourceId) => ({
        name: JobName.PartnerPropagate as const,
        data: { kind: 'album' as const, sourceId, fields: tracked },
      })),
    );
  }
};

/** A new album of `ownerId`'s goes to everyone they share with (spec §4.4, §4.6). */
export const queueAlbumCopies = async (
  { partner, job }: { partner: PartnerRepository; job: JobRepository },
  ownerId: string,
  albumId: string,
) => {
  const partners = await partner.getAll(ownerId);
  const recipients = partners
    .filter((row) => row.sharedById === ownerId && row.sharedWithId !== ownerId)
    .map((row) => row.sharedWithId);
  if (recipients.length > 0) {
    await job.queueAll(
      recipients.map((targetOwnerId) => ({
        name: JobName.PartnerCopyAlbum as const,
        data: { sourceAlbumId: albumId, targetOwnerId, partnerSharedById: ownerId },
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
   * that is the item's own or original owner, or an external-library or Hidden item. A Locked item is
   * copied locked, so only the recipient's own PIN shows it (spec §4.9, `PartnerLockService`).
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
    // and is copied with its still, never on its own
    if (source.libraryId || source.isExternal || source.isOffline || source.visibility === AssetVisibility.Hidden) {
      return;
    }

    const origin = await this.partnerOriginRepository.getOrigin('asset', source.id);
    const rootOwnerId = origin?.rootOwnerId ?? source.ownerId;
    if (rootOwnerId === targetOwnerId) {
      return;
    }

    const locks = BaseService.create(PartnerLockService, this);
    const lockInput = { sourceAssetId: source.id, sourceOwnerId: source.ownerId };
    if (await this.partnerOriginRepository.libraryHasChecksum(targetOwnerId, source.checksum)) {
      // a retry of a copy that failed part-way: its lock state is mirrored again (idempotent)
      await this.remirrorExistingCopy(source.id, source.ownerId, targetOwnerId);
      return;
    }

    // a copy the recipient deleted is never made again (its origin row outlives it)
    if (await this.partnerOriginRepository.hasEverCopied(source.id, targetOwnerId)) {
      return;
    }

    const original = await this.resolvePhysicalOriginal(source.id);
    if (!original) {
      this.logger.warn(`Partner copy of ${source.id} skipped: its original has no stored file to link`);
      return;
    }

    // spec §4.9: decided before the copy exists, so a Locked item's copy is never visible unlocked
    const lockReason = await locks.getCopyLockReason(lockInput);
    const copyId = await this.partnerOriginRepository.insertAssetCopy({
      sourceAssetId: source.id,
      ownerId: targetOwnerId,
      rootOwnerId,
      partnerSharedById,
      original: { id: original.id, path: original.path },
      lockReason,
    });
    if (!copyId) {
      return;
    }
    if (lockReason) {
      await locks.noteLockedCopy(targetOwnerId);
    }

    if (source.livePhotoVideoId) {
      const motionId = await this.copyMotionPart(
        source.livePhotoVideoId,
        targetOwnerId,
        rootOwnerId,
        partnerSharedById,
        lockReason,
      );
      if (motionId) {
        await this.assetRepository.update({ id: copyId, livePhotoVideoId: motionId });
      }
    }
    await this.copyTags(source.id, copyId, targetOwnerId);
    await this.copyFaces({ sourceAssetId: source.id, targetAssetId: copyId, targetOwnerId, partnerSharedById });
    // the source may have been locked or unlocked meanwhile
    await locks.mirrorLockedState({ ...lockInput, targetAssetId: copyId, targetOwnerId });
    // spec §4.4: an album copy whose membership still follows its source gains the new copy
    for (const albumId of await this.partnerOriginRepository.getFollowingAlbumCopiesHolding(source.id, targetOwnerId)) {
      await this.albumRepository.addAssetIds(albumId, [copyId]);
    }
    await this.ensureCopyThumbnails(copyId);
    return copyId;
  }

  /** Metadata can admit a copy before the source's derivatives have been published. */
  private async ensureCopyThumbnails(copyId: string) {
    const copy = await this.assetRepository.getById(copyId, { files: true });
    if (!copy || copy.deletedAt || copy.status !== AssetStatus.Active || copy.visibility === AssetVisibility.Hidden) {
      return;
    }
    if (
      [AssetFileType.Preview, AssetFileType.Thumbnail].some(
        (type) => !copy.files?.some((file) => file.type === type && !file.isEdited),
      )
    ) {
      await this.jobRepository.queue({ name: JobName.AssetGenerateThumbnails, data: { id: copyId } });
    }
  }

  /**
   * `targetOwnerId` already holds a copy of this source (a retried copy job, or a re-run): mirror its lock
   * state again while it follows the source's visibility, so a copy whose earlier attempt failed before
   * its lock was settled is never left visible.
   */
  private async remirrorExistingCopy(sourceAssetId: string, sourceOwnerId: string, targetOwnerId: string) {
    const copyId = await this.partnerOriginRepository.getCopyId('asset', sourceAssetId, targetOwnerId);
    if (!copyId) {
      return;
    }
    // Admission may have failed after the copy committed; replay repairs its missing derivatives.
    await this.ensureCopyThumbnails(copyId);
    const origin = await this.partnerOriginRepository.getOrigin('asset', copyId);
    if (!origin?.following || origin.overriddenFields.includes(AssetOriginField.Visibility)) {
      return;
    }
    await BaseService.create(PartnerLockService, this).mirrorLockedState({
      sourceAssetId,
      sourceOwnerId,
      targetAssetId: copyId,
      targetOwnerId,
    });
  }

  /**
   * The stored original a copy links to: the source's own `physical_file`, registered now if it has
   * none yet. ponytail: no file-trash lookup here, a copy's source is an active asset that still
   * references its original, so that original can never be in the file trash.
   */
  private resolvePhysicalOriginal(sourceAssetId: string) {
    return this.physicalFileRepository.ensureOriginalPhysicalFile(sourceAssetId);
  }

  /** A Live Photo's Hidden motion part, linked to the same stored file, for the still's copy to pair with. */
  private async copyMotionPart(
    motionAssetId: string,
    targetOwnerId: string,
    rootOwnerId: string,
    partnerSharedById: string,
    lockReason?: AssetLockReason,
  ): Promise<string | undefined> {
    const original = await this.resolvePhysicalOriginal(motionAssetId);
    if (!original) {
      return;
    }
    // both parts of a Live Photo lock as one
    return this.partnerOriginRepository.insertAssetCopy({
      sourceAssetId: motionAssetId,
      ownerId: targetOwnerId,
      rootOwnerId,
      partnerSharedById,
      original: { id: original.id, path: original.path },
      lockReason,
    });
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
   * Spec §4.5: the source's faces (exact boxes, `face_search` embeddings, no ML re-run), mapped to the
   * target library's people: auto-merged into a matching person of theirs, or a new person that follows.
   */
  protected async copyFaces(input: {
    sourceAssetId: string;
    targetAssetId: string;
    targetOwnerId: string;
    partnerSharedById: string;
  }): Promise<void> {
    await BaseService.create(PartnerPeopleService, this).copyFaces(input);
  }

  /**
   * Copy an album `partnerSharedById` shares into `targetOwnerId`'s library (spec §4.4): only a plain
   * album its owner owns (collections and shared spaces are not copied), never one the target already
   * sees as a member, never back to its original owner, and once per library per root album. The copy
   * holds the target's copies of the album's items and follows the source's title, description, cover
   * and membership.
   */
  async copyAlbum(
    sourceAlbumId: string,
    targetOwnerId: string,
    partnerSharedById: string,
  ): Promise<string | undefined> {
    const album = await this.partnerOriginRepository.getAlbumForCopy(sourceAlbumId);
    if (!album || album.deletedAt || album.kind !== AlbumKind.Album || album.ownerId === targetOwnerId) {
      return;
    }
    const origin = await this.partnerOriginRepository.getOrigin('album', album.id);
    const rootOwnerId = origin?.rootOwnerId ?? album.ownerId;
    if (rootOwnerId === targetOwnerId) {
      return;
    }
    if (await this.partnerOriginRepository.isAlbumMember(album.id, targetOwnerId)) {
      return;
    }
    if (await this.partnerOriginRepository.getCopyId('album', album.id, targetOwnerId)) {
      return;
    }
    // one copy per library per root album: another partner may already have passed this one on
    if (await this.partnerOriginRepository.hasAlbumCopyOfRoot(album.id, targetOwnerId)) {
      return;
    }
    if (!(await this.partnerRepository.get({ sharedById: partnerSharedById, sharedWithId: targetOwnerId }))) {
      return;
    }

    const assetIds = await this.partnerOriginRepository.getAlbumAssetCopyIds(album.id, targetOwnerId);
    const cover = album.albumThumbnailAssetId
      ? await this.partnerOriginRepository.getCopyId('asset', album.albumThumbnailAssetId, targetOwnerId)
      : undefined;
    const copy = await this.albumRepository.create(
      {
        albumName: album.albumName,
        description: album.description,
        order: album.order,
        albumThumbnailAssetId: cover ?? assetIds[0] ?? null,
        kind: AlbumKind.Album,
      },
      assetIds,
      [{ userId: targetOwnerId, role: AlbumUserRole.Owner }],
      targetOwnerId,
    );
    const recorded = await this.partnerOriginRepository.createAlbumOriginIfPartnered({
      id: copy.id,
      sourceId: album.id,
      ownerId: targetOwnerId,
      rootOwnerId,
      partnerSharedById,
    });
    if (!recorded) {
      // the partnership ended while the album was being copied: no copy is made for it
      await this.albumRepository.delete(copy.id);
      return;
    }
    return copy.id;
  }

  @OnJob({ name: JobName.PartnerCopyAlbum, queue: QueueName.BackgroundTask })
  async handleCopyAlbum({ sourceAlbumId, targetOwnerId, partnerSharedById }: IPartnerCopyAlbumJob): Promise<JobStatus> {
    const partner = await this.partnerRepository.get({ sharedById: partnerSharedById, sharedWithId: targetOwnerId });
    if (!partner) {
      return JobStatus.Skipped;
    }
    const copyId = await this.copyAlbum(sourceAlbumId, targetOwnerId, partnerSharedById);
    if (!copyId) {
      return JobStatus.Skipped;
    }
    // A→B→C: B's copy goes on to everyone B shares with
    await queueAlbumCopies({ partner: this.partnerRepository, job: this.jobRepository }, targetOwnerId, copyId);
    return JobStatus.Success;
  }

  /** Bring one album copy's items in line with its source's (only while membership is followed). */
  private async syncAlbumMembership(sourceAlbumId: string, copyAlbumId: string, ownerId: string) {
    const desired = new Set(await this.partnerOriginRepository.getAlbumAssetCopyIds(sourceAlbumId, ownerId));
    const current = new Set(await this.partnerOriginRepository.getAlbumAssetIds(copyAlbumId));
    const added = [...desired.difference(current)];
    const removed = [...current.difference(desired)];
    if (added.length > 0) {
      await this.albumRepository.addAssetIds(copyAlbumId, added);
    }
    if (removed.length > 0) {
      await this.albumRepository.removeAssetIds(copyAlbumId, removed);
    }
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

  /**
   * Spec §4.9: a lock made anywhere (the owner, a sensitive detection, a stack or iCloud) reaches the
   * copies that still follow the item's visibility. Only propagated, never recorded as the owner's edit.
   */
  @OnEvent({ name: 'AssetLocked' })
  async onAssetLocked({ assetIds }: ArgOf<'AssetLocked'>) {
    const sources = await this.partnerOriginRepository.getIdsWithFollowers('asset', assetIds);
    if (sources.length > 0) {
      await this.jobRepository.queueAll(
        sources.map((sourceId) => ({
          name: JobName.PartnerPropagate as const,
          data: { kind: 'asset' as const, sourceId, fields: [AssetOriginField.Visibility] },
        })),
      );
    }
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
      if (apply.includes(AssetOriginField.Faces)) {
        await this.personRepository.deleteFacesOfAsset(follower.id);
        await this.copyFaces({
          sourceAssetId: sourceId,
          targetAssetId: follower.id,
          targetOwnerId: follower.ownerId,
          partnerSharedById: follower.partnerSharedById,
        });
      }
      // spec §4.9: a lock or unlock carries over while the copy's visibility is followed, including one a
      // tag or face edit causes by bringing the source under (or out of) the sharer's Locked rules
      if (
        !follower.overriddenFields.includes(AssetOriginField.Visibility) &&
        LOCK_RELEVANT_FIELDS.some((field) => apply.includes(field))
      ) {
        await BaseService.create(PartnerLockService, this).mirrorLockedState({
          sourceAssetId: sourceId,
          sourceOwnerId: follower.partnerSharedById,
          targetAssetId: follower.id,
          targetOwnerId: follower.ownerId,
        });
      }
      onward.push({ name: JobName.PartnerPropagate, data: { kind, sourceId: follower.id, fields: apply } });
    }
    if (onward.length > 0) {
      await this.jobRepository.queueAll(onward);
    }
    return followers.length > 0 ? JobStatus.Success : JobStatus.Skipped;
  }

  /** Album propagation (spec §4.4): title, description, cover and membership, each until changed. */
  private async propagateAlbum(sourceId: string, fields: string[]): Promise<JobStatus> {
    const followers = await this.partnerOriginRepository.getFollowers('album', sourceId);
    if (followers.length === 0) {
      return JobStatus.Skipped;
    }
    const source = await this.partnerOriginRepository.getAlbumForCopy(sourceId);
    if (!source) {
      return JobStatus.Skipped;
    }
    const onward: JobItem[] = [];
    for (const follower of followers) {
      const apply = fields.filter((field) => !follower.overriddenFields.includes(field));
      if (apply.length === 0) {
        continue;
      }
      if (apply.includes(AlbumOriginField.Membership)) {
        await this.syncAlbumMembership(sourceId, follower.id, follower.ownerId);
      }
      const cover =
        apply.includes(AlbumOriginField.Cover) && source.albumThumbnailAssetId
          ? await this.partnerOriginRepository.getCopyId('asset', source.albumThumbnailAssetId, follower.ownerId)
          : undefined;
      const update = {
        ...(apply.includes(AlbumOriginField.Title) && { albumName: source.albumName }),
        ...(apply.includes(AlbumOriginField.Description) && { description: source.description }),
        ...(cover && { albumThumbnailAssetId: cover }),
      };
      if (Object.keys(update).length > 0) {
        await this.albumRepository.update(follower.id, { id: follower.id, ...update }, follower.ownerId);
      }
      onward.push({ name: JobName.PartnerPropagate, data: { kind: 'album', sourceId: follower.id, fields: apply } });
    }
    if (onward.length > 0) {
      await this.jobRepository.queueAll(onward);
    }
    return JobStatus.Success;
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

  /**
   * After the assets: albums (spec §4.7). People need no step of their own: each copied face was mapped to
   * the recipient's people as it was copied (`copyFaces`, spec §4.5).
   */
  protected async onAssetsBackfilled(sharedById: string, sharedWithId: string): Promise<void> {
    for (const albumId of await this.partnerOriginRepository.getOwnedAlbumIds(sharedById)) {
      const copyId = await this.copyAlbum(albumId, sharedWithId, sharedById);
      if (copyId) {
        await queueAlbumCopies({ partner: this.partnerRepository, job: this.jobRepository }, sharedWithId, copyId);
      }
    }
  }
}

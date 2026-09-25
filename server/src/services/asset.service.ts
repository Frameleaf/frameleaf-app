import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isUndefined, omitBy } from 'lodash-es';
import { DateTime, Duration } from 'luxon';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobItem, JobOf } from 'src/types.js';
import { AssetFile, placeProperties } from 'src/database.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AssetResponseDto, SanitizedAssetResponseDto, mapAsset } from 'src/dtos/asset-response.dto.js';
import {
  AssetBulkDeleteDto,
  AssetBulkUpdateDto,
  AssetCopyDto,
  AssetJobName,
  AssetJobsDto,
  AssetMetadataBulkDeleteDto,
  AssetMetadataBulkResponseDto,
  AssetMetadataBulkUpsertDto,
  AssetMetadataResponseDto,
  AssetMetadataUpsertDto,
  AssetStatsDto,
  UpdateAssetDto,
  mapStats,
} from 'src/dtos/asset.dto.js';
import {
  AssetEditAction,
  AssetEditActionItem,
  AssetEditsCreateDto,
  AssetEditsResponseDto,
  VideoEditVersionResponseDto,
} from 'src/dtos/editing.dto.js';
import { AssetOcrResponseDto } from 'src/dtos/ocr.dto.js';
import {
  AssetFileType,
  AssetLockReason,
  AssetMetadataKey,
  AssetStatus,
  AssetType,
  AssetVisibility,
  JobName,
  JobStatus,
  Permission,
  QueueName,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { requireElevatedPermission } from 'src/utils/access.js';
import {
  getAssetFiles,
  getDimensions,
  isPanorama,
  onAfterUnlink,
  onBeforeLink,
  onBeforeUnlink,
} from 'src/utils/asset.util.js';
import { updateLockedColumns } from 'src/utils/database.js';
import { extractTimeZone } from 'src/utils/date.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { batched, findOrFail, isNsfwHidingEnabled } from 'src/utils/misc.js';
import { deriveIsNsfwFromMetadata } from 'src/utils/nsfw.js';
import { applyAlbumLocationPolicy, applyPartnerLocationPolicy } from 'src/utils/partner-location.js';
import { transformOcrBoundingBox } from 'src/utils/transform.js';

const imageEditActions = new Set<AssetEditAction>([
  AssetEditAction.Crop,
  AssetEditAction.Rotate,
  AssetEditAction.Mirror,
]);

const videoEditActions = new Set<AssetEditAction>([
  ...imageEditActions,
  AssetEditAction.Trim,
  AssetEditAction.Straighten,
  AssetEditAction.Adjust,
  AssetEditAction.Filter,
  AssetEditAction.Effect,
  AssetEditAction.AutoEnhance,
  AssetEditAction.Stabilize,
  AssetEditAction.TextOverlay,
  AssetEditAction.Audio,
  AssetEditAction.Speed,
]);

const getDurationMs = (duration: number | null | undefined) => {
  const value = Number(duration);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const getAssetDateTimeUpdates = (dateTimeOriginal?: string) => {
  if (!dateTimeOriginal) {
    return {};
  }

  const dateTime = DateTime.fromISO(dateTimeOriginal, { setZone: true, zone: 'UTC' });
  if (!dateTime.isValid) {
    return {};
  }

  return {
    fileCreatedAt: dateTime.toUTC().toJSDate(),
    localDateTime: dateTime.setZone('UTC', { keepLocalTime: true }).toJSDate(),
  };
};

const videoVersionErrors: Record<string, string> = {
  video_version_inactive: 'Video version history is unavailable while fork writes are disabled',
  video_version_handoff: 'Video version history is locked while a schema handoff is running',
  video_version_not_ready: 'The current video version is not ready to export',
  video_version_selected_or_missing: 'Only an unselected saved video version can be pruned',
  video_version_source_changed: 'The original video changed after this version was saved',
};

/** Repository refusals for retained video versions are client errors, not server faults. */
const withVideoVersionErrors = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'video_version_not_found') {
      throw new NotFoundException('Video version is unavailable');
    }
    if (code in videoVersionErrors) {
      throw new BadRequestException(videoVersionErrors[code]);
    }
    throw error;
  }
};

@Injectable()
export class AssetService extends BaseService {
  async getStatistics(auth: AuthDto, dto: AssetStatsDto) {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const stats = await this.assetRepository.getStatistics(auth.user.id, {
      ...dto,
      ...getHiddenContentQueryOptions(auth),
    });
    return mapStats(stats);
  }

  async get(auth: AuthDto, id: string): Promise<AssetResponseDto | SanitizedAssetResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });

    const asset = await this.assetRepository.getById(id, {
      exifInfo: true,
      owner: true,
      faces: { person: true, viewingUserId: auth.user.id },
      // a stack led by Locked media stays off the asset unless it is the viewer's own and unlocked
      stack: { assets: true, ...getLockedVisibilityOptions(auth) },
      edits: true,
      tags: true,
    });

    if (!asset) {
      throw new BadRequestException('Asset not found');
    }

    if (auth.hideNsfwAssets && asset.livePhotoVideoId) {
      const nsfwMotionAssetIds = await this.assetRepository.getHiddenContentAssetIds(
        [asset.livePhotoVideoId],
        getHiddenContentQueryOptions(auth),
      );
      if (nsfwMotionAssetIds.has(asset.livePhotoVideoId)) {
        asset.livePhotoVideoId = null;
      }
    }

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      return mapAsset(asset, { stripMetadata: true, withStack: true, auth });
    }

    // a sharer who hides locations from this viewer never hands over coordinates or place names
    const locationOptions = { userId: auth.user.id, repository: this.partnerRepository };
    const [data] = await applyAlbumLocationPolicy(
      await applyPartnerLocationPolicy([mapAsset(asset, { withStack: true, auth })], locationOptions),
      locationOptions,
    );

    if (auth.sharedLink) {
      delete data.owner;
    }

    if (auth.sharedLink) {
      data.people = [];
    }

    return data;
  }

  async update(auth: AuthDto, id: string, dto: UpdateAssetDto): Promise<AssetResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id] });

    const { description, dateTimeOriginal, latitude, longitude, rating, visibility, city, state, country, ...rest } =
      dto;
    const repos = { asset: this.assetRepository, event: this.eventRepository };

    let previousMotion: { id: string } | null = null;
    if (rest.livePhotoVideoId) {
      await onBeforeLink(repos, { userId: auth.user.id, livePhotoVideoId: rest.livePhotoVideoId });
    } else if (rest.livePhotoVideoId === null) {
      const asset = await this.findOrFail(id);
      if (asset.livePhotoVideoId) {
        previousMotion = await onBeforeUnlink(repos, { livePhotoVideoId: asset.livePhotoVideoId });
      }
    }

    await this.updateExif({ id, description, dateTimeOriginal, latitude, longitude, rating, city, state, country });

    const storedVisibility = await this.applyLockedVisibility(auth, [id], visibility);
    const asset = await this.assetRepository.update({
      id,
      ...getAssetDateTimeUpdates(dateTimeOriginal),
      ...rest,
      ...(storedVisibility && { visibility: storedVisibility }),
    });

    if (previousMotion && asset) {
      await onAfterUnlink(repos, {
        userId: auth.user.id,
        livePhotoVideoId: previousMotion.id,
        visibility: asset.visibility,
      });
    }

    if (!asset) {
      throw new BadRequestException('Asset not found');
    }

    // A visibility change that locks or unlocks a whole stack also changes the siblings `id` never
    // mentions (FL-34, FL-53); push the same real-time update to `id` and to every one of them, so every
    // open session reflects the move at once.
    if (visibility !== undefined) {
      const siblingIds = asset.stackId ? ((await this.assetRepository.getStackSiblingIds([id])) ?? []) : [];
      await this.notifyAssetsUpdated([id, ...siblingIds], auth.user.id);
    }

    // Locking needs no PIN, but a session without it can no longer read what it just locked (FL-34):
    // answer from the updated row instead of refusing a change that was made.
    if (visibility === AssetVisibility.Locked && !auth.session?.hasElevatedPermission) {
      return mapAsset({ ...asset, isLocked: true }, { auth });
    }

    return this.get(auth, id) as Promise<AssetResponseDto>;
  }

  async updateAll(auth: AuthDto, dto: AssetBulkUpdateDto): Promise<void> {
    const {
      ids,
      isFavorite,
      visibility,
      dateTimeOriginal,
      latitude,
      longitude,
      rating,
      description,
      duplicateId,
      dateTimeRelative,
      timeZone,
    } = dto;
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids });

    const storedVisibility = await this.applyLockedVisibility(auth, ids, visibility);
    const assetDto = omitBy(
      { isFavorite, visibility: storedVisibility, duplicateId, ...getAssetDateTimeUpdates(dateTimeOriginal) },
      isUndefined,
    );
    const exifDto = omitBy(
      {
        latitude,
        longitude,
        rating,
        description,
        dateTimeOriginal,
      },
      isUndefined,
    );

    // FL-36 (V-24): moving items releases their typed place names, as a single edit does
    // (`updateExif`), so reverse geocoding names the new spot instead of keeping the old place.
    const moved = latitude !== undefined || longitude !== undefined;
    if (Object.keys(exifDto).length > 0) {
      await this.assetRepository.updateAllExif(ids, exifDto, moved ? [...placeProperties] : []);
    }

    const extractedTimeZone = extractTimeZone(dateTimeOriginal);

    const updatedDateTimes =
      (dateTimeRelative !== undefined && dateTimeRelative !== 0) ||
      timeZone !== undefined ||
      extractedTimeZone?.type === 'fixed'
        ? await this.assetRepository.updateDateTimeOriginal(ids, dateTimeRelative, timeZone ?? extractedTimeZone?.name)
        : [];

    for (const { assetId, dateTimeOriginal } of updatedDateTimes) {
      await this.assetRepository.update({ id: assetId, ...getAssetDateTimeUpdates(dateTimeOriginal?.toISOString()) });
    }

    if (Object.keys(assetDto).length > 0) {
      await this.assetRepository.updateAll(ids, assetDto);
    }

    // A lock or unlock carries whole stacks along (FL-34, FL-53), including siblings `ids` never names;
    // push the same real-time update to `ids` and to every one of them, so every open session reflects
    // the change at once.
    if (visibility !== undefined) {
      const siblingIds = (await this.assetRepository.getStackSiblingIds(ids)) ?? [];
      await this.notifyAssetsUpdated([...ids, ...siblingIds], auth.user.id);
    }

    // Locking keeps album membership (owner decision, September 22, 2026): the asset stays in its albums
    // and every album read hides it from everyone but its owner's elevated session, so it is back in
    // place once unlocked. Upstream removed it from all albums when it moved into the Locked folder.

    await this.jobRepository.queueAll(ids.map((id) => ({ name: JobName.SidecarWrite, data: { id } })));
  }

  /**
   * Assets locked outside this service (FL-34: the iCloud reconciler locking Apple Hidden photos) get
   * the same follow-up as a lock made here, once that lock has committed.
   */
  @OnEvent({ name: 'AssetLockAll' })
  async onAssetLockAll({ assetIds, userId }: ArgOf<'AssetLockAll'>): Promise<void> {
    await this.afterAssetsLocked(assetIds);
    await this.notifyAssetsUpdated(assetIds, userId);
  }

  /**
   * Push assets whose visibility a transactional archive changed outside `updateAll` (FL-32), with
   * their stack siblings, to the owner's open sessions, the same real-time update `updateAll` sends.
   */
  async notifyVisibilityChanged(ids: string[], ownerId: string): Promise<void> {
    const siblingIds = (await this.assetRepository.getStackSiblingIds(ids)) ?? [];
    await this.notifyAssetsUpdated([...new Set([...ids, ...siblingIds])], ownerId);
  }

  /**
   * Lock (FL-34): the owner's own lock, recorded as `marked`. A lock is metadata: the assets keep their
   * albums, favourites, tags, faces and stored visibility, and every read except the owner's elevated
   * session stops showing them. Stacks and live photos lock as a whole. No elevated session is needed
   * to lock: it only hides.
   */
  async lock(auth: AuthDto, dto: BulkIdsDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: dto.ids });
    await this.lockAssets(auth, dto.ids, AssetLockReason.Marked);
  }

  /**
   * `visibility: locked` in a request (older clients, the upstream "Move to Locked folder") is a lock
   * record, never a stored visibility (FL-34). Any other visibility is stored as asked and never unlocks:
   * a locked asset stays locked, whatever its stored visibility, until its owner unlocks it through
   * `POST /assets/unlock` from an unlocked session. Returns the visibility to store, if any.
   */
  private async applyLockedVisibility(
    auth: AuthDto,
    ids: string[],
    visibility?: AssetVisibility,
  ): Promise<AssetVisibility | undefined> {
    if (visibility === undefined) {
      return undefined;
    }

    if (visibility === AssetVisibility.Locked) {
      // `update` and `updateAll` push the final state of `ids` (and their stacks) once they are done
      await this.lockAssets(auth, ids, AssetLockReason.Marked, { pushedByCaller: ids });
      return undefined;
    }

    // Never an unlock (FL-34): only `POST /assets/unlock` removes a lock, from an unlocked session,
    // recording the owner's review. Any other visibility is stored and the lock, if any, stays.
    return visibility;
  }

  /**
   * Locks and follows up (FL-34, FL-53): every cover, featured photo and face thumbnail the newly locked
   * assets were is released in the lock's transaction; the people whose featured face moved get a new
   * thumbnail, and a profile picture copied from one of the photos is replaced.
   */
  private async lockAssets(
    auth: AuthDto,
    ids: string[],
    reason: AssetLockReason,
    { pushedByCaller = [] }: { pushedByCaller?: string[] } = {},
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const locked = await this.assetRepository.lock(ids, reason, auth.user.id);
    if (locked.length > 0) {
      await this.afterAssetsLocked(locked);
      // everything the lock carried along (stack siblings, live photo parts), not what the caller pushes
      const pushed = new Set(pushedByCaller);
      await this.notifyAssetsUpdated(
        locked.filter((id) => !pushed.has(id)),
        auth.user.id,
      );
    }
  }

  /**
   * A sensitive verdict written through the metadata API locks the asset like the detector's own
   * (FL-34): an owner's review marking it sensitive is their lock (`marked`); a detection result locks
   * it as `detected` when "hide sensitive detections" is on. Nothing is ever unlocked here.
   */
  private async lockSensitiveMetadata(auth: AuthDto, items: { assetId: string; key: string; value: unknown }[]) {
    const marked: string[] = [];
    const detected: string[] = [];
    for (const { assetId, key, value } of items) {
      if (key !== AssetMetadataKey.MlEnrichment || deriveIsNsfwFromMetadata(value) !== true) {
        continue;
      }

      const review = (value as { nsfwDetection?: { review?: { isNsfw?: unknown } } }).nsfwDetection?.review;
      if (review?.isNsfw === true) {
        marked.push(assetId);
      } else if (!review) {
        detected.push(assetId);
      }
    }

    await this.lockAssets(auth, marked, AssetLockReason.Marked);
    if (detected.length > 0) {
      const { machineLearning } = await this.getConfig({ withCache: true });
      if (isNsfwHidingEnabled(machineLearning)) {
        const locked = await this.assetRepository.lock(detected, AssetLockReason.Detected, null);
        if (locked.length > 0) {
          await this.afterAssetsLocked(locked);
        }
      }
    }
  }

  /**
   * Shift capture dates by a number of minutes from recorded starting dates (FL-32).
   *
   * `updateAll` with `dateTimeRelative` adds to whatever the date is now, so sending it twice moves
   * an item twice. This sets each item to `from + minutes` instead and otherwise follows the same
   * steps — the capture date and its lock, then the asset's own dates, then the sidecar — so it ends
   * in the same place, and sending it again changes nothing. The durable bulk runner records `from`
   * before a batch is first sent, which is what makes an interrupted or retried shift safe.
   */
  async shiftDateTimeOriginalFrom(auth: AuthDto, items: { id: string; from: Date }[], minutes: number): Promise<void> {
    const ids = items.map(({ id }) => id);
    if (ids.length === 0) {
      return;
    }

    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids });

    for (const { id, from } of items) {
      const updated = await this.assetRepository.setDateTimeOriginal(id, new Date(from.getTime() + minutes * 60_000));
      if (updated) {
        await this.assetRepository.update({ id, ...getAssetDateTimeUpdates(updated.dateTimeOriginal?.toISOString()) });
      }
    }

    await this.jobRepository.queueAll(ids.map((id) => ({ name: JobName.SidecarWrite, data: { id } })));
  }

  async copy(
    auth: AuthDto,
    {
      sourceId,
      targetId,
      albums = true,
      sidecar = true,
      sharedLinks = true,
      stack = true,
      favorite = true,
    }: AssetCopyDto,
  ) {
    await this.requireAccess({ auth, permission: Permission.AssetCopy, ids: [sourceId, targetId] });
    const sourceAsset = await this.assetRepository.getForCopy(sourceId);
    const targetAsset = await this.assetRepository.getForCopy(targetId);

    if (!sourceAsset || !targetAsset) {
      throw new BadRequestException('Both assets must exist');
    }

    if (sourceId === targetId) {
      throw new BadRequestException('Source and target id must be distinct');
    }

    if (albums) {
      await this.albumRepository.copyAlbums({ sourceAssetId: sourceId, targetAssetId: targetId });
    }

    if (sharedLinks) {
      await this.sharedLinkAssetRepository.copySharedLinks({ sourceAssetId: sourceId, targetAssetId: targetId });
    }

    if (stack) {
      await this.copyStack({ sourceAsset, targetAsset });
    }

    if (favorite) {
      await this.assetRepository.update({ id: targetId, isFavorite: sourceAsset.isFavorite });
    }

    if (sidecar) {
      await this.copySidecar({ sourceAsset, targetAsset });
    }
  }

  private async copyStack({
    sourceAsset,
    targetAsset,
  }: {
    sourceAsset: { id: string; stackId: string | null };
    targetAsset: { id: string; stackId: string | null };
  }) {
    if (!sourceAsset.stackId) {
      return;
    }

    if (targetAsset.stackId) {
      await this.stackRepository.merge({ sourceId: sourceAsset.stackId, targetId: targetAsset.stackId });
      await this.stackRepository.delete(sourceAsset.stackId);
    } else {
      await this.assetRepository.update({ id: targetAsset.id, stackId: sourceAsset.stackId });
    }
  }

  private async copySidecar({
    sourceAsset,
    targetAsset,
  }: {
    sourceAsset: { files: AssetFile[] };
    targetAsset: { id: string; files: AssetFile[]; originalPath: string };
  }) {
    const { sidecarFile: sourceFile } = getAssetFiles(sourceAsset.files);
    if (!sourceFile?.path) {
      return;
    }

    const { sidecarFile: targetFile } = getAssetFiles(targetAsset.files ?? []);
    if (targetFile?.path) {
      await this.storageRepository.unlink(targetFile.path);
    }

    await this.storageRepository.copyFile(sourceFile.path, `${targetAsset.originalPath}.xmp`);
    await this.assetRepository.upsertFile({
      assetId: targetAsset.id,
      path: `${targetAsset.originalPath}.xmp`,
      type: AssetFileType.Sidecar,
    });
    await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: targetAsset.id } });
  }

  @OnJob({ name: JobName.AssetDeleteCheck, queue: QueueName.BackgroundTask })
  async handleAssetDeletionCheck(): Promise<JobStatus> {
    const config = await this.getConfig({ withCache: false });
    const trashedDays = config.trash.enabled ? config.trash.days : 0;
    const trashedBefore = DateTime.now()
      .minus(Duration.fromObject({ days: trashedDays }))
      .toJSDate();

    for await (const assets of batched(this.assetJobRepository.streamForDeletedJob(trashedBefore))) {
      await this.jobRepository.queueAll(
        assets.map(({ id, isOffline }) => ({ name: JobName.AssetDelete, data: { id, deleteOnDisk: !isOffline } })),
      );
    }

    // FL-39: video versions whose asset is gone (left behind while fork writes were disabled, or
    // archived by a handoff return) release their files here.
    const orphanedVersionPaths = await this.assetEditRepository.releaseOrphanedVideoVersions();
    if (orphanedVersionPaths.length > 0) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: orphanedVersionPaths } });
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetDelete, queue: QueueName.BackgroundTask })
  async handleAssetDeletion(job: JobOf<JobName.AssetDelete>): Promise<JobStatus> {
    const { id, deleteOnDisk } = job;

    const asset = await this.assetJobRepository.getForAssetDeletion(id);

    if (!asset) {
      return JobStatus.Failed;
    }

    // FL-71: a failed deletion can be retried long after it was queued. Only an asset that is still in
    // the trash (or force-deleted) goes, or a live photo's hidden motion part that no photo uses any
    // more; one restored since is kept.
    if (!asset.deletedAt && !(await this.isOrphanedMotionPart(asset))) {
      this.logger.warn(`Skipped deleting asset ${id}: it is no longer in the trash`);
      return JobStatus.Skipped;
    }

    if (asset.stack) {
      // asset.stack.assets only includes timeline visible assets and excludes the primary asset
      const remainingStackAssetIds = asset.stack.assets.map((a) => a.id).filter((assetId) => assetId !== id);

      // the primary survives unless it is the asset being deleted
      let remainingCount = remainingStackAssetIds.length;
      if (asset.stack.primaryAssetId !== id) {
        remainingCount++;
      }

      if (remainingCount < 2) {
        // 0 or 1 asset would remain: dissolve the stack so it does not linger as a single-asset stack
        await this.stackRepository.delete(asset.stack.id);
      } else if (asset.stack.primaryAssetId === id) {
        // the primary is being deleted but others remain: promote a new primary
        await this.stackRepository.update(asset.stack.id, {
          id: asset.stack.id,
          primaryAssetId: remainingStackAssetIds[0],
        });
      }
    }

    const videoDuplicateFrameFiles = await this.duplicateRepository.getVideoDuplicateFrames([id]);

    const removedAsset = await this.assetRepository.remove(asset);
    if (!removedAsset) {
      return JobStatus.Failed;
    }
    if (!asset.libraryId) {
      await this.userRepository.updateUsage(asset.ownerId, -(asset.exifInfo?.fileSizeInByte || 0));
    }

    await this.eventRepository.emit('AssetDelete', { assetId: id, userId: asset.ownerId });

    // delete the motion if it is not used by another asset
    if (asset.livePhotoVideoId) {
      const count = await this.assetRepository.getLivePhotoCount(asset.livePhotoVideoId);
      if (count === 0) {
        await this.jobRepository.queue({
          name: JobName.AssetDelete,
          data: { id: asset.livePhotoVideoId, deleteOnDisk },
        });
      }
    }

    const assetFiles = getAssetFiles(asset.files ?? []);
    const files = [
      assetFiles.thumbnailFile?.path,
      assetFiles.previewFile?.path,
      assetFiles.fullsizeFile?.path,
      assetFiles.editedFullsizeFile?.path,
      assetFiles.editedPreviewFile?.path,
      assetFiles.editedThumbnailFile?.path,
      assetFiles.encodedVideoFile?.path,
      ...videoDuplicateFrameFiles.map(({ path }) => path),
      ...(removedAsset.videoEditPaths ?? []),
    ];

    // FL-78: an external library item only references its original, which stays in the library's
    // folder whatever happens to the item; its sidecar there is the owner's too. Generated files
    // above are Frameleaf's own and go either way.
    if (deleteOnDisk && !asset.isOffline && !asset.libraryId) {
      files.push(
        assetFiles.sidecarFile?.path,
        removedAsset.originalPath,
        removedAsset.reservationTemporaryPath ?? undefined,
      );
    }

    await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: files.filter(Boolean) } });

    return JobStatus.Success;
  }

  private async isOrphanedMotionPart(asset: { id: string; visibility: AssetVisibility }) {
    return (
      asset.visibility === AssetVisibility.Hidden && (await this.assetRepository.getLivePhotoCount(asset.id)) === 0
    );
  }

  async deleteAll(auth: AuthDto, dto: AssetBulkDeleteDto): Promise<void> {
    const { ids, force } = dto;

    await this.requireAccess({ auth, permission: Permission.AssetDelete, ids });
    await this.assetRepository.updateAll(ids, {
      deletedAt: new Date(),
      status: force ? AssetStatus.Deleted : AssetStatus.Trashed,
    });
    await this.eventRepository.emit(force ? 'AssetDeleteAll' : 'AssetTrashAll', {
      assetIds: ids,
      userId: auth.user.id,
    });
  }

  async getMetadata(auth: AuthDto, id: string): Promise<AssetMetadataResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    return this.assetRepository.getMetadata(id);
  }

  async getOcr(auth: AuthDto, id: string): Promise<AssetOcrResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    const ocr = await this.ocrRepository.getByAssetId(id);
    const asset = await this.assetRepository.getForOcr(id);

    if (!asset) {
      throw new BadRequestException('Asset not found');
    }

    const dimensions = getDimensions({
      exifImageHeight: asset.exifImageHeight,
      exifImageWidth: asset.exifImageWidth,
      orientation: asset.orientation,
    });

    return ocr.map((item) => transformOcrBoundingBox(item, asset.edits, dimensions));
  }

  async upsertBulkMetadata(auth: AuthDto, dto: AssetMetadataBulkUpsertDto): Promise<AssetMetadataBulkResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: dto.items.map((item) => item.assetId) });

    const uniqueKeys = new Set<string>();
    for (const item of dto.items) {
      const key = `(${item.assetId}, ${item.key})`;
      if (uniqueKeys.has(key)) {
        throw new BadRequestException(`Duplicate items are not allowed: "${key}"`);
      }

      uniqueKeys.add(key);
    }

    // The repository centralizes the asset.is_nsfw denormalization sync for
    // 'ml-enrichment' items, so a malicious or curious user who writes
    // 'ml-enrichment' here cannot leave the boolean column out of sync with
    // the JSONB. See AssetRepository.syncIsNsfwForItems.
    const result = await this.assetRepository.upsertBulkMetadata(dto.items);
    await this.lockSensitiveMetadata(auth, dto.items);
    return result;
  }

  async upsertMetadata(auth: AuthDto, id: string, dto: AssetMetadataUpsertDto): Promise<AssetMetadataResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id] });

    const uniqueKeys = new Set<string>();
    for (const { key } of dto.items) {
      if (uniqueKeys.has(key)) {
        throw new BadRequestException(`Duplicate items are not allowed: "${key}"`);
      }

      uniqueKeys.add(key);
    }

    // See `upsertBulkMetadata` — the repository handles the asset.is_nsfw
    // sync for any 'ml-enrichment' items in the payload.
    const result = await this.assetRepository.upsertMetadata(id, dto.items);
    await this.lockSensitiveMetadata(
      auth,
      dto.items.map((item) => ({ assetId: id, ...item })),
    );
    return result;
  }

  async getMetadataByKey(auth: AuthDto, id: string, key: string): Promise<AssetMetadataResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });

    const item = await this.assetRepository.getMetadataByKey(id, key);
    if (!item) {
      throw new BadRequestException(`Metadata with key "${key}" not found for asset with id "${id}"`);
    }
    return item;
  }

  async deleteMetadataByKey(auth: AuthDto, id: string, key: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id] });
    await this.assetRepository.deleteMetadataByKey(id, key);
  }

  async deleteBulkMetadata(auth: AuthDto, dto: AssetMetadataBulkDeleteDto) {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: dto.items.map((item) => item.assetId) });
    await this.assetRepository.deleteBulkMetadata(dto.items);
  }

  async run(auth: AuthDto, dto: AssetJobsDto) {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: dto.assetIds });

    const jobs: JobItem[] = [];

    for (const id of dto.assetIds) {
      switch (dto.name) {
        case AssetJobName.REFRESH_FACES: {
          jobs.push({ name: JobName.AssetDetectFaces, data: { id } });
          break;
        }

        case AssetJobName.REFRESH_METADATA: {
          jobs.push({ name: JobName.AssetExtractMetadata, data: { id } });
          break;
        }

        case AssetJobName.REFRESH_OCR: {
          // FL-63: the same text recognition job the library runs; it admits the request only against
          // the destination routed for text recognition (FL-110) and never picks another one
          jobs.push({ name: JobName.Ocr, data: { id } });
          break;
        }

        case AssetJobName.REGENERATE_THUMBNAIL: {
          jobs.push({ name: JobName.AssetGenerateThumbnails, data: { id } });
          break;
        }

        case AssetJobName.TRANSCODE_VIDEO: {
          jobs.push({ name: JobName.AssetEncodeVideo, data: { id } });
          break;
        }
      }
    }

    await this.jobRepository.queueAll(jobs);
  }

  private findOrFail(id: string) {
    return findOrFail(() => this.assetRepository.getById(id), 'Asset');
  }

  private async updateExif(dto: {
    id: string;
    description?: string;
    dateTimeOriginal?: string;
    latitude?: number;
    longitude?: number;
    rating?: number | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
  }) {
    const { id, description, dateTimeOriginal, latitude, longitude, rating } = dto;
    // FL-36 (V-24): a typed place name is stored as typed (an empty one clears it) and locked, so
    // reverse geocoding keeps it; moving the item without naming its place lets geocoding name it again.
    const place = omitBy(
      {
        city: this.placeName(dto.city),
        state: this.placeName(dto.state),
        country: this.placeName(dto.country),
      },
      isUndefined,
    );
    const writes = omitBy(
      {
        description,
        dateTimeOriginal,
        timeZone: extractTimeZone(dateTimeOriginal)?.name,
        latitude,
        longitude,
        rating,
        ...place,
      },
      isUndefined,
    );

    if (latitude !== undefined && Object.keys(place).length === 0) {
      await this.assetRepository.unlockProperties(id, [...placeProperties]);
    }

    if (Object.keys(writes).length > 0) {
      await this.assetRepository.upsertExif({
        exif: updateLockedColumns({
          assetId: id,
          ...writes,
        }),
        lockedPropertiesBehavior: 'append',
      });
      await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id } });
    }
  }

  private placeName(value: string | null | undefined): string | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    return value?.trim() || null;
  }

  async getAssetEdits(auth: AuthDto, id: string): Promise<AssetEditsResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    const asset = await this.assetRepository.getById(id);
    if (!asset) throw new BadRequestException('Asset not found');
    // Best effort: clients that only list edits must not fail because the original cannot be probed.
    // Saving still requires the original's bounds (see editAsset).
    let originalVideo: AssetEditsResponseDto['originalVideo'];
    if (asset.type === AssetType.Video) {
      try {
        originalVideo = await this.getOriginalVideoMetadata(asset.originalPath);
      } catch (error: any) {
        this.logger.warn(`Original video metadata is unavailable for asset ${id}: ${error?.message ?? error}`);
      }
    }
    const edits = await this.assetEditRepository.getAll(id);

    return { assetId: id, edits, ...(originalVideo && { originalVideo }) };
  }

  private async getOriginalVideoMetadata(path: string): Promise<NonNullable<AssetEditsResponseDto['originalVideo']>> {
    const source = await this.mediaRepository.probe(path);
    const video = source.videoStreams[0];
    const durationMs = getDurationMs(Math.round(source.format.duration * 1000));
    if (
      !video ||
      !Number.isSafeInteger(video.width) ||
      video.width <= 0 ||
      !Number.isSafeInteger(video.height) ||
      video.height <= 0 ||
      !durationMs ||
      !Number.isFinite(video.rotation)
    ) {
      throw new BadRequestException('Original video metadata is not available for editing');
    }
    const rotated = Math.abs(video.rotation) % 180 === 90;
    return { width: rotated ? video.height : video.width, height: rotated ? video.width : video.height, durationMs };
  }

  async editAsset(
    auth: AuthDto,
    id: string,
    dto: AssetEditsCreateDto,
    purpose: 'save' | 'revert' = 'save',
  ): Promise<AssetEditsResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetEditCreate, ids: [id] });

    const asset = await this.assetRepository.getForEdit(id);
    if (!asset) {
      throw new BadRequestException('Asset not found');
    }

    const edits = dto.edits as AssetEditActionItem[];
    const supportedActions = asset.type === AssetType.Video ? videoEditActions : imageEditActions;
    const unsupportedAction = edits.find((edit) => !supportedActions.has(edit.action));
    if (unsupportedAction) {
      throw new BadRequestException(
        `Edit action '${unsupportedAction.action}' is not supported for ${asset.type} assets`,
      );
    }

    if (![AssetType.Image, AssetType.Video].includes(asset.type)) {
      throw new BadRequestException('Only images and videos can be edited');
    }

    if (asset.livePhotoVideoId) {
      throw new BadRequestException('Editing live photos is not supported');
    }

    if (isPanorama(asset)) {
      throw new BadRequestException('Editing panorama media is not supported');
    }

    if (asset.type === AssetType.Image && asset.originalPath?.toLowerCase().endsWith('.gif')) {
      throw new BadRequestException('Editing GIF images is not supported');
    }

    if (asset.type === AssetType.Image && asset.originalPath?.toLowerCase().endsWith('.svg')) {
      throw new BadRequestException('Editing SVG images is not supported');
    }

    const originalVideo =
      asset.type === AssetType.Video ? await this.getOriginalVideoMetadata(asset.originalPath) : undefined;
    const { width: assetWidth, height: assetHeight } = originalVideo ?? getDimensions(asset);
    if (!assetWidth || !assetHeight) {
      throw new BadRequestException('Asset dimensions are not available for editing');
    }

    const originalDurationMs = originalVideo?.durationMs ?? null;

    const crop = edits.find((e) => e.action === AssetEditAction.Crop);
    if (crop) {
      if (edits[0].action !== AssetEditAction.Crop) {
        throw new BadRequestException('Crop action must be the first edit action');
      }

      const { x, y, width, height } = crop.parameters;
      if (x + width > assetWidth || y + height > assetHeight) {
        throw new BadRequestException('Crop parameters are out of bounds');
      }
    }

    if (asset.type === AssetType.Video) {
      const durationMs = originalDurationMs!;
      const trimEdit = edits.find(
        (edit): edit is Extract<AssetEditActionItem, { action: AssetEditAction.Trim }> =>
          edit.action === AssetEditAction.Trim,
      );
      const trimStartMs = trimEdit?.parameters.startMs ?? 0;
      const trimEndMs = trimEdit?.parameters.endMs ?? durationMs;
      const speedEdits = edits.filter((edit) => edit.action === AssetEditAction.Speed);
      const hasGlobalSpeedEdit = speedEdits.some(
        (edit) => edit.parameters.startMs === undefined && edit.parameters.endMs === undefined,
      );
      const speedSegments = speedEdits
        .filter((edit) => edit.parameters.startMs !== undefined && edit.parameters.endMs !== undefined)
        .sort((a, b) => a.parameters.startMs! - b.parameters.startMs!);

      if (hasGlobalSpeedEdit && speedSegments.length > 0) {
        throw new BadRequestException('Global and segment speed edits cannot be combined');
      }

      for (let index = 1; index < speedSegments.length; index++) {
        if (speedSegments[index].parameters.startMs! < speedSegments[index - 1].parameters.endMs!) {
          throw new BadRequestException('Speed segments cannot overlap');
        }
      }

      for (const edit of edits) {
        if (edit.action === AssetEditAction.Trim && edit.parameters.endMs > durationMs) {
          throw new BadRequestException('Trim parameters are out of bounds');
        }

        if (edit.action === AssetEditAction.Speed || edit.action === AssetEditAction.TextOverlay) {
          const { startMs, endMs } = edit.parameters;
          if ((startMs !== undefined && startMs > durationMs) || (endMs !== undefined && endMs > durationMs)) {
            throw new BadRequestException(`${edit.action} parameters are out of bounds`);
          }

          if (
            trimEdit &&
            ((startMs !== undefined && startMs < trimStartMs) || (endMs !== undefined && endMs > trimEndMs))
          ) {
            throw new BadRequestException(`${edit.action} parameters must be within the trimmed video range`);
          }
        }
      }
    }

    const newEdits = await withVideoVersionErrors(() => this.assetEditRepository.replaceAll(id, edits, purpose));
    await this.jobRepository.queue({
      name: asset.type === AssetType.Video ? JobName.AssetVideoEditGeneration : JobName.AssetEditThumbnailGeneration,
      data: { id },
    });

    // Return the asset and its applied edits
    return {
      assetId: id,
      edits: newEdits,
    };
  }

  async getVideoEditVersions(auth: AuthDto, id: string): Promise<VideoEditVersionResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetEditGet, ids: [id] });
    const versions = await this.assetEditRepository.listVideoVersions(id, auth.user.id);
    return versions.map((version) => ({
      id: version.id,
      assetId: version.assetId,
      purpose: version.purpose,
      status: version.status,
      createdAt: new Date(version.createdAt).toISOString(),
      edits: version.recipe,
      isCurrent: version.isCurrent,
      isRequested: version.isRequested,
    }));
  }

  async restoreVideoEditVersion(auth: AuthDto, id: string, versionId: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetEditCreate, ids: [id] });
    const version = await this.assetEditRepository.getVideoVersion(id, versionId);
    if (!version || version.ownerId !== auth.user.id || version.status !== 'ready')
      throw new BadRequestException('Video version is unavailable');
    if (version.recipe.length === 0) await this.clearAssetEdits(id, 'revert');
    else await this.editAsset(auth, id, { edits: version.recipe }, 'revert');
  }

  async exportVideoEditVersion(auth: AuthDto, id: string): Promise<VideoEditVersionResponseDto> {
    // An export renders a new master, so it needs the same permission as saving an edit.
    await this.requireAccess({ auth, permission: Permission.AssetEditCreate, ids: [id] });
    const version = await withVideoVersionErrors(() => this.assetEditRepository.createVideoExport(id, auth.user.id));
    await this.jobRepository.queue({ name: JobName.AssetVideoEditGeneration, data: { id, versionId: version.id } });
    return {
      id: version.id,
      assetId: id,
      purpose: version.purpose,
      status: version.status,
      createdAt: new Date(version.createdAt).toISOString(),
      edits: version.recipe,
      isCurrent: false,
      isRequested: false,
    };
  }

  async pruneVideoEditVersion(auth: AuthDto, id: string, versionId: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetEditDelete, ids: [id] });
    const paths = await withVideoVersionErrors(() =>
      this.assetEditRepository.pruneVideoVersion(id, versionId, auth.user.id),
    );
    if (paths.length > 0) await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: paths } });
  }

  async removeAssetEdits(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetEditDelete, ids: [id] });
    await this.clearAssetEdits(id, 'save');
  }

  /** Restoring a version with an empty recipe is an edit, not a deletion; callers check access. */
  private async clearAssetEdits(id: string, purpose: 'save' | 'revert'): Promise<void> {
    const asset = await this.assetRepository.getById(id, { files: true });
    if (!asset) {
      throw new BadRequestException('Asset not found');
    }

    await withVideoVersionErrors(() => this.assetEditRepository.replaceAll(id, [], purpose));

    const requested =
      asset.type === AssetType.Video
        ? await withVideoVersionErrors(() => this.assetEditRepository.getRequestedVideoVersion(id))
        : undefined;
    // A retained version owns its files; only legacy (history-less) edits are deleted here.
    if (asset.type === AssetType.Video && !requested) {
      const editedFiles = asset.files?.filter((file) => file.isEdited) ?? [];
      if (editedFiles.length > 0) {
        await this.jobRepository.queue({
          name: JobName.FileDelete,
          data: { files: editedFiles.map((file) => file.path) },
        });
        await this.assetRepository.deleteFiles(editedFiles);
      }
    }

    await this.jobRepository.queue({
      name: asset.type === AssetType.Video ? JobName.AssetVideoEditGeneration : JobName.AssetEditThumbnailGeneration,
      data: { id },
    });
  }
}

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SystemConfig } from 'src/config.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { MapAsset, mapAsset } from 'src/dtos/asset-response.dto.js';
import {
  DuplicateEstimateQueryDto,
  DuplicateEstimateResponseDto,
  DuplicateRecompareDto,
  DuplicateResolveDto,
  DuplicateResolveGroupDto,
  DuplicateResponseDto,
} from 'src/dtos/duplicate.dto.js';
import {
  AssetStatus,
  AssetType,
  AssetVisibility,
  JobName,
  JobStatus,
  Permission,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { deferJobAdoption, queueExecution } from 'src/queue/context.js';
import { deferJobUntilDependency } from 'src/queue/dependency.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { AssetDuplicateResult } from 'src/repositories/search.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { duplicateDisposalReasons, reviewKindOf } from 'src/utils/duplicate-review.js';
import { suggestDuplicateKeepAssetIds } from 'src/utils/duplicate.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { effectiveVisibilityOf } from 'src/utils/locked.js';
import { isDuplicateDetectionEnabled } from 'src/utils/misc.js';
import { compareVideoFingerprints, middleFrameHashes } from 'src/utils/video-fingerprint.js';

type ResolveRequest = {
  assetUpdate: {
    isFavorite?: boolean;
    visibility?: AssetVisibility;
  };

  exifUpdate: {
    rating?: number;
    latitude?: number;
    longitude?: number;
    description?: string;
  };

  mergedAlbumIds: string[];

  mergedTagIds: string[];

  mergedTagValues: string[];
};

/** FL-520: photos sampled for the look-alike estimate on Library care › Duplicates. */
export const DUPLICATE_ESTIMATE_SAMPLE = 200;

const uniqueNonEmptyLines = (values: Array<string | null | undefined>): string[] => {
  const unique = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        unique.add(trimmed);
      }
    }
  }
  return [...unique];
};

const getUniqueCoordinate = (assets: MapAsset[], key: 'latitude' | 'longitude'): number | null => {
  let coordinate: number | null = null;
  for (const asset of assets) {
    const value = asset.exifInfo?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      continue;
    }
    if (coordinate !== null && coordinate !== value) {
      return null;
    }
    coordinate = value === 0 ? 0 : value;
  }
  return coordinate;
};

@Injectable()
export class DuplicateService extends BaseService {
  async getDuplicates(auth: AuthDto): Promise<DuplicateResponseDto[]> {
    // Clean up singleton groups (assets that are the only member of their duplicate group)
    await this.duplicateRepository.cleanupSingletonGroups(auth.user.id);

    const duplicates = await this.duplicateRepository.getAll(auth.user.id, this.nsfwOptions(auth));
    let history: Set<string> | undefined;
    try {
      history = await this.assetDevelopRepository.getAssetIdsWithHistory(
        duplicates.flatMap(({ assets }) => assets.map(({ id }) => id)),
      );
    } catch {
      // Recommendations stay visible, but missing evidence never permits unattended disposal.
    }
    return Promise.all(
      duplicates.map(async ({ duplicateId, assets }) => {
        const mappedAssets = assets.map((asset) => mapAsset(asset, { auth }));
        const suggestedKeepAssetIds =
          reviewKindOf(mappedAssets) === 'copies' ? suggestDuplicateKeepAssetIds(mappedAssets) : [];
        let motionId: string | undefined;
        if (suggestedKeepAssetIds.length === 1 && assets.some((asset) => asset.livePhotoVideoId)) {
          try {
            motionId = await this.duplicateRepository.findMotionTransfer(
              auth.user.id,
              suggestedKeepAssetIds[0],
              assets.filter(({ id }) => !suggestedKeepAssetIds.includes(id)).map(({ id }) => id),
            );
          } catch {
            /* Inconclusive pairing evidence retains the review requirement. */
          }
        }
        const prospective = mappedAssets.map((asset) =>
          motionId && suggestedKeepAssetIds.includes(asset.id) ? { ...asset, livePhotoVideoId: motionId } : asset,
        );
        const reviewRequiredReasons = history
          ? duplicateDisposalReasons(prospective, suggestedKeepAssetIds, history)
          : ['evidence-unavailable'];
        return {
          duplicateId,
          assets: mappedAssets,
          suggestedKeepAssetIds,
          ...(reviewRequiredReasons.length > 0 && { reviewRequiredReasons }),
        };
      }),
    );
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.DuplicateDelete, ids: [id] });
    await this.duplicateRepository.delete(auth.user.id, id);
  }

  async deleteAll(auth: AuthDto, dto: BulkIdsDto) {
    await this.requireAccess({ auth, permission: Permission.DuplicateDelete, ids: dto.ids });
    await this.duplicateRepository.deleteAll(auth.user.id, dto.ids);
  }

  async resolve(auth: AuthDto, dto: DuplicateResolveDto) {
    const duplicateIds = dto.groups.map(({ duplicateId }) => duplicateId);

    await this.requireAccess({ auth, permission: Permission.DuplicateDelete, ids: duplicateIds });

    const results: BulkIdResponseDto[] = [];

    for (const group of dto.groups) {
      try {
        results.push(await this.resolveGroup(auth, group));
      } catch (error: any) {
        this.logger.error(`Error resolving duplicate group ${group.duplicateId}: ${error}`, error?.stack);
        results.push({ id: group.duplicateId, success: false, error: BulkIdErrorReason.UNKNOWN });
      }
    }

    return results;
  }

  private async resolveGroup(auth: AuthDto, group: DuplicateResolveGroupDto): Promise<BulkIdResponseDto> {
    const effects: JobOf<JobName.DuplicateResolutionLifecycle> = {
      id: randomUUID(),
      userId: auth.user.id,
      sidecarIds: [],
      lockedIds: [],
      trashIds: [],
      force: false,
    };
    const result = await this.duplicateRepository.withResolutionLock(group.duplicateId, async (tx) => {
      const result = await this.resolveLockedGroup(auth, group, effects);
      if (
        result.success &&
        (effects.sidecarIds.length > 0 || effects.lockedIds.length > 0 || effects.trashIds.length > 0)
      ) {
        await this.jobRepository.queueInTransaction(tx, { name: JobName.DuplicateResolutionLifecycle, data: effects });
      }
      return result;
    });
    if (
      result.success &&
      (effects.sidecarIds.length > 0 || effects.lockedIds.length > 0 || effects.trashIds.length > 0)
    ) {
      try {
        await queueExecution.exit(() => this.handleResolutionLifecycle(effects));
        await this.jobRepository.removeJob(JobName.DuplicateResolutionLifecycle, effects.id);
      } catch {
        this.logger.warn('Duplicate resolution committed; lifecycle work retained for retry');
      }
    }
    return result;
  }

  @OnJob({ name: JobName.DuplicateResolutionLifecycle, queue: QueueName.BackgroundTask })
  async handleResolutionLifecycle(effects: JobOf<JobName.DuplicateResolutionLifecycle>): Promise<JobStatus> {
    const work: (() => Promise<unknown>)[] = [];
    if (effects.sidecarIds.length > 0)
      work.push(() =>
        this.jobRepository.queueAll(effects.sidecarIds.map((id) => ({ name: JobName.SidecarWrite, data: { id } }))),
      );
    if (effects.lockedIds.length > 0)
      work.push(async () => {
        await this.afterAssetsLocked(effects.lockedIds);
        const siblingIds = (await this.assetRepository.getStackSiblingIds(effects.lockedIds)) ?? [];
        await this.notifyAssetsUpdated([...effects.lockedIds, ...siblingIds], effects.userId);
      });
    if (effects.trashIds.length > 0)
      work.push(() =>
        this.eventRepository.emit(effects.force ? 'AssetDeleteAll' : 'AssetTrashAll', {
          assetIds: effects.trashIds,
          userId: effects.userId,
        }),
      );
    const results = await Promise.allSettled(work.map((run) => run()));
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Duplicate lifecycle work requires retry');
    return JobStatus.Success;
  }

  private async resolveLockedGroup(
    auth: AuthDto,
    group: DuplicateResolveGroupDto,
    effects: JobOf<JobName.DuplicateResolutionLifecycle>,
  ): Promise<BulkIdResponseDto> {
    const { duplicateId, keepAssetIds, trashAssetIds } = group;

    await this.requireAccess({ auth, permission: Permission.DuplicateDelete, ids: [duplicateId] });

    const duplicateGroup = await this.duplicateRepository.get(duplicateId, this.nsfwOptions(auth));
    if (!duplicateGroup) {
      return { id: duplicateId, success: false, error: BulkIdErrorReason.NOT_FOUND };
    }

    const groupAssetIds = new Set(duplicateGroup.assets.map((a) => a.id));

    // SECURITY (server.md Medium #nsfwOptions): explicitly reject ids the
    // user didn't see when their NSFW privacy is on. Silently filtering would
    // let an attacker probe for hidden ids by guessing UUIDs in the
    // trashAssetIds list.
    const submittedIds = [...keepAssetIds, ...trashAssetIds];
    const unknownIds = submittedIds.filter((id) => !groupAssetIds.has(id));
    if (unknownIds.length > 0) {
      return {
        id: duplicateId,
        success: false,
        error: BulkIdErrorReason.NOT_FOUND,
        errorMessage: 'One or more assetIds are not part of this duplicate group',
      };
    }

    const idsToKeep = keepAssetIds;
    const idsToTrash = trashAssetIds;

    for (const assetId of groupAssetIds) {
      if (idsToKeep.includes(assetId) && idsToTrash.includes(assetId)) {
        return {
          id: duplicateId,
          success: false,
          error: BulkIdErrorReason.VALIDATION,
          errorMessage: 'An asset cannot be in both keepAssetIds and trashAssetIds',
        };
      }

      if (!idsToKeep.includes(assetId) && !idsToTrash.includes(assetId)) {
        return {
          id: duplicateId,
          success: false,
          error: BulkIdErrorReason.VALIDATION,
          errorMessage: 'Every asset must be in either keepAssetIds or trashAssetIds',
        };
      }
    }

    if (idsToTrash.length > 0) {
      const ids = await this.checkAccess({ auth, permission: Permission.AssetDelete, ids: idsToTrash });
      if (ids.size !== idsToTrash.length) {
        return {
          id: duplicateId,
          success: false,
          error: BulkIdErrorReason.NO_PERMISSION,
          errorMessage: 'No permission to delete assets',
        };
      }
    }

    const history = await this.assetDevelopRepository.getAssetIdsWithHistory(idsToTrash);
    const motionId =
      idsToKeep.length === 1 && duplicateGroup.assets.some((asset) => asset.livePhotoVideoId)
        ? await this.duplicateRepository.findMotionTransfer(auth.user.id, idsToKeep[0], idsToTrash)
        : undefined;
    const prospective = duplicateGroup.assets.map((asset) =>
      motionId && idsToKeep.includes(asset.id) ? { ...asset, livePhotoVideoId: motionId } : asset,
    );
    const reviewRequiredReasons = duplicateDisposalReasons(prospective, idsToKeep, history);
    if (reviewRequiredReasons.length > 0) {
      return {
        id: duplicateId,
        success: false,
        error: BulkIdErrorReason.VALIDATION,
        errorMessage: 'Keep copies with edits or distinct Live Photo motion; review them before disposal',
      };
    }

    if (motionId) {
      const allowed = await this.checkAccess({ auth, permission: Permission.AssetUpdate, ids: idsToKeep });
      if (!allowed.has(idsToKeep[0]))
        return { id: duplicateId, success: false, error: BulkIdErrorReason.NO_PERMISSION };
      // Keep the disposable still's original reference too, for restoration and shared-motion accounting.
      await this.assetRepository.update({ id: idsToKeep[0], livePhotoVideoId: motionId });
    }

    // Only merge metadata into the keeper when exactly one asset can absorb trashed duplicates.
    if (idsToKeep.length === 1 && idsToTrash.length > 0) {
      const assetAlbumMap = await this.albumRepository.getByAssetIds(auth.user.id, [...groupAssetIds]);

      const { assetUpdate, exifUpdate, mergedAlbumIds, mergedTagIds, mergedTagValues } = this.getSyncMergeResult(
        duplicateGroup.assets,
        assetAlbumMap,
      );

      if (mergedAlbumIds.length > 0) {
        const allowedAlbumIds = await this.checkAccess({
          auth,
          permission: Permission.AlbumAssetCreate,
          ids: mergedAlbumIds,
        });

        const allowedShareIds = await this.checkAccess({
          auth,
          permission: Permission.AssetShare,
          ids: idsToKeep,
        });

        if (allowedAlbumIds.size > 0 && allowedShareIds.size > 0) {
          await this.albumRepository.addAssetIdsToAlbums(
            [...allowedAlbumIds].flatMap((albumId) => [...allowedShareIds].map((assetId) => ({ albumId, assetId }))),
          );
        }
      }

      if (mergedTagIds.length > 0) {
        const allowedTagIds = await this.checkAccess({
          auth,
          permission: Permission.TagAsset,
          ids: mergedTagIds,
        });

        if (allowedTagIds.size > 0) {
          await Promise.all(
            idsToKeep.map((assetId) => this.tagRepository.replaceAssetTags(assetId, [...allowedTagIds])),
          );

          await this.assetRepository.updateAllExif(idsToKeep, { tags: mergedTagValues });
        }
      }

      const hasExifUpdate = Object.keys(exifUpdate).length > 0;
      const hasTagUpdate = mergedTagIds.length > 0;

      if (hasExifUpdate) {
        await this.assetRepository.updateAllExif(idsToKeep, exifUpdate);
      }

      if (hasExifUpdate || hasTagUpdate) {
        effects.sidecarIds = idsToKeep;
      }

      await this.assetRepository.updateAll(idsToKeep, { duplicateId: null, ...assetUpdate });
      if (assetUpdate.visibility === AssetVisibility.Locked) {
        // a kept copy that became Locked is no longer a face thumbnail or profile picture (FL-53)
        // give every stack sibling the cascade also locked the same real-time update the kept copies
        // get, so an open web client reflects the whole stack at once (FL-53, `locked-stacks.ts`)
        effects.lockedIds = idsToKeep;
      }
    } else if (idsToKeep.length > 0) {
      await this.assetRepository.updateAll(idsToKeep, { duplicateId: null });
    }

    if (idsToTrash.length > 0) {
      // TODO: this is duplicated with AssetService.deleteAssets
      const { trash } = await this.getConfig({ withCache: true });
      const isForce = !trash.enabled;

      await this.assetRepository.updateAll(idsToTrash, {
        deletedAt: new Date(),
        status: isForce ? AssetStatus.Deleted : AssetStatus.Trashed,
        duplicateId: null,
      });

      effects.trashIds = idsToTrash;
      effects.force = isForce;
    }

    return { id: duplicateId, success: true };
  }

  private getSyncMergeResult(assets: MapAsset[], assetAlbumMap: Map<string, string[]> = new Map()): ResolveRequest {
    const response: ResolveRequest = {
      mergedAlbumIds: [],
      mergedTagIds: [],
      mergedTagValues: [],
      assetUpdate: {},
      exifUpdate: {},
    };

    response.assetUpdate.isFavorite = assets.some((asset) => asset.isFavorite);

    const visibilityOrder = [AssetVisibility.Locked, AssetVisibility.Archive, AssetVisibility.Timeline];
    // `locked` is the lock record (FL-34); `updateAll` turns it into a lock on the kept copy
    let visibility = visibilityOrder.find((level) => assets.some((asset) => effectiveVisibilityOf(asset) === level));
    if (!visibility && assets.some((asset) => asset.visibility === AssetVisibility.Hidden)) {
      visibility = AssetVisibility.Hidden;
    }
    if (visibility) {
      response.assetUpdate.visibility = visibility;
    }

    let rating = 0;
    for (const asset of assets) {
      const assetRating = asset.exifInfo?.rating ?? 0;
      if (assetRating > rating) {
        rating = assetRating;
      }
    }
    if (rating > 0) {
      response.exifUpdate.rating = rating;
    }

    const descriptionLines = uniqueNonEmptyLines(assets.map((asset) => asset.exifInfo?.description));
    const description = descriptionLines.length > 0 ? descriptionLines.join('\n') : null;
    if (description !== null) {
      response.exifUpdate.description = description;
    }

    const latitude = getUniqueCoordinate(assets, 'latitude');
    const longitude = getUniqueCoordinate(assets, 'longitude');
    if (latitude !== null && longitude !== null) {
      response.exifUpdate.latitude = latitude;
      response.exifUpdate.longitude = longitude;
    }

    const albumIdSet = new Set<string>();
    for (const [, albumIds] of assetAlbumMap) {
      for (const albumId of albumIds) {
        albumIdSet.add(albumId);
      }
    }
    response.mergedAlbumIds = [...albumIdSet];

    const allTags = assets.flatMap((asset) => asset.tags ?? []);
    const tagIds = [...new Set(allTags.map((tag) => tag.id).filter((id): id is string => !!id))];
    const tagValues = [...new Set(allTags.map((tag) => tag.value).filter((v): v is string => !!v))];
    if (tagIds.length > 0) {
      response.mergedTagIds = tagIds;
      response.mergedTagValues = tagValues;
    }

    return response;
  }

  private nsfwOptions(auth: AuthDto) {
    return getHiddenContentQueryOptions(auth);
  }

  /**
   * FL-520: about how many look-alike groups each "How alike" choice makes, from a sample. For each
   * sampled photo the nearest photo of the same kind in its library is found; the share whose nearest
   * is within a distance, times the photos compared, is the photos that would be grouped, and the
   * groups so far say how many photos a group holds (two when there are none yet). The time the sample
   * took, per photo, times the photos compared is the time comparing again takes.
   */
  async estimateLookAlikes({ maxDistances }: DuplicateEstimateQueryDto): Promise<DuplicateEstimateResponseDto> {
    const startedAt = Date.now();
    const distances = await this.duplicateRepository.sampleNearestDistances(DUPLICATE_ESTIMATE_SAMPLE);
    const elapsed = Date.now() - startedAt;
    const { comparable, groups, grouped } = await this.duplicateRepository.countComparable();
    const perGroup = groups > 0 && grouped > groups ? grouped / groups : 2;
    const sampled = distances.length;
    return {
      comparable,
      groups,
      sampled,
      seconds: sampled > 0 ? Math.ceil(((elapsed / sampled) * comparable) / 1000) : 0,
      choices: maxDistances.map((maxDistance) => {
        const close = distances.filter((distance) => distance <= maxDistance).length;
        return {
          maxDistance,
          groups: sampled > 0 ? Math.round(((close / sampled) * comparable) / perGroup) : 0,
        };
      }),
    };
  }

  /**
   * FL-520: compare every photo again after "How alike" changed: now, or as part of the next overnight
   * run (`OvernightService` reads the request at its tidy-up step).
   */
  async recompare({ when }: DuplicateRecompareDto): Promise<void> {
    if (when === 'now') {
      await this.jobRepository.queue({ name: JobName.AssetDetectDuplicatesQueueAll, data: { force: true } });
      await this.systemMetadataRepository.delete(SystemMetadataKey.DuplicateRecompare);
      return;
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.DuplicateRecompare, {
      requestedAt: new Date().toISOString(),
    });
  }

  @OnJob({ name: JobName.AssetDetectDuplicatesQueueAll, queue: QueueName.DuplicateDetection })
  async handleQueueSearchDuplicates({ force }: JobOf<JobName.AssetDetectDuplicatesQueueAll>): Promise<JobStatus> {
    const { machineLearning, libraryCare } = await this.getConfig({ withCache: false });
    // Library care → "Group near-duplicates for review" (FL-69, settings-catalog.mjs:951-956).
    if (!isDuplicateDetectionEnabled(machineLearning) || !libraryCare.duplicateReview) {
      deferJobUntilDependency('workload-disabled');
      return JobStatus.Skipped;
    }

    await this.jobRepository.queueSelection(
      JobName.AssetDetectDuplicates,
      this.assetJobRepository.selectionForSearchDuplicates(force),
    );

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetVideoFingerprintQueueAll, queue: QueueName.VideoDuplicateDetection })
  async handleQueueVideoFingerprints({ force }: JobOf<JobName.AssetVideoFingerprintQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isDuplicateDetectionEnabled(machineLearning)) {
      deferJobUntilDependency('workload-disabled');
      return JobStatus.Skipped;
    }
    if (!machineLearning.duplicateDetection.enhancedVideo.enabled) {
      return JobStatus.Skipped;
    }

    await this.jobRepository.queueSelection(
      JobName.AssetVideoFingerprint,
      this.assetJobRepository.selectionForVideoFingerprint(force),
    );

    return JobStatus.Success;
  }

  /** FL-651 retired the sampled CLIP frames; a job queued before the upgrade changes nothing. */
  @OnJob({ name: JobName.AssetGenerateVideoDuplicateFramesQueueAll, queue: QueueName.VideoDuplicateDetection })
  handleQueueGenerateVideoDuplicateFrames(): Promise<JobStatus> {
    return Promise.resolve(JobStatus.Skipped);
  }

  /** FL-651 retired the sampled CLIP frames; a job queued before the upgrade changes nothing. */
  @OnJob({ name: JobName.AssetGenerateVideoDuplicateFrames, queue: QueueName.VideoDuplicateDetection })
  handleGenerateVideoDuplicateFrames(): Promise<JobStatus> {
    return Promise.resolve(JobStatus.Skipped);
  }

  @OnJob({ name: JobName.AssetDetectDuplicates, queue: QueueName.DuplicateDetection })
  async handleSearchDuplicates({ id }: JobOf<JobName.AssetDetectDuplicates>): Promise<JobStatus> {
    const { machineLearning, libraryCare } = await this.getConfig({ withCache: true });
    if (!isDuplicateDetectionEnabled(machineLearning) || !libraryCare.duplicateReview) {
      deferJobUntilDependency('workload-disabled');
      return JobStatus.Skipped;
    }

    const read = await this.machineLearningRepository.captureClipRead();
    const publish = (): Promise<JobStatus> =>
      read.publish(async () => {
        const tx = publicationTransaction.getStore();
        if (tx) {
          // Group merges can touch siblings not returned by the nearest-neighbour query.
          // Lock this owner's rows in stable order before reading matching/manual resolution state.
          const owner = await tx.selectFrom('asset').select('ownerId').where('id', '=', id).executeTakeFirst();
          if (owner)
            await tx
              .selectFrom('asset')
              .select('id')
              .where('ownerId', '=', owner.ownerId)
              .orderBy('id')
              .forUpdate()
              .execute();
        }
        const asset = await this.assetJobRepository.getForSearchDuplicatesJob(id);
        if (!asset) {
          this.logger.error(`Asset ${id} not found`);
          return JobStatus.Failed;
        }

        if (asset.stackId) {
          this.logger.debug(`Asset ${id} is part of a stack, skipping`);
          return JobStatus.Skipped;
        }

        if (asset.visibility === AssetVisibility.Hidden) {
          this.logger.debug(`Asset ${id} is not visible, skipping`);
          return JobStatus.Skipped;
        }

        if (asset.visibility === AssetVisibility.Locked) {
          this.logger.debug(`Asset ${id} is locked, skipping`);
          return JobStatus.Skipped;
        }

        if (!asset.embedding) {
          this.logger.debug(`Asset ${id} is missing embedding`);
          return JobStatus.Failed;
        }

        let duplicateAssets = await this.duplicateRepository.search({
          assetId: asset.id,
          embedding: asset.embedding,
          maxDistance: machineLearning.duplicateDetection.maxDistance,
          type: asset.type,
          userIds: [asset.ownerId],
        });

        if (asset.type === AssetType.Video) {
          const videoDuplicates = await this.findVideoDuplicates(
            asset,
            duplicateAssets,
            machineLearning.duplicateDetection,
          );
          if (videoDuplicates === 'pending') {
            // its group stays as it is until the fingerprints exist; their jobs compare it again
            return JobStatus.Success;
          }
          duplicateAssets = videoDuplicates;
        }

        let assetIds = [asset.id];
        if (duplicateAssets.length > 0) {
          this.logger.debug(
            `Found ${duplicateAssets.length} duplicate${duplicateAssets.length === 1 ? '' : 's'} for asset ${asset.id}`,
          );
          assetIds = await this.updateDuplicates(asset, duplicateAssets);
        } else if (asset.duplicateId) {
          this.logger.debug(`No duplicates found for asset ${asset.id}, removing duplicateId`);
          await this.assetRepository.update({ id: asset.id, duplicateId: null });
        }

        const duplicatesDetectedAt = new Date();
        await this.assetRepository.upsertJobStatus(...assetIds.map((assetId) => ({ assetId, duplicatesDetectedAt })));

        return JobStatus.Success;
      });
    if (
      deferJobAdoption(async () => {
        if ((await publish()) === JobStatus.Failed) throw new Error('Duplicate matching could not be published');
      })
    )
      return JobStatus.Success;
    return publish();
  }

  /**
   * FL-651: the preview's look-alikes plus videos sharing a frame with this one's middle, kept only
   * when their timelines line up (utils/video-fingerprint.ts). Videos without a fingerprint yet are
   * fingerprinted first; that job compares them again. `pending` while this video has no
   * fingerprint, or while nothing is confirmed and a candidate still has none, so no group is
   * undone on missing data.
   */
  private async findVideoDuplicates(
    asset: { id: string; ownerId: string },
    clipMatches: AssetDuplicateResult[],
    duplicateDetection: SystemConfig['machineLearning']['duplicateDetection'],
  ): Promise<AssetDuplicateResult[] | 'pending'> {
    const { enabled, minMatchFraction, maxHashDistance } = duplicateDetection.enhancedVideo;
    if (!enabled) {
      return clipMatches;
    }

    const [fingerprint] = await this.duplicateRepository.getVideoFingerprints([asset.id]);
    if (!fingerprint) {
      await this.jobRepository.queue({ name: JobName.AssetVideoFingerprint, data: { id: asset.id } });
      return 'pending';
    }

    const hashMatches = await this.duplicateRepository.searchVideoFingerprints({
      assetId: asset.id,
      hashes: middleFrameHashes(fingerprint),
      maxBits: maxHashDistance,
      userIds: [asset.ownerId],
    });
    const candidates = new Map([...hashMatches, ...clipMatches].map((match) => [match.assetId, match]))
      .values()
      .toArray();
    const fingerprints = new Map(
      (await this.duplicateRepository.getVideoFingerprints(candidates.map(({ assetId }) => assetId))).map((other) => [
        other.assetId,
        other,
      ]),
    );

    const unfingerprinted = candidates.filter(({ assetId }) => !fingerprints.has(assetId));
    if (unfingerprinted.length > 0) {
      await this.jobRepository.queueAll(
        unfingerprinted.map(({ assetId }) => ({ name: JobName.AssetVideoFingerprint, data: { id: assetId } })),
      );
    }

    const confirmed = candidates.filter(({ assetId }) => {
      const other = fingerprints.get(assetId);
      return (
        other !== undefined &&
        compareVideoFingerprints(fingerprint, other, { maxBits: maxHashDistance, minMatchFraction }).isDuplicate
      );
    });
    return confirmed.length === 0 && unfingerprinted.length > 0 ? 'pending' : confirmed;
  }

  private async updateDuplicates(
    asset: { id: string; duplicateId: string | null },
    duplicateAssets: AssetDuplicateResult[],
  ): Promise<string[]> {
    let targetDuplicateId = asset.duplicateId;
    const sourceIds = new Set<string>();
    const assetIdsToUpdate: string[] = [];
    for (const duplicate of duplicateAssets) {
      targetDuplicateId ??= duplicate.duplicateId || null;
      if (targetDuplicateId === null || duplicate.duplicateId !== targetDuplicateId) {
        assetIdsToUpdate.push(duplicate.assetId);
        if (duplicate.duplicateId) {
          sourceIds.add(duplicate.duplicateId);
        }
      }
    }
    targetDuplicateId ??= this.cryptoRepository.randomUUID();
    assetIdsToUpdate.push(asset.id);

    await this.duplicateRepository.merge({
      targetId: targetDuplicateId,
      assetIds: assetIdsToUpdate,
      sourceIds: [...sourceIds],
    });
    return assetIdsToUpdate;
  }
}

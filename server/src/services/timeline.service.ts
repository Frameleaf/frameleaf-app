import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  TIMELINE_HIGHLIGHT_DEFAULT,
  TimeBucketAssetDto,
  TimeBucketDto,
  TimeBucketsResponseDto,
  TimelineHighlightResponseDto,
  TimelineHighlightsDto,
  TimelineOrderedDto,
} from 'src/dtos/time-bucket.dto.js';
import { AssetVisibility, Permission } from 'src/enum.js';
import { TimeBucketOptions } from 'src/repositories/asset.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { requireElevatedPermission } from 'src/utils/access.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';
import { getPrivacyQueryOptions, requireSuppressedOnlyAccess } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { getLocationHiddenOwnerIdsForView } from 'src/utils/partner-location.js';
import { requirePetFilterAllowed } from 'src/utils/search-filter.js';

const getRevealOptions = (auth: AuthDto) => {
  const revealLockedOwnerId = getLockedOwnerId(auth);
  return revealLockedOwnerId ? { revealLockedOwnerId } : {};
};

@Injectable()
export class TimelineService extends BaseService {
  async getTimeBuckets(auth: AuthDto, dto: TimeBucketDto): Promise<TimeBucketsResponseDto[]> {
    await this.timeBucketChecks(auth, dto);
    const timeBucketOptions = await this.buildTimeBucketOptions(auth, dto);
    return await this.assetRepository.getTimeBuckets(timeBucketOptions, auth);
  }

  // pre-jsonified response
  async getTimeBucket(auth: AuthDto, dto: TimeBucketAssetDto): Promise<string> {
    await this.timeBucketChecks(auth, dto);
    const timeBucketOptions = await this.buildTimeBucketOptions(auth, { ...dto });

    // TODO: use id cursor for pagination
    const bucket = await this.assetRepository.getTimeBucket(dto.timeBucket, timeBucketOptions, auth);
    return bucket.assets;
  }

  /**
   * FL-30 (S-15): one page of the timeline ordered by file name or rating, for Browse and Work. The
   * time buckets' checks and options, so it never shows what the buckets would not.
   */
  async getTimelineOrdered(auth: AuthDto, dto: TimelineOrderedDto): Promise<string> {
    const { sort, skip, take, ...bucketDto } = dto;
    // S-15: a shared link that hides EXIF may not sort by file name or rating; the order would reveal them
    if (auth.sharedLink && !auth.sharedLink.showExif) {
      throw new BadRequestException('This link does not allow sorting by file name or rating');
    }
    await this.timeBucketChecks(auth, bucketDto);
    const timeBucketOptions = await this.buildTimeBucketOptions(auth, bucketDto);
    const page = await this.assetRepository.getTimelineOrdered(timeBucketOptions, auth, { sort, skip, take });
    return page.assets;
  }

  /**
   * FL-33: curated Years and Months cards. The same checks and the same options as the time buckets,
   * so a card counts exactly what the matching bucket counts and never reveals more.
   */
  async getTimelineHighlights(auth: AuthDto, dto: TimelineHighlightsDto): Promise<TimelineHighlightResponseDto[]> {
    const { grouping, highlightCount, ...bucketDto } = dto;
    await this.timeBucketChecks(auth, bucketDto);
    const timeBucketOptions = await this.buildTimeBucketOptions(auth, bucketDto);
    return this.assetRepository.getTimelineHighlights(timeBucketOptions, auth, {
      grouping,
      highlightCount: grouping === 'year' ? 0 : (highlightCount ?? TIMELINE_HIGHLIGHT_DEFAULT),
      // a shared link that hides EXIF hides places too, as its buckets do
      withPlaces: !auth.sharedLink || auth.sharedLink.showExif,
    });
  }

  private async buildTimeBucketOptions(auth: AuthDto, dto: TimeBucketDto): Promise<TimeBucketOptions> {
    const { userId, suppressedOnly, lockReason, ...options } = dto;
    let userIds: string[] | undefined;

    if (userId) {
      userIds = [userId];
      if (dto.withPartners) {
        const partnerIds = await getMyPartnerIds({
          userId: auth.user.id,
          repository: this.partnerRepository,
          timelineEnabled: true,
          // a bounding box is itself a location query, so partners who hide their locations stay out of it
          locationSharedOnly: !!dto.bbox,
        });
        userIds.push(...partnerIds);
      }
    }

    // FL-54: other people's assets can appear here through partners, albums or people; owners who hide
    // their locations from this viewer get their location columns nulled in the bucket SQL
    const canSeeOthersAssets =
      dto.withPartners || !!dto.albumId || !!dto.personId || (!!userId && userId !== auth.user.id);
    // an album view also hides owners who hide their locations from the album's owner (owner default)
    const locationHiddenOwnerIds = canSeeOthersAssets
      ? [
          ...(await getLocationHiddenOwnerIdsForView({
            viewerId: auth.user.id,
            albumIds: dto.albumId ? [dto.albumId] : [],
            repository: this.partnerRepository,
          })),
        ]
      : [];

    return {
      ...options,
      ...getPrivacyQueryOptions(auth, suppressedOnly),
      // An album shows the viewer their own Locked members in an elevated session (owner decision,
      // September 22, 2026). The main timeline never does: the Locked view is its own view.
      ...(dto.albumId && getLockedVisibilityOptions(auth)),
      userIds,
      ...(lockReason && { lockReasons: [lockReason] }),
      // FL-34: the owner's own sensitive marks and detections show in their ordinary timeline once the
      // session is unlocked ("Revealed for this session"); items from the old Locked folder do not
      ...(!dto.albumId && dto.visibility === AssetVisibility.Timeline && getRevealOptions(auth)),
      ...(locationHiddenOwnerIds.length > 0 && { locationHiddenOwnerIds }),
    };
  }

  private async timeBucketChecks(auth: AuthDto, dto: TimeBucketDto) {
    requireSuppressedOnlyAccess(auth, dto.suppressedOnly);

    // FL-34: why an asset is locked is part of the Locked view only
    if (dto.lockReason && dto.visibility !== AssetVisibility.Locked) {
      throw new BadRequestException('lockReason is only supported with visibility LOCKED');
    }

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
      if (dto.userId && dto.userId !== auth.user.id) {
        throw new BadRequestException("You may not access another user's locked timeline");
      }
      // Locked media is owner-private: whatever else narrows the request (an album, a person), only
      // the caller's own Locked items may come back, so the owner scope is always the caller.
      dto.userId = auth.user.id;
    }

    if (dto.albumId) {
      await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [dto.albumId] });
    } else {
      dto.userId ||= auth.user.id;
    }

    if (dto.userId) {
      await this.requireAccess({ auth, permission: Permission.TimelineRead, ids: [dto.userId] });
      if (dto.visibility === AssetVisibility.Archive) {
        await this.requireAccess({ auth, permission: Permission.ArchiveRead, ids: [dto.userId] });
      }
    }

    if (dto.tagId) {
      await this.requireAccess({ auth, permission: Permission.TagRead, ids: [dto.tagId] });
    }

    // FL-58: a pet is its owner's alone; the bucket SQL also only matches the caller's own pets
    requirePetFilterAllowed(auth, dto.petId ? [dto.petId] : undefined);

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      dto.withCoordinates = false;
    }

    if (dto.withPartners) {
      const isRequestedLocked = dto.visibility === AssetVisibility.Locked;
      const isRequestedArchived = dto.visibility === AssetVisibility.Archive || dto.visibility === undefined;
      const isRequestedFavorite = dto.isFavorite === true || dto.isFavorite === false;
      const isRequestedTrash = dto.isTrashed === true;

      if (isRequestedLocked || isRequestedArchived || isRequestedFavorite || isRequestedTrash) {
        throw new BadRequestException(
          'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
        );
      }
    }
  }
}

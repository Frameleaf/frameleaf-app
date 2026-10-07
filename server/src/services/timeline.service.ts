import { BadRequestException, Injectable } from '@nestjs/common';
import z from 'zod';
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
import { TimeBucketOptions, TimelineOrderedPage } from 'src/repositories/asset.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { requireElevatedPermission } from 'src/utils/access.js';
import { getPrivacyQueryOptions, requireSuppressedOnlyAccess } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { requirePetFilterAllowed } from 'src/utils/search-filter.js';

@Injectable()
export class TimelineService extends BaseService {
  async getTimeBuckets(auth: AuthDto, dto: TimeBucketDto): Promise<TimeBucketsResponseDto[]> {
    await this.timeBucketChecks(auth, dto);
    const timeBucketOptions = this.buildTimeBucketOptions(auth, dto);
    return await this.assetRepository.getTimeBuckets(timeBucketOptions, auth);
  }

  // pre-jsonified response
  async getTimeBucket(auth: AuthDto, dto: TimeBucketAssetDto): Promise<string> {
    await this.timeBucketChecks(auth, dto);
    const timeBucketOptions = this.buildTimeBucketOptions(auth, { ...dto });

    // TODO: use id cursor for pagination
    const bucket = await this.assetRepository.getTimeBucket(dto.timeBucket, timeBucketOptions, auth);
    return bucket.assets;
  }

  /**
   * FL-30 (S-15): one page of the timeline ordered by file name or rating, for Browse and Work. The
   * time buckets' checks and options, so it never shows what the buckets would not.
   */
  async getTimelineOrdered(auth: AuthDto, dto: TimelineOrderedDto): Promise<string> {
    const { sort, skip, take, after, before, ...bucketDto } = dto;
    let cursor: TimelineOrderedPage['cursor'];
    if (after !== undefined || before !== undefined) {
      if (after !== undefined && before !== undefined) {
        throw new BadRequestException('Use either after or before, not both');
      }
      try {
        const [key, date, id] = z
          .tuple([
            sort === 'filename' ? z.string().max(4096) : z.number().int().min(-1).max(5),
            z.iso.datetime({ offset: true }),
            z.uuid(),
          ])
          .parse(JSON.parse(after ?? before!));
        cursor = { key, date, id };
      } catch {
        throw new BadRequestException('Invalid ordered timeline cursor');
      }
    }
    // S-15: a shared link that hides EXIF may not sort by file name or rating; the order would reveal them
    if (auth.sharedLink && !auth.sharedLink.showExif) {
      throw new BadRequestException('This link does not allow sorting by file name or rating');
    }
    await this.timeBucketChecks(auth, bucketDto);
    const timeBucketOptions = this.buildTimeBucketOptions(auth, bucketDto);
    const page = await this.assetRepository.getTimelineOrdered(timeBucketOptions, auth, {
      sort,
      skip,
      take,
      ...(cursor && { cursor, reverse: before !== undefined }),
    });
    return page.assets;
  }

  /**
   * FL-33: curated Years and Months cards. The same checks and the same options as the time buckets,
   * so a card counts exactly what the matching bucket counts and never reveals more.
   */
  async getTimelineHighlights(auth: AuthDto, dto: TimelineHighlightsDto): Promise<TimelineHighlightResponseDto[]> {
    const { grouping, highlightCount, ...bucketDto } = dto;
    await this.timeBucketChecks(auth, bucketDto);
    const timeBucketOptions = this.buildTimeBucketOptions(auth, bucketDto);
    return this.assetRepository.getTimelineHighlights(timeBucketOptions, auth, {
      grouping,
      highlightCount: grouping === 'year' ? 0 : (highlightCount ?? TIMELINE_HIGHLIGHT_DEFAULT),
      // a shared link that hides EXIF hides places too, as its buckets do
      withPlaces: !auth.sharedLink || auth.sharedLink.showExif,
    });
  }

  private buildTimeBucketOptions(auth: AuthDto, dto: TimeBucketDto): TimeBucketOptions {
    const { userId, suppressedOnly, lockReason, ...options } = dto;
    let userIds: string[] | undefined;

    // FL-326 (spec §4.8): a timeline holds only its owner's rows; what partners share arrives as copies
    if (userId) {
      userIds = [userId];
    }

    return {
      ...options,
      // FL-195: for an elevated session this carries `revealLockedOwnerId`, so the owner's own Locked
      // items — marks, detections and those moved from the old Locked folder — show in every ordinary
      // view (timeline, archive, a person, a tag, an album filtered by visibility) like any other item
      ...getPrivacyQueryOptions(auth, suppressedOnly),
      // An album shows the viewer their own Locked members in an elevated session (owner decision,
      // September 22, 2026). The main timeline never does: the Locked view is its own view.
      ...(dto.albumId && getLockedVisibilityOptions(auth)),
      userIds,
      ...(lockReason && { lockReasons: [lockReason] }),
      // FL-34: the Locked view also lists what the owner's Locked rules hide (the prototype's
      // `classifyLocked`); the checks above only let the owner's elevated session ask for it
      ...(dto.visibility === AssetVisibility.Locked &&
        !lockReason &&
        auth.suppressedContent && { lockedRuleMatches: auth.suppressedContent }),
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
  }
}

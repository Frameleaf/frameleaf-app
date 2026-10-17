import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Activity } from 'src/database.js';
import {
  ActivityCreateDto,
  ActivityDto,
  ActivityResponseDto,
  ActivitySearchDto,
  ActivityStatisticsResponseDto,
  MaybeDuplicate,
  ReactionLevel,
  ReactionType,
  mapActivity,
} from 'src/dtos/activity.dto.js';
import { Permission, SharedSpaceEventType } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { isSharedSpace, requireSpaceMember } from 'src/utils/shared-space.js';

@Injectable()
export class ActivityService extends BaseService {
  async getAll(auth: AuthDto, dto: ActivitySearchDto): Promise<ActivityResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [dto.albumId] });
    const activities = await this.activityRepository.search({
      userId: dto.userId,
      albumId: dto.albumId,
      assetId: dto.level === ReactionLevel.ALBUM ? null : dto.assetId,
      isLiked: dto.type && dto.type === ReactionType.LIKE,
      ...this.nsfwOptions(auth),
      ...getLockedVisibilityOptions(auth),
    });

    return activities.map((activity) => mapActivity(activity));
  }

  async getStatistics(auth: AuthDto, dto: ActivityDto): Promise<ActivityStatisticsResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [dto.albumId] });
    return await this.activityRepository.getStatistics({
      albumId: dto.albumId,
      assetId: dto.assetId,
      ...this.nsfwOptions(auth),
      ...getLockedVisibilityOptions(auth),
    });
  }

  async create(auth: AuthDto, dto: ActivityCreateDto): Promise<MaybeDuplicate<ActivityResponseDto>> {
    await this.requireAccess({ auth, permission: Permission.ActivityCreate, ids: [dto.albumId] });
    if (auth.hideNsfwAssets && dto.assetId) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.assetId] });
    }

    const common = {
      userId: auth.user.id,
      assetId: dto.assetId,
      albumId: dto.albumId,
    };
    // the duplicate-like check reads only the caller's own reactions, so it keeps Locked items in view:
    // a like the caller already left on an item that has since been locked is still a duplicate
    const searchCommon = { ...common, ...this.nsfwOptions(auth), includeLocked: true };

    let activity: Activity | undefined;
    let isDuplicate = false;

    if (dto.type === ReactionType.LIKE) {
      delete dto.comment;
      [activity] = await this.activityRepository.search({
        ...searchCommon,
        // `null` will search for an album like
        assetId: dto.assetId ?? null,
        isLiked: true,
      });
      isDuplicate = !!activity;
    }

    if (!activity) {
      activity = await this.activityRepository.create({
        ...common,
        isLiked: dto.type === ReactionType.LIKE,
        comment: dto.comment,
      });
      await this.recordSpaceEvent(auth, dto.albumId, activity);
    }

    return { duplicate: isDuplicate, value: mapActivity(activity) };
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.ActivityDelete, ids: [id] });

    // FL-55: in a shared space, only a current member may remove anything, and a comment takes its
    // replies with it — the same rules as the space's own comment endpoint, whichever one is used.
    const activity = await this.activityRepository.getById(id);
    const album = activity ? await this.albumRepository.getById(activity.albumId, { withAssets: false }) : undefined;
    if (album && isSharedSpace(album)) {
      requireSpaceMember(album, auth.user.id);
      await this.albumUserRepository.deleteCommentWithReplies(id);
      return;
    }

    await this.activityRepository.delete(id);
  }

  /**
   * A like or comment on a shared space is also an entry in the space's
   * activity feed (FL-55). The event row points at the activity and cascades
   * with it, so deleting the reaction takes it out of the feed too. Nothing
   * here reads the asset: what members see of the event is filtered when the
   * feed is read, per viewer.
   */
  private async recordSpaceEvent(auth: AuthDto, albumId: string, activity: Activity) {
    const album = await this.albumRepository.getById(albumId, { withAssets: false });
    if (!album || !isSharedSpace(album)) {
      return;
    }

    await this.albumUserRepository.createSpaceEvent({
      albumId,
      actorId: auth.user.id,
      type: activity.isLiked ? SharedSpaceEventType.Like : SharedSpaceEventType.Comment,
      activityId: activity.id,
    });
  }

  private nsfwOptions(auth: AuthDto) {
    return getHiddenContentQueryOptions(auth);
  }
}

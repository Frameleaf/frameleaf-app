import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { AlbumMoveAssetsDto, AlbumTransferDto } from 'src/dtos/album-actions.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { IBulkAsset } from 'src/types.js';
import { asAlbumKind } from 'src/dtos/album.dto.js';
import { BulkIdErrorReason, BulkIdResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { AlbumKind, AlbumUserRole, Permission, PushEventType, SharedSpaceEventType } from 'src/enum.js';
import { AlbumOriginField } from 'src/repositories/partner-origin.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { recordAlbumEdit } from 'src/services/partner-copy.service.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';

/** Reads membership through `bulk` but writes nothing, so the add and remove rules can be asked before either runs. */
const dryRun = (bulk: IBulkAsset): IBulkAsset => ({
  getAssetIds: (id, assetIds) => bulk.getAssetIds(id, assetIds),
  addAssetIds: () => Promise.resolve(),
  removeAssetIds: () => Promise.resolve(),
});

/**
 * FL-846: moving photos between albums and handing an album to someone else. Album merge is FL-1298's
 * `AlbumMergeService`. The add/remove follow-ups (covers, locks, smart-album decisions, partner copies) are
 * `AlbumService`'s, so a move behaves exactly like a removal from one album and an addition to the other.
 */
@Injectable()
export class AlbumActionsService extends BaseService {
  private get albums() {
    return BaseService.create(AlbumService, this);
  }

  /**
   * Takes photos out of this album and puts them in `targetAlbumId`, in one transaction. Only membership
   * changes: nothing is trashed or deleted. A photo is moved only when it could both be removed from this
   * album and added to the target by hand; otherwise it stays where it is. One already in the target just
   * leaves this album.
   */
  async moveAssets(auth: AuthDto, id: string, dto: AlbumMoveAssetsDto): Promise<BulkIdResponseDto[]> {
    const { targetAlbumId } = dto;
    if (targetAlbumId === id) {
      throw new BadRequestException('Choose a different album to move to');
    }
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [targetAlbumId] });

    const albums = this.albums;
    const source = await albums.findOrFail(id, auth, { withAssets: false });
    const target = await albums.findOrFail(targetAlbumId, auth, { withAssets: false });
    if (asAlbumKind(target.kind) !== AlbumKind.Album) {
      throw new BadRequestException('Photos can only be moved into an album, not a collection or shared space');
    }
    albums.requireAppMayAddTo(auth, target);

    const assetIds = [...new Set(dto.assetIds)];
    const ids = [id, targetAlbumId];
    const { results, added } = await this.partnerOriginRepository.withOriginEdit('album', ids, [], () =>
      this.albumRepository.withMembershipWrite(ids, async (_tx, bulk) => {
        const repositories = { access: this.accessRepository, bulk: dryRun(bulk) };
        const removal = await removeAssets(auth, repositories, {
          parentId: id,
          assetIds,
          canAlwaysRemove: Permission.AlbumDelete,
        });
        const removable = removal.filter(({ success }) => success).map(({ id }) => id);
        const addition = new Map(
          (
            await addAssets(auth, repositories, {
              parentId: targetAlbumId,
              assetIds: removable,
              permission: Permission.AssetShare,
            })
          ).map((result) => [result.id, result]),
        );

        const results: BulkIdResponseDto[] = removal.map((result) => {
          if (!result.success) {
            return result;
          }
          const add = addition.get(result.id);
          // Already in the target is fine: the photo only has to leave this album.
          return add?.success || add?.error === BulkIdErrorReason.DUPLICATE
            ? result
            : { id: result.id, success: false, error: BulkIdErrorReason.NO_PERMISSION };
        });
        const moved = results.filter(({ success }) => success).map(({ id }) => id);
        const added = moved.filter((assetId) => addition.get(assetId)?.success);
        if (moved.length > 0) {
          await bulk.addAssetIds(targetAlbumId, added);
          await bulk.removeAssetIds(id, moved);
          await this.partnerOriginRepository.markOverridden('album', added.length > 0 ? ids : [id], [
            AlbumOriginField.Membership,
          ]);
        }
        return { results, added };
      }),
    );

    const moved = results.filter(({ success }) => success).map(({ id }) => id);
    if (moved.length === 0) {
      return results;
    }

    // The target, as after an addition.
    await albums.lockAddedItems(targetAlbumId, added);
    await this.emitAssetsChanged(moved);
    await this.classificationRepository.recordAlbumAdditions(targetAlbumId, added, auth.user.id);
    const shown = await albums.shownToMembers(added);
    if (shown.length > 0) {
      await this.albumRepository.update(
        targetAlbumId,
        {
          id: targetAlbumId,
          updatedAt: new Date(),
          albumThumbnailAssetId: target.albumThumbnailAssetId ?? (await albums.firstCoverCandidate(auth, shown)),
        },
        auth.user.id,
      );
    }
    if (added.length > 0) {
      await this.albumRepository.updateNewestCovers([targetAlbumId]);
      await this.eventRepository.emit('AlbumUpdate', albums.albumUpdateEvent(target, auth, shown.length > 0));
    }

    // The source, as after a removal.
    const isOwner = source.albumUsers.some(
      ({ role, user }) => role === AlbumUserRole.Owner && user.id === auth.user.id,
    );
    await albums.recordSmartAlbumRemovals(id, moved, auth.user.id, isOwner);
    if (source.albumThumbnailAssetId && moved.includes(source.albumThumbnailAssetId)) {
      await this.albumRepository.updateThumbnails([id]);
    }
    await this.eventRepository.emit('AlbumUpdate', {
      id,
      userIds: source.albumUsers.map(({ user }) => user.id),
      recipientIds: [],
    });
    await albums.recordSpaceAssets(source, auth, SharedSpaceEventType.AssetsRemoved, moved);

    // FL-326 (spec §4.4): membership changed by hand stops a copy following; copies of these albums follow
    await recordAlbumEdit(
      { partnerOrigin: this.partnerOriginRepository, job: this.jobRepository },
      added.length > 0 ? ids : [id],
      [AlbumOriginField.Membership],
    );

    return results;
  }

  /**
   * Hands the album to someone else. Only its owner may; they stay on as an editor. The new owner is someone
   * already in the album, or a partner the owner shares a library with (either way round).
   */
  async transfer(auth: AuthDto, id: string, { userId }: AlbumTransferDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    const album = await this.albums.findOrFail(id, auth, { withAssets: false });
    const owner = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner);
    if (owner?.user.id !== auth.user.id) {
      throw new ForbiddenException('Only the album owner can hand it to someone else');
    }
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });

    if (userId === auth.user.id) {
      throw new BadRequestException('You already own this album');
    }
    if (album.isLocked) {
      // A locked album locks its owner's items: a new owner would see their own photos leave the Timeline.
      throw new BadRequestException('Unlock the album before handing it to someone else');
    }

    const [builtIn, ruled, origins] = await Promise.all([
      this.smartAlbumRepository.getSmartBackedAlbumKinds([id]),
      this.classificationRepository.getRuleAlbumIds([id]),
      this.partnerOriginRepository.getOriginLabels('album', [id], auth.user.id),
    ]);
    if (builtIn.size > 0 || ruled.size > 0) {
      throw new BadRequestException('Smart albums follow their owner’s rules, so they cannot be handed over');
    }
    if (origins.size > 0) {
      throw new BadRequestException('An album shared from a partner follows theirs, so it cannot be handed over');
    }

    const member = album.albumUsers.some(({ user }) => user.id === userId);
    if (!member) {
      // Nobody joins a shared space without accepting an invitation, so its new owner must already be in it.
      if (asAlbumKind(album.kind) === AlbumKind.Space) {
        throw new BadRequestException('A shared space can only be handed to one of its members');
      }
      const user = await this.userRepository.get(userId, {});
      const [sharedWith, sharedBy] = user
        ? await Promise.all([
            this.partnerRepository.get({ sharedById: auth.user.id, sharedWithId: userId }),
            this.partnerRepository.get({ sharedById: userId, sharedWithId: auth.user.id }),
          ])
        : [];
      if (!sharedWith && !sharedBy) {
        throw new BadRequestException('Invalid user');
      }
    }

    if (!(await this.albumUserRepository.transferOwnership(id, auth.user.id, userId))) {
      throw new BadRequestException('The album changed hands meanwhile');
    }

    const albums = this.albums;
    const everyone = album.albumUsers.map(({ user }) => user.id);
    albums.sendAccessChange(album, auth.user.id, AlbumUserRole.Editor);
    albums.sendAccessChange(album, userId, AlbumUserRole.Owner);
    await this.eventRepository.emit('AlbumUpdate', {
      id,
      userIds: member ? everyone : [...everyone, userId],
      recipientIds: [],
    });
    await this.eventRepository.emit('PushNotify', {
      type: PushEventType.AccessChanged,
      userIds: [userId],
      title: 'Access changed',
      body: `Your role in ${album.albumName} is now ${AlbumUserRole.Owner}`,
      systemTemplate: { version: 1, key: `album-role-${AlbumUserRole.Owner}`, args: { albumName: album.albumName } },
      data: { albumId: id, change: 'role', role: AlbumUserRole.Owner },
    });
    if (asAlbumKind(album.kind) === AlbumKind.Space) {
      await this.albumUserRepository.createSpaceEvent({
        albumId: id,
        actorId: auth.user.id,
        type: SharedSpaceEventType.MemberRoleChanged,
        targetUserId: userId,
        subject: AlbumUserRole.Owner,
      });
    }
    this.logger.log(`Album ${id} handed from ${auth.user.id} to ${userId}`);
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumResponseDto, mapAlbum } from 'src/dtos/album.dto.js';
import {
  SharedSpaceMemberResponseDto,
  SharedSpaceMembersResponseDto,
  SharedSpacePreviewResponseDto,
} from 'src/dtos/shared-space.dto.js';
import { mapUser } from 'src/dtos/user.dto.js';
import { AlbumUserRole, Permission } from 'src/enum.js';
import { SharedSpaceInvite } from 'src/repositories/album-user.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { asDateTimeString } from 'src/utils/date.js';
import { isSpaceMember, requireSharedSpace, requireSpaceOwner, spaceOwnerId } from 'src/utils/shared-space.js';

/**
 * Shared spaces (FL-55).
 *
 * A shared space is an album row with `kind = 'space'`, so everything about its
 * photos — membership, roles, activity, cover, download, sensitive and Locked
 * semantics — is the album behaviour, checked by the album access rules. This
 * service owns only the part a space adds: you are invited to a space, you see
 * what it exposes, and then you accept or decline.
 *
 * The invitation is not a membership. Until it is accepted the recipient has no
 * `album_user` row, so no access check, listing, sync feed or activity rule can
 * reach the space through it, and the preview below is the only thing they can
 * read. The preview carries no asset of any kind and its counts exclude media
 * marked sensitive and Locked media, so nothing is disclosed by the numbers
 * either.
 */
@Injectable()
export class SharedSpaceService extends BaseService {
  /** Every space this person has been invited to and has not answered. */
  async getInvitations(auth: AuthDto): Promise<SharedSpacePreviewResponseDto[]> {
    const invites = await this.albumUserRepository.getInvitesForUser(auth.user.id);
    const previews: SharedSpacePreviewResponseDto[] = [];
    for (const invite of invites) {
      const preview = await this.buildPreview(invite.albumId, invite, false);
      if (preview) {
        previews.push(preview);
      }
    }
    return previews;
  }

  /**
   * What the space exposes, for someone holding an invitation to it or already
   * in it. Anyone else is told nothing, including whether the space exists.
   */
  async getPreview(auth: AuthDto, id: string): Promise<SharedSpacePreviewResponseDto> {
    const invite = await this.albumUserRepository.getInvite({ albumId: id, userId: auth.user.id });
    const album = await this.albumRepository.getById(id, { withAssets: false }, auth.user.id);
    if (!album) {
      throw new NotFoundException('Shared space not found');
    }
    requireSharedSpace(album);

    const accepted = isSpaceMember(album, auth.user.id);
    if (!invite && !accepted) {
      throw new NotFoundException('Shared space not found');
    }

    const preview = await this.buildPreview(id, invite, accepted);
    if (!preview) {
      throw new NotFoundException('Shared space not found');
    }
    return preview;
  }

  /**
   * Join the space with the role the owner offered. The invitation is the only
   * way in, so there is nothing to check beyond holding one: the role comes from
   * the stored invitation, never from the request.
   */
  async accept(auth: AuthDto, id: string): Promise<AlbumResponseDto> {
    const invite = await this.albumUserRepository.getInvite({ albumId: id, userId: auth.user.id });
    if (!invite) {
      throw new NotFoundException('No invitation to this shared space');
    }

    const album = await this.albumRepository.getById(id, { withAssets: false }, auth.user.id);
    if (!album) {
      throw new NotFoundException('Shared space not found');
    }
    requireSharedSpace(album);

    if (!isSpaceMember(album, auth.user.id)) {
      await this.albumUserRepository.create({ albumId: id, userId: auth.user.id, role: invite.role });
    }
    await this.albumUserRepository.deleteInvite({ albumId: id, userId: auth.user.id });

    const joined = await this.albumRepository.getById(id, { withAssets: false }, auth.user.id);
    if (!joined) {
      throw new NotFoundException('Shared space not found');
    }
    const userIds = joined.albumUsers.map(({ user }) => user.id);
    await this.eventRepository.emit('AlbumUpdate', { id, userIds, recipientIds: [] });

    return mapAlbum(joined);
  }

  /** Decline the invitation. Nothing else changes and the owner keeps the space. */
  async decline(auth: AuthDto, id: string): Promise<void> {
    const invite = await this.albumUserRepository.getInvite({ albumId: id, userId: auth.user.id });
    if (!invite) {
      throw new NotFoundException('No invitation to this shared space');
    }
    await this.albumUserRepository.deleteInvite({ albumId: id, userId: auth.user.id });
  }

  /**
   * Who is in the space and who has been invited. Any member may see the roster —
   * they can already see each other on the album — but only the owner may change it.
   */
  async getMembers(auth: AuthDto, id: string): Promise<SharedSpaceMembersResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    const album = await this.albumRepository.getById(id, { withAssets: false }, auth.user.id);
    if (!album) {
      throw new NotFoundException('Shared space not found');
    }
    requireSharedSpace(album);

    const members: SharedSpaceMemberResponseDto[] = album.albumUsers.map(({ user, role }) => ({
      user: mapUser(user),
      role,
      pending: false,
    }));

    const invites = await this.albumUserRepository.getInvitesForAlbum(id);
    for (const invite of invites) {
      const user = await this.userRepository.get(invite.userId, {});
      if (!user) {
        continue;
      }
      members.push({
        user: mapUser(user),
        role: invite.role,
        pending: true,
        invitedAt: asDateTimeString(invite.createdAt),
      });
    }

    return { members };
  }

  /**
   * Withdraw a pending invitation. Removing someone who has already joined is the
   * album's own remove-member endpoint; this only reaches people who never joined.
   */
  async removeInvitation(auth: AuthDto, id: string, userId: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    const album = await this.albumRepository.getById(id, { withAssets: false }, auth.user.id);
    if (!album) {
      throw new NotFoundException('Shared space not found');
    }
    requireSharedSpace(album);
    requireSpaceOwner(album, auth.user.id);

    const invite = await this.albumUserRepository.getInvite({ albumId: id, userId });
    if (!invite) {
      throw new BadRequestException('No invitation to withdraw');
    }
    await this.albumUserRepository.deleteInvite({ albumId: id, userId });
  }

  /**
   * The safe summary. Counts and dates come from the album metadata query with
   * `excludeNsfw`, which also drops Locked media through the default visibility
   * filter, so a sensitive item never appears in, and never shifts, what a
   * recipient is shown.
   */
  private async buildPreview(
    id: string,
    invite: SharedSpaceInvite | undefined,
    accepted: boolean,
  ): Promise<SharedSpacePreviewResponseDto | null> {
    const album = await this.albumRepository.getById(id, { withAssets: false });
    if (!album) {
      return null;
    }

    const ownerId = spaceOwnerId(album);
    const owner = album.albumUsers.find(({ user }) => user.id === ownerId)?.user;
    if (!owner) {
      return null;
    }

    const [metadata] = await this.albumRepository.getMetadataForIds([id], { excludeNsfw: true });
    const invitedBy = invite?.invitedById
      ? ((await this.userRepository.get(invite.invitedById, {})) ?? null)
      : null;

    return {
      id: album.id,
      albumName: album.albumName,
      description: album.description ?? '',
      icon: album.icon,
      owner: mapUser(owner),
      invitedBy: invitedBy ? mapUser(invitedBy) : null,
      role: invite?.role ?? AlbumUserRole.Viewer,
      invitedAt: asDateTimeString(invite?.createdAt ?? album.createdAt),
      accepted,
      memberCount: album.albumUsers.length,
      assetCount: metadata?.assetCount ?? 0,
      startDate: asDateTimeString(metadata?.startDate ?? undefined),
      endDate: asDateTimeString(metadata?.endDate ?? undefined),
    };
  }
}

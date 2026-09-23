import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumResponseDto, mapAlbum } from 'src/dtos/album.dto.js';
import {
  SharedSpaceAlbumResponseDto,
  SharedSpaceAlbumsResponseDto,
  SharedSpaceMemberResponseDto,
  SharedSpaceMembersResponseDto,
  SharedSpaceNewResponseDto,
  SharedSpacePeopleResponseDto,
  SharedSpacePersonLinkDto,
  SharedSpacePersonResponseDto,
  SharedSpacePreviewResponseDto,
} from 'src/dtos/shared-space.dto.js';
import { mapUser } from 'src/dtos/user.dto.js';
import { AlbumUserRole, Permission } from 'src/enum.js';
import { SharedSpaceInvite } from 'src/repositories/album-user.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { asDateString, asDateTimeString } from 'src/utils/date.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import {
  canUnlink,
  isSpaceMember,
  requireLinkableAlbum,
  requireSharedSpace,
  requireSpaceContributor,
  requireSpaceMember,
  requireSpaceOwner,
  requireUnlinkRights,
  spaceOwnerId,
} from 'src/utils/shared-space.js';

/**
 * What every read of a shared space's content excludes.
 *
 * `excludeNsfw` drops media marked sensitive and, through the default
 * visibility filter the same queries apply, Locked media — for every owner, not
 * only the viewer. A space is shared by definition, so the panels err towards
 * the stricter reading: a member's sensitive photo is never counted, mapped,
 * used as somebody's face, or announced as "new" to anybody else, and it does
 * not shift a number either. Every query these options are handed is also
 * confined to the space's own assets, so nothing outside the space can reach a
 * panel in the first place.
 */
const SPACE_CONTENT_OPTIONS: HiddenContentQueryOptions = { excludeNsfw: true };

/** How many "new since your last visit" ids the client is given to filter a timeline with. */
const NEW_ASSET_LIMIT = 500;

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

  /* ------------------------------------------------------------------ */
  /* The space page's panels (FL-55)                                     */
  /* ------------------------------------------------------------------ */

  /** The albums members have linked into this space. */
  async getLinkedAlbums(auth: AuthDto, id: string): Promise<SharedSpaceAlbumsResponseDto> {
    const space = await this.requireSpaceMembership(auth, id);

    const links = await this.albumUserRepository.getLinkedAlbums(id);
    const counts = await this.albumUserRepository.getLinkedAlbumCounts(
      id,
      links.map(({ linkedAlbumId }) => linkedAlbumId),
      SPACE_CONTENT_OPTIONS,
    );
    const countById = new Map(counts.map((count) => [count.albumId, count]));

    const albums: SharedSpaceAlbumResponseDto[] = [];
    for (const link of links) {
      const count = countById.get(link.linkedAlbumId);
      const linkedBy = link.linkedById ? ((await this.userRepository.get(link.linkedById, {})) ?? null) : null;
      albums.push({
        id: link.linkedAlbumId,
        albumName: link.linkedAlbumName,
        icon: link.linkedAlbumIcon,
        linkedBy: linkedBy ? mapUser(linkedBy) : null,
        linkedAt: asDateTimeString(link.createdAt),
        assetCount: count?.assetCount ?? 0,
        thumbnailAssetId: count?.thumbnailAssetId ?? null,
        canUnlink: canUnlink(space, auth.user.id, link.linkedById),
      });
    }

    return { albums };
  }

  /**
   * Point the space at one of the caller's albums.
   *
   * Two checks and no side effects. The caller must be able to contribute to
   * the space, and must already be able to read the album — `Permission.
   * AlbumRead` on the album itself, so linking can never be used to reach
   * somebody else's album. Beyond writing the reference, nothing happens: no
   * asset moves, no `album_user` grant changes, and the album stays exactly
   * where its owner put it in their own tree.
   */
  async linkAlbum(auth: AuthDto, id: string, albumId: string): Promise<SharedSpaceAlbumsResponseDto> {
    const space = await this.requireSpaceMembership(auth, id);
    requireSpaceContributor(space, auth.user.id);

    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [albumId] });
    const album = await this.albumRepository.getById(albumId, { withAssets: false }, auth.user.id);
    if (!album) {
      throw new NotFoundException('Album not found');
    }
    requireLinkableAlbum(space, album);

    await this.albumUserRepository.createLinkedAlbum({ albumId: id, linkedAlbumId: albumId, linkedById: auth.user.id });

    return this.getLinkedAlbums(auth, id);
  }

  /** Remove the reference and only the reference. */
  async unlinkAlbum(auth: AuthDto, id: string, albumId: string): Promise<void> {
    const space = await this.requireSpaceMembership(auth, id);

    const link = await this.albumUserRepository.getLinkedAlbum(id, albumId);
    if (!link) {
      throw new NotFoundException('That album is not linked into this shared space');
    }
    requireUnlinkRights(space, auth.user.id, link.linkedById);

    await this.albumUserRepository.deleteLinkedAlbum(id, albumId);
  }

  /**
   * The people panel: who this space has been told about, and who the caller
   * could tell it about next.
   *
   * The two halves are deliberately asymmetric. `linked` is what members have
   * published into the space and carries only the space's own identity for
   * somebody — a name, a picture already in the space and a count. `candidates`
   * is the caller's *own* people, seen on the space's assets: their own library,
   * their own names, disclosed to nobody. There is no third list of "people
   * other members have in their libraries", because that would be exactly the
   * disclosure this shape exists to avoid.
   */
  async getPeople(auth: AuthDto, id: string): Promise<SharedSpacePeopleResponseDto> {
    const space = await this.requireSpaceMembership(auth, id);

    const links = await this.albumUserRepository.getLinkedPeople(id);
    const counts = await this.albumUserRepository.getLinkedPersonCounts(
      id,
      links.map(({ personGroupId }) => personGroupId),
      SPACE_CONTENT_OPTIONS,
    );
    const countByGroup = new Map(counts.map(({ personGroupId, assetCount }) => [personGroupId, assetCount]));

    const linked: SharedSpacePersonResponseDto[] = [];
    for (const link of links) {
      const linkedBy = await this.userRepository.get(link.personOwnerId, {});
      if (!linkedBy) {
        continue;
      }
      linked.push({
        id: link.id,
        name: link.name,
        coverAssetId: link.coverAssetId,
        assetCount: countByGroup.get(link.personGroupId) ?? 0,
        linkedBy: mapUser(linkedBy),
        linkedAt: asDateTimeString(link.createdAt),
        canUnlink: canUnlink(space, auth.user.id, link.personOwnerId),
      });
    }

    const alreadyLinked = new Set(
      links.filter(({ personOwnerId }) => personOwnerId === auth.user.id).map(({ personGroupId }) => personGroupId),
    );
    const candidates = await this.albumUserRepository.getSpacePersonCandidates(
      id,
      auth.user.id,
      SPACE_CONTENT_OPTIONS,
    );

    return {
      linked,
      candidates: candidates
        .filter(({ personGroupId }) => !alreadyLinked.has(personGroupId))
        .map((candidate) => ({
          id: candidate.personGroupId,
          name: candidate.name,
          birthDate: asDateString(candidate.birthDate),
          thumbnailPath: candidate.thumbnailPath,
          isHidden: candidate.isHidden,
          isFavorite: candidate.isFavorite,
          color: candidate.color ?? undefined,
          updatedAt: asDateTimeString(candidate.updatedAt),
        })),
    };
  }

  /**
   * Publish one of the caller's own people into the space.
   *
   * The person must be theirs: `getByGroupId` is scoped to the caller, so there
   * is no way to link somebody else's identity. What the space stores is a name
   * of its own — the caller's name for them by default, but theirs to change —
   * and a cover chosen from the assets already in the space. The caller's own
   * `person` row is not touched, and re-linking the same person rewrites this
   * link rather than creating a second one.
   */
  async linkPerson(auth: AuthDto, id: string, dto: SharedSpacePersonLinkDto): Promise<SharedSpacePeopleResponseDto> {
    const space = await this.requireSpaceMembership(auth, id);
    requireSpaceContributor(space, auth.user.id);

    const person = await this.personRepository.getByGroupId({
      ownerId: auth.user.id,
      personGroupId: dto.personId,
    });
    if (!person) {
      throw new NotFoundException('Person not found');
    }

    const coverAssetId = await this.albumUserRepository.getLinkedPersonCoverAssetId(
      id,
      dto.personId,
      SPACE_CONTENT_OPTIONS,
    );

    await this.albumUserRepository.createLinkedPerson({
      albumId: id,
      personOwnerId: auth.user.id,
      personGroupId: dto.personId,
      name: dto.name?.trim() || person.name,
      coverAssetId,
    });

    return this.getPeople(auth, id);
  }

  /**
   * Take a person back out of the space.
   *
   * This deletes the link row and nothing else. The person, their name, their
   * faces, every asset that shows them and the space's own contents are all
   * exactly as they were; the space simply stops naming that face.
   */
  async unlinkPerson(auth: AuthDto, id: string, linkId: string): Promise<void> {
    const space = await this.requireSpaceMembership(auth, id);

    const link = await this.albumUserRepository.getLinkedPerson(linkId);
    if (!link || link.albumId !== id) {
      throw new NotFoundException('That person is not linked into this shared space');
    }
    requireUnlinkRights(space, auth.user.id, link.personOwnerId);

    await this.albumUserRepository.deleteLinkedPerson(linkId);
  }

  /** What other members have added since this member last marked the space seen. */
  async getNew(auth: AuthDto, id: string): Promise<SharedSpaceNewResponseDto> {
    await this.requireSpaceMembership(auth, id);

    const visit = await this.albumUserRepository.getSpaceVisit({ albumId: id, userId: auth.user.id });
    const since = visit?.lastSeenAt;
    const args = { since, viewerId: auth.user.id };

    const [assetCount, assetIds] = await Promise.all([
      this.albumUserRepository.getSpaceNewAssetCount(id, args, SPACE_CONTENT_OPTIONS),
      this.albumUserRepository.getSpaceNewAssetIds(id, { ...args, take: NEW_ASSET_LIMIT }, SPACE_CONTENT_OPTIONS),
    ]);

    return {
      lastVisitedAt: visit ? asDateTimeString(visit.lastSeenAt) : null,
      assetCount,
      assetIds,
    };
  }

  /**
   * Mark the space seen, now.
   *
   * This is an explicit acknowledgement, not something loading the page does.
   * If opening a space cleared the badge, somebody who glanced at it on a phone
   * would lose the list of what they had not looked at yet.
   */
  async markVisited(auth: AuthDto, id: string): Promise<SharedSpaceNewResponseDto> {
    await this.requireSpaceMembership(auth, id);
    await this.albumUserRepository.setSpaceVisit({ albumId: id, userId: auth.user.id }, new Date());
    return this.getNew(auth, id);
  }

  /**
   * Every panel starts here: this must be a shared space, and the caller must
   * be in it. Holding an invitation is not enough — the preview is all an
   * invitation gets — and neither is a shared link, which is never a member.
   */
  private async requireSpaceMembership(auth: AuthDto, id: string) {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    const album = await this.albumRepository.getById(id, { withAssets: false }, auth.user.id);
    if (!album) {
      throw new NotFoundException('Shared space not found');
    }
    requireSharedSpace(album);
    requireSpaceMember(album, auth.user.id);
    return album;
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

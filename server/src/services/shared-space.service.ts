import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { AlbumResponseDto, mapAlbum } from 'src/dtos/album.dto.js';
import {
  RecipientGroupCreateDto,
  RecipientGroupResponseDto,
  RecipientGroupUpdateDto,
  SharedSpaceActivityResponseDto,
  SharedSpaceActivitySearchDto,
  SharedSpaceAlbumResponseDto,
  SharedSpaceAlbumsResponseDto,
  SharedSpaceCommentCreateDto,
  SharedSpaceCommentResponseDto,
  SharedSpaceCommentSearchDto,
  SharedSpaceCommentUpdateDto,
  SharedSpaceCommentsResponseDto,
  SharedSpaceEventResponseDto,
  SharedSpaceMemberResponseDto,
  SharedSpaceMembersResponseDto,
  SharedSpaceNewResponseDto,
  SharedSpacePeopleResponseDto,
  SharedSpacePersonLinkDto,
  SharedSpacePersonResponseDto,
  SharedSpacePreviewResponseDto,
} from 'src/dtos/shared-space.dto.js';
import { UserResponseDto, mapUser } from 'src/dtos/user.dto.js';
import { AlbumUserRole, Permission, SharedSpaceEventType } from 'src/enum.js';
import { RecipientGroup, SharedSpaceEvent, SharedSpaceInvite } from 'src/repositories/album-user.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { asDateString, asDateTimeString } from 'src/utils/date.js';
import {
  type CommentThreadInfo,
  type SpaceLike,
  canDeleteSpaceComment,
  canEditSpaceComment,
  canUnlink,
  isCommentEventType,
  isNewSpaceEvent,
  isSpaceMember,
  narrowSpaceEvent,
  parseMentions,
  replyRecipient,
  requireCommentDeleteRights,
  requireCommentEditRights,
  requireLinkableAlbum,
  requireMentionableMembers,
  requireReplyOnSameItem,
  requireSharedSpace,
  requireSpaceContributor,
  requireSpaceMember,
  requireSpaceOwner,
  requireUnlinkRights,
  spaceOwnerId,
  threadComments,
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

/** How many feed events a page carries by default, and the most the unread count will inspect. */
const ACTIVITY_PAGE = 50;
const UNREAD_EVENT_LIMIT = 500;

/**
 * What one member may see of a space's media, for the feed and the comments.
 *
 * Their own hidden-content settings apply, and on top of them the space's
 * stricter reading: media marked sensitive is excluded even for a member who
 * has turned that off for their own library, exactly as the other panels do
 * with `SPACE_CONTENT_OPTIONS`. Locked media is excluded by the default
 * visibility filter the same queries apply.
 */
const spaceViewerOptions = (auth: AuthDto): HiddenContentQueryOptions =>
  auth.hiddenContent ? { hiddenContent: { ...auth.hiddenContent, includeNsfw: true } } : SPACE_CONTENT_OPTIONS;

/** A comment with no thread row: top level, and no replies the caller can see. */
const TOP_LEVEL: CommentThreadInfo = { parentId: null, replyCount: 0 };

/** A per-request cache of user lookups, so a feed page names each person once. */
type UserMemo = { get: (userId: string | null) => Promise<UserResponseDto | null> };

/** What the comment endpoints need of an `activity` row. */
type CommentRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
  user: Parameters<typeof mapUser>[0];
  assetId: string | null;
  comment: string | null;
};

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
  /* ------------------------------------------------------------------------ */
  /* Named recipient shortcuts (FL-55)                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * The owner's saved groups of people to invite together. Only ever the caller's own: a group, its
   * name and who is in it are never shown to anyone else, the people in it included.
   */
  async getRecipientGroups(auth: AuthDto): Promise<RecipientGroupResponseDto[]> {
    const [groups, users] = await Promise.all([
      this.albumUserRepository.getRecipientGroups(auth.user.id),
      this.userRepository.getList({}),
    ]);
    return groups.map((group) => this.mapRecipientGroup(group, users));
  }

  /**
   * Save a named group. It is a shortcut only: nothing is shared and nobody is invited until the
   * owner applies it to a space and sends the invitations it proposes.
   */
  async createRecipientGroup(auth: AuthDto, dto: RecipientGroupCreateDto): Promise<RecipientGroupResponseDto> {
    const users = await this.userRepository.getList({});
    const userIds = this.recipientIds(auth, dto.userIds, users);
    const group = await this.albumUserRepository.createRecipientGroup(auth.user.id, dto.name, userIds);
    return this.mapRecipientGroup(group, users);
  }

  /**
   * Rename a group or change who is in it. Only the group changes: people already invited to or
   * members of a space keep exactly the access they have, and people added here are not invited
   * anywhere until the owner applies the group again.
   */
  async updateRecipientGroup(
    auth: AuthDto,
    id: string,
    dto: RecipientGroupUpdateDto,
  ): Promise<RecipientGroupResponseDto> {
    const users = await this.userRepository.getList({});
    const userIds = dto.userIds === undefined ? undefined : this.recipientIds(auth, dto.userIds, users);
    const group = await this.albumUserRepository.updateRecipientGroup(auth.user.id, id, { name: dto.name, userIds });
    if (!group) {
      throw new NotFoundException('Recipient group not found');
    }
    return this.mapRecipientGroup(group, users);
  }

  /** Delete a group. Nobody loses access to anything. */
  async deleteRecipientGroup(auth: AuthDto, id: string): Promise<void> {
    const deleted = await this.albumUserRepository.deleteRecipientGroup(auth.user.id, id);
    if (!deleted) {
      throw new NotFoundException('Recipient group not found');
    }
  }

  /** The people a group may hold: existing accounts other than the owner, each once. */
  private recipientIds(auth: AuthDto, ids: string[], users: { id: string }[]): string[] {
    const known = new Set(users.map(({ id }) => id));
    const wanted = [...new Set(ids)].filter((id) => id !== auth.user.id);
    if (wanted.some((id) => !known.has(id))) {
      throw new BadRequestException('Invalid user');
    }
    return wanted;
  }

  private mapRecipientGroup(group: RecipientGroup, users: Parameters<typeof mapUser>[0][]): RecipientGroupResponseDto {
    const byId = new Map(users.map((user) => [user.id, user]));
    return {
      id: group.id,
      name: group.name,
      users: group.userIds
        .map((id) => byId.get(id))
        .filter((user) => user !== undefined)
        .map((user) => mapUser(user))
        .sort((left, right) => left.name.localeCompare(right.name)),
      createdAt: asDateTimeString(group.createdAt),
      updatedAt: asDateTimeString(group.updatedAt),
    };
  }

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
      await this.albumUserRepository.createSpaceEvent({
        albumId: id,
        actorId: auth.user.id,
        type: SharedSpaceEventType.MemberJoined,
        targetUserId: auth.user.id,
      });
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
    await this.albumUserRepository.createSpaceEvent({
      albumId: id,
      actorId: auth.user.id,
      type: SharedSpaceEventType.AlbumLinked,
      subject: album.albumName,
    });

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
    await this.albumUserRepository.createSpaceEvent({
      albumId: id,
      actorId: auth.user.id,
      type: SharedSpaceEventType.AlbumUnlinked,
      subject: link.linkedAlbumName,
    });
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
    const candidates = await this.albumUserRepository.getSpacePersonCandidates(id, auth.user.id, SPACE_CONTENT_OPTIONS);

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

    const name = dto.name?.trim() || person.name;
    await this.albumUserRepository.createLinkedPerson({
      albumId: id,
      personOwnerId: auth.user.id,
      personGroupId: dto.personId,
      name,
      coverAssetId,
    });
    // The feed carries the space's own name for them, never the person's id or private name.
    await this.albumUserRepository.createSpaceEvent({
      albumId: id,
      actorId: auth.user.id,
      type: SharedSpaceEventType.PersonLinked,
      subject: name,
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
    await this.albumUserRepository.createSpaceEvent({
      albumId: id,
      actorId: auth.user.id,
      type: SharedSpaceEventType.PersonUnlinked,
      subject: link.name,
    });
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

  /* ------------------------------------------------------------------ */
  /* The activity feed (FL-55)                                           */
  /* ------------------------------------------------------------------ */

  /**
   * What happened in the space, newest first, as this member may see it.
   *
   * Every stored event is narrowed to the caller before it leaves: an asset
   * event keeps only the items they may see and that are still in the space,
   * a comment or like on an item they cannot see is dropped whole, and an
   * event with nothing visible left is not sent at all — so nothing about
   * Locked or sensitive media reaches a member through the feed, not even a
   * count. The unread count is computed the same way, over the events since
   * the caller's own last-seen marker, so it never counts what it would not
   * show.
   */
  async getActivity(
    auth: AuthDto,
    id: string,
    dto: SharedSpaceActivitySearchDto,
  ): Promise<SharedSpaceActivityResponseDto> {
    await this.requireSpaceMembership(auth, id);

    const take = dto.take ?? ACTIVITY_PAGE;
    const before = dto.before ? new Date(dto.before) : undefined;
    const visit = await this.albumUserRepository.getSpaceVisit({ albumId: id, userId: auth.user.id });
    const lastSeenAt = visit?.lastSeenAt;

    const [page, sinceVisit] = await Promise.all([
      this.albumUserRepository.getSpaceEvents(id, { before, take: take + 1 }),
      this.albumUserRepository.getSpaceEvents(id, { since: lastSeenAt, take: UNREAD_EVENT_LIMIT }),
    ]);

    const [visible, unread] = await Promise.all([
      this.narrowEvents(auth, id, page.slice(0, take)),
      this.narrowEvents(auth, id, sinceVisit),
    ]);

    const users = this.userMemo();
    const mentions = await this.mentionsByActivity(
      visible.filter(({ type }) => isCommentEventType(type)).map(({ activityId }) => activityId!),
    );
    const events: SharedSpaceEventResponseDto[] = [];
    for (const event of visible) {
      events.push({
        id: event.id,
        type: event.type,
        createdAt: asDateTimeString(event.createdAt),
        actor: await users.get(event.actorId),
        targetUser: await users.get(event.targetUserId),
        subject: event.subject,
        assetIds: event.assetIds,
        assetCount: event.assetCount,
        activityId: event.activityId,
        comment: isCommentEventType(event.type) ? event.activityComment : null,
        mentions: await this.mapMentions(mentions.get(event.activityId ?? '') ?? [], users),
      });
    }

    return {
      events,
      lastVisitedAt: visit ? asDateTimeString(visit.lastSeenAt) : null,
      unreadCount: unread.filter((event) => isNewSpaceEvent(event, auth.user.id, lastSeenAt)).length,
      hasMore: page.length > take,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Comments on the space and its items (FL-55)                         */
  /* ------------------------------------------------------------------ */

  /**
   * The comments on one item in the space, or on the space itself. Oldest first,
   * flat: a reply names its top-level comment in `parentId`, and a top-level
   * comment carries how many replies the caller can see.
   */
  async getComments(
    auth: AuthDto,
    id: string,
    dto: SharedSpaceCommentSearchDto,
  ): Promise<SharedSpaceCommentsResponseDto> {
    const space = await this.requireSpaceMembership(auth, id);
    if (dto.assetId) {
      await this.requireVisibleSpaceAsset(auth, id, dto.assetId);
    }

    const rows = await this.activityRepository.search({
      albumId: id,
      assetId: dto.assetId ?? null,
      isLiked: false,
      ...spaceViewerOptions(auth),
    });
    const ids = rows.map(({ id }) => id);
    const [mentions, parents] = await Promise.all([
      this.mentionsByActivity(ids),
      this.albumUserRepository.getCommentParents(ids),
    ]);
    const threads = threadComments(ids, parents);
    const users = this.userMemo();

    const comments: SharedSpaceCommentResponseDto[] = [];
    for (const row of rows) {
      comments.push(
        await this.mapComment(space, auth, row, mentions.get(row.id) ?? [], users, threads.get(row.id) ?? TOP_LEVEL),
      );
    }
    return { comments };
  }

  /**
   * Write a comment, on an item or on the space, or a reply to one.
   *
   * The comment is an `activity` row, so the album's own rule applies too:
   * commenting must be enabled on the space. The item, if any, must be one
   * the caller can see and that is in the space. Mentions are parsed from
   * `@{userId}` tokens, every one must name a current member, and each
   * mentioned member other than the author gets a notification through the
   * ordinary notification system.
   *
   * A reply (`parentId`) is stored under the top-level comment of the thread,
   * even when it answers another reply, and is on the same item as that
   * comment. It is announced in the feed as a reply, and the author of the
   * top-level comment is told — in the app only — unless that is the replier,
   * they have left the space, or the reply already mentions them.
   */
  async createComment(
    auth: AuthDto,
    id: string,
    dto: SharedSpaceCommentCreateDto,
  ): Promise<SharedSpaceCommentResponseDto> {
    const space = await this.requireSpaceMembership(auth, id);
    await this.requireAccess({ auth, permission: Permission.ActivityCreate, ids: [id] });

    const root = dto.parentId ? await this.requireThreadRoot(auth, id, dto.parentId, dto.assetId) : null;
    const assetId = root ? root.assetId : (dto.assetId ?? null);
    if (!root && assetId) {
      await this.requireVisibleSpaceAsset(auth, id, assetId);
    }

    const mentioned = parseMentions(dto.comment);
    requireMentionableMembers(space, mentioned);

    const activity = await this.activityRepository.create({
      userId: auth.user.id,
      albumId: id,
      assetId,
      isLiked: false,
      comment: dto.comment,
    });

    if (root) {
      try {
        await this.albumUserRepository.createCommentThread({
          activityId: activity.id,
          parentActivityId: root.id,
          albumId: id,
        });
      } catch (error) {
        // Never leave a reply behind as a stray top-level comment.
        try {
          await this.activityRepository.delete(activity.id);
        } catch {
          // Keep the original error below; it is the one that explains what happened.
        }
        // The comment being answered was removed meanwhile: that is "not found", as for any comment that is gone.
        const parentStillThere = await this.activityRepository
          .getById(root.id)
          .then((found) => !!found)
          .catch(() => true);
        throw parentStillThere ? error : new NotFoundException('Comment not found');
      }
    }

    await this.albumUserRepository.createMentions(activity.id, mentioned);
    await this.albumUserRepository.createSpaceEvent(
      root
        ? {
            albumId: id,
            actorId: auth.user.id,
            type: SharedSpaceEventType.Reply,
            activityId: activity.id,
            targetUserId: root.userId,
          }
        : { albumId: id, actorId: auth.user.id, type: SharedSpaceEventType.Comment, activityId: activity.id },
    );
    await this.notifyMentioned(auth, id, assetId, activity.id, mentioned, []);

    const recipient = root ? replyRecipient(space, root, auth.user.id, mentioned) : null;
    if (root && recipient) {
      await this.eventRepository.emit('SharedSpaceReply', {
        id,
        assetId,
        activityId: activity.id,
        parentActivityId: root.id,
        userId: recipient,
        senderName: auth.user.name,
      });
    }

    return this.mapComment(space, auth, activity, mentioned, this.userMemo(), {
      parentId: root?.id ?? null,
      replyCount: 0,
    });
  }

  /** Change what a comment says. Only its author may; newly mentioned members are told. */
  async updateComment(
    auth: AuthDto,
    id: string,
    commentId: string,
    dto: SharedSpaceCommentUpdateDto,
  ): Promise<SharedSpaceCommentResponseDto> {
    const space = await this.requireSpaceMembership(auth, id);
    const existing = await this.requireSpaceComment(id, commentId);
    requireCommentEditRights(existing, auth.user.id);

    const mentioned = parseMentions(dto.comment);
    requireMentionableMembers(space, mentioned);

    const previous = (await this.albumUserRepository.getMentions([commentId])).map(({ userId }) => userId);
    const updated = await this.activityRepository.update(commentId, { comment: dto.comment });
    await this.albumUserRepository.deleteMentions(commentId);
    await this.albumUserRepository.createMentions(commentId, mentioned);
    await this.notifyMentioned(auth, id, updated.assetId, commentId, mentioned, previous);

    // Editing never moves a comment between threads; report where it already is.
    const [[parent], replies] = await Promise.all([
      this.albumUserRepository.getCommentParents([commentId]),
      this.albumUserRepository.getCommentReplies([commentId]),
    ]);

    return this.mapComment(space, auth, updated, mentioned, this.userMemo(), {
      parentId: parent?.parentActivityId ?? null,
      replyCount: parent ? 0 : replies.length,
    });
  }

  /**
   * Remove a comment. Its author may, and so may a space owner or editor —
   * that is moderation. The mentions and the feed entry go with it, and so do
   * its replies: removing a top-level comment removes its whole thread.
   */
  async deleteComment(auth: AuthDto, id: string, commentId: string): Promise<void> {
    const space = await this.requireSpaceMembership(auth, id);
    const existing = await this.requireSpaceComment(id, commentId);
    requireCommentDeleteRights(space, existing, auth.user.id);

    await this.albumUserRepository.deleteCommentWithReplies(commentId);
  }

  /**
   * The top-level comment a reply joins.
   *
   * The comment being answered must be one of this space's comments, on an
   * item the caller can see (or on the space itself); anything else is "not
   * found", with the same answer whichever it was, so a guessed id says
   * nothing about a comment on an item the caller cannot see. Answering a reply
   * joins that reply's own thread, so threads stay one level deep.
   */
  private async requireThreadRoot(auth: AuthDto, spaceId: string, parentId: string, assetId: string | undefined) {
    const replied = await this.requireSpaceComment(spaceId, parentId);
    const [thread] = await this.albumUserRepository.getCommentParents([replied.id]);
    const root = thread ? await this.requireSpaceComment(spaceId, thread.parentActivityId) : replied;

    if (root.assetId) {
      const visible = await this.albumUserRepository.filterVisibleSpaceAssetIds(
        spaceId,
        [root.assetId],
        spaceViewerOptions(auth),
        { inSpace: true },
      );
      if (!visible.has(root.assetId)) {
        throw new NotFoundException('Comment not found');
      }
    }

    requireReplyOnSameItem(root, assetId);
    return root;
  }

  /** Narrow a page of stored events to what this member may see, dropping what they may not. */
  private async narrowEvents(auth: AuthDto, spaceId: string, events: SharedSpaceEvent[]) {
    const options = spaceViewerOptions(auth);
    const inSpace = new Set<string>();
    const anywhere = new Set<string>();
    for (const event of events) {
      if (event.type === SharedSpaceEventType.AssetsRemoved) {
        for (const assetId of event.assetIds) {
          anywhere.add(assetId);
        }
      } else if (event.type === SharedSpaceEventType.AssetsAdded) {
        for (const assetId of event.assetIds) {
          inSpace.add(assetId);
        }
      } else if (event.activityAssetId) {
        inSpace.add(event.activityAssetId);
      }
    }

    const [visibleInSpace, visibleAnywhere] = await Promise.all([
      this.albumUserRepository.filterVisibleSpaceAssetIds(spaceId, [...inSpace], options, { inSpace: true }),
      this.albumUserRepository.filterVisibleSpaceAssetIds(spaceId, [...anywhere], options, { inSpace: false }),
    ]);

    return events
      .map((event) =>
        narrowSpaceEvent(event, event.type === SharedSpaceEventType.AssetsRemoved ? visibleAnywhere : visibleInSpace),
      )
      .filter((event): event is NonNullable<typeof event> => event !== null);
  }

  /** The item must be in the space and visible to this member, or it is not there as far as they know. */
  private async requireVisibleSpaceAsset(auth: AuthDto, spaceId: string, assetId: string) {
    const visible = await this.albumUserRepository.filterVisibleSpaceAssetIds(
      spaceId,
      [assetId],
      spaceViewerOptions(auth),
      { inSpace: true },
    );
    if (!visible.has(assetId)) {
      throw new NotFoundException('That item is not in this shared space');
    }
  }

  /** A comment of this space's, or 404: a like, or another album's comment, is not one. */
  private async requireSpaceComment(spaceId: string, commentId: string) {
    const activity = await this.activityRepository.getById(commentId);
    if (!activity || activity.albumId !== spaceId || activity.isLiked) {
      throw new NotFoundException('Comment not found');
    }
    return activity;
  }

  /** Tell the members newly named in a comment, never the author about themselves. */
  private async notifyMentioned(
    auth: AuthDto,
    spaceId: string,
    assetId: string | null,
    activityId: string,
    mentioned: string[],
    alreadyMentioned: string[],
  ) {
    const userIds = mentioned.filter((userId) => userId !== auth.user.id && !alreadyMentioned.includes(userId));
    if (userIds.length === 0) {
      return;
    }
    await this.eventRepository.emit('SharedSpaceMention', {
      id: spaceId,
      assetId,
      activityId,
      userIds,
      senderName: auth.user.name,
    });
  }

  private async mentionsByActivity(activityIds: string[]): Promise<Map<string, string[]>> {
    const byActivity = new Map<string, string[]>();
    for (const { activityId, userId } of await this.albumUserRepository.getMentions(activityIds)) {
      byActivity.set(activityId, [...(byActivity.get(activityId) ?? []), userId]);
    }
    return byActivity;
  }

  private async mapMentions(userIds: string[], users: UserMemo): Promise<UserResponseDto[]> {
    const mentions: UserResponseDto[] = [];
    for (const userId of userIds) {
      const user = await users.get(userId);
      if (user) {
        mentions.push(user);
      }
    }
    return mentions;
  }

  private async mapComment(
    space: SpaceLike,
    auth: AuthDto,
    row: CommentRow,
    mentionIds: string[],
    users: UserMemo,
    thread: CommentThreadInfo,
  ): Promise<SharedSpaceCommentResponseDto> {
    return {
      id: row.id,
      createdAt: asDateTimeString(row.createdAt),
      updatedAt: asDateTimeString(row.updatedAt),
      user: mapUser(row.user),
      assetId: row.assetId,
      comment: row.comment ?? '',
      mentions: await this.mapMentions(mentionIds, users),
      canEdit: canEditSpaceComment(row, auth.user.id),
      canDelete: canDeleteSpaceComment(space, row, auth.user.id),
      parentId: thread.parentId,
      replyCount: thread.replyCount,
    };
  }

  private userMemo(): UserMemo {
    const cache = new Map<string, Promise<UserResponseDto | null>>();
    return {
      get: (userId) => {
        if (!userId) {
          return Promise.resolve(null);
        }
        if (!cache.has(userId)) {
          cache.set(
            userId,
            this.userRepository.get(userId, {}).then((user) => (user ? mapUser(user) : null)),
          );
        }
        return cache.get(userId)!;
      },
    };
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
    const invitedBy = invite?.invitedById ? ((await this.userRepository.get(invite.invitedById, {})) ?? null) : null;

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

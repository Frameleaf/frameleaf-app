import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AlbumResponseDto } from 'src/dtos/album.dto.js';
import {
  RecipientGroupCreateDto,
  RecipientGroupResponseDto,
  RecipientGroupUpdateDto,
  SharedSpaceActivityResponseDto,
  SharedSpaceActivitySearchDto,
  SharedSpaceAlbumParamDto,
  SharedSpaceAlbumsResponseDto,
  SharedSpaceCommentCreateDto,
  SharedSpaceCommentParamDto,
  SharedSpaceCommentResponseDto,
  SharedSpaceCommentSearchDto,
  SharedSpaceCommentUpdateDto,
  SharedSpaceCommentsResponseDto,
  SharedSpaceInviteParamDto,
  SharedSpaceMembersResponseDto,
  SharedSpaceNewResponseDto,
  SharedSpacePeopleResponseDto,
  SharedSpacePersonLinkDto,
  SharedSpacePersonParamDto,
  SharedSpacePreviewResponseDto,
} from 'src/dtos/shared-space.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { SharedSpaceService } from 'src/services/shared-space.service.js';
import { UUIDParamDto } from 'src/validation.js';

/**
 * Shared spaces (FL-55). A shared space is an album with `kind: "space"`, so its
 * photos, members, roles, activity and download all use the album endpoints.
 * What lives here is only what a space adds on top: an invitation a recipient
 * can inspect before joining, and accepting or declining it.
 */
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
export class SharedSpaceController {
  constructor(private service: SharedSpaceService) {}

  @Get('recipient-groups')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'List recipient groups',
    description:
      "The authenticated user's own named groups of people to invite to a shared space together. A group is a shortcut only: it grants nothing, and its name is never shown to anyone but its owner.",
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getRecipientGroups(@Auth() auth: AuthDto): Promise<RecipientGroupResponseDto[]> {
    return this.service.getRecipientGroups(auth);
  }

  @Post('recipient-groups')
  @Authenticated({ permission: Permission.AlbumShare })
  @Endpoint({
    summary: 'Create a recipient group',
    description:
      'Save a named group of people to invite together. Nobody is invited or given access until the group is applied to a shared space and its invitations are sent.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  createRecipientGroup(
    @Auth() auth: AuthDto,
    @Body() dto: RecipientGroupCreateDto,
  ): Promise<RecipientGroupResponseDto> {
    return this.service.createRecipientGroup(auth, dto);
  }

  @Put('recipient-groups/:id')
  @Authenticated({ permission: Permission.AlbumShare })
  @Endpoint({
    summary: 'Update a recipient group',
    description:
      "Rename a group or change who is in it. Existing invitations and memberships are never changed; only the owner's own groups can be updated (anyone else's reads as not found).",
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  updateRecipientGroup(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: RecipientGroupUpdateDto,
  ): Promise<RecipientGroupResponseDto> {
    return this.service.updateRecipientGroup(auth, id, dto);
  }

  @Delete('recipient-groups/:id')
  @Authenticated({ permission: Permission.AlbumShare })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a recipient group',
    description: 'Delete one of your recipient groups. Nobody loses access to anything.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  deleteRecipientGroup(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deleteRecipientGroup(auth, id);
  }

  @Get('invitations')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'List shared space invitations',
    description:
      'Shared spaces the authenticated user has been invited to and has not answered. Each entry is the same safe preview as GET /shared-spaces/{id}/preview: no assets, and counts that exclude media marked sensitive and Locked media.',
    history: new HistoryBuilder().added('v3'),
  })
  getSharedSpaceInvitations(@Auth() auth: AuthDto): Promise<SharedSpacePreviewResponseDto[]> {
    return this.service.getInvitations(auth);
  }

  @Get(':id/preview')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'Preview a shared space',
    description:
      'What the shared space exposes, for someone holding an invitation to it or already in it. The preview carries no asset: no ids, no thumbnails, no file names, no people and no places. Counts and dates exclude media marked sensitive and Locked media. Anyone without an invitation or membership gets 404.',
    history: new HistoryBuilder().added('v3'),
  })
  getSharedSpacePreview(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<SharedSpacePreviewResponseDto> {
    return this.service.getPreview(auth, id);
  }

  @Get(':id/members')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'List shared space members',
    description:
      'Everyone in the shared space and everyone invited to it who has not answered. Any member may read the roster; only the owner may change it.',
    history: new HistoryBuilder().added('v3'),
  })
  getSharedSpaceMembers(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<SharedSpaceMembersResponseDto> {
    return this.service.getMembers(auth, id);
  }

  @Post(':id/accept')
  @Authenticated({ permission: Permission.AlbumUserUpdate })
  @Endpoint({
    summary: 'Accept a shared space invitation',
    description:
      'Join the shared space with the role its owner offered. The role comes from the stored invitation, never from the request. This is the only way to become a member of a space.',
    history: new HistoryBuilder().added('v3'),
  })
  acceptSharedSpaceInvitation(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AlbumResponseDto> {
    return this.service.accept(auth, id);
  }

  @Delete(':id/invitation')
  @Authenticated({ permission: Permission.AlbumUserDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Decline a shared space invitation',
    description:
      'Decline the invitation. Nothing else changes: the shared space and its photos are untouched, and the owner may invite again later.',
    history: new HistoryBuilder().added('v3'),
  })
  declineSharedSpaceInvitation(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.decline(auth, id);
  }

  @Delete(':id/invitations/:userId')
  @Authenticated({ permission: Permission.AlbumUserDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Withdraw a shared space invitation',
    description:
      'Withdraw a pending invitation. Only the shared space owner can do this, and it only reaches people who have not joined; removing a member is DELETE /albums/{id}/user/{userId}.',
    history: new HistoryBuilder().added('v3'),
  })
  removeSharedSpaceInvitation(
    @Auth() auth: AuthDto,
    @Param() { id, userId }: SharedSpaceInviteParamDto,
  ): Promise<void> {
    return this.service.removeInvitation(auth, id, userId);
  }

  @Get(':id/albums')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'List albums linked into a shared space',
    description:
      'The albums members have linked into the shared space, one level: a space links albums, never another space and never a collection. A link is a reference, not a move and not a share — the album keeps its owner, its members, its access rules and its place in its owner’s tree, and this response grants no access to it. The count and the tile picture come only from items that are in both the album and the space, with media marked sensitive and Locked media excluded.',
    history: new HistoryBuilder().added('v3'),
  })
  getSharedSpaceAlbums(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<SharedSpaceAlbumsResponseDto> {
    return this.service.getLinkedAlbums(auth, id);
  }

  @Put(':id/albums/:albumId')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Link an album into a shared space',
    description:
      'Point the shared space at an album the caller can already read. Nothing else happens: no item moves or is copied, no album membership changes, and the album stays where its owner put it. Linking the same album twice is the same single link. An owner or editor of the space may link; a viewer may not.',
    history: new HistoryBuilder().added('v3'),
  })
  linkSharedSpaceAlbum(
    @Auth() auth: AuthDto,
    @Param() { id, albumId }: SharedSpaceAlbumParamDto,
  ): Promise<SharedSpaceAlbumsResponseDto> {
    return this.service.linkAlbum(auth, id, albumId);
  }

  @Delete(':id/albums/:albumId')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Unlink an album from a shared space',
    description:
      'Remove the reference and only the reference. The album, its items, its members and the shared space’s own items are untouched. The member who made the link, and the shared space owner, may remove it.',
    history: new HistoryBuilder().added('v3'),
  })
  unlinkSharedSpaceAlbum(@Auth() auth: AuthDto, @Param() { id, albumId }: SharedSpaceAlbumParamDto): Promise<void> {
    return this.service.unlinkAlbum(auth, id, albumId);
  }

  @Get(':id/new')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'What is new in a shared space since your last visit',
    description:
      'Items other members added since the caller last marked this shared space seen. The marker is per member. If the caller has never marked it seen, everything in the space counts as new to them. The caller’s own additions are left out, and media marked sensitive and Locked media are excluded.',
    history: new HistoryBuilder().added('v3'),
  })
  getSharedSpaceNew(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<SharedSpaceNewResponseDto> {
    return this.service.getNew(auth, id);
  }

  @Get(':id/people')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'People in a shared space',
    description:
      'Two lists. `linked` is who members have published into the space, carrying the space’s own name for each one and a picture that is already in the space — never the owner’s private name, thumbnail, birth date or person ID. `candidates` is the caller’s own people seen on the space’s items, so they can publish one; no other member’s people are ever listed. Counts exclude media marked sensitive and Locked media.',
    history: new HistoryBuilder().added('v3'),
  })
  getSharedSpacePeople(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<SharedSpacePeopleResponseDto> {
    return this.service.getPeople(auth, id);
  }

  @Post(':id/people')
  @Authenticated({ permission: Permission.PersonUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Link a person into a shared space',
    description:
      'Publish one of the caller’s own people into the shared space under a name the space uses. The name is independent: it never renames the caller’s own person, and renaming that person does not rename it here. The caller’s person record is not disclosed to anybody. Linking the same person again rewrites the link rather than adding a second one.',
    history: new HistoryBuilder().added('v3'),
  })
  linkSharedSpacePerson(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: SharedSpacePersonLinkDto,
  ): Promise<SharedSpacePeopleResponseDto> {
    return this.service.linkPerson(auth, id, dto);
  }

  @Delete(':id/people/:linkId')
  @Authenticated({ permission: Permission.PersonUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Unlink a person from a shared space',
    description:
      'Remove the link and only the link. The person, their name, their faces and every item that shows them are untouched, and so are the shared space’s items. The member who made the link, and the shared space owner, may remove it.',
    history: new HistoryBuilder().added('v3'),
  })
  unlinkSharedSpacePerson(@Auth() auth: AuthDto, @Param() { id, linkId }: SharedSpacePersonParamDto): Promise<void> {
    return this.service.unlinkPerson(auth, id, linkId);
  }

  @Post(':id/visit')
  @Authenticated({ permission: Permission.AlbumRead })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Mark a shared space seen',
    description:
      'Move the caller’s own last-seen marker to now and return what is new after doing so. This is deliberately explicit rather than something opening the page does, so glancing at a space on a phone does not silently clear the list of what has not been looked at.',
    history: new HistoryBuilder().added('v3'),
  })
  markSharedSpaceVisited(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<SharedSpaceNewResponseDto> {
    return this.service.markVisited(auth, id);
  }

  @Get(':id/activity')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'What happened in a shared space',
    description:
      'The shared space’s activity feed, newest first: items added and removed, albums and people linked and unlinked, members joining, leaving, being removed or changing role, comments and likes — by every member. Only current members may read it. Every event is narrowed to the caller before it is sent: an item the caller cannot see (Locked, marked sensitive, hidden by their own settings, or no longer in the space) is never named, and an event with nothing visible left is not sent at all, so nothing can be inferred from a count. `unreadCount` is the events by other members since the caller last marked the space seen, computed the same way. Page with `before` and `take`.',
    history: new HistoryBuilder().added('v3'),
  })
  getSharedSpaceActivity(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: SharedSpaceActivitySearchDto,
  ): Promise<SharedSpaceActivityResponseDto> {
    return this.service.getActivity(auth, id, dto);
  }

  @Get(':id/comments')
  @Authenticated({ permission: Permission.ActivityRead })
  @Endpoint({
    summary: 'List comments in a shared space',
    description:
      'The comments on one item in the shared space (`assetId`), or on the space itself when `assetId` is left out. Oldest first. Only current members may read them, and an item the caller cannot see is not in the space as far as they are concerned (404). Mentions stay as `@{userId}` tokens in the text and are resolved in `mentions`. Threads are one level deep: a reply names its top-level comment in `parentId`, and a top-level comment carries its `replyCount`.',
    history: new HistoryBuilder().added('v3'),
  })
  getSharedSpaceComments(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: SharedSpaceCommentSearchDto,
  ): Promise<SharedSpaceCommentsResponseDto> {
    return this.service.getComments(auth, id, dto);
  }

  @Post(':id/comments')
  @Authenticated({ permission: Permission.ActivityCreate })
  @Endpoint({
    summary: 'Comment in a shared space',
    description:
      'Write a comment on one item in the shared space, or on the space itself when `assetId` is left out. Commenting must be enabled on the space, and the item must be one the caller can see. Mention a member with `@{userId}`: mentions are by id, never by name, every mention must name a current member (400 otherwise), and each mentioned member other than the author is notified. Reply with `parentId`: a reply to a reply joins the same thread under its top-level comment, is on the same item, and notifies the top-level comment’s author in the app.',
    history: new HistoryBuilder().added('v3'),
  })
  createSharedSpaceComment(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: SharedSpaceCommentCreateDto,
  ): Promise<SharedSpaceCommentResponseDto> {
    return this.service.createComment(auth, id, dto);
  }

  @Put(':id/comments/:commentId')
  @Authenticated({ permission: Permission.ActivityUpdate })
  @Endpoint({
    summary: 'Edit a shared space comment',
    description:
      'Change what a comment says. Only its author may. Mentions are re-read from the new text under the same rules, and members newly mentioned are notified.',
    history: new HistoryBuilder().added('v3'),
  })
  updateSharedSpaceComment(
    @Auth() auth: AuthDto,
    @Param() { id, commentId }: SharedSpaceCommentParamDto,
    @Body() dto: SharedSpaceCommentUpdateDto,
  ): Promise<SharedSpaceCommentResponseDto> {
    return this.service.updateComment(auth, id, commentId, dto);
  }

  @Delete(':id/comments/:commentId')
  @Authenticated({ permission: Permission.ActivityDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove a shared space comment',
    description:
      'Remove a comment. Its author may, and so may a shared space owner or editor — that is how a space is moderated. A viewer removes only their own. The comment’s mentions and its entry in the activity feed go with it, and removing a top-level comment removes its replies.',
    history: new HistoryBuilder().added('v3'),
  })
  deleteSharedSpaceComment(
    @Auth() auth: AuthDto,
    @Param() { id, commentId }: SharedSpaceCommentParamDto,
  ): Promise<void> {
    return this.service.deleteComment(auth, id, commentId);
  }
}

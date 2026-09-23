import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AlbumResponseDto } from 'src/dtos/album.dto.js';
import {
  SharedSpaceInviteParamDto,
  SharedSpaceMembersResponseDto,
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
  removeSharedSpaceInvitation(@Auth() auth: AuthDto, @Param() { id, userId }: SharedSpaceInviteParamDto): Promise<void> {
    return this.service.removeInvitation(auth, id, userId);
  }
}

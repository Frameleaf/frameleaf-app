import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AlbumMoveAssetsDto, AlbumTransferDto } from 'src/dtos/album-actions.dto.js';
import { BulkIdResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AlbumActionsService } from 'src/services/album-actions.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.5.0').alpha('v3.5.0');

/** FL-846: move photos to another album and hand an album to someone else. Merging is `AlbumMergeController`. */
@ApiTags(ApiTag.Albums)
@Controller('albums')
export class AlbumActionsController {
  constructor(private service: AlbumActionsService) {}

  @Post(':id/assets/move')
  @Authenticated({ permission: Permission.AlbumAssetDelete })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Move assets to another album',
    description:
      'Move photos and videos from this album into another album in one step. Only album membership changes: nothing is trashed or deleted. Needs permission to remove assets from this album and to add assets to the target, which must be an album, not a collection or shared space. Each asset is reported on its own; one already in the target simply leaves this album.',
    history: history(),
  })
  moveAlbumAssets(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AlbumMoveAssetsDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.moveAssets(auth, id, dto);
  }

  @Post(':id/transfer')
  @Authenticated({ permission: Permission.AlbumDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Transfer album ownership',
    description:
      'Make someone else the owner of this album. Only the owner can do this, and stays on as an editor. The new owner must already be in the album, or be a partner you share a library with. A shared space can only go to one of its members.',
    history: history(),
  })
  transferAlbum(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: AlbumTransferDto): Promise<void> {
    return this.service.transfer(auth, id, dto);
  }
}

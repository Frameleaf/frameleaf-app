import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AlbumSourceLinkResponseDto,
  AlbumSourceResolveDto,
  AlbumSourceResolveResponseDto,
  AlbumSourceUpdateDto,
  AlbumSourceUpdateResponseDto,
} from 'src/dtos/album-source.dto.js';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AlbumSourceService } from 'src/services/album-source.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.1').alpha('v3.2.1');

/** FL-331 (NAPI-015): phone albums and folders linked to the owner's server albums, for the native apps. */
@ApiTags(ApiTag.AlbumSources)
@Controller('album-sources')
export class AlbumSourceController {
  constructor(private service: AlbumSourceService) {}

  @Get()
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'List album source links',
    description: 'List your phone albums and folders linked to server albums.',
    history: history(),
  })
  getAlbumSourceLinks(@Auth() auth: AuthDto): Promise<AlbumSourceLinkResponseDto[]> {
    return this.service.getAll(auth);
  }

  @Post('resolve')
  @Authenticated({ permission: Permission.AlbumCreate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Resolve album sources',
    description:
      'For each phone album or folder, return its linked server album; otherwise link it to your oldest album with the same trimmed, case-insensitive name, or create an album. Never creates two albums for one source, also with several devices resolving at once.',
    history: history(),
  })
  resolveAlbumSources(
    @Auth() auth: AuthDto,
    @Body() dto: AlbumSourceResolveDto,
  ): Promise<AlbumSourceResolveResponseDto> {
    return this.service.resolve(auth, dto);
  }

  @Post(':id/assets')
  @Authenticated({ permission: Permission.AlbumAssetCreate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Add assets through an album source link',
    description:
      'Add assets to the linked album and record that the sync added them. Idempotent; an asset already in the album by hand is reported as a duplicate and never recorded.',
    history: history(),
  })
  addAlbumSourceAssets(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: BulkIdsDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.addAssets(auth, id, dto);
  }

  @Delete(':id/assets')
  @Authenticated({ permission: Permission.AlbumAssetDelete })
  @Endpoint({
    summary: 'Remove assets through an album source link',
    description:
      "Take out only the album memberships this link's sync added. Assets are never deleted, trashed or hidden, and memberships added by hand or still recorded by another link stay.",
    history: history(),
  })
  removeAlbumSourceAssets(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: BulkIdsDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.removeAssets(auth, id, dto);
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Update an album source link',
    description:
      'Record the source’s new name on the phone, renaming the server album only while its name still equals the name it last followed. An optional sourceId re-keys the link (409 when another link holds it).',
    history: history(),
  })
  updateAlbumSourceLink(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AlbumSourceUpdateDto,
  ): Promise<AlbumSourceUpdateResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete an album source link',
    description: 'Unlink the phone album or folder. The server album and its photos are kept.',
    history: history(),
  })
  deleteAlbumSourceLink(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(auth, id);
  }
}

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AlbumChangeRunLatestResponseDto,
  AlbumChangeUndoDto,
  AlbumChangeUndoResponseDto,
  AlbumMergeDto,
  AlbumMergeIntoDto,
  AlbumMergePreviewParamDto,
  AlbumMergePreviewResponseDto,
  AlbumMergeResponseDto,
} from 'src/dtos/album-merge.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AlbumChangeRunService } from 'src/services/album-change-run.service.js';
import { AlbumMergeService } from 'src/services/album-merge.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.1').alpha('v3.2.1');

/** FL-1298: merge one album into another, and undo what a merge, cleanup or date healing did. */
@ApiTags(ApiTag.Albums)
@Controller('albums')
export class AlbumMergeController {
  constructor(
    private merge: AlbumMergeService,
    private runs: AlbumChangeRunService,
  ) {}

  @Get('change-runs/latest')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'Get the latest undoable album change',
    description: 'The newest merge, cleanup or date healing you have not undone, while it can still be undone.',
    history: history(),
  })
  getLatestAlbumChangeRun(@Auth() auth: AuthDto): Promise<AlbumChangeRunLatestResponseDto> {
    return this.runs.getLatest(auth);
  }

  @Post('change-runs/latest/undo')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Undo the latest album change',
    description:
      'Reverse your newest merge, cleanup or date healing, for up to 30 days. Anything changed since is left alone and reported in `skipped`.',
    history: history(),
  })
  undoLatestAlbumChangeRun(
    @Auth() auth: AuthDto,
    @Body() dto: AlbumChangeUndoDto,
  ): Promise<AlbumChangeUndoResponseDto> {
    return this.runs.undoLatest(auth, dto);
  }

  @Get(':id/merge/:otherId')
  @Authenticated({ permission: Permission.AlbumDelete })
  @Endpoint({
    summary: 'Preview an album merge',
    description:
      'Which album will keep its name and icon, how many photos the merged album will hold that this session may see, and whether either is shared.',
    history: history(),
  })
  getAlbumMergePreview(
    @Auth() auth: AuthDto,
    @Param() { id, otherId }: AlbumMergePreviewParamDto,
  ): Promise<AlbumMergePreviewResponseDto> {
    return this.merge.getPreview(auth, id, otherId);
  }

  @Post(':id/merge')
  @Authenticated({ permission: Permission.AlbumDelete })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Merge an album with another',
    description:
      'Merge two albums you own into the one with the most photos, counting Locked ones; on a tie the older album stays. No photos leave your library. The other album can be brought back with Undo for 30 days.',
    history: history(),
  })
  mergeAlbum(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AlbumMergeDto,
  ): Promise<AlbumMergeResponseDto> {
    return this.merge.merge(auth, id, dto);
  }

  @Post(':id/merge-into')
  @Authenticated({ permission: Permission.AlbumDelete })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Merge albums into this one',
    description:
      'Merge other albums you own into this album, which keeps its name and icon whatever its size. No photos leave your library. One Undo brings them all back for 30 days.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  mergeAlbumsInto(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AlbumMergeIntoDto,
  ): Promise<AlbumMergeResponseDto> {
    return this.merge.mergeMany(auth, id, dto);
  }
}

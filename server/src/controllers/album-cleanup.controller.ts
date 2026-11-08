import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AlbumCleanupApplyDto,
  AlbumCleanupApplyResponseDto,
  AlbumCleanupSnapshotResponseDto,
  AlbumCleanupStatusResponseDto,
} from 'src/dtos/album-cleanup.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AlbumCleanupService } from 'src/services/album-cleanup.service.js';

const history = () => new HistoryBuilder().added('v3.2.1').alpha('v3.2.1');

/** FL-1300: Magic Albums cleanup: what the scan found, and applying what the person approved. */
@ApiTags(ApiTag.Albums)
@Controller('albums/cleanup')
export class AlbumCleanupController {
  constructor(private service: AlbumCleanupService) {}

  @Get('status')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'Get the album cleanup status',
    description:
      'Whether the album cleanup scan has run, how much it found, and how far a cleanup in progress has got.',
    history: history(),
  })
  getAlbumCleanupStatus(@Auth() auth: AuthDto): Promise<AlbumCleanupStatusResponseDto> {
    return this.service.getStatus(auth);
  }

  @Get('snapshot')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'Get the album cleanup scan results',
    description:
      'What the scan found in your top-level albums. A session without the PIN receives nothing computed from Locked items.',
    history: history(),
  })
  getAlbumCleanupSnapshot(@Auth() auth: AuthDto): Promise<AlbumCleanupSnapshotResponseDto> {
    return this.service.getSnapshot(auth);
  }

  @Post('apply')
  @Authenticated({ permission: Permission.AlbumDelete })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Apply an album cleanup',
    description:
      'Check a list of operations and apply them in the background. No photos leave your library. The result can be undone for 30 days.',
    history: history(),
  })
  applyAlbumCleanup(@Auth() auth: AuthDto, @Body() dto: AlbumCleanupApplyDto): Promise<AlbumCleanupApplyResponseDto> {
    return this.service.apply(auth, dto);
  }
}

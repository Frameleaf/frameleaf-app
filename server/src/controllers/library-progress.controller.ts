import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  LibraryProgressResponseDto,
  LibraryRedoDto,
  LibraryRedoResponseDto,
  MediaCopiesResponseDto,
  VideoCardDto,
} from 'src/dtos/library-progress.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { LibraryProgressService } from 'src/services/library-progress.service.js';

/**
 * FL-521: Library care's progress of each reading feature with a time estimate, Editing & playback's
 * space and counts, and starting a feature again over every photo now or tonight.
 */
@ApiTags(ApiTag.Jobs)
@Controller('admin/library-progress')
export class LibraryProgressController {
  constructor(private service: LibraryProgressService) {}

  @Get()
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({
    summary: 'Get the reading progress',
    description:
      'For Visual search, Faces, Text in photos, Descriptions and Locked detection: how many photos and videos are read of how many, how many an hour lately, and about how long the rest takes.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getLibraryProgress(): Promise<LibraryProgressResponseDto> {
    return this.service.getProgress();
  }

  @Get('media-copies')
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({
    summary: 'Get the previews and playback copies',
    description:
      'How many photos have no preview yet, how many videos have a playback copy, the space previews and playback copies take (as last measured), and what waits for tonight.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getMediaCopies(): Promise<MediaCopiesResponseDto> {
    return this.service.getMediaCopies();
  }

  @Post('media-copies/video-card/test')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    summary: 'Test the graphics card for video',
    description:
      'Makes a short test video on the graphics card the video converter uses, and on the processor for comparison, and keeps the result.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  testVideoCard(): Promise<VideoCardDto> {
    return this.service.testVideoCard();
  }

  @Post('redo')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Start a feature again over every photo',
    description:
      'Read every photo again for Visual search, group faces again, rebuild previews or remake playback copies: now, or in the next overnight run.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  redoLibraryWork(@Body() dto: LibraryRedoDto): Promise<LibraryRedoResponseDto> {
    return this.service.redo(dto);
  }
}

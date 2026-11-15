import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { PlaybackSelfTestResponseDto } from 'src/dtos/playback-self-test.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { PlaybackSelfTestService } from 'src/services/playback-self-test.service.js';

/** FL-977: the video playback self-test, shown on Video playback copies › Speed. */
@ApiTags(ApiTag.Jobs)
@Controller('admin/playback-self-test')
export class PlaybackSelfTestController {
  constructor(private service: PlaybackSelfTestService) {}

  @Get()
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    summary: 'Get the latest playback self-test',
    description:
      'The latest check of the hardware video path: each kind of reference video (SDR, HLG, Dolby Vision 8.4, HDR10 and hev1-tagged HEVC) converted with the configured hardware acceleration, whether it came out right, and the kinds now converted without hardware acceleration because it did not.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getPlaybackSelfTest(): Promise<PlaybackSelfTestResponseDto> {
    return this.service.getPlaybackSelfTest();
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    summary: 'Run the playback self-test',
    description:
      'Starts the check of the hardware video path (or joins the one already running) and answers at once with it running. It takes under a minute; read the result with the GET.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  startPlaybackSelfTest(): Promise<PlaybackSelfTestResponseDto> {
    return this.service.startPlaybackSelfTest();
  }
}

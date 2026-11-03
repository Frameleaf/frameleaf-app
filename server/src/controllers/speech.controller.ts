import { Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  SpeechCapabilitiesDto,
  SpeechRevisionDto,
  SpeechSearchDto,
  SpeechSearchResponseDto,
  SpeechSettingsUpdateDto,
  SpeechStatusDto,
} from 'src/dtos/speech.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { SpeechService } from 'src/services/speech.service.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');
@ApiTags(ApiTag.Search)
@Controller('speech')
export class SpeechController {
  constructor(private service: SpeechService) {}
  @Get('capabilities')
  @Authenticated()
  @Endpoint({ summary: 'Get spoken words indexing capabilities', history: history() })
  getSpeechCapabilities(): SpeechCapabilitiesDto {
    return { version: 1 };
  }
  @Get()
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({ summary: 'Get your speech indexing scope and progress', history: history() })
  getSpeechStatus(@Auth() auth: AuthDto): Promise<SpeechStatusDto> {
    return this.service.status(auth);
  }
  @Put()
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({ summary: 'Set your speech indexing opt-in and scope', history: history() })
  updateSpeechSettings(@Auth() auth: AuthDto, @Body() dto: SpeechSettingsUpdateDto): Promise<SpeechStatusDto> {
    return this.service.configure(auth, dto);
  }
  @Post('retry')
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({ summary: 'Retry failed speech indexing within your current scope', history: history() })
  retrySpeechIndexing(@Auth() auth: AuthDto, @Body() dto: SpeechRevisionDto): Promise<SpeechStatusDto> {
    return this.service.retry(auth, dto);
  }
  @Delete()
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({ summary: 'Disable speech indexing and delete your stored transcripts', history: history() })
  deleteSpeechIndex(@Auth() auth: AuthDto, @Body() dto: SpeechRevisionDto): Promise<SpeechStatusDto> {
    return this.service.purge(auth, dto);
  }
  @Post('search')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({ summary: 'Search literal spoken words and quoted phrases in your videos', history: history() })
  searchSpokenWords(@Auth() auth: AuthDto, @Body() dto: SpeechSearchDto): Promise<SpeechSearchResponseDto> {
    return this.service.search(auth, dto);
  }
}

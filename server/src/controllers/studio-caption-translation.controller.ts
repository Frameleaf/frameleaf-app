import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StudioCaptionTranslationCreateDto,
  StudioCaptionTranslationDto,
} from 'src/dtos/studio-caption-translation.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioCaptionTranslationService } from 'src/services/studio-caption-translation.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/** Captions in other languages (FL-641). */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
export class StudioCaptionTranslationController {
  constructor(private service: StudioCaptionTranslationService) {}

  @Post(':id/caption-translations')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Endpoint({
    summary: 'Translate Studio captions',
    description:
      'Owner only. Translates caption lines, sent as plain text, from one language into another on the first place in the processing order that can (this server, then a computer at home). The answer has one translation per line in the same order, so each keeps its timing; the editor keeps them as their own caption track. Only the text is sent; nothing is stored.',
    history: new HistoryBuilder().added('v3.3.0').alpha('v3.3.0'),
  })
  translateStudioCaptions(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioCaptionTranslationCreateDto,
  ): Promise<StudioCaptionTranslationDto> {
    return this.service.translate(auth, id, dto);
  }
}

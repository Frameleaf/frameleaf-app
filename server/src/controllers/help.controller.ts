import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { HelpArticleResponseDto, HelpAskDto, HelpAskResponseDto, HelpIndexResponseDto } from 'src/dtos/help.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { HelpService } from 'src/services/help.service.js';

/** In-app help (FL-488): the help panel's articles and Ask Frameleaf. */
@ApiTags(ApiTag.Help)
@Controller('help')
export class HelpController {
  constructor(private service: HelpService) {}

  @Get('index')
  @Authenticated({ permission: false })
  @Endpoint({
    operationId: 'getHelpIndex',
    summary: 'Get the help articles',
    description:
      'Every frameleaf.app help article as plain text, with the app screens each one helps on, whether Ask Frameleaf is on and the hardware its answers take into account. Served from the copy on this server, which is refreshed from the help website once a day.',
    history: new HistoryBuilder().added('v3.3.0').alpha('v3.3.0'),
  })
  getIndex(): Promise<HelpIndexResponseDto> {
    return this.service.getIndex();
  }

  @Get('articles/:section/:slug')
  @Authenticated({ permission: false })
  @Endpoint({
    operationId: 'getHelpArticle',
    summary: 'Get a help article',
    description: 'One help article as Markdown, from the help website. Only articles in the help index can be read.',
    history: new HistoryBuilder().added('v3.3.0').alpha('v3.3.0'),
  })
  getArticle(@Param('section') section: string, @Param('slug') slug: string): Promise<HelpArticleResponseDto> {
    return this.service.getArticle(`${section}/${slug}`);
  }

  @Post('ask')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: false })
  @RateLimited(RATE_LIMITS.helpAsk)
  @Endpoint({
    operationId: 'askHelp',
    summary: 'Ask Frameleaf',
    description:
      "Sends a question, the conversation so far and this server's hardware to frameleaf.app's Ask service and returns its answer, with the help articles it rests on. Nothing is stored on this server.",
    history: new HistoryBuilder().added('v3.3.0').alpha('v3.3.0'),
  })
  ask(
    @Auth() auth: AuthDto,
    @Body() dto: HelpAskDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<HelpAskResponseDto> {
    // the browser going away before the answer cancels the question at the Ask service too; the
    // request's own 'close' fires as soon as its body is read, so watch the response instead
    const abort = new AbortController();
    response.on('close', () => !response.writableFinished && abort.abort());
    return this.service.ask(auth, dto, abort.signal);
  }
}

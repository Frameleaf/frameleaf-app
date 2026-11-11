import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssistantAskDto, AssistantAskResponseDto, AssistantSwitchBackDto } from 'src/dtos/assistant.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AssistantService } from 'src/services/assistant.service.js';
import { assistantSwitchBack } from 'src/utils/assistant-switch-back.js';

const sessionId = (auth: AuthDto) => (auth.apiKey || auth.oauthApp || auth.sharedLink ? undefined : auth.session?.id);

@ApiTags(ApiTag.Search)
@Controller('assistant')
export class AssistantController {
  constructor(private service: AssistantService) {}

  @Post('ask')
  @Authenticated({ permission: Permission.AssetRead })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Search with Frameleaf Assistant',
    description:
      'Answer a question about the library with matching items and, for each one, why it matched. Plans with a planner model when one is installed and turned on, otherwise with the search rules.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  async askAssistant(@Auth() auth: AuthDto, @Body() dto: AssistantAskDto): Promise<AssistantAskResponseDto> {
    const answer = await this.service.ask(auth, dto);
    return { ...answer, switchBackToken: assistantSwitchBack.answer(sessionId(auth)) };
  }

  @Post('classic')
  @Authenticated({ permission: Permission.AssetRead })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Record a switch to Classic search',
    description:
      'Record a local switch to Classic search from an Assistant answer. Expired, previously used, and other-session tokens are ignored.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  recordAssistantSwitchBack(@Auth() auth: AuthDto, @Body() dto: AssistantSwitchBackDto): void {
    assistantSwitchBack.switchBack(sessionId(auth), dto.token);
  }
}

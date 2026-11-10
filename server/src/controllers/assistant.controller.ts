import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssistantAskDto, AssistantAskResponseDto } from 'src/dtos/assistant.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AssistantService } from 'src/services/assistant.service.js';

@ApiTags(ApiTag.Search)
@Controller('assistant')
export class AssistantController {
  constructor(private service: AssistantService) {}

  @Post('ask')
  @Authenticated({ permission: Permission.AssetRead })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Ask the Library Assistant',
    description:
      'Answer a question about the library with matching items and, for each one, why it matched. Plans with a planner model when one is installed and turned on, otherwise with the search rules.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  askAssistant(@Auth() auth: AuthDto, @Body() dto: AssistantAskDto): Promise<AssistantAskResponseDto> {
    return this.service.ask(auth, dto);
  }
}

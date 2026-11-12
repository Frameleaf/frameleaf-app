import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AssistantActionApplyDto,
  AssistantActionListResponseDto,
  AssistantActionProposeDto,
  AssistantActionResponseDto,
  AssistantActionSearchDto,
  AssistantAskDto,
  AssistantAskResponseDto,
  AssistantSwitchBackDto,
} from 'src/dtos/assistant.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AssistantActionService } from 'src/services/assistant-action.service.js';
import { AssistantService } from 'src/services/assistant.service.js';
import { assistantSwitchBack } from 'src/utils/assistant-switch-back.js';
import { UUIDv7ParamDto } from 'src/validation.js';

const sessionId = (auth: AuthDto) => (auth.apiKey || auth.oauthApp || auth.sharedLink ? undefined : auth.session?.id);

@ApiTags(ApiTag.Search)
@Controller('assistant')
export class AssistantController {
  constructor(
    private service: AssistantService,
    private actions: AssistantActionService,
  ) {}

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

  @Get('actions')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'List your Frameleaf Assistant changes',
    description:
      'The changes Frameleaf Assistant proposed to your library and what became of each, newest first. A confirmed change can be undone for 30 days.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  getAssistantActions(
    @Auth() auth: AuthDto,
    @Query() dto: AssistantActionSearchDto,
  ): Promise<AssistantActionListResponseDto> {
    return this.actions.getAll(auth, dto);
  }

  @Post('actions')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.CREATED)
  @Endpoint({
    summary: 'Propose a Frameleaf Assistant change',
    description:
      'Work out what making an album, adding to one, tagging, favouriting or culling bursts would change for a frozen list of items, and store it as a proposal. Nothing in the library changes: the answer is the count, a sample of the items and what was left out. Locked items and other people’s items are always left out; no change deletes or trashes anything.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  proposeAssistantAction(
    @Auth() auth: AuthDto,
    @Body() dto: AssistantActionProposeDto,
  ): Promise<AssistantActionResponseDto> {
    return this.actions.propose(auth, dto);
  }

  @Post('actions/:id/apply')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Confirm a Frameleaf Assistant change',
    description:
      'Carry out a proposal. Only the account that owns the proposal can confirm it, and only with `confirm: true`. The change runs as a background job listed in Activity; what each item was before is recorded so the change can be undone.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  applyAssistantAction(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() _dto: AssistantActionApplyDto,
  ): Promise<AssistantActionResponseDto> {
    return this.actions.apply(auth, id);
  }

  @Post('actions/:id/undo')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Undo a Frameleaf Assistant change',
    description:
      'Put back what a confirmed change did, within 30 days. Each item is restored only if it is still as the change left it; anything changed since is left alone and reported in `undo.skipped`. An album the change made is removed only when it holds nothing else.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  undoAssistantAction(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<AssistantActionResponseDto> {
    return this.actions.undo(auth, id);
  }
}

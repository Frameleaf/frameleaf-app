import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  TidyUpDecisionDto,
  TidyUpDecisionResponseDto,
  TidyUpKindParamDto,
  TidyUpKindStatusDto,
  TidyUpKindUpdateDto,
  TidyUpPageDto,
  TidyUpPageQueryDto,
  TidyUpStatusDto,
} from 'src/dtos/tidy-up.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { TidyUpService } from 'src/services/tidy-up.service.js';

const history = () => new HistoryBuilder().added('v3.4.0').alpha('v3.4.0');

/**
 * FL-1469 Tidy up: memes, receipts, screenshots and other clutter suggested for the Archive. Every kind,
 * suggestion and decision is the signed-in account's own; nothing is ever deleted.
 */
@ApiTags(ApiTag.MediaHealth)
@Controller('tidy-up')
export class TidyUpController {
  constructor(private service: TidyUpService) {}

  @Get()
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get Tidy up',
    description:
      'Each kind of clutter: whether it is looked for, how strictly, whether it archives automatically and how many photos wait for review.',
    history: history(),
  })
  getTidyUp(@Auth() auth: AuthDto): Promise<TidyUpStatusDto> {
    return this.service.getStatus(auth);
  }

  @Put('kinds/:kind')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Change one Tidy up kind',
    description:
      'Turn a kind on or off, set how strict it is, or let it archive new photos automatically (off unless asked). Turning a kind on looks through the library and only suggests; turning it off never takes a photo out of the Archive.',
    history: history(),
  })
  updateTidyUpKind(
    @Auth() auth: AuthDto,
    @Param() { kind }: TidyUpKindParamDto,
    @Body() dto: TidyUpKindUpdateDto,
  ): Promise<TidyUpKindStatusDto> {
    return this.service.setKind(auth, kind, dto);
  }

  @Get('suggestions')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'List Tidy up suggestions',
    description: 'Photos on the timeline that look like clutter, newest first, each with the kinds that found it.',
    history: history(),
  })
  getTidyUpSuggestions(@Auth() auth: AuthDto, @Query() dto: TidyUpPageQueryDto): Promise<TidyUpPageDto> {
    return this.service.getSuggestions(auth, dto);
  }

  @Get('tidied-away')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'List photos Tidy up archived',
    description: 'Photos Tidy up moved to the Archive and that are still there, newest first, so any can be put back.',
    history: history(),
  })
  getTidiedAway(@Auth() auth: AuthDto, @Query() dto: TidyUpPageQueryDto): Promise<TidyUpPageDto> {
    return this.service.getTidiedAway(auth, dto);
  }

  @Post('decide')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Archive, keep or undo Tidy up photos',
    description:
      'archive moves suggestions to the Archive; keep leaves photos on the timeline (putting back any Tidy up archived) and never suggests them again; undo puts photos you just archived back up for review.',
    history: history(),
  })
  decideTidyUp(@Auth() auth: AuthDto, @Body() dto: TidyUpDecisionDto): Promise<TidyUpDecisionResponseDto> {
    return this.service.decide(auth, dto);
  }
}

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import {
  TrashApplyDto,
  TrashItemsDto,
  TrashItemsResponseDto,
  TrashResponseDto,
  TrashReviewDto,
  TrashReviewResponseDto,
  TrashSummaryResponseDto,
  UtilityActivityQueryDto,
  UtilityActivityResponseDto,
} from 'src/dtos/trash.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { TrashService } from 'src/services/trash.service.js';

@ApiTags(ApiTag.Trash)
@Controller('trash')
export class TrashController {
  constructor(private service: TrashService) {}

  @Get('summary')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get trash summary',
    description:
      'Counts for your own trash as this session may see it: items, the combined size of their originals, and items still being removed from storage. Locked media counts only in an unlocked session.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getTrashSummary(@Auth() auth: AuthDto): Promise<TrashSummaryResponseDto> {
    return this.service.getSummary(auth);
  }

  @Get('items')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'List trash items',
    description:
      'One page of your own trash, filtered by file name and media type and ordered by deletion time, size or name. Locked media is listed only in an unlocked session.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getTrashItems(@Auth() auth: AuthDto, @Query() dto: TrashItemsDto): Promise<TrashItemsResponseDto> {
    return this.service.getItems(auth, dto);
  }

  @Get('activity')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get utility activity',
    description:
      'Your own history of moves to the trash and their undos made from a utility such as Large files, newest first, kept for a year. An item is named only while this session may still see it.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getUtilityActivity(
    @Auth() auth: AuthDto,
    @Query() dto: UtilityActivityQueryDto,
  ): Promise<UtilityActivityResponseDto> {
    return this.service.getUtilityActivity(auth, dto);
  }

  @Post('review')
  @Authenticated({ permission: Permission.AssetDelete })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Review a trash change',
    description:
      'Resolves exactly which items an action would change (move to trash, restore, restore all, delete or empty) and returns their count, size, shared originals and a token that fingerprints the set. Nothing is changed.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  reviewTrash(@Auth() auth: AuthDto, @Body() dto: TrashReviewDto): Promise<TrashReviewResponseDto> {
    return this.service.review(auth, dto);
  }

  @Post('apply')
  @Authenticated({ permission: Permission.AssetDelete })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Apply a reviewed trash change',
    description:
      'Applies an action to exactly the reviewed set. The set is resolved again with the same ownership, Locked and privacy rules; if it differs from the review in any way the request fails with 409 and nothing changes.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  applyTrashReview(@Auth() auth: AuthDto, @Body() dto: TrashApplyDto): Promise<TrashResponseDto> {
    return this.service.apply(auth, dto);
  }

  @Post('empty')
  @Authenticated({ permission: Permission.AssetDelete })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Empty trash',
    description: 'Permanently delete all items in the trash.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  emptyTrash(@Auth() auth: AuthDto): Promise<TrashResponseDto> {
    return this.service.empty(auth);
  }

  @Post('restore')
  @Authenticated({ permission: Permission.AssetDelete })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Restore trash',
    description: 'Restore all items in the trash.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  restoreTrash(@Auth() auth: AuthDto): Promise<TrashResponseDto> {
    return this.service.restore(auth);
  }

  @Post('restore/assets')
  @Authenticated({ permission: Permission.AssetDelete })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Restore assets',
    description: 'Restore specific assets from the trash.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  restoreAssets(@Auth() auth: AuthDto, @Body() dto: BulkIdsDto): Promise<TrashResponseDto> {
    return this.service.restoreAssets(auth, dto);
  }
}

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ClassificationApplyDto,
  ClassificationApplyResponseDto,
  ClassificationContributionDto,
  ClassificationDecisionDto,
  ClassificationDecisionResponseDto,
  ClassificationMatchPageDto,
  ClassificationMatchQueryDto,
  ClassificationPlanResponseDto,
  ClassificationPreviewDto,
  ClassificationPreviewResponseDto,
  ClassificationRuleCreateDto,
  ClassificationRuleQueryDto,
  ClassificationRuleResponseDto,
  ClassificationRuleUpdateDto,
  ClassificationSettingsDto,
} from 'src/dtos/classification.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ClassificationService } from 'src/services/classification.service.js';
import { UUIDParamDto, UUIDv7ParamDto } from 'src/validation.js';

/**
 * Classification rules (FL-60): the rules behind the signed-in account's own smart albums.
 *
 * Every rule, preview, plan and review is the signed-in account's own. A rule only reads and changes
 * that account's unlocked media and never grants anybody access to anything.
 */
@ApiTags(ApiTag.Albums)
@Controller('classification')
export class ClassificationController {
  constructor(private service: ClassificationService) {}

  @Get('settings')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'Retrieve classification rule settings',
    description: 'Whether rules may use visual categories, whether those can be compared now, and the default action.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getClassificationSettings(): Promise<ClassificationSettingsDto> {
    return this.service.getSettings();
  }

  @Get('rules')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'List classification rules',
    description: 'Your smart album rules, optionally only the one behind an album.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getClassificationRules(
    @Auth() auth: AuthDto,
    @Query() dto: ClassificationRuleQueryDto,
  ): Promise<ClassificationRuleResponseDto[]> {
    return this.service.getRules(auth, dto);
  }

  @Post('rules')
  @Authenticated({ permission: Permission.AlbumCreate })
  @Endpoint({
    summary: 'Create a classification rule',
    description:
      'Create a smart album and the rule that fills it. Nothing is matched until the rule is applied. Archiving matches requires `archiveConsent`.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  createClassificationRule(
    @Auth() auth: AuthDto,
    @Body() dto: ClassificationRuleCreateDto,
  ): Promise<ClassificationRuleResponseDto> {
    return this.service.createRule(auth, dto);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'Preview a classification rule',
    description:
      'What a draft rule matches, without writing anything. Rules with visual categories are previewed over a bounded sample of your newest items.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  previewClassificationRule(
    @Auth() auth: AuthDto,
    @Body() dto: ClassificationPreviewDto,
  ): Promise<ClassificationPreviewResponseDto> {
    return this.service.preview(auth, dto);
  }

  @Get('rules/:id')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'Retrieve a classification rule',
    description: 'One of your smart album rules and its counts.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getClassificationRule(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
  ): Promise<ClassificationRuleResponseDto> {
    return this.service.getRule(auth, id);
  }

  @Patch('rules/:id')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Update a classification rule',
    description:
      'Change what the rule matches, what it does, or turn it off. A rule that is off keeps what it applied. Turning archiving on requires `archiveConsent`.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  updateClassificationRule(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: ClassificationRuleUpdateDto,
  ): Promise<ClassificationRuleResponseDto> {
    return this.service.updateRule(auth, id, dto);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Delete a classification rule',
    description: 'Stop the rule. Its album stays as an ordinary album with everything in it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  deleteClassificationRule(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<void> {
    return this.service.deleteRule(auth, id);
  }

  @Post('rules/:id/plan')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'Plan a classification rule re-evaluation',
    description:
      'What applying the rule now would add, suggest and take back, without writing anything. Manual decisions are never part of it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  planClassificationRule(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
  ): Promise<ClassificationPlanResponseDto> {
    return this.service.plan(auth, id);
  }

  @Post('rules/:id/apply')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Apply a classification rule',
    description:
      'Apply the rule to up to 500 items from its plan. Larger plans run as an `apply-classification-rule` bulk media operation.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  applyClassificationRule(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: ClassificationApplyDto,
  ): Promise<ClassificationApplyResponseDto> {
    return this.service.apply(auth, id, dto);
  }

  @Get('rules/:id/matches')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'List classification rule matches',
    description: 'The rule’s matches with one decision, suggestions to review by default.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getClassificationRuleMatches(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Query() dto: ClassificationMatchQueryDto,
  ): Promise<ClassificationMatchPageDto> {
    return this.service.getMatches(auth, id, dto);
  }

  @Post('rules/:id/decisions')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Review classification rule matches',
    description:
      'Accept matches (they stay whatever later processing finds) or reject them (what the rule applied is taken back and never applied again).',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  decideClassificationRuleMatches(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: ClassificationDecisionDto,
  ): Promise<ClassificationDecisionResponseDto> {
    return this.service.decide(auth, id, dto);
  }

  @Get('assets/:id')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Retrieve classification contributions for an asset',
    description: 'Which of your rules put this item in a smart album, added a tag to it or archived it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getAssetClassifications(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
  ): Promise<ClassificationContributionDto[]> {
    return this.service.getContributions(auth, id);
  }
}

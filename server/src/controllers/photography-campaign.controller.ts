import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PhotographyCampaignDeliveriesDto,
  PhotographyCampaignDto,
  PhotographyCampaignListDto,
  PhotographyCampaignPreviewDto,
  PhotographyCampaignSaveDto,
  PhotographyCampaignScheduleDto,
} from 'src/dtos/photography-campaign.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { RateLimited } from 'src/middleware/rate-limit.guard.js';
import { PhotographyCampaignService } from 'src/services/photography-campaign.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
export class PhotographyCampaignController {
  constructor(private readonly service: PhotographyCampaignService) {}
  @Get('campaigns')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyCampaigns' })
  @ApiResponse({ status: 200, type: PhotographyCampaignListDto })
  list(@Auth() auth: AuthDto): Promise<PhotographyCampaignListDto> {
    return this.service.list(auth);
  }
  @Put('campaigns/:id')
  @Authenticated()
  @ApiOperation({ operationId: 'photographySaveCampaign' })
  @ApiResponse({ status: 200, type: PhotographyCampaignDto })
  save(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PhotographyCampaignSaveDto,
  ): Promise<PhotographyCampaignDto> {
    return this.service.save(auth, id, dto);
  }
  @Get('campaigns/:id/deliveries')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyCampaignDeliveries' })
  @ApiResponse({ status: 200, type: PhotographyCampaignDeliveriesDto })
  results(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PhotographyCampaignDeliveriesDto> {
    return this.service.results(auth, id);
  }
  @Get('campaigns/:id/preview')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyPreviewCampaign' })
  @ApiResponse({ status: 200, type: PhotographyCampaignPreviewDto })
  preview(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PhotographyCampaignPreviewDto> {
    return this.service.preview(auth, id);
  }
  @Post('campaigns/:id/test')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ operationId: 'photographyTestCampaign' })
  test(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.test(auth, id);
  }
  @Post('campaigns/:id/schedule')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyScheduleCampaign' })
  @ApiResponse({ status: 201, type: PhotographyCampaignDto })
  schedule(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PhotographyCampaignScheduleDto,
  ): Promise<PhotographyCampaignDto> {
    return this.service.schedule(auth, id, dto);
  }
  @Post('campaigns/:id/cancel')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyCancelCampaign' })
  @ApiResponse({ status: 201, type: PhotographyCampaignDto })
  cancel(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PhotographyCampaignDto> {
    return this.service.cancel(auth, id);
  }
  @Get('unsubscribe/:token')
  @Authenticated({ public: true })
  @RateLimited({ bucket: 'photography-unsubscribe', limit: 60, windowSeconds: 60 })
  @ApiOperation({ operationId: 'photographyUnsubscribePage' })
  async unsubscribePage(@Param('token') token: string, @Query('locale') locale = 'en', @Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.type('html').send(await this.service.unsubscribe(token, locale, false));
  }
  @Post('unsubscribe/:token')
  @Authenticated({ public: true })
  @RateLimited({ bucket: 'photography-unsubscribe', limit: 60, windowSeconds: 60 })
  @ApiOperation({ operationId: 'photographyUnsubscribe' })
  async unsubscribe(@Param('token') token: string, @Query('locale') locale = 'en', @Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.type('html').send(await this.service.unsubscribe(token, locale, true));
  }
}

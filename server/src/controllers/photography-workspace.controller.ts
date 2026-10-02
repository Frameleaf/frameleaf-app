import { Body, Controller, Get, HttpCode, HttpStatus, Next, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { PhotographyLogoVariantDto, PhotographyRenditionPreviewDto } from 'src/dtos/photography-rendition.dto.js';
import {
  PhotographyBrandDto,
  PhotographyBrandSaveDto,
  PhotographyLogoCandidatesDto,
  PhotographyPhotoQueryDto,
  PhotographyPhotosDto,
  PhotographyRatingDto,
  PhotographyWorkspaceDto,
  PhotographyWorkspaceSaveDto,
} from 'src/dtos/photography-workspace.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkspaceService } from 'src/services/photography-workspace.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.StudioProjects)
@Controller('photography/shoots')
export class PhotographyWorkspaceController {
  constructor(
    private service: PhotographyWorkspaceService,
    private logger: LoggingRepository,
  ) {}

  @Get()
  @Authenticated()
  @Endpoint({ summary: 'Read your private shoots', history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
  getPhotographyWorkspace(@Auth() auth: AuthDto): Promise<PhotographyWorkspaceDto> {
    return this.service.get(auth);
  }

  @Put()
  @Authenticated()
  @Endpoint({
    summary: 'Save your shoots using the loaded revision',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  savePhotographyWorkspace(
    @Auth() auth: AuthDto,
    @Body() dto: PhotographyWorkspaceSaveDto,
  ): Promise<PhotographyWorkspaceDto> {
    return this.service.save(auth, dto);
  }

  @Get('branding')
  @Authenticated()
  @Endpoint({
    summary: 'Read your private studio branding',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getPhotographyBrand(@Auth() auth: AuthDto): Promise<PhotographyBrandDto> {
    return this.service.getBrand(auth);
  }

  @Put('branding')
  @Authenticated()
  @Endpoint({
    summary: 'Save private studio branding with the workspace revision',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  savePhotographyBrand(@Auth() auth: AuthDto, @Body() dto: PhotographyBrandSaveDto): Promise<PhotographyBrandDto> {
    return this.service.saveBrand(auth, dto);
  }

  @Get('branding/logos')
  @Authenticated()
  @Endpoint({
    summary: 'List your eligible unlocked studio logo images',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getPhotographyLogos(
    @Auth() auth: AuthDto,
    @Query() query: PhotographyPhotoQueryDto,
  ): Promise<PhotographyLogoCandidatesDto> {
    return this.service.logos(auth, query);
  }

  @Get('branding/logos/:id/thumbnail')
  @FileResponse()
  @Authenticated()
  @Endpoint({
    summary: 'View an eligible owned logo thumbnail without original metadata',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  async getPhotographyLogoThumbnail(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res() response: Response,
    @Next() next: NextFunction,
    @Query() query?: PhotographyLogoVariantDto,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'private, no-store');
    await sendFile(
      response,
      next,
      () => this.service.logoThumbnail(auth, id, PhotographyLogoVariantDto.schema.parse(query ?? {}).variant),
      this.logger,
    );
  }

  @Post('branding/preview')
  @Authenticated()
  @Endpoint({
    summary: 'Preview a watermark using the production font metrics and renderer',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  async previewPhotographyWatermark(
    @Auth() auth: AuthDto,
    @Body() dto: PhotographyRenditionPreviewDto,
    @Res() response: Response,
  ): Promise<void> {
    const output = await this.service.previewWatermark(auth, dto);
    response.setHeader('Cache-Control', 'private, no-store');
    response.type('image/jpeg').send(output);
  }

  @Get(':id/photos')
  @Authenticated()
  @Endpoint({
    summary: 'Read a page of unlocked shoot photos',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getPhotographyPhotos(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() query: PhotographyPhotoQueryDto,
  ): Promise<PhotographyPhotosDto> {
    return this.service.photos(auth, id, query);
  }

  @Patch(':id/rating')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Rate or reject an owned photo in your shoot',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  ratePhotographyPhoto(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PhotographyRatingDto,
  ): Promise<void> {
    return this.service.rate(auth, id, dto);
  }
}

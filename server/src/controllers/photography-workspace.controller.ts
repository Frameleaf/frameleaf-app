import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  PhotographyPhotosDto,
  PhotographyPhotoQueryDto,
  PhotographyRatingDto,
  PhotographyWorkspaceDto,
  PhotographyWorkspaceSaveDto,
} from 'src/dtos/photography-workspace.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PhotographyWorkspaceService } from 'src/services/photography-workspace.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.StudioProjects)
@Controller('photography/shoots')
export class PhotographyWorkspaceController {
  constructor(private service: PhotographyWorkspaceService) {}

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

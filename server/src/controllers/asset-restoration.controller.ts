import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AssetRestorationFileQueryDto,
  AssetRestorationListResponseDto,
  AssetRestorationOptionsDto,
  AssetRestorationOptionsQueryDto,
  AssetRestorationParamDto,
  AssetRestorationRequestDto,
  AssetRestorationResponseDto,
  AssetRestorationSelectDto,
} from 'src/dtos/asset-restoration.dto.js';
import { ApiTag, Permission, RouteKey } from 'src/enum.js';
import { Auth, Authenticated, FileResponse, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetRestorationService } from 'src/services/asset-restoration.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

/**
 * Preview-first restoration (FL-115). Every route re-checks asset access through the existing
 * edit permissions; the original file is never modified by any of them. Progress, cancel and
 * retry of the underlying jobs are the media operations API (`/media-operations`).
 *
 * Route order matters: `options` and `current` are declared before `:restorationId` routes.
 */
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class AssetRestorationController {
  constructor(
    private service: AssetRestorationService,
    private logger: LoggingRepository,
  ) {}

  @Get(':id/restorations')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'List restorations of an asset',
    description:
      'Every restoration of the asset, newest first, with its lifecycle state, the destination it was bound to and which result the owner chose as the playback version.',
    history: history(),
  })
  getAssetRestorations(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetRestorationListResponseDto> {
    return this.service.list(auth, id);
  }

  @Get(':id/restorations/options')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'Get restoration options for an asset',
    description:
      'The output size after the 4K cap and every processing destination with whether it would admit the workload right now, whether media would leave the network, and a measured time estimate per destination.',
    history: history(),
  })
  getAssetRestorationOptions(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: AssetRestorationOptionsQueryDto,
  ): Promise<AssetRestorationOptionsDto> {
    return this.service.getOptions(auth, id, dto);
  }

  @Post(':id/restorations')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Request a restoration preview',
    description:
      'Creates the next restoration revision of the asset and queues a small preview on the named destination. The destination is admitted now; a refusal (no consent, disabled, over budget, unhealthy) is returned instead of another destination being used.',
    history: history(),
  })
  requestAssetRestoration(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetRestorationRequestDto,
  ): Promise<AssetRestorationResponseDto> {
    return this.service.requestPreview(auth, id, dto);
  }

  @Put(':id/restorations/current')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Choose the restoration used for playback',
    description:
      'Makes a finished restoration the version the asset plays back, or the original when none is named. Explicit and reversible; a finished job never makes this choice.',
    history: history(),
  })
  setCurrentAssetRestoration(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetRestorationSelectDto,
  ): Promise<AssetRestorationListResponseDto> {
    return this.service.setCurrent(auth, id, dto);
  }

  @Post(':id/restorations/:restorationId/accept')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Accept a restoration preview',
    description:
      'Queues the full-resolution render bound to exactly what was previewed: same destination, model, mode and size. Refused when the original changed since the preview or the destination no longer admits the workload.',
    history: history(),
  })
  acceptAssetRestoration(
    @Auth() auth: AuthDto,
    @Param() { id, restorationId }: AssetRestorationParamDto,
  ): Promise<AssetRestorationResponseDto> {
    return this.service.accept(auth, id, restorationId);
  }

  @Post(':id/restorations/:restorationId/reject')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Reject a restoration preview',
    description: 'Records the rejection. The preview files are kept briefly for comparison and then removed.',
    history: history(),
  })
  rejectAssetRestoration(
    @Auth() auth: AuthDto,
    @Param() { id, restorationId }: AssetRestorationParamDto,
  ): Promise<AssetRestorationResponseDto> {
    return this.service.reject(auth, id, restorationId);
  }

  @Delete(':id/restorations/:restorationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Discard a restoration',
    description:
      'Cancels anything still running, stops using the result for playback and removes every file the restoration produced. The record stays as history.',
    history: history(),
  })
  discardAssetRestoration(
    @Auth() auth: AuthDto,
    @Param() { id, restorationId }: AssetRestorationParamDto,
  ): Promise<void> {
    return this.service.discard(auth, id, restorationId);
  }

  @Get(':id/restorations/:restorationId/file')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetEditGet })
  // FL-161: can stream the full-resolution restored result
  @OriginalTransfer()
  @Endpoint({
    summary: 'View a restoration file',
    description: 'Streams the preview input, the restored preview, the full result or its playback rendition.',
    history: history(),
  })
  async viewAssetRestorationFile(
    @Auth() auth: AuthDto,
    @Param() { id, restorationId }: AssetRestorationParamDto,
    @Query() { kind }: AssetRestorationFileQueryDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.getFile(auth, id, restorationId, kind), this.logger);
  }
}

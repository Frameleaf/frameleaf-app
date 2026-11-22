import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  DesktopTranscodeClaimDto,
  DesktopTranscodeInputQueryDto,
  DesktopTranscodeUploadQueryDto,
} from 'src/dtos/desktop-transcode.dto.js';
import { DesktopWorkerAckDto, DesktopWorkerHeartbeatDto } from 'src/dtos/desktop-worker-job.dto.js';
import { DesktopWorkerPayloadDto } from 'src/dtos/desktop-worker.dto.js';
import { ApiTag } from 'src/enum.js';
import { Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { DesktopWorkerLanGuard } from 'src/middleware/desktop-worker-lan.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DesktopTranscodeService } from 'src/services/desktop-transcode.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

@ApiTags(ApiTag.Server)
@ApiBearerAuth()
@ApiHeader({
  name: 'x-frameleaf-desktop-proof',
  required: true,
  description: 'Canonical base64 installation-signed worker request proof. Photo sessions are not accepted.',
})
@UseGuards(DesktopWorkerLanGuard)
@Controller('desktop/transcodes')
export class DesktopTranscodeController {
  constructor(
    private service: DesktopTranscodeService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(DesktopTranscodeController.name);
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Claim one video playback conversion', history: history() })
  claimDesktopTranscode(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DesktopTranscodeClaimDto> {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.claim(authorization, proof);
  }

  @Get(':id/input')
  @Authenticated({ public: true })
  @FileResponse()
  @Endpoint({ summary: 'Read the original of a claimed video conversion', history: history() })
  async readDesktopTranscodeInput(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Param() { id }: UUIDParamDto,
    @Query() { claimToken }: DesktopTranscodeInputQueryDto,
    @Res() response: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(response, next, () => this.service.input(authorization, proof, id, claimToken), this.logger);
  }

  @Post(':id/heartbeat')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Renew the lease of a video conversion', history: history() })
  heartbeatDesktopTranscode(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DesktopWorkerPayloadDto,
  ): Promise<DesktopWorkerHeartbeatDto> {
    return this.service.heartbeat(authorization, proof, id, dto.payload);
  }

  @Put(':id/output')
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Upload a converted video for server validation', history: history() })
  uploadDesktopTranscode(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Param() { id }: UUIDParamDto,
    @Query() query: DesktopTranscodeUploadQueryDto,
    @Req() request: Request,
  ): Promise<DesktopWorkerAckDto> {
    return this.service.upload(authorization, proof, id, query, request);
  }

  @Post(':id/fail')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Hand a video conversion back to the server', history: history() })
  failDesktopTranscode(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DesktopWorkerPayloadDto,
  ): Promise<DesktopWorkerAckDto> {
    return this.service.fail(authorization, proof, id, dto.payload);
  }
}

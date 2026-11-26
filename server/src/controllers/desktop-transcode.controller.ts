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
  DesktopTranscodeUploadGrantDto,
} from 'src/dtos/desktop-transcode.dto.js';
import { DesktopWorkerAckDto, DesktopWorkerHeartbeatDto } from 'src/dtos/desktop-worker-job.dto.js';
import { DesktopWorkerPayloadDto } from 'src/dtos/desktop-worker.dto.js';
import { ApiTag } from 'src/enum.js';
import { Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { DesktopWorkerLanGuard } from 'src/middleware/desktop-worker-lan.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DesktopTranscodeService } from 'src/services/desktop-transcode.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDv7ParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');
const WorkerProof = () =>
  ApiHeader({
    name: 'x-frameleaf-desktop-proof',
    required: true,
    description: 'Canonical base64 installation-signed worker request proof. Photo sessions are not accepted.',
  });

@ApiTags(ApiTag.Server)
@ApiBearerAuth()
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
  @WorkerProof()
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
  @WorkerProof()
  @Authenticated({ public: true })
  @FileResponse()
  @Endpoint({ summary: 'Read the original of a claimed video conversion', history: history() })
  async readDesktopTranscodeInput(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Query() { claimToken }: DesktopTranscodeInputQueryDto,
    @Res() response: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(response, next, () => this.service.input(authorization, proof, id, claimToken), this.logger);
  }

  @Post(':id/heartbeat')
  @WorkerProof()
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Renew the lease of a video conversion', history: history() })
  heartbeatDesktopTranscode(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: DesktopWorkerPayloadDto,
  ): Promise<DesktopWorkerHeartbeatDto> {
    return this.service.heartbeat(authorization, proof, id, dto.payload);
  }

  @Post(':id/upload-grant')
  @WorkerProof()
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Get the token for uploading a converted video', history: history() })
  grantDesktopTranscodeUpload(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: DesktopWorkerPayloadDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DesktopTranscodeUploadGrantDto> {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.grantUpload(authorization, proof, id, dto.payload);
  }

  /** Not a signed request: those go one at a time, and a long upload would hold up its own heartbeats. */
  @Put(':id/output')
  @ApiHeader({
    name: 'x-frameleaf-transcode-upload',
    required: true,
    description: 'Token from the upload grant, bound to this conversion and its current claim.',
  })
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Upload a converted video for server validation', history: history() })
  uploadDesktopTranscode(
    @Headers('x-frameleaf-transcode-upload') uploadToken: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Req() request: Request,
  ): Promise<DesktopWorkerAckDto> {
    return this.service.upload(uploadToken, id, request);
  }

  @Post(':id/fail')
  @WorkerProof()
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Hand a video conversion back to the server', history: history() })
  failDesktopTranscode(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: DesktopWorkerPayloadDto,
  ): Promise<DesktopWorkerAckDto> {
    return this.service.fail(authorization, proof, id, dto.payload);
  }
}

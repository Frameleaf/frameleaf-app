import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  DesktopWorkerAckDto,
  DesktopWorkerClaimDto,
  DesktopWorkerHeartbeatDto,
} from 'src/dtos/desktop-worker-job.dto.js';
import { DesktopSessionDto, DesktopWorkerPayloadDto } from 'src/dtos/desktop-worker.dto.js';
import { ApiTag } from 'src/enum.js';
import { Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { DesktopWorkerService } from 'src/services/desktop-worker.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');
@ApiTags(ApiTag.Server)
@ApiBearerAuth()
@ApiHeader({
  name: 'x-frameleaf-desktop-proof',
  required: true,
  description: 'Canonical base64 installation-signed worker request proof. Photo sessions are not accepted.',
})
@Controller('desktop')
export class DesktopWorkerController {
  constructor(private service: DesktopWorkerService) {}

  @Post('worker/claim')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Claim one qualified desktop inference attempt', history: history() })
  async claimDesktopTask(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Body() dto: DesktopWorkerPayloadDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DesktopWorkerClaimDto> {
    const controller = new AbortController();
    const close = () => controller.abort();
    response.once('close', close);
    response.setHeader('Cache-Control', 'no-store');
    try {
      return await this.service.claim(authorization, proof, dto.payload, controller.signal);
    } finally {
      response.off('close', close);
    }
  }

  @Get('tasks/:id/input')
  @Authenticated({ public: true })
  @FileResponse()
  @Endpoint({ summary: 'Read only the input bound to this desktop attempt handle', history: history() })
  async readDesktopTaskInput(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Param() { id }: UUIDParamDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const input = await this.service.input(authorization, proof, id);
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(input, { type: 'application/octet-stream', length: input.length });
  }

  @Post('worker/heartbeat')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Renew a bounded desktop inference lease', history: history() })
  heartbeatDesktopTask(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Body() dto: DesktopWorkerPayloadDto,
  ): Promise<DesktopWorkerHeartbeatDto> {
    return this.service.heartbeat(authorization, proof, dto.payload);
  }

  @Post('tasks/:id/result')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Stage an idempotent desktop inference result for NAS validation', history: history() })
  completeDesktopTask(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DesktopWorkerPayloadDto,
  ): Promise<DesktopWorkerAckDto> {
    return this.service.complete(authorization, proof, id, dto.payload);
  }

  @Post('tasks/:id/fail')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Report a bounded desktop attempt failure', history: history() })
  failDesktopTask(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DesktopWorkerPayloadDto,
  ): Promise<DesktopWorkerAckDto> {
    return this.service.fail(authorization, proof, id, dto.payload);
  }

  @Post('worker/session')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Rotate a live installation-bound worker credential', history: history() })
  renewDesktopWorkerSession(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
    @Body() dto: DesktopWorkerPayloadDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DesktopSessionDto> {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.renew(authorization, proof, dto.payload);
  }

  @Delete('worker/session')
  @Authenticated({ public: true })
  @Endpoint({ summary: 'Revoke this desktop worker grant', history: history() })
  revokeDesktopWorkerSession(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-desktop-proof') proof: string | undefined,
  ): Promise<DesktopWorkerAckDto> {
    return this.service.revoke(authorization, proof);
  }
}

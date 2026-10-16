import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { DesktopSessionDto, DesktopSessionRequestDto } from 'src/dtos/desktop-worker.dto.js';
import {
  DesktopCapabilitiesDto,
  DesktopDeviceDto,
  DesktopEnrollmentDto,
  DesktopMemberApprovalDto,
} from 'src/dtos/desktop.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopDeviceService } from 'src/services/desktop-device.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');
@ApiTags(ApiTag.Server)
@Controller('desktop')
export class DesktopDeviceController {
  constructor(
    private service: DesktopDeviceService,
    private workerAuth: DesktopWorkerAuthService,
    private policy: DesktopAssistancePolicyService,
  ) {}

  @Get('accounts/:id/approval')
  @Authenticated({ permission: Permission.AdminUserRead, admin: true })
  @Endpoint({ summary: 'Read desktop processing approval for a member account', history: history() })
  readDesktopMemberApproval(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<DesktopMemberApprovalDto> {
    return this.policy.readMemberApproval(auth, id);
  }

  @Put('accounts/:id/approval')
  @Authenticated({ permission: Permission.AdminUserUpdate, admin: true })
  @Endpoint({ summary: 'Approve or remove desktop processing for a member account', history: history() })
  setDesktopMemberApproval(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DesktopMemberApprovalDto,
  ): Promise<DesktopMemberApprovalDto> {
    return this.policy.setMemberApproval(auth, id, dto.enabled);
  }

  @Get('capabilities')
  @Authenticated({ permission: false })
  @Endpoint({ summary: 'Get desktop capabilities', history: history() })
  getDesktopCapabilities(@Auth() auth: AuthDto): Promise<DesktopCapabilitiesDto> {
    return this.service.capabilities(auth);
  }

  @Get('devices')
  @Authenticated({ permission: false })
  @Endpoint({ summary: 'List this account’s desktop devices', history: history() })
  getDesktopDevices(@Auth() auth: AuthDto): Promise<DesktopDeviceDto[]> {
    return this.service.list(auth);
  }

  @Post('devices/enroll')
  @Authenticated({ permission: false })
  @Endpoint({ summary: 'Enroll or resume this desktop identity', history: history() })
  enrollDesktopDevice(@Auth() auth: AuthDto, @Body() dto: DesktopEnrollmentDto): Promise<DesktopDeviceDto> {
    return this.service.enroll(auth, dto);
  }

  @Post('devices/session')
  @Authenticated({ permission: false })
  @Endpoint({ summary: 'Issue an installation-bound library worker credential', history: history() })
  issueDesktopWorkerSession(
    @Auth() auth: AuthDto,
    @Body() dto: DesktopSessionRequestDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DesktopSessionDto> {
    response.setHeader('Cache-Control', 'no-store');
    return this.workerAuth.issue(auth, dto);
  }

  @Delete('devices/:id/session')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: false })
  @Endpoint({ summary: 'End this desktop association while retaining its installation identity', history: history() })
  endDesktopSession(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.endSession(auth, id);
  }

  @Delete('devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: false })
  @Endpoint({ summary: 'Revoke this account’s desktop device', history: history() })
  revokeDesktopDevice(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.revoke(auth, id);
  }
}

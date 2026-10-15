import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { DesktopCapabilitiesDto, DesktopDeviceDto, DesktopEnrollmentDto } from 'src/dtos/desktop.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { DesktopDeviceService } from 'src/services/desktop-device.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');
@ApiTags(ApiTag.Server)
@Controller('desktop')
export class DesktopDeviceController {
  constructor(private service: DesktopDeviceService) {}

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

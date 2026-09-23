import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ICloudAuthDto,
  ICloudConnectionCreateDto,
  ICloudConnectionResponseDto,
  ICloudConnectionUpdateDto,
  ICloudConnectionsResponseDto,
  ICloudControlDto,
  ICloudInventoryResponseDto,
} from 'src/dtos/icloud-sync.dto.js';
import { Auth, Authenticated, GetLoginDetails } from 'src/middleware/auth.guard.js';
import { ICloudSyncService } from 'src/services/icloud-sync.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags('ICloud Sync')
@Controller('icloud-sync/connections')
export class ICloudSyncController {
  constructor(private service: ICloudSyncService) {}

  @Get()
  @Authenticated()
  @Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
  listICloudConnections(@Auth() auth: AuthDto): Promise<ICloudConnectionsResponseDto> {
    return this.service.list(auth);
  }

  @Post()
  @Authenticated()
  @Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
  createICloudConnection(
    @Auth() auth: AuthDto,
    @Body() dto: ICloudConnectionCreateDto,
  ): Promise<ICloudConnectionResponseDto> {
    return this.service.create(auth, dto);
  }

  @Patch(':id')
  @Authenticated()
  @Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
  updateICloudConnection(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: ICloudConnectionUpdateDto,
  ): Promise<ICloudConnectionResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Post(':id/auth')
  @Authenticated()
  @Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
  authenticateICloudConnection(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: ICloudAuthDto,
    @GetLoginDetails() details: LoginDetails,
  ): Promise<ICloudConnectionResponseDto> {
    return this.service.authenticate(auth, id, dto, details.isSecure);
  }

  @Post(':id/control')
  @Authenticated()
  @Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
  controlICloudConnection(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: ICloudControlDto,
  ): Promise<ICloudConnectionResponseDto> {
    return this.service.control(auth, id, dto);
  }

  @Get(':id/inventory')
  @Authenticated()
  @Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
  getICloudInventory(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<ICloudInventoryResponseDto> {
    return this.service.inventory(auth, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
  disconnectICloudConnection(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.disconnect(auth, id);
  }

  // Remove a disconnected connection and what it recorded about the source (FL-68). Photos it
  // imported stay in the library.
  @Post(':id/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
  removeICloudConnection(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.remove(auth, id);
  }
}

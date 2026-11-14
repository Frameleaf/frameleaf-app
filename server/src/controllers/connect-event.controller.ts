import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ConnectEventLatestQueryDto,
  ConnectEventPageDto,
  ConnectEventQueryDto,
  ConnectEventSampleDto,
  ConnectEventSampleQueryDto,
} from 'src/dtos/connect-event.dto.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ConnectEventService } from 'src/services/connect-event.service.js';

@ApiTags('Connect')
@Controller('connect/events')
export class ConnectEventController {
  constructor(private service: ConnectEventService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'getConnectEvents',
    summary: 'Initialize or drain a durable Connect event checkpoint',
  })
  read(@Auth() auth: AuthDto, @Query() query: ConnectEventQueryDto): Promise<ConnectEventPageDto> {
    return this.service.read(auth, query);
  }

  @Get('latest')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'getLatestConnectEvents',
    summary: 'Read at most the newest 1000 authorized events across ten pages',
  })
  latest(@Auth() auth: AuthDto, @Query() query: ConnectEventLatestQueryDto): Promise<ConnectEventPageDto> {
    return this.service.latest(auth, query);
  }

  @Get('sample')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'getConnectEventSample',
    summary: 'Read one current event without changing a polling checkpoint',
  })
  sample(@Auth() auth: AuthDto, @Query() query: ConnectEventSampleQueryDto): Promise<ConnectEventSampleDto> {
    return this.service.sample(auth, query);
  }
}

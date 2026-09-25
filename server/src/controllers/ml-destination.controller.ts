import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  MlAdmissionRequestDto,
  MlAdmissionResponseDto,
  MlCapabilitiesResponseDto,
  MlDestinationConsentRequestDto,
  MlDestinationCreateDto,
  MlDestinationHealthStateDto,
  MlDestinationResponseDto,
  MlDestinationUpdateDto,
  MlWorkloadRouteUpdateDto,
  MlWorkloadRoutesResponseDto,
} from 'src/dtos/ml-destination.dto.js';
import { MlRestorationModelsResponseDto } from 'src/dtos/restoration-inference.dto.js';
import { ApiTag, MlWorkloadSchema, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { MlDestinationService } from 'src/services/ml-destination.service.js';
import { UUIDParamDto } from 'src/validation.js';

class MlWorkloadParamDto extends createZodDto(z.object({ workload: MlWorkloadSchema })) {}

/**
 * Machine-learning destinations (FL-110). Administration is admin-only; the capability
 * snapshot and admission are for any signed-in user because the Studio host and the
 * restoration flow ask them on the person's behalf.
 */
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
export class MlDestinationController {
  constructor(private service: MlDestinationService) {}

  @Get('capabilities')
  @Authenticated()
  @Endpoint({
    operationId: 'getMlCapabilities',
    summary: 'Get machine-learning capabilities',
    description:
      'What this deployment can run right now, per workload and destination, from the last health probes. Includes the Studio capability row the Studio host reads.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getCapabilities(): Promise<MlCapabilitiesResponseDto> {
    return this.service.getCapabilities();
  }

  @Get('routes')
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    operationId: 'getMlWorkloadRoutes',
    summary: 'List workload routes',
    description:
      'The destination each workload is routed to. A workload without a route is refused, never sent anywhere.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getRoutes(): Promise<MlWorkloadRoutesResponseDto> {
    return this.service.getRoutes();
  }

  @Put('routes/:workload')
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    operationId: 'setMlWorkloadRoute',
    summary: 'Route a workload',
    description:
      'Route a workload to one destination, or remove its route with a null destination. Routing to a cloud destination requires its consent to be recorded first.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  setRoute(
    @Param() { workload }: MlWorkloadParamDto,
    @Body() dto: MlWorkloadRouteUpdateDto,
  ): Promise<MlWorkloadRoutesResponseDto> {
    return this.service.setRoute(workload, dto);
  }

  @Get()
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    operationId: 'listMlDestinations',
    summary: 'List machine-learning destinations',
    description: 'Every configured destination with its consent state, cost controls and last probe.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  list(): Promise<MlDestinationResponseDto[]> {
    return this.service.list();
  }

  @Post()
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    operationId: 'createMlDestination',
    summary: 'Create a machine-learning destination',
    description: 'Add a LAN worker. Frameleaf Cloud is added from its own endpoint (POST admin/cloud/ml/destination).',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  create(@Body() dto: MlDestinationCreateDto): Promise<MlDestinationResponseDto> {
    return this.service.create(dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    operationId: 'getMlDestination',
    summary: 'Get a machine-learning destination',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  get(@Param() { id }: UUIDParamDto): Promise<MlDestinationResponseDto> {
    return this.service.get(id);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    operationId: 'updateMlDestination',
    summary: 'Update a machine-learning destination',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  update(@Param() { id }: UUIDParamDto, @Body() dto: MlDestinationUpdateDto): Promise<MlDestinationResponseDto> {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    operationId: 'deleteMlDestination',
    summary: 'Delete a machine-learning destination',
    description:
      'Removes the destination and every route to it; the affected workloads are refused until routed again.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  delete(@Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(id);
  }

  @Post(':id/probe')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    operationId: 'probeMlDestination',
    summary: 'Probe a machine-learning destination',
    description: 'Check reachability, served workloads and hardware now, and record the result.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  probe(@Param() { id }: UUIDParamDto): Promise<MlDestinationHealthStateDto> {
    return this.service.probe(id);
  }

  @Get(':id/restoration-models')
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    summary: 'Get restoration models of a destination',
    description:
      'Asks the destination which Faithful and Creative restoration models it has, the state of each and every reason one is unavailable, with the throughput measured when it was qualified. No media is sent.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getMlDestinationRestorationModels(@Param() { id }: UUIDParamDto): Promise<MlRestorationModelsResponseDto> {
    return this.service.getRestorationModels(id);
  }

  @Put(':id/consent')
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    operationId: 'grantMlDestinationConsent',
    summary: 'Record consent for a cloud destination',
    description: 'Records that an administrator accepts media leaving the network for this destination.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  grantConsent(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: MlDestinationConsentRequestDto,
  ): Promise<MlDestinationResponseDto> {
    return this.service.grantConsent(auth, id, dto);
  }

  @Delete(':id/consent')
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    operationId: 'revokeMlDestinationConsent',
    summary: 'Revoke consent for a cloud destination',
    description: 'Every workload routed to the destination is refused from the next request on.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  revokeConsent(@Param() { id }: UUIDParamDto): Promise<MlDestinationResponseDto> {
    return this.service.revokeConsent(id);
  }

  @Post(':id/admission')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Endpoint({
    operationId: 'admitMlDestination',
    summary: 'Admit a workload on a destination',
    description:
      'Per-request selection: checks that exactly this destination can run the workload now (enabled, allowed, consented, within budget, healthy, serving it) and returns the measured estimate. A refusal is a 4xx error naming the reason; the server never answers with a different destination.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  admit(@Param() { id }: UUIDParamDto, @Body() dto: MlAdmissionRequestDto): Promise<MlAdmissionResponseDto> {
    return this.service.admit(id, dto);
  }
}

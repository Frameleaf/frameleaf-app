import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  LocationFillApplyDto,
  LocationFillCreateDto,
  LocationFillProposalsQueryDto,
  LocationFillProposalsResponseDto,
  LocationFillRunResponseDto,
} from 'src/dtos/location-fill.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { LocationFillService } from 'src/services/location-fill.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.4.0').alpha('v3.4.0');

/**
 * FL-964: fill your photos that have no location from your own location history: propose, look, apply, undo.
 * Every route is the signed-in person's own.
 */
@ApiTags(ApiTag.Users)
@Controller('users/me/location-fills')
export class LocationFillController {
  constructor(private service: LocationFillService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Look for locations for your photos',
    description:
      'Starts a run that proposes a location for each of your photos that has none, from the places in your location history close enough in time. Nothing changes until you apply proposals. A photo that has a location is never proposed another.',
    history: history(),
  })
  createLocationFill(@Auth() auth: AuthDto, @Body() dto: LocationFillCreateDto): Promise<LocationFillRunResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get()
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({ summary: 'List your location fill runs', description: 'Newest first.', history: history() })
  getLocationFills(@Auth() auth: AuthDto): Promise<LocationFillRunResponseDto[]> {
    return this.service.getAll(auth);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({ summary: 'Get a location fill run', history: history() })
  getLocationFill(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<LocationFillRunResponseDto> {
    return this.service.get(auth, id);
  }

  @Get(':id/proposals')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'List the proposals of a location fill run',
    description: 'In the order the photos were taken, grouped by local day.',
    history: history(),
  })
  getLocationFillProposals(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Query() query: LocationFillProposalsQueryDto,
  ): Promise<LocationFillProposalsResponseDto> {
    return this.service.getProposals(auth, id, query);
  }

  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Apply the proposals of a location fill run',
    description:
      'Gives every proposal, or the chosen ones, to its photo, as a location edit does: the database and the sidecar change, the original file does not. A photo given a location since the run looked is left alone. Continues after the browser closes.',
    history: history(),
  })
  applyLocationFill(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: LocationFillApplyDto,
  ): Promise<LocationFillRunResponseDto> {
    return this.service.apply(auth, id, dto);
  }

  @Post(':id/undo')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Undo a location fill run',
    description:
      'Removes every location the run gave that is still as the run left it. A location you changed since stays as you set it.',
    history: history(),
  })
  undoLocationFill(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<LocationFillRunResponseDto> {
    return this.service.undo(auth, id);
  }
}

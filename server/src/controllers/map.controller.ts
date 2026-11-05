import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  MapClusterDto,
  MapClusterListResponseDto,
  MapMarkerDto,
  MapMarkerListDto,
  MapMarkerResponseDto,
  MapReverseGeocodeDto,
  MapReverseGeocodeResponseDto,
  MapStatisticsResponseDto,
} from 'src/dtos/map.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { MapService } from 'src/services/map.service.js';

@ApiTags(ApiTag.Map)
@Controller('map')
export class MapController {
  constructor(private service: MapService) {}

  @Get('markers')
  @Authenticated({ permission: Permission.MapRead })
  @Endpoint({
    summary: 'Retrieve map markers',
    description: 'Retrieve a list of latitude and longitude coordinates for every asset with location data.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getMapMarkers(@Auth() auth: AuthDto, @Query() options: MapMarkerListDto): Promise<MapMarkerResponseDto[]> {
    return this.service.getMapMarkers(auth, options);
  }

  @Get('clusters')
  @Authenticated({ permission: Permission.MapRead })
  @Endpoint({
    summary: 'Retrieve map clusters',
    description:
      'Retrieve the located items for one view of the map: items close together at the zoom level come as clusters with a count, the rest as markers. A library small enough to send whole comes as markers only, marked complete.',
    history: new HistoryBuilder().added('v3.2.1'),
  })
  getMapClusters(@Auth() auth: AuthDto, @Query() options: MapClusterDto): Promise<MapClusterListResponseDto> {
    return this.service.getMapClusters(auth, options);
  }

  @Get('statistics')
  @Authenticated({ permission: Permission.MapRead })
  @Endpoint({
    summary: 'Retrieve map statistics',
    description:
      "Count what the map settings would add, under the same date and favorite filters: the viewer's own located archived items and the viewer's own items without a location. The partner count is always 0, since partners' items arrive as the viewer's own copies.",
    history: new HistoryBuilder().added('v3'),
  })
  getMapStatistics(@Auth() auth: AuthDto, @Query() options: MapMarkerDto): Promise<MapStatisticsResponseDto> {
    return this.service.getMapStatistics(auth, options);
  }

  @Get('reverse-geocode')
  @Authenticated({ permission: Permission.MapSearch })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Reverse geocode coordinates',
    description: 'Retrieve location information (e.g., city, country) for given latitude and longitude coordinates.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  reverseGeocode(@Query() dto: MapReverseGeocodeDto): Promise<MapReverseGeocodeResponseDto[]> {
    return this.service.reverseGeocode(dto);
  }
}

import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  MapClusterDto,
  MapClusterListResponseDto,
  MapMarkerDto,
  MapMarkerListDto,
  MapMarkerResponseDto,
  MapReverseGeocodeDto,
  MapStatisticsResponseDto,
} from 'src/dtos/map.dto.js';
import { MAP_SINGLES_LIMIT, type MapArea, type MapMarkerSearchOptions } from 'src/repositories/map.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { getHiddenContentQueryOptions, getOthersRulesQueryOptions } from 'src/utils/hidden-content.js';

/** FL-1214: a library with at most this many located items is sent whole, and the browser groups it. */
export const MAP_COMPLETE_LIMIT = 20_000;

/** Without an area the whole world is grouped, never finer than this zoom level (about 16k cells). */
export const MAP_WORLD_MAX_ZOOM = 4;

/** All four edges, or no area (the whole world). */
const areaOf = ({ west, south, east, north }: Partial<MapArea>): MapArea | undefined =>
  west === undefined || south === undefined || east === undefined || north === undefined
    ? undefined
    : { west, south, east, north };

@Injectable()
export class MapService extends BaseService {
  async getMapMarkers(auth: AuthDto, dto: MapMarkerListDto): Promise<MapMarkerResponseDto[]> {
    const { west, south, east, north, skip, take, ...filters } = dto;
    const { albumIds, options } = await this.libraryOptions(auth, filters);
    return this.mapRepository.getMapMarkers(auth.user.id, [auth.user.id], albumIds, {
      ...options,
      area: areaOf({ west, south, east, north }),
      skip,
      take,
    });
  }

  /**
   * FL-1214: one view of the map. Asked without an area, a library of at most `MAP_COMPLETE_LIMIT`
   * located items comes whole (`complete`), as `getMapMarkers` would send it; otherwise the clusters and
   * single items in the area at the requested zoom.
   */
  async getMapClusters(auth: AuthDto, dto: MapClusterDto): Promise<MapClusterListResponseDto> {
    const { west, south, east, north, zoom, ...filters } = dto;
    const { albumIds, options } = await this.libraryOptions(auth, filters);
    const area = areaOf({ west, south, east, north });
    const result = await this.mapRepository.getMapClusters(
      auth.user.id,
      [auth.user.id],
      albumIds,
      area ? zoom : Math.min(zoom, MAP_WORLD_MAX_ZOOM),
      area ? MAP_SINGLES_LIMIT : MAP_COMPLETE_LIMIT,
      { ...options, area },
    );
    return { ...result, complete: !area && result.total <= MAP_COMPLETE_LIMIT };
  }

  private async libraryOptions(auth: AuthDto, dto: MapMarkerDto) {
    // FL-326 (spec §4.8): the map holds only the viewer's rows; what partners share arrives as copies
    const albumIds = dto.withSharedAlbums ? await this.albumRepository.getAllIds(auth.user.id) : [];
    const options: MapMarkerSearchOptions = {
      ...dto,
      ...getHiddenContentQueryOptions(auth),
      // FL-446: a shared album never places another member's item that matches its owner's Locked rules
      ...(albumIds.length > 0 && getOthersRulesQueryOptions(auth)),
    };
    return { albumIds, options };
  }

  /**
   * FL-51: the settings sheet's counts. Archived and unlocated items are the viewer's own. Hidden and
   * Locked content follows the session, as for the markers. FL-326: partners' items are the viewer's own
   * copies now, so the partner count is always 0 (kept for older clients).
   */
  async getMapStatistics(auth: AuthDto, options: MapMarkerDto): Promise<MapStatisticsResponseDto> {
    return this.mapRepository.getMapStatistics(auth.user.id, [], {
      isFavorite: options.isFavorite,
      fileCreatedAfter: options.fileCreatedAfter,
      fileCreatedBefore: options.fileCreatedBefore,
      ...getHiddenContentQueryOptions(auth),
    });
  }

  async reverseGeocode(dto: MapReverseGeocodeDto) {
    const { lat: latitude, lon: longitude } = dto;
    // eventually this should probably return an array of results
    const result = await this.mapRepository.reverseGeocode({ latitude, longitude });
    return result ? [result] : [];
  }
}

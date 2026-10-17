import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  MapMarkerDto,
  MapMarkerResponseDto,
  MapReverseGeocodeDto,
  MapStatisticsResponseDto,
} from 'src/dtos/map.dto.js';
import { BaseService } from 'src/services/base.service.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';

@Injectable()
export class MapService extends BaseService {
  async getMapMarkers(auth: AuthDto, options: MapMarkerDto): Promise<MapMarkerResponseDto[]> {
    // FL-326 (spec §4.8): the map holds only the viewer's rows; what partners share arrives as copies
    const albumIds = options.withSharedAlbums ? await this.albumRepository.getAllIds(auth.user.id) : [];
    return this.mapRepository.getMapMarkers(auth.user.id, [auth.user.id], albumIds, {
      ...options,
      ...getHiddenContentQueryOptions(auth),
    });
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

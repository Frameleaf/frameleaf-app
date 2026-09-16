import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { MapMarkerDto, MapMarkerResponseDto, MapReverseGeocodeDto } from 'src/dtos/map.dto.js';
import { BaseService } from 'src/services/base.service.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';

@Injectable()
export class MapService extends BaseService {
  async getMapMarkers(auth: AuthDto, options: MapMarkerDto): Promise<MapMarkerResponseDto[]> {
    const userIds = [auth.user.id];
    if (options.withPartners) {
      const partnerIds = await getMyPartnerIds({ userId: auth.user.id, repository: this.partnerRepository });
      userIds.push(...partnerIds);
    }

    const albumIds = options.withSharedAlbums ? await this.albumRepository.getAllIds(auth.user.id) : [];

    return this.mapRepository.getMapMarkers(auth.user.id, userIds, albumIds, {
      ...options,
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
